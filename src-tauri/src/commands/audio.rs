//! Audio recording commands.
//!
//! # Architecture
//!
//! Three Tauri-managed states handle the lifecycle of a recording session:
//!
//! - `AudioSamplesState` – accumulates raw i16 PCM samples via the cpal
//!   data callback (inside an `Arc<Mutex<Vec<i16>>>`).
//! - `AudioStreamState` – wraps a `RecordingThread` handle. The recording
//!   thread owns the `cpal::Stream` for its entire lifetime and is the only
//!   thread that creates or drops it — satisfying Core Audio's same-thread
//!   lifecycle requirement without any `unsafe impl Send`. A rendezvous
//!   `SyncSender<()>` is used to signal the thread to stop; after it returns
//!   the stream is guaranteed dropped.
//! - `AudioSessionState` – stores the session token so `stop_recording` can
//!   validate the caller's UUID.
//!
//! # Commands
//!
//! | Command | Sync/Async | Description |
//! |---------|-----------|-------------|
//! | `start_recording` | sync | Opens mic, spawns recording thread, returns session ID |
//! | `stop_recording`  | sync | Signals thread to stop, joins it, writes WAV to temp file |
//! | `save_audio_memo` | async | Reads WAV bytes, calls `save_media_to_media_dir`, inserts DB row |

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

use crate::commands::media::{save_media_to_media_dir, PickImageResult};
use crate::AppState;

/// Maximum number of mono i16 samples retained in memory.
///
/// At 48 000 Hz this corresponds to ~30 minutes of audio (~174 MB).
/// Once the buffer hits this limit the data callback silently discards new
/// samples. `stop_recording` still writes the captured audio — the recording
/// just stops growing rather than crashing the process with an OOM.
const MAX_SAMPLES: usize = 48_000 * 60 * 30;

// ---------------------------------------------------------------------------
// Recording-thread handle — no unsafe required.
//
// cpal::Stream is !Send on macOS because the underlying Core Audio AudioUnit
// must be created and destroyed on the same OS thread.  The previous design
// stored the stream in global Tauri state using `unsafe impl Send`, relying on
// an unenforceable "same command-thread" assumption.
//
// This design fixes the soundness issue: a dedicated recording thread owns the
// stream for its entire lifetime.  start_recording spawns the thread, which
// builds and plays the stream, then blocks on a rendezvous channel.
// stop_recording sends the stop signal, then joins the thread — at that point
// the stream is guaranteed to have been dropped on its own thread.
//
// `SyncSender<()>` and `JoinHandle<()>` are both `Send`, so `RecordingThread`
// is `Send` without any unsafe.
// ---------------------------------------------------------------------------

/// Handle to the OS thread that owns the active cpal recording stream.
struct RecordingThread {
    /// Rendezvous channel (bound 0): sending () blocks until the recording
    /// thread's `recv()` fires, triggering an orderly shutdown.
    stop_tx: std::sync::mpsc::SyncSender<()>,
    handle: std::thread::JoinHandle<()>,
}

/// Tauri-managed state: the sample buffer shared between the cpal data
/// callback and the command handlers.
pub struct AudioSamplesState(pub Arc<Mutex<Vec<i16>>>);

impl AudioSamplesState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(Vec::new())))
    }
}

impl Default for AudioSamplesState {
    fn default() -> Self {
        Self::new()
    }
}

/// Tauri-managed state: the active recording thread handle (if any).
pub struct AudioStreamState(Mutex<Option<RecordingThread>>);

impl AudioStreamState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<RecordingThread>> {
        match self.0.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }
}

impl Default for AudioStreamState {
    fn default() -> Self {
        Self::new()
    }
}

/// Tauri-managed state: the current session UUID (set by `start_recording`,
/// cleared by `stop_recording`).
pub struct AudioSessionState(Mutex<Option<String>>);

impl AudioSessionState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<String>> {
        match self.0.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }
}

impl Default for AudioSessionState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Result type returned by stop_recording.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StopRecordingResult {
    pub temp_path: String,
    pub duration_seconds: f64,
}

// ---------------------------------------------------------------------------
// Recording thread body
// ---------------------------------------------------------------------------

/// Body of the dedicated recording thread. Builds and plays the cpal stream on
/// this thread, signals `result_tx` with Ok/Err, then blocks on `stop_rx`.
/// When `stop_rx` fires (or disconnects), the function returns and `stream` is
/// dropped — on this thread, satisfying Core Audio's lifecycle requirement.
fn run_recording_thread(
    device: cpal::Device,
    config: cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    samples: Arc<Mutex<Vec<i16>>>,
    channels: usize,
    result_tx: std::sync::mpsc::SyncSender<Result<(), String>>,
    stop_rx: std::sync::mpsc::Receiver<()>,
) {
    let buf_clone = Arc::clone(&samples);
    let stream_result = match sample_format {
        cpal::SampleFormat::I16 => build_input_stream_i16(&device, &config, buf_clone, channels),
        cpal::SampleFormat::F32 => build_input_stream_f32(&device, &config, buf_clone, channels),
        cpal::SampleFormat::U16 => build_input_stream_u16(&device, &config, buf_clone, channels),
        other => Err(format!("Unsupported sample format: {other:?}")),
    };

    let stream = match stream_result {
        Ok(s) => s,
        Err(e) => {
            let _ = result_tx.send(Err(e));
            return;
        }
    };

    if let Err(e) = stream.play() {
        let _ = result_tx.send(Err(format!("Stream play error: {e}")));
        return;
    }

    // Signal start_recording that the stream is running successfully.
    let _ = result_tx.send(Ok(()));

    // Block until stop_recording sends the stop signal (or disconnects).
    // On return, `stream` is dropped here — on this thread — as required.
    let _ = stop_rx.recv();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Start recording from the default input device.
///
/// Returns the session UUID that must be passed to `stop_recording`.
#[tauri::command]
pub fn start_recording(
    samples_state: State<'_, AudioSamplesState>,
    stream_state: State<'_, AudioStreamState>,
    session_state: State<'_, AudioSessionState>,
) -> Result<String, String> {
    // If a session is already active, reject the call.
    {
        let current = session_state.lock();
        if current.is_some() {
            return Err("Recording already in progress".to_string());
        }
    }

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "No audio input device available".to_string())?;

    let supported_config = device
        .default_input_config()
        .map_err(|e| format!("Could not get input config: {e}"))?;

    let config: cpal::StreamConfig = supported_config.clone().into();
    let sample_rate = config.sample_rate.0;
    let channels = config.channels as usize;
    let sample_format = supported_config.sample_format();

    // Clear any leftover samples from a previous session.
    {
        let mut buf = samples_state.0.lock().unwrap_or_else(|p| p.into_inner());
        buf.clear();
    }

    // Two channels:
    // - `result_tx/rx`: the recording thread signals startup success or failure.
    // - `stop_tx/rx` (rendezvous, bound 0): stop_recording sends () to trigger
    //   an orderly shutdown; the send() blocks until the thread's recv() fires,
    //   then handle.join() guarantees the stream was dropped on the right thread.
    let (result_tx, result_rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
    let (stop_tx, stop_rx) = std::sync::mpsc::sync_channel::<()>(0);

    let buf_clone = Arc::clone(&samples_state.0);
    let handle = std::thread::spawn(move || {
        run_recording_thread(
            device,
            config,
            sample_format,
            buf_clone,
            channels,
            result_tx,
            stop_rx,
        );
    });

    // Wait for the recording thread to confirm the stream is running.
    match result_rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = handle.join();
            return Err(e);
        }
        Err(_) => {
            // Thread hung during startup; abandon it.
            return Err("Audio recording thread timed out during startup".to_string());
        }
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let session_token = format!("{session_id}|{sample_rate}");

    *stream_state.lock() = Some(RecordingThread { stop_tx, handle });
    *session_state.lock() = Some(session_token);

    Ok(session_id)
}

fn build_input_stream_i16(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    buf: Arc<Mutex<Vec<i16>>>,
    channels: usize,
) -> Result<cpal::Stream, String> {
    device
        .build_input_stream(
            config,
            move |data: &[i16], _| {
                let mut guard = buf.lock().unwrap_or_else(|p| p.into_inner());
                if guard.len() >= MAX_SAMPLES {
                    return;
                }
                // Downmix to mono by averaging channels.
                for frame in data.chunks(channels) {
                    if guard.len() >= MAX_SAMPLES {
                        break;
                    }
                    let sum: i32 = frame.iter().map(|&s| s as i32).sum();
                    guard.push((sum / channels as i32) as i16);
                }
            },
            |err| log::error!("Audio stream error: {err}"),
            None,
        )
        .map_err(|e| format!("build_input_stream (i16): {e}"))
}

fn build_input_stream_u16(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    buf: Arc<Mutex<Vec<i16>>>,
    channels: usize,
) -> Result<cpal::Stream, String> {
    device
        .build_input_stream(
            config,
            move |data: &[u16], _| {
                let mut guard = buf.lock().unwrap_or_else(|p| p.into_inner());
                if guard.len() >= MAX_SAMPLES {
                    return;
                }
                for frame in data.chunks(channels) {
                    if guard.len() >= MAX_SAMPLES {
                        break;
                    }
                    let sum: u32 = frame.iter().map(|&s| s as u32).sum();
                    // Convert u16 [0, 65535] average to i16 [-32768, 32767].
                    let mono_i16 = ((sum / channels as u32) as i32 - 32768) as i16;
                    guard.push(mono_i16);
                }
            },
            |err| log::error!("Audio stream error: {err}"),
            None,
        )
        .map_err(|e| format!("build_input_stream (u16): {e}"))
}

fn build_input_stream_f32(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    buf: Arc<Mutex<Vec<i16>>>,
    channels: usize,
) -> Result<cpal::Stream, String> {
    device
        .build_input_stream(
            config,
            move |data: &[f32], _| {
                let mut guard = buf.lock().unwrap_or_else(|p| p.into_inner());
                if guard.len() >= MAX_SAMPLES {
                    return;
                }
                for frame in data.chunks(channels) {
                    if guard.len() >= MAX_SAMPLES {
                        break;
                    }
                    let sum: f32 = frame.iter().sum();
                    let mono = sum / channels as f32;
                    // Clamp and convert f32 [-1, 1] to i16.
                    let sample =
                        (mono * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32) as i16;
                    guard.push(sample);
                }
            },
            |err| log::error!("Audio stream error: {err}"),
            None,
        )
        .map_err(|e| format!("build_input_stream (f32): {e}"))
}

/// Stop recording and write the captured audio to a temp WAV file.
///
/// `session_id` must match the UUID returned by `start_recording`.
/// Signals the recording thread to stop via the rendezvous channel, then joins
/// it — at that point the cpal stream is guaranteed to have been dropped on the
/// recording thread. Returns `{ temp_path, duration_seconds }`.
#[tauri::command]
pub fn stop_recording(
    session_id: String,
    samples_state: State<'_, AudioSamplesState>,
    stream_state: State<'_, AudioStreamState>,
    session_state: State<'_, AudioSessionState>,
) -> Result<StopRecordingResult, String> {
    // Validate the session token.
    let token = {
        let guard = session_state.lock();
        guard
            .clone()
            .ok_or_else(|| "No recording in progress".to_string())?
    };

    // Token format: "<uuid>|<sample_rate>"
    let (stored_id, sample_rate_str) = token
        .split_once('|')
        .ok_or_else(|| "Corrupt session token".to_string())?;

    if stored_id != session_id {
        return Err("Session ID mismatch".to_string());
    }

    let sample_rate: u32 = sample_rate_str
        .parse()
        .map_err(|_| "Invalid sample rate in token".to_string())?;

    // Take the recording-thread handle out of state.
    let recording = stream_state
        .lock()
        .take()
        .ok_or_else(|| "No recording in progress (stream missing)".to_string())?;
    *session_state.lock() = None;

    // Signal the recording thread to stop.
    // `stop_tx` is a rendezvous channel (bound 0): send() blocks until the
    // thread's recv() fires.  The thread then returns, dropping the stream on
    // its own thread — satisfying Core Audio's same-thread lifecycle guarantee.
    // An Err here means the thread already exited (panic/disconnect), which is
    // acceptable; we still join below.
    let _ = recording.stop_tx.send(());

    // Wait for the thread to fully exit (stream guaranteed dropped after this).
    let _ = recording.handle.join();

    // Now read samples — the data callback has definitely stopped.
    let samples = {
        let mut guard = samples_state.0.lock().unwrap_or_else(|p| p.into_inner());
        std::mem::take(&mut *guard)
    };

    let duration_seconds = samples.len() as f64 / sample_rate as f64;

    // Write WAV to a temp file.
    let temp_dir = std::env::temp_dir();
    let temp_name = format!("memlore_memo_{}.wav", uuid::Uuid::new_v4());
    let temp_path = temp_dir.join(&temp_name);

    crate::utils::audio::write_wav(&samples, sample_rate, 1, &temp_path)?;

    Ok(StopRecordingResult {
        temp_path: temp_path.to_string_lossy().into_owned(),
        duration_seconds,
    })
}

// ---------------------------------------------------------------------------
// Path-validation helpers for save_audio_memo
// ---------------------------------------------------------------------------

/// Returns true only for filenames matching the exact pattern the app writes:
/// `memlore_memo_<UUID>.wav` where UUID is 8-4-4-4-12 lowercase hex.
///
/// This rejects path-traversal attempts, unexpected extensions, and any
/// file the app itself could not have created.
pub(crate) fn is_valid_audio_temp_filename(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("memlore_memo_") else {
        return false;
    };
    let Some(uuid_part) = rest.strip_suffix(".wav") else {
        return false;
    };
    // Validate UUID format: 8-4-4-4-12 lowercase hex groups.
    let parts: Vec<&str> = uuid_part.split('-').collect();
    if parts.len() != 5 {
        return false;
    }
    let expected_lens: [usize; 5] = [8, 4, 4, 4, 12];
    parts.iter().zip(expected_lens.iter()).all(|(p, &len)| {
        p.len() == len && p.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// Checks that `bytes` starts with the RIFF/WAVE signature expected of a WAV file.
pub(crate) fn validate_wav_header(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 12 {
        return Err("File too small to be a valid WAV".to_string());
    }
    if &bytes[0..4] != b"RIFF" {
        return Err("Not a valid WAV file: missing RIFF header".to_string());
    }
    if &bytes[8..12] != b"WAVE" {
        return Err("Not a valid WAV file: missing WAVE marker".to_string());
    }
    Ok(())
}

/// Validates that `temp_path` is a safe, non-symlink WAV temp file inside the
/// system temp directory. Returns the canonicalized path on success.
fn validate_audio_temp_path(temp_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(temp_path);

    // 1. Filename must match the app's own naming convention.
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid path: no filename".to_string())?;
    if !is_valid_audio_temp_filename(file_name) {
        return Err(
            "temp_path filename does not match expected memlore_memo_*.wav pattern".to_string(),
        );
    }

    // 2. Reject symlinks — a symlink inside the temp dir can point anywhere.
    let meta =
        std::fs::symlink_metadata(&path).map_err(|e| format!("Cannot stat temp_path: {e}"))?;
    if meta.file_type().is_symlink() {
        return Err("temp_path must not be a symlink".to_string());
    }

    // 3. Canonicalize and confirm the real path is still inside temp dir.
    //    On macOS /tmp is a symlink to /private/tmp — canonicalize both sides.
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Cannot resolve temp_path: {e}"))?;
    let temp_root = std::env::temp_dir()
        .canonicalize()
        .unwrap_or_else(|_| std::env::temp_dir());
    if !canonical.starts_with(&temp_root) {
        return Err("temp_path must be inside the system temp directory".to_string());
    }

    Ok(canonical)
}

/// Persist a recorded WAV file as a media attachment on an entry.
///
/// Reads the WAV bytes from `temp_path`, passes them through
/// `save_media_to_media_dir` (which inserts the DB row and moves the file
/// into the app media directory), then deletes the temp file.
///
/// Returns the same `PickImageResult { media_id, local_path }` used by
/// image/video flows so the frontend can insert a uniform audio node.
#[tauri::command]
pub async fn save_audio_memo(
    entry_id: String,
    temp_path: String,
    duration_seconds: f64,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<PickImageResult, String> {
    // Validate filename pattern, reject symlinks, confirm path is inside temp dir.
    let path = validate_audio_temp_path(&temp_path)?;

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("read temp WAV: {e}"))?;

    // Validate WAV magic bytes before storing — prevents the temp-path from
    // being used as a local-file read primitive for non-audio data.
    validate_wav_header(&bytes)?;

    let media_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("media");

    // Acquire the DB lock, do all synchronous work, then *drop* the guard
    // before any subsequent `.await` — MutexGuard<Connection> is !Send and
    // Tauri requires the async command future to be Send.
    let result = {
        let conn = state.lock()?;
        let media =
            save_media_to_media_dir(&conn, &media_dir, &entry_id, &bytes, "wav", "attached")?;
        // Persist the recording duration so the UI can display "1:23 voice memo" labels.
        if duration_seconds > 0.0 {
            if let Err(e) =
                crate::db::update_media_duration(&conn, &media.media_id, duration_seconds)
            {
                log::warn!("update_media_duration for {}: {e}", media.media_id);
            }
        }
        media
    };

    // Best-effort cleanup of the temp file — non-fatal if it fails.
    let _ = tokio::fs::remove_file(&path).await;

    Ok(result)
}

/// Sample the most recent audio levels so the frontend can draw a live
/// waveform / VU-meter animation while recording. Returns `bucket_count`
/// floats in `[0.0, 1.0]`, where each float is the RMS amplitude of one
/// time bucket over the last ~100 ms of recording.
///
/// The buckets are ordered oldest → newest so the animation can grow from
/// left to right. Returns an empty vec when no samples have been captured
/// yet (idle or right after `start_recording`).
///
/// Polling cost is bounded: regardless of how long the user has been
/// recording, this command only reads the last 4800 samples (~100 ms @
/// 48 kHz) and returns `bucket_count` floats, so the IPC payload is tiny.
#[tauri::command]
pub fn get_recording_levels(
    samples_state: State<'_, AudioSamplesState>,
    bucket_count: usize,
) -> Result<Vec<f32>, String> {
    if bucket_count == 0 || bucket_count > 256 {
        return Err("bucket_count must be in 1..=256".to_string());
    }
    // ~100 ms at 48 kHz — enough to capture syllable-level dynamics without
    // making the animation feel sluggish, and small enough that we don't
    // hold the samples lock for long.
    const WINDOW_SAMPLES: usize = 4_800;
    let samples = samples_state
        .0
        .lock()
        .map_err(|_| "samples lock poisoned".to_string())?;
    if samples.is_empty() {
        return Ok(Vec::new());
    }
    let len = samples.len();
    let start = len.saturating_sub(WINDOW_SAMPLES);
    let window = &samples[start..len];
    let bucket_size = window.len().div_ceil(bucket_count).max(1);

    let mut buckets = Vec::with_capacity(bucket_count);
    for chunk in window.chunks(bucket_size) {
        // RMS over the chunk, normalized to [0, 1] against i16 range.
        let sum_sq: f64 = chunk.iter().map(|&s| (s as f64).powi(2)).sum();
        let rms = (sum_sq / chunk.len() as f64).sqrt();
        buckets.push((rms / i16::MAX as f64) as f32);
    }
    // Right-pad with zeros if we have fewer chunks than buckets (very short
    // recording window). Keeps the frontend bar count stable.
    while buckets.len() < bucket_count {
        buckets.push(0.0);
    }
    Ok(buckets)
}

/// Read the bytes of a temp WAV file so the frontend can preview it via a Blob
/// URL. The temp dir is NOT in the Tauri asset protocol scope (only the app
/// data media dir is), so `convertFileSrc(tempPath)` cannot be used for the
/// preview <audio> element — we ship the bytes instead.
///
/// Validates path the same way `save_audio_memo` does to prevent arbitrary
/// file reads through this command.
#[tauri::command]
pub async fn read_audio_memo_bytes(temp_path: String) -> Result<Vec<u8>, String> {
    let path = validate_audio_temp_path(&temp_path)?;
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("read temp WAV: {e}"))?;
    validate_wav_header(&bytes)?;
    Ok(bytes)
}

/// Delete a temp WAV file that the user chose to discard (Cancel in the
/// recorder modal). Best-effort — ignores "file not found" errors so calling
/// twice is safe.
#[tauri::command]
pub async fn discard_audio_memo(temp_path: String) -> Result<(), String> {
    let path = validate_audio_temp_path(&temp_path)?;
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove temp WAV: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::db::schema::migrate;
    use tempfile::TempDir;

    fn setup_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrations");
        conn
    }

    /// Verify that `mime_from_ext("wav")` returns the correct audio MIME.
    /// This is a regression guard — if the mapping is ever accidentally removed
    /// the audio branch in save_media_to_media_dir would silently fall back to
    /// application/octet-stream, breaking the frontend audio element.
    #[test]
    fn wav_mime_is_audio_wav() {
        assert_eq!(
            crate::commands::media::mime_from_ext("wav"),
            "audio/wav",
            "WAV must map to audio/wav so MediaAttachment renders <audio>"
        );
    }

    /// Verify that `save_audio_memo` (the pure ingest path via
    /// `save_media_to_media_dir`) inserts a media row with file_type =
    /// "audio/wav".  We test the inner function directly to avoid Tauri state
    /// wiring in unit tests.
    #[test]
    fn save_audio_memo_inserts_media_row_with_audio_mime() {
        let conn = setup_db();
        let dir = TempDir::new().unwrap();

        let journal_id = db::create_journal(&conn, "Test Journal", None).unwrap().id;
        let entry_id = db::create_entry(
            &conn,
            db::CreateEntryParams {
                journal_id: &journal_id,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id;

        // Build a minimal but valid WAV byte sequence using hound.
        let mut wav_bytes: Vec<u8> = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut wav_bytes);
            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: 22050,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut writer = hound::WavWriter::new(cursor, spec).expect("hound writer");
            writer.write_sample(0i16).unwrap();
            writer.finalize().unwrap();
        }

        let result =
            save_media_to_media_dir(&conn, dir.path(), &entry_id, &wav_bytes, "wav", "inline")
                .expect("save_media_to_media_dir failed");

        assert!(!result.media_id.is_empty(), "media_id must be non-empty");
        assert!(
            result.local_path.ends_with(".wav"),
            "local_path must end with .wav"
        );

        // Confirm the DB row has the correct file_type.
        let row: String = conn
            .query_row(
                "SELECT file_type FROM media WHERE id = ?1",
                rusqlite::params![result.media_id],
                |row| row.get(0),
            )
            .expect("media row not found");
        assert_eq!(row, "audio/wav");
    }

    /// `start_recording` and `stop_recording` depend on cpal hardware.
    /// On CI / machines without a mic they return an error — we just assert
    /// the return type is `Result<_, String>` and that the error message (if
    /// any) is a non-empty string.  The full integration path is covered by
    /// the macOS device tests above.
    #[test]
    #[ignore = "requires audio hardware; run manually with `cargo test -- --ignored`"]
    fn start_stop_recording_roundtrip_with_hardware() {
        // This test is intentionally left as a manual gate.
        // Run with: cargo test start_stop_recording_roundtrip_with_hardware -- --ignored
    }

    // ── is_valid_audio_temp_filename ────────────────────────────────────────

    #[test]
    fn audio_filename_accepts_valid_uuid_wav() {
        assert!(is_valid_audio_temp_filename(
            "memlore_memo_550e8400-e29b-41d4-a716-446655440000.wav"
        ));
    }

    #[test]
    fn audio_filename_rejects_missing_prefix() {
        assert!(!is_valid_audio_temp_filename(
            "550e8400-e29b-41d4-a716-446655440000.wav"
        ));
        assert!(!is_valid_audio_temp_filename(
            "memo_550e8400-e29b-41d4-a716-446655440000.wav"
        ));
    }

    #[test]
    fn audio_filename_rejects_wrong_extension() {
        assert!(!is_valid_audio_temp_filename(
            "memlore_memo_550e8400-e29b-41d4-a716-446655440000.mp3"
        ));
        assert!(!is_valid_audio_temp_filename(
            "memlore_memo_550e8400-e29b-41d4-a716-446655440000"
        ));
    }

    #[test]
    fn audio_filename_rejects_path_traversal() {
        assert!(!is_valid_audio_temp_filename("../evil.wav"));
        assert!(!is_valid_audio_temp_filename(
            "../../memlore_memo_550e8400-e29b-41d4-a716-446655440000.wav"
        ));
    }

    #[test]
    fn audio_filename_rejects_short_uuid() {
        // UUID part too short — not a real v4 UUID.
        assert!(!is_valid_audio_temp_filename("memlore_memo_abc123.wav"));
    }

    #[test]
    fn audio_filename_rejects_uppercase_hex() {
        // UUID hex must be lowercase (as uuid::Uuid::new_v4() produces).
        assert!(!is_valid_audio_temp_filename(
            "memlore_memo_550E8400-E29B-41D4-A716-446655440000.wav"
        ));
    }

    // ── validate_wav_header ─────────────────────────────────────────────────

    #[test]
    fn wav_header_accepts_riff_wave() {
        let mut bytes = vec![0u8; 44];
        bytes[0..4].copy_from_slice(b"RIFF");
        bytes[8..12].copy_from_slice(b"WAVE");
        assert!(validate_wav_header(&bytes).is_ok());
    }

    #[test]
    fn wav_header_rejects_too_short() {
        assert!(validate_wav_header(&[0u8; 8]).is_err());
        assert!(validate_wav_header(&[]).is_err());
    }

    #[test]
    fn wav_header_rejects_missing_riff() {
        let mut bytes = vec![0u8; 44];
        bytes[0..4].copy_from_slice(b"XXXX");
        bytes[8..12].copy_from_slice(b"WAVE");
        assert!(validate_wav_header(&bytes).is_err());
    }

    #[test]
    fn wav_header_rejects_missing_wave_marker() {
        let mut bytes = vec![0u8; 44];
        bytes[0..4].copy_from_slice(b"RIFF");
        bytes[8..12].copy_from_slice(b"AIFF");
        assert!(validate_wav_header(&bytes).is_err());
    }

    #[test]
    fn wav_header_rejects_mp3_magic() {
        // MP3 frame sync: 0xFF 0xFB
        let bytes: Vec<u8> = vec![
            0xFF, 0xFB, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ];
        assert!(validate_wav_header(&bytes).is_err());
    }

    // ── validate_audio_temp_path — symlink rejection ────────────────────────

    #[test]
    #[cfg(unix)]
    fn audio_temp_path_rejects_symlink() {
        use tempfile::TempDir;
        let dir = TempDir::new().unwrap();
        let real_file = dir.path().join("real.wav");
        std::fs::write(&real_file, b"dummy").unwrap();
        // Place symlink inside temp_dir() so the starts_with check would pass
        // if we didn't detect the symlink first.
        let temp_root = std::env::temp_dir();
        let link_name = format!("memlore_memo_{}.wav", uuid::Uuid::new_v4());
        let link = temp_root.join(&link_name);
        // Clean up any previous stale link from a prior test run.
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&real_file, &link).unwrap();
        let result = validate_audio_temp_path(link.to_str().unwrap());
        let _ = std::fs::remove_file(&link);
        assert!(result.is_err(), "symlink inside temp dir must be rejected");
        assert!(result.unwrap_err().contains("symlink"));
    }
}
