# memlore-core fixtures

## desktop-vault.v1.json

A throwaway vault written by the real desktop code (first-run setup,
`publish_v2_keyring_with_provider`, and `SyncEngine::sync_now` through a
generation-fenced `LocalSyncProvider`), frozen as JSON:

- `files`: every file the desktop wrote into the cloud dir, path to base64 (the
  production layout `generations/g-0/<deviceId>/...` plus `.meta/*`).
- `recovery_phrase`, `password`, `device_id`, `generation`.
- `expected`: the plaintext (titles, content, tags, emotion, media bytes, version).

All data is synthetic: the BIP39 all-zero test vector (`abandon ... art`) and the
password `12345678`.

### This file is the BACKWARD-COMPAT ORACLE

It pins the frozen v0.1.0 wire formats. Today's desktop and `memlore-core` must
keep decoding it (`golden_desktop_fixture_decodes`, and the WASM/web goldens).

**Never regenerate it casually.** Regenerating from today's code makes the oracle
agree with whatever today's code writes, which hides exactly the format
regressions it exists to catch. If a test reading it fails, fix the code, not the
fixture. Regenerate only for a deliberate, reviewed fixture change.

### Regenerate (deliberate use only)

```bash
cd src-tauri
MEMLORE_REGEN_FIXTURES=1 cargo test golden_desktop_fixture_regen -- --ignored
```

The generator is `#[ignore]`d and also checks the env var, so without both it
writes nothing. The JSON is excluded from prettier (`.prettierignore`); do not
reflow it.

## web-envelopes.v1.json

A V2 media envelope, a thumbnail and an entry envelope sealed by the WASM build
(`memlore-wasm`, `test-sealers`) under the keys of `desktop-vault.v1.json`, plus the
expected plaintexts. The native tests `golden_web_envelopes_*` in `envelope.rs` open
them with the content keys unwrapped from the desktop vault (WASM to native parity;
the reverse direction is `web/src/core/core.wasm.test.ts`).

Same rules as the desktop oracle: never regenerate casually. The generator refuses to
overwrite the file unless `MEMLORE_REGEN_FIXTURES=1`:

```bash
MEMLORE_REGEN_FIXTURES=1 pnpm web:fixture:envelopes
```

`web:fixture:outbox` (Phase 14.3) is a separate script and never regenerates this file.
