//! Per-platform `llama-server` binary catalog (Phase 1 Task 3).
//!
//! This is the backend source of truth for the on-device LLM **sidecar
//! binary** — the `llama-server` executable from llama.cpp that the
//! OpenAI-compatible HTTP boundary (`OpenAICompatibleProvider` against
//! `http://127.0.0.1:{port}/v1`) talks to. Unlike [`super::llm_catalog`]
//! (the GGUF weights), this catalog pins the *binary* per (os, arch) so the
//! JIT downloader can fetch the right prebuilt archive, verify its SHA-256,
//! and extract `llama-server` into a versioned install dir.
//!
//! # Pinning policy
//!
//! - [`SERVER_VERSION_TAG`] is a **single** pinned llama.cpp release tag,
//!   hardcoded from `https://api.github.com/repos/ggml-org/llama.cpp/releases/latest`
//!   at pin time. It is baked into both the asset URLs and the install dir
//!   name (`{app_data}/on-device-llm/bin/{SERVER_VERSION_TAG}/llama-server`),
//!   so a tag bump re-downloads cleanly into a fresh dir instead of
//!   overwriting a live binary.
//! - Every `sha256` below is the per-asset digest published on the GitHub
//!   release (the `digest` field on each release asset), cross-validated at
//!   pin time by re-downloading the asset and matching `shasum -a 256` for
//!   every platform whose CDN was reachable (3 of 4 matched byte-for-byte;
//!   the 4th uses the published digest, which matched for the other 3).
//! - Asset names use llama.cpp's actual release naming: the macOS/Linux
//!   builds are `.tar.gz` with a top-level `llama-b<tag>/` dir; Windows is a
//!   flat `.zip` (`llama-server.exe` at the archive root).
//! - Extraction strategy is encoded per-asset in [`ServerBinaryAsset::archive_member`],
//!   which is `None` for **every** platform — all four archives are extracted
//!   whole into `bin/{SERVER_VERSION_TAG}/`. On Windows the `llama-server.exe`
//!   is a thin (~9 KB) launcher shim that depends on a large DLL bundle
//!   shipped alongside it in the same flat archive (`llama-server-impl.dll`,
//!   `llama.dll`, `ggml-base.dll`, the `ggml-cpu-*.dll` variants,
//!   `libomp140.x86_64.dll`, `mtmd.dll`, ...). On macOS/Linux `llama-server`
//!   is likewise dynamically linked against companion shared libraries
//!   shipped in the same archive dir (`libllama.dylib`/`.so`,
//!   `libggml.dylib`/`.so`, `libggml-base`, `libggml-cpu`, `libmtmd`, ...).
//!   Extracting only the binary on either platform would leave dyld/ld.so
//!   unable to find those libs and the process would die on launch before
//!   `/health` ever answers. macOS/Linux archives additionally have a
//!   top-level `llama-<tag>/` dir the extractor strips so every file (binary
//!   + libs) lands flat in the install dir, same as the already-flat Windows
//!   zip.
//!
//! # Why CPU-only Windows / generic Linux
//!
//! The catalog pins one asset per supported (os, arch) — the **CPU** build.
//! GPU-accelerated variants (cuda-12.4, vulkan, rocm, sycl, openvino) exist
//! on the release but require host GPU drivers/CUDA runtimes the app can't
//! assume. CPU builds run everywhere; a future GPU-autoselect tier can layer
//! on top without changing this catalog's shape.

/// The pinned llama.cpp release tag this catalog points at. Baked into both
/// the asset URLs and the on-disk install dir name so upgrades re-download
/// into a fresh dir. Sourced from the GitHub releases `latest` endpoint at
/// pin time — do NOT change without re-verifying every `sha256` below.
pub const SERVER_VERSION_TAG: &str = "b10107";

/// One pinned `llama-server` prebuilt release asset for a single (os, arch).
///
/// Mirrors the static-slice + `&'static str` style of [`super::catalog`] /
/// [`super::llm_catalog`]: every field is a `'static` so the catalog is a
/// plain const-construction with no allocations, and lookups return borrowed
/// references.
#[derive(Debug, Clone, PartialEq)]
pub struct ServerBinaryAsset {
    /// `std::env::consts::OS` value: `"macos"` | `"windows"` | `"linux"`.
    pub os: &'static str,
    /// `std::env::consts::ARCH` value: `"aarch64"` | `"x86_64"`.
    pub arch: &'static str,
    /// Full GitHub release download URL for the prebuilt archive. Starts with
    /// `https://github.com/ggml-org/llama.cpp/releases/download/` and contains
    /// [`SERVER_VERSION_TAG`] (both enforced by tests).
    pub asset_url: &'static str,
    /// Lowercase hex SHA-256 of the downloaded archive bytes (64 chars,
    /// validated by tests). The downloader rejects any fetched archive whose
    /// SHA-256 doesn't match, so a re-built release can't ship unverified.
    pub sha256: &'static str,
    /// Extraction directive for the downloader. Always `None` — every
    /// platform's `llama-server`/`llama-server.exe` is dynamically linked
    /// against companion shared libraries shipped in the same archive, so the
    /// **entire** archive is extracted into the install dir:
    /// - Windows `.zip` is already flat — `llama-server.exe` needs the
    ///   companion DLLs (`llama.dll`, `ggml-base.dll`, ...) shipped alongside
    ///   it at the archive root.
    /// - macOS/Linux `.tar.gz` has a top-level `llama-<tag>/` dir that the
    ///   extractor strips so `llama-server` and its companion
    ///   `.dylib`/`.so` files (`libllama`, `libggml`, `libggml-cpu`,
    ///   `libmtmd`, ...) land flat in the install dir, right where dyld /
    ///   ld.so's `@rpath`/`RPATH` lookup expects them.
    ///
    /// Kept as an `Option` (rather than removed) so a future asset that truly
    /// is a standalone single-file binary can opt back into single-member
    /// extraction without a struct shape change.
    pub archive_member: Option<&'static str>,
    /// Human-readable label for the install UI, e.g. `"macOS (Apple Silicon)"`.
    pub display_name: &'static str,
}

/// The full per-platform catalog, covering the four supported (os, arch)
/// combos: macos-aarch64, macos-x86_64, windows-x86_64, linux-x86_64.
pub const CATALOG: &[ServerBinaryAsset] = &[
    // macOS (Apple Silicon). Archive layout: llama-b10107/{llama-server,
    // lib*.dylib}. Whole-archive extraction (with top-dir strip) — see
    // ServerBinaryAsset::archive_member doc.
    ServerBinaryAsset {
        os: "macos",
        arch: "aarch64",
        asset_url: "https://github.com/ggml-org/llama.cpp/releases/download/b10107/llama-b10107-bin-macos-arm64.tar.gz",
        sha256: "b9554ab4c9f6e91199f48387cb4ab27466fb1d724881f81463ef03f6370cfa32",
        archive_member: None,
        display_name: "macOS (Apple Silicon)",
    },
    // macOS (Intel). Same archive layout as arm64.
    ServerBinaryAsset {
        os: "macos",
        arch: "x86_64",
        asset_url: "https://github.com/ggml-org/llama.cpp/releases/download/b10107/llama-b10107-bin-macos-x64.tar.gz",
        // Byte-reverified 2026-07-27: downloaded llama-b10107-bin-macos-x64.tar.gz
        // and matched `shasum -a 256` to this pin (same as the GitHub release digest).
        sha256: "6f35c90a6e9f33c905d09694946b82a29b4ab530a358226d95d832262f526ea2",
        archive_member: None,
        display_name: "macOS (Intel)",
    },
    // Windows x64 (CPU build — see module doc on GPU variants). Flat zip:
    // llama-server.exe sits at the archive root alongside its companion DLLs
    // (the .exe is a thin launcher shim, NOT standalone). archive_member is
    // None → the whole archive is extracted into bin/{SERVER_VERSION_TAG}/ so
    // the .exe finds its DLLs in the same dir.
    ServerBinaryAsset {
        os: "windows",
        arch: "x86_64",
        asset_url: "https://github.com/ggml-org/llama.cpp/releases/download/b10107/llama-b10107-bin-win-cpu-x64.zip",
        sha256: "52133a0a5a8f6035b1bdd2f89c3425ea8b742413d9bdb9a2dee30e3a1681b18c",
        archive_member: None,
        display_name: "Windows (x64)",
    },
    // Linux x64 (Ubuntu CPU build). Same tar.gz layout as macOS.
    ServerBinaryAsset {
        os: "linux",
        arch: "x86_64",
        asset_url: "https://github.com/ggml-org/llama.cpp/releases/download/b10107/llama-b10107-bin-ubuntu-x64.tar.gz",
        sha256: "afe1ae0b706c4a0830b218a9249037b7a6cc723f81deb78825662128b25453e6",
        archive_member: None,
        display_name: "Linux (x64)",
    },
];

/// Find the catalog asset for a given (`os`, `arch`) pair, using the same
/// string values `std::env::consts::{OS, ARCH}` produce. Returns `None` for
/// unsupported combos.
pub fn find_asset(os: &str, arch: &str) -> Option<&'static ServerBinaryAsset> {
    CATALOG.iter().find(|a| a.os == os && a.arch == arch)
}

/// Resolve the catalog asset for the **current host** (`std::env::consts::OS`
/// / `ARCH`). Returns `Err` with a descriptive message when the host isn't one
/// of the four supported combos.
pub fn current_platform_asset() -> Result<&'static ServerBinaryAsset, String> {
    match find_asset(std::env::consts::OS, std::env::consts::ARCH) {
        Some(a) => Ok(a),
        None => Err(format!(
            "no llama-server asset for os={} arch={}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The four (os, arch) combos this catalog must cover.
    const EXPECTED_COMBOS: &[(&str, &str)] = &[
        ("macos", "aarch64"),
        ("macos", "x86_64"),
        ("windows", "x86_64"),
        ("linux", "x86_64"),
    ];

    #[test]
    fn catalog_has_exactly_one_asset_per_supported_combo() {
        for &(os, arch) in EXPECTED_COMBOS {
            let matches: Vec<&ServerBinaryAsset> = CATALOG
                .iter()
                .filter(|a| a.os == os && a.arch == arch)
                .collect();
            assert_eq!(
                matches.len(),
                1,
                "expected exactly one asset for (os={os}, arch={arch}), found {}: {:?}",
                matches.len(),
                matches
            );
        }
    }

    #[test]
    fn catalog_has_no_unsupported_combos() {
        for a in CATALOG {
            let is_supported = EXPECTED_COMBOS.contains(&(a.os, a.arch));
            assert!(
                is_supported,
                "catalog contains unsupported combo (os={}, arch={}); only {:?} are allowed",
                a.os, a.arch, EXPECTED_COMBOS
            );
        }
    }

    #[test]
    fn every_sha256_is_64_lowercase_hex_chars() {
        let hex = |b: u8| matches!(b, b'0'..=b'9' | b'a'..=b'f');
        for a in CATALOG {
            assert_eq!(
                a.sha256.len(),
                64,
                "(os={}, arch={}) sha256 must be 64 chars, got {}",
                a.os,
                a.arch,
                a.sha256.len()
            );
            assert!(
                a.sha256.bytes().all(hex),
                "(os={}, arch={}) sha256 must be lowercase hex [0-9a-f], got {:?}",
                a.os,
                a.arch,
                a.sha256
            );
        }
    }

    #[test]
    fn every_asset_url_is_a_github_release_download_url_for_the_pinned_tag() {
        let prefix = "https://github.com/ggml-org/llama.cpp/releases/download/";
        for a in CATALOG {
            assert!(
                a.asset_url.starts_with(prefix),
                "(os={}, arch={}) asset_url must start with {prefix}, got {}",
                a.os,
                a.arch,
                a.asset_url
            );
            assert!(
                a.asset_url.contains(SERVER_VERSION_TAG),
                "(os={}, arch={}) asset_url must contain SERVER_VERSION_TAG {:?}, got {}",
                a.os,
                a.arch,
                SERVER_VERSION_TAG,
                a.asset_url
            );
        }
    }

    #[test]
    fn every_asset_uses_whole_archive_extraction() {
        // All four platforms extract the whole archive — macOS/Linux
        // `llama-server` is dynamically linked against companion .dylib/.so
        // libraries shipped in the same archive, exactly like Windows'
        // llama-server.exe + DLL bundle. archive_member must be None
        // everywhere so extract_member() takes the whole-archive path instead
        // of pulling out a single (now-broken-without-its-libs) member.
        for a in CATALOG {
            assert!(
                a.archive_member.is_none(),
                "(os={}, arch={}) must use whole-archive extraction (archive_member = None), got {:?}",
                a.os,
                a.arch,
                a.archive_member
            );
        }
    }

    #[test]
    fn macos_and_linux_are_tar_gz_windows_is_zip() {
        // The extractor picks tar.gz vs zip handling from the archive
        // filename — lock the per-os archive format so a catalog edit can't
        // silently swap one platform onto the wrong extractor.
        for a in CATALOG {
            let expected_suffix = if a.os == "windows" { ".zip" } else { ".tar.gz" };
            assert!(
                a.asset_url.ends_with(expected_suffix),
                "(os={}, arch={}) asset_url must end with {expected_suffix:?}, got {}",
                a.os,
                a.arch,
                a.asset_url
            );
        }
    }

    #[test]
    fn every_display_name_is_non_empty() {
        for a in CATALOG {
            assert!(
                !a.display_name.is_empty(),
                "(os={}, arch={}) display_name must be non-empty",
                a.os,
                a.arch
            );
        }
    }

    #[test]
    fn current_platform_asset_resolves_on_the_test_host() {
        // The CI/test host is one of the four supported combos, so this must
        // resolve to Ok and the os field must match the host OS.
        let asset = current_platform_asset().expect(
            "current_platform_asset() must resolve on a supported test host \
             (one of macos-aarch64, macos-x86_64, windows-x86_64, linux-x86_64)",
        );
        assert_eq!(
            asset.os,
            std::env::consts::OS,
            "resolved asset os must match host OS"
        );
        assert_eq!(
            asset.arch,
            std::env::consts::ARCH,
            "resolved asset arch must match host ARCH"
        );
    }

    #[test]
    fn find_asset_returns_none_for_an_unsupported_combo() {
        // freebsd isn't in the catalog — simulate an unsupported host directly
        // via the find_asset helper rather than trying to spoof std::env.
        assert!(find_asset("freebsd", "x86_64").is_none());
        assert!(find_asset("linux", "aarch64").is_none());
        assert!(find_asset("", "").is_none());
    }

    #[test]
    fn server_version_tag_is_a_non_empty_release_tag() {
        assert!(
            !SERVER_VERSION_TAG.is_empty(),
            "SERVER_VERSION_TAG must be pinned, not empty"
        );
        assert!(
            SERVER_VERSION_TAG.starts_with('b') || SERVER_VERSION_TAG.starts_with('v'),
            "SERVER_VERSION_TAG {SERVER_VERSION_TAG:?} should be a llama.cpp release tag \
             (e.g. b1234 or v0.9.0)"
        );
    }
}
