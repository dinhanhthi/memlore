//! Filesystem-backed `SyncProvider` implementation.
//!
//! The engine writes per-device ciphertext files under a root directory.
//! Real-world users can point this at a Dropbox / iCloud-Drive / OneDrive
//! folder; the tests use a `tempfile::TempDir` so two simulated devices
//! can exchange entries with no network.
//!
//! **Path contract.** Every `device_id` and `entry_id` that feeds into a
//! path is validated against `^[A-Za-z0-9_-]+$` before it is path-joined.
//! A rejected component never reaches the OS, so the usual `../` traversal
//! vectors cannot escape `root`. Rejecting rather than sanitizing is
//! deliberate — silently coercing a bad id into a "safe" one would
//! diverge the on-disk shape from the device's local state and make
//! round-tripping impossible.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use tokio::fs;

use super::keyring_v2::io::{
    is_recovery_authority_path, preserve_during_cloud_cleanup, verify_cleanup_preserved_control,
};
use super::provider::{ConditionalRead, FileKind, SyncError, SyncProvider};

/// Synthetic revision prefix for the local provider. The full revision is
/// `local:<secs_since_epoch>:<nanos>:<size>` — derived from `mtime` + file
/// size. A separate prefix (not `sha256:` / `drive-version:`) because the
/// local filesystem has neither an ETag nor a Drive version; the mtime+size
/// pair is its native change signal. Two files with identical contents but
/// different mtimes are treated as different revisions — that is correct for
/// sync: a re-write (even of identical bytes) bumps mtime and must invalidate
/// the cache.
const REV_LOCAL_PREFIX: &str = "local:";

/// Minimum length for any id used as a path component. UUIDs are 36,
/// nanoid is typically 10–21. A length of 4 is deliberately generous so
/// tests can use short ids like `"dev-a"` while still rejecting
/// single-character ids (`"-"`, `"_"`) that the docstring forbids.
const MIN_ID_LEN: usize = 4;

/// Windows reserved device names. Case-insensitive. Creating a file
/// with any of these as a stem (or exactly matching one) fails on
/// Windows even under a valid path — the OS reserves them for legacy
/// DOS devices. Checking here keeps Chunk 8 (Windows build) from hitting
/// opaque IO errors when a peer's device ID collides with one.
///
/// `list_devices` also filters incoming names by `is_safe_component`, so
/// a peer that manages to create a `CON` directory on a Unix sync folder
/// would be ignored on a Windows pull rather than crashing the app.
const WINDOWS_RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

fn is_windows_reserved(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    WINDOWS_RESERVED.iter().any(|r| *r == lower)
}

/// Allowed character class for every path component that comes from a
/// device or entry identifier. Matches UUIDs, nanoid-style ids, and
/// nothing else. The caller may additionally require a specific shape
/// (see `is_safe_component` vs `validate_relative_path`).
pub(crate) fn is_safe_component(s: &str) -> bool {
    s.len() >= MIN_ID_LEN
        && !is_windows_reserved(s)
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Split a relative path at `/` and verify every segment is safe.
///
/// The engine passes paths like `"{device_id}/entries/{entry_id}.bin"` or
/// `"{device_id}/metadata.json"`. We allow the literal segments
/// `"entries"`, `"metadata.json"`, and `"*.bin"` filenames, alongside the
/// caller-supplied ids. The `.`/`..` segments are rejected because
/// `is_safe_component` forbids `.` entirely (no `.` in the character
/// class).
fn validate_relative_path(path: &str) -> Result<(), SyncError> {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') {
        return Err(SyncError::Io(format!("invalid path component: {path:?}")));
    }
    for seg in path.split('/') {
        if seg.is_empty() {
            return Err(SyncError::Io(format!(
                "empty path segment in {path:?} — double slash"
            )));
        }
        // Allow `metadata.json`, `<id>.bin`, and `<id>.thumb` filenames in
        // addition to the strict id character class. `.thumb` is the encrypted
        // thumbnail path convention introduced in Chunk 6b.
        let safe_id = is_safe_component(seg);
        let safe_file = seg == "metadata.json"
            || (seg.ends_with(".bin")
                && is_safe_component(seg.strip_suffix(".bin").unwrap_or(seg)))
            || (seg.ends_with(".thumb")
                && is_safe_component(seg.strip_suffix(".thumb").unwrap_or(seg)))
            || seg == "entries"
            || seg == "media"
            || seg == "versions";
        if !(safe_id || safe_file) {
            return Err(SyncError::Io(format!(
                "invalid path component: {seg:?} in {path:?}"
            )));
        }
    }
    Ok(())
}

/// Derive a local revision token from a file's metadata: `mtime` (split into
/// seconds + subsecond nanos since the Unix epoch) and size in bytes.
///
/// `mtime + size` is the filesystem's native change signal — it changes on
/// any real content write without requiring a full byte hash. Two writes of
/// identical bytes still bump mtime and thus the revision, which is the
/// correct sync semantics (the cache must invalidate on re-write). The
/// seconds/nanos split keeps the token stable across platforms that expose
/// sub-second mtime differently.
///
/// Returns `None` when the filesystem does not report a modification time
/// (extremely rare; e.g. some FUSE mounts). Callers MUST treat `None` as
/// "cannot cache" per the trait's None-invariant.
fn local_revision_from_mtime_size(
    modified: Option<std::time::SystemTime>,
    size: u64,
) -> Option<String> {
    let (secs, nanos) = modified
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| (d.as_secs(), d.subsec_nanos()))?;
    Some(format!("{REV_LOCAL_PREFIX}{secs}:{nanos}:{size}"))
}

pub(crate) fn local_revision_from_metadata(meta: &std::fs::Metadata) -> Option<String> {
    local_revision_from_mtime_size(meta.modified().ok(), meta.len())
}

/// Map a filesystem error. Only `ErrorKind::NotFound` becomes
/// [`SyncError::NotFound`] — any other mapping would let `read_meta`
/// treat a permission/IO failure as "no vault" and publish over it.
pub(crate) fn map_io(e: std::io::Error) -> SyncError {
    match e.kind() {
        std::io::ErrorKind::NotFound => SyncError::NotFound(e.to_string()),
        std::io::ErrorKind::PermissionDenied => {
            SyncError::Auth("permission denied: grant Memlore access to this folder".to_string())
        }
        _ => SyncError::Io(e.to_string()),
    }
}

/// Finder / iCloud listing noise that must not trip "non-empty vault":
/// `.DS_Store`, `.localized`, `*.icloud`, and hidden non-`.json` temps
/// (names containing `.tmp` or `tmp-`). Leftover `.bin` / `README.md` count.
fn is_ignored_root_listing(name: &str) -> bool {
    if name == ".DS_Store" || name == ".localized" || name.ends_with(".icloud") {
        return true;
    }
    if name.ends_with(".json") || !name.starts_with('.') {
        return false;
    }
    name.contains(".tmp") || name.contains("tmp-")
}

struct FenceState {
    enabled: AtomicBool,
    expected_generation: AtomicU64,
    permit: RwLock<Option<crate::sync::recovery::RecoveryOwnerPermit>>,
}

/// Filesystem-backed sync provider rooted at a single directory.
pub struct LocalSyncProvider {
    root: PathBuf,
    fence: Arc<FenceState>,
}

impl LocalSyncProvider {
    /// Build a new provider rooted at `root`. The directory is created
    /// lazily on first write; the constructor does not touch the
    /// filesystem so `new` is infallible. Recovery fence starts off so
    /// existing callers keep the flat `<root>/<device_id>/` layout.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            fence: Arc::new(FenceState {
                enabled: AtomicBool::new(false),
                expected_generation: AtomicU64::new(u64::MAX),
                permit: RwLock::new(None),
            }),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Device-scoped root. Flat `root` while the fence is off;
    /// `root/generations/g-<N>` once [`Self::with_recovery_fence`] or
    /// [`Self::configure_recovery_fence_authority`] has been called.
    fn device_root(&self) -> PathBuf {
        if self.fence.enabled.load(Ordering::Acquire) {
            self.root
                .join("generations")
                .join(self.generation_folder_name())
        } else {
            self.root.clone()
        }
    }

    fn configured_recovery_generation(&self) -> u64 {
        match self.fence.expected_generation.load(Ordering::Acquire) {
            u64::MAX => 0,
            generation => generation,
        }
    }

    fn generation_folder_name(&self) -> String {
        format!("g-{}", self.configured_recovery_generation())
    }

    fn stamp_fence(
        &self,
        generation: u64,
        permit: Option<crate::sync::recovery::RecoveryOwnerPermit>,
    ) {
        self.fence
            .expected_generation
            .store(generation, Ordering::Release);
        *self
            .fence
            .permit
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = permit;
        self.fence.enabled.store(true, Ordering::Release);
    }

    /// Enable the recovery fence on a freshly constructed provider.
    /// Device writes then land under `generations/g-<generation>/`.
    pub fn with_recovery_fence(
        self,
        generation: u64,
        permit: Option<crate::sync::recovery::RecoveryOwnerPermit>,
    ) -> Self {
        self.stamp_fence(generation, permit);
        self
    }

    /// Re-stamp the expected generation / owner permit on a live instance.
    pub fn configure_recovery_fence_authority(
        &self,
        generation: u64,
        permit: Option<crate::sync::recovery::RecoveryOwnerPermit>,
    ) {
        self.stamp_fence(generation, permit);
    }

    fn resolve(&self, relative: &str) -> Result<PathBuf, SyncError> {
        validate_relative_path(relative)?;
        Ok(self.device_root().join(relative))
    }

    async fn read_control_file(
        &self,
    ) -> Result<Option<crate::sync::sync_control::SyncControlV1>, SyncError> {
        let path = self.root.join(".meta").join("control.json");
        match fs::read(&path).await {
            Ok(bytes) => crate::sync::recovery::parse_control(&bytes).map(Some),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(map_io(e)),
        }
    }

    async fn read_control_or_initial(
        &self,
    ) -> Result<crate::sync::sync_control::SyncControlV1, SyncError> {
        Ok(self
            .read_control_file()
            .await?
            .unwrap_or_else(|| crate::sync::sync_control::SyncControlV1::initial(0)))
    }

    async fn read_control_required(
        &self,
        missing: &str,
    ) -> Result<crate::sync::sync_control::SyncControlV1, SyncError> {
        self.read_control_file()
            .await?
            .ok_or_else(|| SyncError::Auth(missing.to_string()))
    }

    async fn list_child_entries(dir: &Path) -> Result<Vec<(PathBuf, String, bool)>, SyncError> {
        let mut out = Vec::new();
        let mut rd = fs::read_dir(dir).await.map_err(map_io)?;
        while let Some(entry) = rd.next_entry().await.map_err(map_io)? {
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_dir = entry.file_type().await.map_err(map_io)?.is_dir();
            out.push((entry.path(), name, is_dir));
        }
        Ok(out)
    }

    async fn remove_existing(path: &Path, is_dir: bool) -> Result<(), SyncError> {
        if is_dir {
            fs::remove_dir_all(path).await.map_err(map_io)
        } else {
            fs::remove_file(path).await.map_err(map_io)
        }
    }

    pub(crate) async fn revalidate_recovery_fence_before_mutation(
        &self,
        path: &str,
    ) -> Result<(), SyncError> {
        if is_recovery_authority_path(path) || !self.fence.enabled.load(Ordering::Acquire) {
            return Ok(());
        }
        let control = self.read_control_or_initial().await?;
        let local_generation = match self.fence.expected_generation.load(Ordering::Acquire) {
            u64::MAX => control.recovery_generation,
            configured => configured,
        };
        let permit = self
            .fence
            .permit
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        crate::sync::recovery::authorize_recovery_push(
            control.recovery_lease.as_ref(),
            control.recovery_generation,
            local_generation,
            permit.as_ref(),
        )
        .map_err(SyncError::Auth)
    }

    async fn ensure_cleanup_authority_unchanged(
        &self,
        control_before: &crate::sync::sync_control::SyncControlV1,
    ) -> Result<(), SyncError> {
        self.revalidate_recovery_fence_before_mutation("__clear_cloud_payload__")
            .await?;
        let current = self
            .read_control_required("control.json disappeared during cleanup")
            .await?;
        verify_cleanup_preserved_control(control_before, &current)
    }

    /// Ensure the vault root exists. Does not create a device or generation
    /// namespace — connect must establish `control.json` first.
    pub async fn ensure_root_folder_only(&self) -> Result<(String, bool), SyncError> {
        fs::create_dir_all(&self.root).await.map_err(map_io)?;
        let root = self.root.to_string_lossy().into_owned();
        let empty = self.root_is_empty(&root).await?;
        Ok((root, empty))
    }

    /// True when `root_path` has no vault content. Ignores Finder / iCloud
    /// placeholders and stray non-`.json` temp files.
    pub async fn root_is_empty(&self, root_path: &str) -> Result<bool, SyncError> {
        let mut rd = match fs::read_dir(root_path).await {
            Ok(rd) => rd,
            Err(e) => return Err(map_io(e)),
        };
        while let Some(entry) = rd.next_entry().await.map_err(map_io)? {
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_dir = entry.file_type().await.map_err(map_io)?.is_dir();
            if is_dir || !is_ignored_root_listing(&name) {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Create `entries/media/journals/versions/embeddings` under
    /// `device_root()/device_id`. Returns the vault root path.
    pub async fn ensure_folder_structure(&self, device_id: &str) -> Result<String, SyncError> {
        self.revalidate_recovery_fence_before_mutation("__ensure_folders__")
            .await?;
        if !is_safe_component(device_id) {
            return Err(SyncError::Io(format!("invalid device_id: {device_id:?}")));
        }
        let (root, _) = self.ensure_root_folder_only().await?;
        let device_dir = self.device_root().join(device_id);
        for sub in ["entries", "media", "journals", "versions", "embeddings"] {
            fs::create_dir_all(device_dir.join(sub))
                .await
                .map_err(map_io)?;
        }
        Ok(root)
    }

    /// Best-effort delete `device_root()/device_id`. Missing folders are
    /// success (idempotent).
    pub async fn best_effort_delete_device_namespace(
        &self,
        device_id: &str,
    ) -> Result<(), SyncError> {
        self.revalidate_recovery_fence_before_mutation("__delete_device_namespace__")
            .await?;
        if !is_safe_component(device_id) {
            return Err(SyncError::Io(format!("invalid device_id: {device_id:?}")));
        }
        let path = self.device_root().join(device_id);
        self.revalidate_recovery_fence_before_mutation("__delete_device_namespace__")
            .await?;
        match fs::remove_dir_all(&path).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(map_io(e)),
        }
    }

    /// Delete all journal payload and keyring artifacts while preserving
    /// `.meta/control.json` and `.meta/_recovery_marker.json`.
    pub async fn clear_cloud_preserving_control(&self) -> Result<(), SyncError> {
        self.revalidate_recovery_fence_before_mutation("__clear_cloud_payload__")
            .await?;
        let control_before = self
            .read_control_required("cloud cleanup requires control.json")
            .await?;

        for (path, name, is_dir) in Self::list_child_entries(&self.root).await? {
            self.ensure_cleanup_authority_unchanged(&control_before)
                .await?;
            if !preserve_during_cloud_cleanup("root", &name) {
                Self::remove_existing(&path, is_dir).await?;
                continue;
            }
            if !is_dir {
                return Err(SyncError::Auth(
                    "reserved .meta path is not a folder".to_string(),
                ));
            }
            for (meta_path, meta_name, meta_is_dir) in Self::list_child_entries(&path).await? {
                if !preserve_during_cloud_cleanup(".meta", &meta_name) {
                    self.ensure_cleanup_authority_unchanged(&control_before)
                        .await?;
                    Self::remove_existing(&meta_path, meta_is_dir).await?;
                }
            }
        }

        let control_after = self
            .read_control_required("control.json disappeared during cleanup")
            .await?;
        verify_cleanup_preserved_control(&control_before, &control_after)
    }
}

#[async_trait]
impl SyncProvider for LocalSyncProvider {
    async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
        let mut out = Vec::new();
        let mut rd = match fs::read_dir(&self.device_root()).await {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(map_io(e)),
        };
        while let Some(entry) = rd.next_entry().await.map_err(map_io)? {
            let ft = entry.file_type().await.map_err(map_io)?;
            if !ft.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            // `is_safe_component("generations")` is true — exclude the
            // literal generation-namespace folder so it never surfaces as
            // a peer device (mirrors gdrive_provider.rs).
            if name == "generations" {
                continue;
            }
            if is_safe_component(&name) {
                out.push(name);
            }
        }
        out.sort();
        Ok(out)
    }

    async fn list_files(&self, device_id: &str, kind: FileKind) -> Result<Vec<String>, SyncError> {
        if !is_safe_component(device_id) {
            return Err(SyncError::Io(format!("invalid device_id: {device_id:?}")));
        }
        let mut out = Vec::new();
        match kind.subfolder_name() {
            None => {
                // DeviceRoot: files directly under `{device_id}/` (settings.bin,
                // tags.bin, metadata.json, …). Subfolders (entries/, media/, …)
                // are skipped.
                let dir = self.device_root().join(device_id);
                let mut rd = match fs::read_dir(&dir).await {
                    Ok(rd) => rd,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
                    Err(e) => return Err(map_io(e)),
                };
                while let Some(entry) = rd.next_entry().await.map_err(map_io)? {
                    let ft = entry.file_type().await.map_err(map_io)?;
                    if !ft.is_file() {
                        continue;
                    }
                    let name = entry.file_name().to_string_lossy().into_owned();
                    // Device root only hosts plaintext metadata.json and
                    // encrypted `{safe_stem}.bin` surfaces — no extensionless
                    // files. (is_safe_component rejects '.' so a bare-name
                    // branch would be dead code.)
                    let accepted = name == "metadata.json"
                        || (name.ends_with(".bin")
                            && is_safe_component(name.strip_suffix(".bin").unwrap_or(&name)));
                    if !accepted {
                        continue;
                    }
                    out.push(format!("{device_id}/{name}"));
                }
            }
            Some(subfolder) => {
                let dir = self.device_root().join(device_id).join(subfolder);
                let mut rd = match fs::read_dir(&dir).await {
                    Ok(rd) => rd,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
                    Err(e) => return Err(map_io(e)),
                };
                while let Some(entry) = rd.next_entry().await.map_err(map_io)? {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    // For Entries: only accept *.bin files whose stem is a safe id.
                    // For Media: accept any file whose name is a safe id.
                    let accepted = match kind {
                        // Entries, journals, and versions are all `{id}.bin` files
                        // keyed by a safe id. Embedding-chunk batches are also
                        // `{name}.bin` files (`batch-{i}.bin`), just not keyed by an
                        // entry/version id — same safe-component check applies to
                        // the stem.
                        FileKind::Entries
                        | FileKind::Journals
                        | FileKind::Versions
                        | FileKind::EmbeddingChunks => {
                            name.ends_with(".bin")
                                && is_safe_component(name.strip_suffix(".bin").unwrap_or(&name))
                        }
                        FileKind::Media => is_safe_component(&name),
                        FileKind::DeviceRoot => unreachable!("matched Some(subfolder)"),
                    };
                    if !accepted {
                        continue;
                    }
                    out.push(format!("{device_id}/{subfolder}/{name}"));
                }
            }
        }
        out.sort();
        Ok(out)
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
        let abs = self.resolve(path)?;
        match fs::read(&abs).await {
            Ok(bytes) => Ok(bytes),
            Err(e) => Err(map_io(e)),
        }
    }

    /// Revision-aware read for the local filesystem.
    ///
    /// Cheap path: a `stat` resolves the mtime + size revision WITHOUT reading
    /// the body; if it matches `known_revision` we return `Unchanged`. Only on
    /// a mismatch (or when `known_revision` is `None`) do we read the bytes,
    /// returning them with the freshly-resolved revision so the caller can
    /// cache it for next time.
    ///
    /// `known_revision: None` and any unresolvable-revision case always return
    /// `Changed` with the bytes (the None-invariant from the trait).
    async fn read_file_if_changed(
        &self,
        path: &str,
        known_revision: Option<&str>,
    ) -> Result<ConditionalRead, SyncError> {
        let abs = self.resolve(path)?;
        // Cheap metadata read first. `symlink_metadata` would let a symlink
        // fool the revision check; `metadata` follows links and stats the
        // target — matching what `fs::read` actually returns bytes from.
        let meta = match fs::metadata(&abs).await {
            Ok(m) => m,
            Err(e) => return Err(map_io(e)),
        };
        let current = local_revision_from_metadata(&meta);
        if current.is_some() && current.as_deref() == known_revision {
            return Ok(ConditionalRead::Unchanged);
        }
        // Revision differs (or caller had None) → read the body. We re-issue
        // rather than reusing `meta` because the file could change between the
        // stat and the read; `fs::read` is the source of truth for bytes.
        let bytes = match fs::read(&abs).await {
            Ok(b) => b,
            Err(e) => return Err(map_io(e)),
        };
        Ok(ConditionalRead::Changed {
            bytes,
            revision: current,
        })
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        self.revalidate_recovery_fence_before_mutation(path).await?;
        let abs = self.resolve(path)?;
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent).await.map_err(map_io)?;
        }
        fs::write(&abs, data).await.map_err(map_io)
    }

    async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
        self.revalidate_recovery_fence_before_mutation(path).await?;
        let abs = self.resolve(path)?;
        match fs::remove_file(&abs).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(map_io(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, LocalSyncProvider) {
        let dir = TempDir::new().unwrap();
        let provider = LocalSyncProvider::new(dir.path().to_path_buf());
        (dir, provider)
    }

    #[tokio::test]
    async fn write_then_read_roundtrips() {
        let (_dir, p) = fixture();
        p.write_file("dev-a/entries/eid1.bin", b"hello")
            .await
            .unwrap();
        let got = p.read_file("dev-a/entries/eid1.bin").await.unwrap();
        assert_eq!(got, b"hello");
    }

    #[tokio::test]
    async fn write_creates_parent_directories() {
        let (dir, p) = fixture();
        p.write_file("dev-a/metadata.json", b"{}").await.unwrap();
        assert!(dir.path().join("dev-a/metadata.json").exists());
    }

    #[tokio::test]
    async fn read_missing_returns_not_found() {
        let (_dir, p) = fixture();
        let err = p.read_file("dev-x/entries/nope.bin").await.unwrap_err();
        assert!(matches!(err, SyncError::NotFound(_)));
    }

    #[tokio::test]
    async fn delete_missing_is_ok() {
        let (_dir, p) = fixture();
        p.delete_file("dev-x/entries/gone.bin").await.unwrap();
    }

    #[tokio::test]
    async fn delete_existing_removes_file() {
        let (dir, p) = fixture();
        p.write_file("dev-a/entries/eid1.bin", b"x").await.unwrap();
        p.delete_file("dev-a/entries/eid1.bin").await.unwrap();
        assert!(!dir.path().join("dev-a/entries/eid1.bin").exists());
    }

    #[tokio::test]
    async fn list_devices_returns_sorted_dirs_only() {
        let (_dir, p) = fixture();
        p.write_file("dev-b/metadata.json", b"{}").await.unwrap();
        p.write_file("dev-a/metadata.json", b"{}").await.unwrap();
        // A stray file at the root — must not appear as a device.
        p.write_file("README.md", b"notes").await.unwrap_err();
        let devices = p.list_devices().await.unwrap();
        assert_eq!(devices, vec!["dev-a".to_string(), "dev-b".to_string()]);
    }

    #[tokio::test]
    async fn list_devices_on_missing_root_returns_empty() {
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("does-not-exist");
        let p = LocalSyncProvider::new(missing);
        let devices = p.list_devices().await.unwrap();
        assert!(devices.is_empty());
    }

    #[tokio::test]
    async fn list_files_entries_returns_bin_only() {
        let (dir, p) = fixture();
        p.write_file("dev-a/entries/eid1.bin", b"1").await.unwrap();
        p.write_file("dev-a/entries/eid2.bin", b"2").await.unwrap();
        // A non-.bin stray file — must be filtered out.
        std::fs::write(dir.path().join("dev-a/entries/notes.txt"), b"hi").unwrap();
        let files = p.list_files("dev-a", FileKind::Entries).await.unwrap();
        assert_eq!(
            files,
            vec![
                "dev-a/entries/eid1.bin".to_string(),
                "dev-a/entries/eid2.bin".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn list_files_rejects_bad_device_id() {
        let (_dir, p) = fixture();
        let err = p
            .list_files("../evil", FileKind::Entries)
            .await
            .unwrap_err();
        assert!(matches!(err, SyncError::Io(_)));
    }

    #[tokio::test]
    async fn list_files_on_missing_dir_returns_empty() {
        let (_dir, p) = fixture();
        let got = p
            .list_files("dev-never-existed", FileKind::Entries)
            .await
            .unwrap();
        assert!(got.is_empty());
    }

    #[tokio::test]
    async fn list_files_media_returns_media_only() {
        let (_dir, p) = fixture();
        p.write_file("dev-a/media/mediauuid1", b"img1")
            .await
            .unwrap();
        p.write_file("dev-a/media/mediauuid2", b"img2")
            .await
            .unwrap();
        // entries must NOT appear in media listing
        p.write_file("dev-a/entries/eid1.bin", b"entry")
            .await
            .unwrap();
        let files = p.list_files("dev-a", FileKind::Media).await.unwrap();
        assert_eq!(
            files,
            vec![
                "dev-a/media/mediauuid1".to_string(),
                "dev-a/media/mediauuid2".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn list_files_no_cross_contamination() {
        let (_dir, p) = fixture();
        p.write_file("dev-a/entries/eid1.bin", b"entry")
            .await
            .unwrap();
        p.write_file("dev-a/media/mediauuid1", b"img")
            .await
            .unwrap();
        let entries = p.list_files("dev-a", FileKind::Entries).await.unwrap();
        let media = p.list_files("dev-a", FileKind::Media).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(media.len(), 1);
        assert!(entries[0].contains("/entries/"));
        assert!(media[0].contains("/media/"));
    }

    #[tokio::test]
    async fn path_traversal_is_rejected() {
        let (_dir, p) = fixture();
        for bad in [
            "../secret",
            "dev-a/../other/x.bin",
            "dev-a/entries/../../../etc/passwd",
            "/abs/path",
            "dev-a//double-slash",
            "dev-a/\\backslash",
        ] {
            let err = p.write_file(bad, b"x").await.unwrap_err();
            assert!(
                matches!(err, SyncError::Io(_)),
                "expected Io error for {bad:?}, got {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn empty_and_dot_segments_are_rejected() {
        let (_dir, p) = fixture();
        for bad in ["", ".", "./x", "dev-a/.", "dev-a/./entries/eid1.bin"] {
            let err = p.write_file(bad, b"x").await.unwrap_err();
            assert!(matches!(err, SyncError::Io(_)), "expected Io for {bad:?}");
        }
    }

    #[tokio::test]
    async fn single_char_ids_are_rejected() {
        // Docstring promises "UUIDs, short ids" — a single `-` is not a
        // short id, it's an escape hatch. Min length 4 filters it out.
        let (_dir, p) = fixture();
        for bad in ["-", "_", "abc"] {
            let err = p
                .write_file(&format!("{bad}/entries/{bad}{bad}.bin"), b"x")
                .await
                .unwrap_err();
            assert!(
                matches!(err, SyncError::Io(_)),
                "expected rejection for id {bad:?}"
            );
        }
    }

    #[tokio::test]
    async fn windows_reserved_names_are_rejected() {
        // Reserved DOS device names fail on Windows even inside a valid
        // path. Reject at the sanitizer so Chunk 8 isn't greeted with
        // opaque IO errors.
        let (_dir, p) = fixture();
        for bad in ["CON", "con", "Con", "PRN", "NUL", "COM1", "lpt9"] {
            let err = p
                .write_file(&format!("{bad}/entries/abcd.bin"), b"x")
                .await
                .unwrap_err();
            assert!(
                matches!(err, SyncError::Io(_)),
                "expected rejection for reserved name {bad:?}"
            );
        }
    }

    #[tokio::test]
    async fn double_bin_suffix_stem_is_rejected() {
        // `foo.bin.bin` has stem `foo.bin` which contains `.` — not in
        // the allowed class, must fail. This pins the regex contract.
        let (_dir, p) = fixture();
        p.write_file("dev-a/entries/eid1.bin.bin", b"x")
            .await
            .unwrap_err();
    }

    #[tokio::test]
    async fn write_overwrites_existing_file() {
        let (_dir, p) = fixture();
        p.write_file("dev-a/entries/eid1.bin", b"first")
            .await
            .unwrap();
        p.write_file("dev-a/entries/eid1.bin", b"second")
            .await
            .unwrap();
        let got = p.read_file("dev-a/entries/eid1.bin").await.unwrap();
        assert_eq!(got, b"second");
    }

    // Chunk 6b: `.thumb` suffix path-validator coverage.

    #[tokio::test]
    async fn thumb_suffix_with_safe_stem_is_accepted() {
        let (_dir, p) = fixture();
        p.write_file("dev-a/media/mediauuid1234.thumb", b"ct")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn bare_thumb_segment_is_rejected() {
        // `.thumb` with an empty stem must fail — a future refactor that
        // drops the `is_safe_component` call on the stripped stem would
        // regress this.
        let (_dir, p) = fixture();
        p.write_file("dev-a/media/.thumb", b"x").await.unwrap_err();
    }

    #[tokio::test]
    async fn double_thumb_suffix_stem_is_rejected() {
        // `foo.thumb.thumb` strips to `foo.thumb`, which contains `.` —
        // not in the allowed id class, must fail.
        let (_dir, p) = fixture();
        p.write_file("dev-a/media/foo.thumb.thumb", b"x")
            .await
            .unwrap_err();
    }

    #[tokio::test]
    async fn thumb_with_traversal_stem_is_rejected() {
        let (_dir, p) = fixture();
        p.write_file("dev-a/media/../evil.thumb", b"x")
            .await
            .unwrap_err();
    }

    #[tokio::test]
    async fn thumb_with_leading_dot_stem_is_rejected() {
        // `..evil.thumb` has no slash — it's a single segment. The `.thumb`
        // arm strips to `..evil`, which `is_safe_component` must reject
        // (the allowed char class has no `.`). This pins the exact branch
        // the `.thumb` whitelist exercises, independent of any future
        // relaxation of `is_safe_component`.
        let (_dir, p) = fixture();
        p.write_file("dev-a/media/..evil.thumb", b"x")
            .await
            .unwrap_err();
    }

    #[tokio::test]
    async fn thumb_with_hidden_stem_is_rejected() {
        // `.hidden.thumb` — stem `.hidden` also violates the char class.
        let (_dir, p) = fixture();
        p.write_file("dev-a/media/.hidden.thumb", b"x")
            .await
            .unwrap_err();
    }

    // ─── read_file_if_changed (Phase 2, Task 2) ──────────────────────────────

    /// Helper: read with no known revision → expect Changed, return the
    /// resolved revision so a follow-up call can prove the Unchanged path.
    async fn cold_read(p: &LocalSyncProvider, path: &str) -> (Vec<u8>, String) {
        let got = p.read_file_if_changed(path, None).await.unwrap();
        match got {
            ConditionalRead::Changed { bytes, revision } => {
                let rev = revision.expect("local provider resolves mtime revision");
                (bytes, rev)
            }
            ConditionalRead::Unchanged => panic!("None revision must never be Unchanged"),
        }
    }

    #[tokio::test]
    async fn local_read_if_changed_returns_unchanged_when_revision_matches() {
        let (_dir, p) = fixture();
        p.write_file("dev-a/entries/eid1.bin", b"hello")
            .await
            .unwrap();

        let (bytes, rev) = cold_read(&p, "dev-a/entries/eid1.bin").await;
        assert_eq!(bytes, b"hello");

        // Handing the same revision back → Unchanged, no body read.
        let got = p
            .read_file_if_changed("dev-a/entries/eid1.bin", Some(&rev))
            .await
            .unwrap();
        assert_eq!(got, ConditionalRead::Unchanged);
    }

    #[tokio::test]
    async fn local_read_if_changed_returns_changed_after_rewrite() {
        let (_dir, p) = fixture();
        p.write_file("dev-a/entries/eid1.bin", b"first")
            .await
            .unwrap();
        let (_, old_rev) = cold_read(&p, "dev-a/entries/eid1.bin").await;

        // Rewrite bumps mtime → revision must differ.
        // Sleep to guarantee an mtime tick on coarse-grained filesystems (HFS+
        // has 1s granularity; ext4 has nanos but only updates them for writes
        // >60s apart in some kernels). 40ms covers HFS+; if mtime didn't move
        // the size change still differentiates the revision.
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        p.write_file("dev-a/entries/eid1.bin", b"second")
            .await
            .unwrap();

        let got = p
            .read_file_if_changed("dev-a/entries/eid1.bin", Some(&old_rev))
            .await
            .unwrap();
        match got {
            ConditionalRead::Changed { bytes, revision } => {
                assert_eq!(bytes, b"second");
                let new_rev = revision.expect("local resolves mtime revision");
                assert_ne!(new_rev, old_rev);
            }
            ConditionalRead::Unchanged => panic!("rewrite must invalidate revision"),
        }
    }

    #[tokio::test]
    async fn local_read_if_changed_none_revision_always_returns_changed() {
        let (_dir, p) = fixture();
        p.write_file("dev-a/entries/eid1.bin", b"hello")
            .await
            .unwrap();
        let got = p
            .read_file_if_changed("dev-a/entries/eid1.bin", None)
            .await
            .unwrap();
        match got {
            ConditionalRead::Changed { bytes, revision } => {
                assert_eq!(bytes, b"hello");
                assert!(revision.is_some(), "local provider resolves a revision");
            }
            ConditionalRead::Unchanged => panic!("None revision must never be Unchanged"),
        }
    }

    #[tokio::test]
    async fn local_read_if_changed_unresolvable_mtime_always_returns_changed() {
        let (dir, p) = fixture();
        p.write_file("dev-a/entries/eid1.bin", b"hello")
            .await
            .unwrap();
        let path = dir.path().join("dev-a/entries/eid1.bin");
        std::fs::File::open(&path)
            .unwrap()
            .set_times(
                std::fs::FileTimes::new()
                    .set_modified(std::time::UNIX_EPOCH - std::time::Duration::from_secs(1)),
            )
            .unwrap();
        assert!(
            local_revision_from_metadata(&std::fs::metadata(&path).unwrap()).is_none(),
            "pre-epoch mtime must be unresolvable as a local revision"
        );

        let got = p
            .read_file_if_changed("dev-a/entries/eid1.bin", None)
            .await
            .unwrap();
        assert_eq!(
            got,
            ConditionalRead::Changed {
                bytes: b"hello".to_vec(),
                revision: None,
            },
            "unresolvable mtime must read the body rather than claiming Unchanged"
        );
    }

    #[tokio::test]
    async fn local_read_if_changed_missing_returns_not_found() {
        let (_dir, p) = fixture();
        let err = p
            .read_file_if_changed("dev-x/entries/nope.bin", None)
            .await
            .unwrap_err();
        assert!(matches!(err, SyncError::NotFound(_)));
    }

    #[tokio::test]
    async fn local_revision_string_format_is_stable() {
        // Pin the revision string format so a future refactor can't silently
        // change it (which would invalidate every existing cached revision).
        let (dir, _p) = (tempfile::TempDir::new().unwrap(), ());
        let path = dir.path().join("f.bin");
        std::fs::write(&path, b"abc").unwrap();
        let meta = std::fs::metadata(&path).unwrap();
        let rev = local_revision_from_metadata(&meta).expect("test file has a usable mtime");
        assert!(
            rev.starts_with("local:"),
            "revision must start with the local prefix: {rev}"
        );
        // Three numeric fields after the prefix: secs:nanos:size.
        let body = rev.strip_prefix("local:").unwrap();
        let parts: Vec<&str> = body.split(':').collect();
        assert_eq!(parts.len(), 3, "expected secs:nanos:size, got {body}");
        assert!(
            parts[0].parse::<u64>().is_ok(),
            "secs not numeric: {}",
            parts[0]
        );
        assert!(
            parts[1].parse::<u32>().is_ok(),
            "nanos not numeric: {}",
            parts[1]
        );
        assert_eq!(parts[2], "3", "size must be byte count");
    }

    #[test]
    fn local_revision_is_not_cacheable_without_mtime() {
        assert_eq!(
            local_revision_from_mtime_size(None, 42),
            None,
            "an unavailable mtime must fail open instead of producing a reusable local:0 token"
        );
    }

    fn write_control(root: &std::path::Path, generation: u64) {
        let meta = root.join(".meta");
        std::fs::create_dir_all(&meta).unwrap();
        let control = crate::sync::sync_control::SyncControlV1 {
            version: crate::sync::sync_control::SYNC_CONTROL_VERSION,
            recovery_generation: generation,
            recovery_lease: None,
            updated_at: 1,
        };
        std::fs::write(
            meta.join("control.json"),
            serde_json::to_vec(&control).unwrap(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn fence_on_writes_under_generation_folder_and_lists_device() {
        let dir = TempDir::new().unwrap();
        write_control(dir.path(), 3);
        let p = LocalSyncProvider::new(dir.path().to_path_buf()).with_recovery_fence(3, None);
        p.write_file("dev-a/entries/eid1.bin", b"hello")
            .await
            .unwrap();
        assert!(
            dir.path()
                .join("generations/g-3/dev-a/entries/eid1.bin")
                .exists(),
            "fenced write must land under generations/g-3"
        );
        assert!(
            !dir.path().join("dev-a/entries/eid1.bin").exists(),
            "fenced write must not use the flat root"
        );
        assert_eq!(p.list_devices().await.unwrap(), vec!["dev-a".to_string()]);
    }

    #[tokio::test]
    async fn list_devices_never_returns_generations() {
        let (dir, p) = fixture();
        std::fs::create_dir_all(dir.path().join("generations")).unwrap();
        std::fs::create_dir_all(dir.path().join("dev-a")).unwrap();
        let devices = p.list_devices().await.unwrap();
        assert_eq!(devices, vec!["dev-a".to_string()]);
        assert!(
            !devices.iter().any(|name| name == "generations"),
            "is_safe_component('generations') is true; list_devices must still exclude it"
        );
    }

    #[tokio::test]
    async fn root_is_empty_ignores_ds_store() {
        let (dir, p) = fixture();
        std::fs::write(dir.path().join(".DS_Store"), b"").unwrap();
        std::fs::write(dir.path().join(".localized"), b"").unwrap();
        std::fs::write(dir.path().join("Notes.icloud"), b"").unwrap();
        std::fs::write(dir.path().join(".control.tmp-1"), b"").unwrap();
        let root = dir.path().to_string_lossy();
        assert!(
            p.root_is_empty(&root).await.unwrap(),
            "Finder/iCloud noise and hidden .tmp / tmp- files must not count as vault content"
        );
    }

    #[tokio::test]
    async fn root_is_empty_false_for_json_or_directory() {
        let (dir, p) = fixture();
        let root = dir.path().to_string_lossy().into_owned();
        std::fs::write(dir.path().join("control.json"), b"{}").unwrap();
        assert!(
            !p.root_is_empty(&root).await.unwrap(),
            "a *.json at vault root is vault content"
        );
        std::fs::remove_file(dir.path().join("control.json")).unwrap();
        std::fs::create_dir_all(dir.path().join("dev-a")).unwrap();
        assert!(
            !p.root_is_empty(&root).await.unwrap(),
            "a device directory must make the vault non-empty"
        );
        std::fs::remove_dir_all(dir.path().join("dev-a")).unwrap();
        std::fs::create_dir_all(dir.path().join("generations")).unwrap();
        assert!(
            !p.root_is_empty(&root).await.unwrap(),
            "a generations/ directory must make the vault non-empty"
        );
    }

    #[tokio::test]
    async fn root_is_empty_false_for_bin_or_readme() {
        let (dir, p) = fixture();
        let root = dir.path().to_string_lossy().into_owned();
        std::fs::write(dir.path().join("leftover.bin"), b"x").unwrap();
        assert!(
            !p.root_is_empty(&root).await.unwrap(),
            "a leftover .bin at vault root is vault content"
        );
        std::fs::remove_file(dir.path().join("leftover.bin")).unwrap();
        std::fs::write(dir.path().join("README.md"), b"notes").unwrap();
        assert!(
            !p.root_is_empty(&root).await.unwrap(),
            "README.md at vault root is vault content"
        );
    }

    #[test]
    fn map_io_permission_denied_is_auth() {
        let err = map_io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "operation not permitted",
        ));
        match err {
            SyncError::Auth(msg) => {
                assert_eq!(
                    msg,
                    "permission denied: grant Memlore access to this folder"
                );
            }
            other => panic!("expected Auth, got {other:?}"),
        }
    }

    #[test]
    fn map_io_not_found_is_not_found() {
        let err = map_io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no such file",
        ));
        assert!(
            matches!(err, SyncError::NotFound(_)),
            "only ErrorKind::NotFound may map to SyncError::NotFound, got {err:?}"
        );
    }

    #[test]
    fn map_io_other_kinds_are_io() {
        for kind in [
            std::io::ErrorKind::InvalidData,
            std::io::ErrorKind::UnexpectedEof,
            std::io::ErrorKind::BrokenPipe,
            std::io::ErrorKind::Other,
        ] {
            let err = map_io(std::io::Error::new(kind, "boom"));
            assert!(
                matches!(err, SyncError::Io(_)),
                "kind {kind:?} must map to Io, got {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn clear_cloud_preserving_control_keeps_authority_files() {
        let (dir, p) = fixture();
        write_control(dir.path(), 1);
        std::fs::write(dir.path().join(".meta/_recovery_marker.json"), b"{}").unwrap();
        std::fs::create_dir_all(dir.path().join(".meta/keyring/devices")).unwrap();
        std::fs::write(dir.path().join(".meta/keyring/_meta.json"), b"{}").unwrap();
        std::fs::write(dir.path().join(".meta/keyring/devices/dev-a.json"), b"{}").unwrap();
        std::fs::create_dir_all(dir.path().join("dev-a/entries")).unwrap();
        std::fs::write(dir.path().join("dev-a/entries/e1.bin"), b"x").unwrap();
        std::fs::create_dir_all(dir.path().join("generations/g-1/dev-a/entries")).unwrap();
        std::fs::write(
            dir.path().join("generations/g-1/dev-a/entries/e1.bin"),
            b"x",
        )
        .unwrap();

        p.clear_cloud_preserving_control().await.unwrap();

        assert!(
            dir.path().join(".meta/control.json").exists(),
            "control.json must survive cleanup"
        );
        assert!(
            dir.path().join(".meta/_recovery_marker.json").exists(),
            "_recovery_marker.json must survive cleanup"
        );
        assert!(
            !dir.path().join(".meta/keyring").exists(),
            "keyring payload must be deleted"
        );
        assert!(
            !dir.path().join("dev-a").exists(),
            "device folders must be deleted"
        );
        assert!(
            !dir.path().join("generations").exists(),
            "generations/ must be wiped with the rest of the payload"
        );
    }

    #[tokio::test]
    async fn fence_mismatch_on_write_file_returns_auth() {
        let dir = TempDir::new().unwrap();
        write_control(dir.path(), 2);
        let p = LocalSyncProvider::new(dir.path().to_path_buf()).with_recovery_fence(1, None);
        let err = p
            .write_file("dev-a/entries/eid1.bin", b"blocked")
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::Auth(_)),
            "generation mismatch must fail closed as Auth, got {err:?}"
        );
        assert!(
            !dir.path()
                .join("generations/g-1/dev-a/entries/eid1.bin")
                .exists(),
            "mismatched fence must not write payload"
        );
    }

    fn plant_wipe_payload(root: &std::path::Path) {
        std::fs::create_dir_all(root.join("dev-a/entries")).unwrap();
        std::fs::write(root.join("dev-a/entries/e1.bin"), b"x").unwrap();
        std::fs::create_dir_all(root.join(".meta/keyring")).unwrap();
        std::fs::write(root.join(".meta/keyring/_meta.json"), b"{}").unwrap();
    }

    fn wipe_payload_present(root: &std::path::Path) -> bool {
        root.join("dev-a").exists() && root.join(".meta/keyring").exists()
    }

    fn write_garbage_control(root: &std::path::Path) {
        std::fs::create_dir_all(root.join(".meta")).unwrap();
        std::fs::write(root.join(".meta/control.json"), b"{truncated").unwrap();
    }

    fn write_invalid_version_control(root: &std::path::Path, generation: u64) {
        let meta = root.join(".meta");
        std::fs::create_dir_all(&meta).unwrap();
        let control = crate::sync::sync_control::SyncControlV1 {
            version: crate::sync::sync_control::SYNC_CONTROL_VERSION + 1,
            recovery_generation: generation,
            recovery_lease: None,
            updated_at: 1,
        };
        std::fs::write(
            meta.join("control.json"),
            serde_json::to_vec(&control).unwrap(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn control_garbage_bytes_is_serialization_not_none() {
        let dir = TempDir::new().unwrap();
        write_garbage_control(dir.path());
        let p = LocalSyncProvider::new(dir.path().to_path_buf()).with_recovery_fence(1, None);
        let err = p
            .write_file("dev-a/entries/eid1.bin", b"blocked")
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::Serialization(_)),
            "truncated control.json must be Serialization (fail closed), not None/initial(0), got {err:?}"
        );
        assert!(
            !dir.path()
                .join("generations/g-1/dev-a/entries/eid1.bin")
                .exists(),
            "unreadable authority must not unlock writes"
        );
    }

    #[tokio::test]
    async fn control_invalid_version_is_serialization() {
        let dir = TempDir::new().unwrap();
        write_invalid_version_control(dir.path(), 1);
        let p = LocalSyncProvider::new(dir.path().to_path_buf()).with_recovery_fence(1, None);
        let err = p
            .write_file("dev-a/entries/eid1.bin", b"blocked")
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::Serialization(_)),
            "semantically invalid control.json must be Serialization, not live authority, got {err:?}"
        );
        assert!(
            !dir.path()
                .join("generations/g-1/dev-a/entries/eid1.bin")
                .exists(),
            "invalid control version must not unlock writes"
        );
    }

    #[tokio::test]
    async fn clear_cloud_does_not_delete_payload_when_control_parse_fails() {
        let (dir, p) = fixture();
        write_invalid_version_control(dir.path(), 1);
        plant_wipe_payload(dir.path());

        let err = p.clear_cloud_preserving_control().await.unwrap_err();
        assert!(
            matches!(err, SyncError::Serialization(_)),
            "invalid control.json must fail closed as Serialization, got {err:?}"
        );
        assert!(
            wipe_payload_present(dir.path()),
            "cleanup must not delete payload when control.json fails validate"
        );
    }

    #[tokio::test]
    async fn clear_cloud_garbage_control_is_serialization_and_leaves_payload() {
        let (dir, p) = fixture();
        write_garbage_control(dir.path());
        plant_wipe_payload(dir.path());

        let err = p.clear_cloud_preserving_control().await.unwrap_err();
        assert!(
            matches!(err, SyncError::Serialization(_)),
            "truncated control.json must be Serialization, not missing/None, got {err:?}"
        );
        assert!(
            wipe_payload_present(dir.path()),
            "cleanup must not delete payload when control.json fails to parse"
        );
    }

    #[tokio::test]
    async fn clear_cloud_missing_control_is_auth_and_leaves_payload() {
        let (dir, p) = fixture();
        plant_wipe_payload(dir.path());

        let err = p.clear_cloud_preserving_control().await.unwrap_err();
        assert!(
            matches!(err, SyncError::Auth(_)),
            "missing control.json must be Auth, got {err:?}"
        );
        assert!(
            wipe_payload_present(dir.path()),
            "dev-a/ and .meta/keyring must remain when control.json is absent"
        );
    }

    #[tokio::test]
    async fn clear_cloud_fence_mismatch_is_auth_and_leaves_payload() {
        let dir = TempDir::new().unwrap();
        write_control(dir.path(), 2);
        plant_wipe_payload(dir.path());
        let p = LocalSyncProvider::new(dir.path().to_path_buf()).with_recovery_fence(1, None);

        let err = p.clear_cloud_preserving_control().await.unwrap_err();
        assert!(
            matches!(err, SyncError::Auth(_)),
            "control gen ≠ local gen must fail closed as Auth, got {err:?}"
        );
        assert!(
            wipe_payload_present(dir.path()),
            "dev-a/ and .meta/keyring must remain on fence mismatch"
        );
    }

    #[tokio::test]
    async fn best_effort_delete_missing_device_is_ok() {
        let (_dir, p) = fixture();
        p.best_effort_delete_device_namespace("dev-a")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn best_effort_delete_removes_device_tree() {
        let (dir, p) = fixture();
        std::fs::create_dir_all(dir.path().join("dev-a/entries")).unwrap();
        std::fs::write(dir.path().join("dev-a/entries/e1.bin"), b"x").unwrap();

        p.best_effort_delete_device_namespace("dev-a")
            .await
            .unwrap();
        assert!(
            !dir.path().join("dev-a").exists(),
            "existing device tree must be removed"
        );
    }

    #[tokio::test]
    async fn best_effort_delete_fence_mismatch_is_auth_and_does_not_delete() {
        let dir = TempDir::new().unwrap();
        write_control(dir.path(), 2);
        std::fs::create_dir_all(dir.path().join("dev-a/entries")).unwrap();
        std::fs::write(dir.path().join("dev-a/entries/e1.bin"), b"x").unwrap();
        let p = LocalSyncProvider::new(dir.path().to_path_buf()).with_recovery_fence(1, None);

        let err = p
            .best_effort_delete_device_namespace("dev-a")
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::Auth(_)),
            "fence mismatch must be Auth, got {err:?}"
        );
        assert!(
            dir.path().join("dev-a/entries/e1.bin").exists(),
            "fence mismatch must not delete the device tree"
        );
    }

    #[tokio::test]
    async fn best_effort_delete_invalid_device_id_is_io_before_join() {
        let (dir, p) = fixture();
        std::fs::create_dir_all(dir.path().join("dev-a")).unwrap();
        for bad in ["../evil", "..", "../"] {
            let err = p
                .best_effort_delete_device_namespace(bad)
                .await
                .unwrap_err();
            assert!(
                matches!(err, SyncError::Io(_)),
                "invalid device_id {bad:?} must be Io before path join, got {err:?}"
            );
        }
        assert!(
            dir.path().join("dev-a").exists(),
            "rejected device_id must not touch sibling folders"
        );
    }

    #[tokio::test]
    async fn root_is_empty_unreadable_root_is_auth() {
        let (dir, p) = fixture();
        let root = dir.path().to_string_lossy().into_owned();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let original = std::fs::metadata(dir.path()).unwrap().permissions();
            std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o000)).unwrap();
            let result = p.root_is_empty(&root).await;
            std::fs::set_permissions(dir.path(), original).unwrap();
            let err = result.expect_err("unreadable vault root must be Err");
            assert!(
                matches!(err, SyncError::Auth(_)),
                "PermissionDenied on root must be Auth, not Ok(true)/NotFound, got {err:?}"
            );
        }

        #[cfg(not(unix))]
        {
            let _ = (p, root);
        }
    }
}
