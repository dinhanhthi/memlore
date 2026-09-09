// Serialisation contract
// ──────────────────────
// xj_pick_photos is exposed as a C symbol called from Rust via swift-rs.
// PHPicker is a modal sheet and can only be presented on the main thread.
// Two concurrent Rust calls would race on `PhotoPickerSession.shared.activeDelegate`
// (a `weak` delegate slot), causing the first call's semaphore to block its
// tokio worker forever while the second call steals the delegate.
//
// To prevent this we guard with a `serialLock` NSLock + an `inFlight` Bool on
// the shared session singleton. A second call that arrives while a picker is
// open immediately returns an empty SRObjectArray (the same result the Rust
// side gets for "user cancelled"), so no tokio worker is ever left stranded.
// The lock is always released before entering the async/semaphore path so there
// is no deadlock risk.

import AppKit
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import PhotosUI
import SwiftRs
import UniformTypeIdentifiers

public class PickedPhoto: NSObject {
    var filename: SRString
    var data: SRData

    init(filename: SRString, data: SRData) {
        self.filename = filename
        self.data = data
        super.init()
    }
}

// Delegate keeps the picker alive and forwards results back via a semaphore.
// Must be retained for the lifetime of the modal; we stash it in
// `PhotoPickerSession.shared.activeDelegate` for the duration of one call.
/// Which top-level UTType the picker should target.
///
/// PHPicker only loads bytes if we hand it a concrete UTI; for video the
/// delegate walks a small precedence list (mp4 → mov → webm → movie) so
/// the original container survives the round-trip. Images path is unchanged
/// (heic → jpeg → image).
private enum PickerKind {
    case image
    case video
}

private final class PhotoPickerDelegate: NSObject, PHPickerViewControllerDelegate {
    let completion: ([PickedPhoto]) -> Void
    let kind: PickerKind
    private var hasCompleted = false
    // `lock` guards `hasCompleted` only — distinct from `PhotoPickerSession.serialLock`.
    private let lock = NSLock()

    init(kind: PickerKind, completion: @escaping ([PickedPhoto]) -> Void) {
        self.kind = kind
        self.completion = completion
        super.init()
    }

    private func finish(_ photos: [PickedPhoto]) {
        lock.lock()
        let alreadyFired = hasCompleted
        if !alreadyFired { hasCompleted = true }
        lock.unlock()
        guard !alreadyFired else { return }
        completion(photos)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        // Intentionally NOT calling `picker.dismiss(nil)` here.
        //
        // For our path-(B) presentation (picker hosted inside a wrapper
        // NSWindow + beginSheet on the host), `dismiss(nil)` perturbs the
        // host NSWindow's contentView origin — the symptom is a visible
        // shift of the entire WKWebView content upward after the sheet
        // closes (the Tauri title-bar area gets clipped). The sheet is
        // closed explicitly via `session.endSheetOnFinish` once results
        // are gathered; path-(A) would close it via the parent VC.
        _ = picker

        if results.isEmpty {
            finish([])
            return
        }

        // Load each item provider's data on the global queue, gather under a
        // serial lock, and finish once every callback has reported.
        let resultsLock = NSLock()
        var photos: [PickedPhoto] = []
        let group = DispatchGroup()

        for result in results {
            group.enter()
            let provider = result.itemProvider
            // Use `loadFileRepresentation` (not `loadDataRepresentation`) so
            // we receive the ORIGINAL file URL with full EXIF intact. The
            // data API transcodes HEIC→JPEG in some macOS versions and
            // strips date / GPS metadata, which silently breaks the
            // EntryDateSuggestionModal trigger downstream. The file API
            // also gives us the real filename + extension instead of
            // forcing a `.jpg` default.
            //
            // Pick the most specific type identifier the provider supports
            // so HEIC photos stay HEIC (the Rust EXIF reader handles both
            // JPEG and HEIF containers).
            let identifier: String = {
                switch self.kind {
                case .image:
                    if provider.hasItemConformingToTypeIdentifier(UTType.heic.identifier) {
                        return UTType.heic.identifier
                    }
                    if provider.hasItemConformingToTypeIdentifier(UTType.jpeg.identifier) {
                        return UTType.jpeg.identifier
                    }
                    return UTType.image.identifier
                case .video:
                    // Preserve the source container the way the image branch
                    // preserves HEIC: prefer mp4 → mov → webm → generic movie.
                    // `UTType.webm` exists on macOS 14+; fall back to the
                    // raw UTI string so the picker still works on earlier hosts.
                    if provider.hasItemConformingToTypeIdentifier(UTType.mpeg4Movie.identifier) {
                        return UTType.mpeg4Movie.identifier
                    }
                    if provider.hasItemConformingToTypeIdentifier(UTType.quickTimeMovie.identifier)
                    {
                        return UTType.quickTimeMovie.identifier
                    }
                    let webmId = "org.webmproject.webm"
                    if provider.hasItemConformingToTypeIdentifier(webmId) {
                        return webmId
                    }
                    return UTType.movie.identifier
                }
            }()
            provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, _ in
                defer { group.leave() }
                guard let url = url else { return }
                // The URL is a temp file managed by PHPicker; read its bytes
                // synchronously before the closure returns (PHPicker reclaims
                // the file once the callback exits).
                guard let data = try? Data(contentsOf: url) else { return }
                // Preserve the real filename + extension from the source
                // file so the Rust pipeline infers the right MIME type.
                let filename = url.lastPathComponent.isEmpty
                    ? (provider.suggestedName ?? "photo") + ".jpg"
                    : url.lastPathComponent
                let picked = PickedPhoto(
                    filename: SRString(filename),
                    data: SRData([UInt8](data))
                )
                resultsLock.lock()
                photos.append(picked)
                resultsLock.unlock()
            }
        }

        group.notify(queue: .global(qos: .userInitiated)) { [weak self] in
            self?.finish(photos)
        }
    }
}

// Single in-flight picker session. PHPicker is modal, and we serialise calls.
// `serialLock` + `inFlight` prevent re-entrant invocations from leaving a
// tokio worker permanently blocked on `semaphore.wait()`.
//
// `sheetWindow` + `endSheetOnFinish` are populated when we use the path-(B)
// `beginSheet` presentation (Tauri's NSWindow has no contentViewController);
// the delegate completion closure calls `endSheetOnFinish?()` so the sheet
// is torn down deterministically before the semaphore signals.
private final class PhotoPickerSession {
    static let shared = PhotoPickerSession()
    var activeDelegate: PhotoPickerDelegate?
    let serialLock = NSLock()
    var inFlight: Bool = false
    var sheetWindow: NSWindow?
    var endSheetOnFinish: (() -> Void)?
}

/// Shared picker entry-point used by both `xj_pick_photos` (images) and
/// `xj_pick_videos`. The two `@_cdecl` wrappers below just plug a `PickerKind`
/// + a PHPickerFilter in. Everything else — re-entrancy guard, sheet
/// presentation path A/B, semaphore wait — is identical.
private func runPicker(kind: PickerKind, filter: PHPickerFilter, limit: Int) -> SRObjectArray {
    // ── Re-entrancy guard ────────────────────────────────────────────────────
    // Acquire the session lock and check whether a picker is already open.
    // If so, decline immediately (return empty = "user cancelled" on Rust side).
    // The lock must be released before we enter the async/semaphore path.
    let session = PhotoPickerSession.shared
    session.serialLock.lock()
    if session.inFlight {
        session.serialLock.unlock()
        return SRObjectArray([PickedPhoto]())
    }
    session.inFlight = true
    session.serialLock.unlock()
    // ────────────────────────────────────────────────────────────────────────

    let semaphore = DispatchSemaphore(value: 0)
    var pickedPhotos: [PickedPhoto] = []

    DispatchQueue.main.async {
        let config = {
            var c = PHPickerConfiguration(photoLibrary: .shared())
            c.filter = filter
            // NOTE: PHPickerConfiguration.selectionLimit = 0 means *unlimited*,
            // not zero. We clamp to at least 1 so that a bug in the Rust caller
            // (e.g. passing 0 or a usize-to-Int overflow) never silently enables
            // unlimited selection.
            c.selectionLimit = max(1, limit)
            return c
        }()
        let picker = PHPickerViewController(configuration: config)

        let delegate = PhotoPickerDelegate(kind: kind) { photos in
            pickedPhotos = photos
            // Path (B) cleanup: end the sheet on the main thread so the host
            // window regains focus before the next picker can present.
            let endSheet = session.endSheetOnFinish
            DispatchQueue.main.async {
                endSheet?()
            }
            session.serialLock.lock()
            session.inFlight = false
            session.activeDelegate = nil
            session.endSheetOnFinish = nil
            session.serialLock.unlock()
            semaphore.signal()
        }
        picker.delegate = delegate
        session.activeDelegate = delegate

        // ── Presentation strategy ────────────────────────────────────────────
        //
        // Two ways to present a `PHPickerViewController` as a sheet on macOS:
        //
        //   (A) `parentVC.presentAsSheet(picker)` — requires the host window
        //       to expose a `contentViewController`. Tauri 2 nests the
        //       `WKWebView` directly in `NSWindow.contentView` (an NSView, not
        //       an NSViewController), so `contentViewController` is `nil` on
        //       the main window. Path (A) is therefore unavailable today.
        //
        //   (B) Wrap `picker.view` inside a fresh `NSWindow` and call
        //       `hostWindow.beginSheet(pickerWindow, completionHandler:)`.
        //       This works on any NSWindow without needing a parent VC. The
        //       sheet drops from the title bar the same way `presentAsSheet`
        //       would. The picker's content view is reused; PHPicker still
        //       owns its lifecycle (the delegate fires `didFinishPicking`,
        //       which calls `dismiss(nil)` — we map that into `endSheet`
        //       via a window controller below).
        //
        // We try (A) first to remain forward-compatible if a future Tauri
        // release introduces a real content VC, and fall back to (B).

        let hostWindow: NSWindow? = NSApp.mainWindow ?? NSApp.windows.first
        guard let host = hostWindow else {
            FileHandle.standardError.write(Data(
                "xj_pick_photos: no NSWindow available; cannot present picker\n".utf8
            ))
            session.serialLock.lock()
            session.inFlight = false
            session.activeDelegate = nil
            session.serialLock.unlock()
            semaphore.signal()
            return
        }

        if let hostVC = host.contentViewController {
            // Path (A): standard `presentAsSheet`.
            hostVC.presentAsSheet(picker)
        } else {
            // Path (B): wrap the picker in an NSWindow and beginSheet.
            //
            // No `.closable` in the styleMask — the wrapper window has no
            // title-bar close affordance, so the only way out is the
            // picker's own Cancel / Add buttons, which fire the delegate.
            // Without this, a user clicking the wrapper's red X would close
            // the sheet without ever invoking `didFinishPicking`, stranding
            // the tokio worker on its semaphore.
            let pickerWindow = NSWindow(contentViewController: picker)
            pickerWindow.styleMask = [.titled]
            // PHPicker has no useful intrinsic content size when hosted
            // outside its standard presentation flow — the wrapper would
            // otherwise default to ~250x150 and crop the grid + search bar.
            // Size to ~70% of the host window, clamped to PHPicker's
            // practical minimum (640x420 — empirically the smallest where
            // search bar + grid + Cancel/Add buttons all stay visible).
            let hostFrame = host.frame
            let targetWidth = max(640, min(hostFrame.width * 0.7, 960))
            let targetHeight = max(420, min(hostFrame.height * 0.7, 720))
            pickerWindow.setContentSize(NSSize(width: targetWidth, height: targetHeight))
            session.sheetWindow = pickerWindow
            host.beginSheet(pickerWindow) { _ in
                session.sheetWindow = nil
            }
            // PHPicker calls `dismiss(nil)` on itself in
            // `picker(_:didFinishPicking:)`, which is a no-op for a sheet
            // presented via `beginSheet`. The delegate's completion closure
            // (set when constructing PhotoPickerDelegate above) calls
            // `endSheetOnFinish` so the wrapper sheet drops in step with the
            // result delivery.
            session.endSheetOnFinish = { [weak host, weak pickerWindow] in
                guard let host = host, let pickerWindow = pickerWindow else { return }
                host.endSheet(pickerWindow)
            }
        }
    }

    semaphore.wait()
    return SRObjectArray(pickedPhotos)
}

@_cdecl("xj_pick_photos")
public func xj_pick_photos(limit: Int) -> SRObjectArray {
    return runPicker(kind: .image, filter: .images, limit: limit)
}

@_cdecl("xj_pick_videos")
public func xj_pick_videos(limit: Int) -> SRObjectArray {
    return runPicker(kind: .video, filter: .videos, limit: limit)
}

// ─── Video thumbnail extraction ─────────────────────────────────────────────
//
// Generate a JPEG poster frame for a video file on disk. Called by the Rust
// `save_media_to_media_dir` after the video bytes are written, so the
// attachment strip can render a tiny preview (~30-80 KB) instead of pulling
// the full clip through IPC just to mount a `<video preload="metadata">`.
//
// Uses AVAssetImageGenerator (frame 0, ≤512 px long edge) + CGImageDestination
// for JPEG encoding. ffmpeg-free; ships with macOS.

/// Build a JPEG `Data` blob ≤ `maxEdge` px on the longest side from a `CGImage`.
/// Returns `nil` if encoding fails (CGImageDestination misconfigured or OOM).
private func encodeJPEG(cgImage: CGImage, maxEdge: Int, quality: Double) -> Data? {
    // Scale: pick the longer dimension and downscale if it exceeds maxEdge.
    // CIImage + Lanczos would be slightly higher quality but requires CoreImage
    // setup. CGContext is sufficient for a poster frame at q=0.8.
    let srcWidth = cgImage.width
    let srcHeight = cgImage.height
    let longest = max(srcWidth, srcHeight)
    let scale: Double =
        longest > maxEdge
        ? Double(maxEdge) / Double(longest)
        : 1.0
    let dstWidth = Int((Double(srcWidth) * scale).rounded())
    let dstHeight = Int((Double(srcHeight) * scale).rounded())

    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard
        let ctx = CGContext(
            data: nil,
            width: max(1, dstWidth),
            height: max(1, dstHeight),
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        )
    else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: dstWidth, height: dstHeight))
    guard let scaled = ctx.makeImage() else { return nil }

    let output = NSMutableData()
    guard
        let dest = CGImageDestinationCreateWithData(
            output as CFMutableData,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        )
    else { return nil }
    let options: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
    CGImageDestinationAddImage(dest, scaled, options as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { return nil }
    return output as Data
}

/// Extract a JPEG poster frame from the video at `path`, downscaled to fit
/// within `maxEdge` px on the longest side. Returns empty `SRData` on any
/// failure (file missing, format unsupported by AVFoundation, generator error)
/// — the Rust side treats empty == "no thumbnail" the same way `image` crate
/// failures fall through to "no thumbnail" for unsupported image MIMEs.
///
/// Frame target: `kCMTimeZero`, with `requestedTimeToleranceBefore/After =
/// kCMTimePositiveInfinity` so AVFoundation can pick the nearest decodable
/// keyframe (much faster than forcing a strict seek + decode chain from t=0).
@_cdecl("xj_extract_video_thumbnail")
public func xj_extract_video_thumbnail(path: SRString, maxEdge: Int) -> SRData {
    let pathStr = path.toString()
    let url = URL(fileURLWithPath: pathStr)

    guard FileManager.default.fileExists(atPath: url.path) else {
        return SRData([UInt8]())
    }

    let asset = AVURLAsset(url: url)
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    // Loose tolerance — we want speed over exact-frame fidelity for a poster.
    generator.requestedTimeToleranceBefore = CMTime.positiveInfinity
    generator.requestedTimeToleranceAfter = CMTime.positiveInfinity

    let time = CMTime(seconds: 0, preferredTimescale: 600)
    let cgImage: CGImage
    do {
        // `copyCGImage(at:actualTime:)` expects `UnsafeMutablePointer<CMTime>?`;
        // we don't care about the actually-decoded time, so pass an explicit
        // typed nil rather than a bare `nil` (Swift can't infer the optional
        // type from context).
        let actualTime: UnsafeMutablePointer<CMTime>? = nil
        cgImage = try generator.copyCGImage(at: time, actualTime: actualTime)
    } catch {
        return SRData([UInt8]())
    }

    let clampedEdge = max(64, min(maxEdge, 4096))
    guard let jpegData = encodeJPEG(cgImage: cgImage, maxEdge: clampedEdge, quality: 0.8) else {
        return SRData([UInt8]())
    }

    return SRData([UInt8](jpegData))
}

/// Transcode/downscale the video at `inPath` into an H.264 + AAC `.mp4` at
/// `outPath` using `AVAssetExportSession` with the given `preset` name (one of
/// the `AVAssetExportPreset*` resolution presets, e.g. `AVAssetExportPreset960x540`).
/// VideoToolbox provides the H.264 encoder, so no codec is bundled and there is
/// no GPL / patent-royalty exposure for the app.
///
/// Returns `1` on a completed export, `0` on any failure (missing input,
/// invalid/incompatible preset, session init failure, export error). The Rust
/// side treats `0` as "keep the original bytes", mirroring how image
/// compression is opportunistic and never blocks an insert.
///
/// The export is asynchronous; we block the calling worker thread on a
/// `DispatchSemaphore` so the swift-rs FFI surface stays synchronous (the Rust
/// caller already runs this inside `spawn_blocking`).
@_cdecl("xj_transcode_video")
public func xj_transcode_video(inPath: SRString, outPath: SRString, preset: SRString) -> Int {
    let inStr = inPath.toString()
    let outStr = outPath.toString()
    let presetStr = preset.toString()
    let inURL = URL(fileURLWithPath: inStr)
    let outURL = URL(fileURLWithPath: outStr)

    guard FileManager.default.fileExists(atPath: inURL.path) else {
        return 0
    }

    let asset = AVURLAsset(url: inURL)

    // Only export with a preset AVFoundation reports as compatible with this
    // asset — an incompatible preset makes `exportAsynchronously` fail anyway,
    // but checking first lets us bail cleanly (Rust keeps the original).
    guard AVAssetExportSession.exportPresets(compatibleWith: asset).contains(presetStr) else {
        return 0
    }
    guard let session = AVAssetExportSession(asset: asset, presetName: presetStr) else {
        return 0
    }

    // `exportAsynchronously` refuses to overwrite an existing file.
    try? FileManager.default.removeItem(at: outURL)

    session.outputURL = outURL
    session.outputFileType = .mp4
    session.shouldOptimizeForNetworkUse = true

    let semaphore = DispatchSemaphore(value: 0)
    session.exportAsynchronously {
        semaphore.signal()
    }
    semaphore.wait()

    if session.status == .completed {
        return 1
    }
    // Best-effort cleanup of a partial/failed output so no orphan lingers.
    try? FileManager.default.removeItem(at: outURL)
    return 0
}
