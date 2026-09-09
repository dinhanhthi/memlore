fn main() {
    load_dotenv_for_oauth();
    link_macos_photo_picker();
    tauri_build::build()
}

// Link the macOS PhotoPicker Swift package via swift-rs.
//
// The Swift package targets macOS 13+ (matches `LSMinimumSystemVersion` in
// `Info.plist`). The first build invokes `swift build`, which adds ~10s on
// a cold cache; subsequent builds are incremental and cached.
//
// Linking is gated to macOS only — Linux/Windows builds skip Swift entirely.
fn link_macos_photo_picker() {
    #[cfg(target_os = "macos")]
    {
        swift_rs::SwiftLinker::new("13.0")
            .with_package("PhotoPicker", "./swift/PhotoPicker")
            .link();
    }
}

// Surface OAuth credentials from `.env` to `option_env!()` at compile time.
//
// `option_env!` is evaluated by the compiler from the process environment when
// the macro site is built. Cargo doesn't auto-load `.env`, and Tauri's
// `beforeDevCommand` only feeds env vars into Vite (frontend), not into cargo.
// Without this hook, `pnpm tauri dev` rebuilds the Rust crate without the
// developer's GDRIVE_CLIENT_ID/SECRET, so the binary keeps the placeholder
// values and Google's OAuth returns `invalid_client`.
fn load_dotenv_for_oauth() {
    const KEYS: &[&str] = &[
        "GDRIVE_CLIENT_ID",
        "GDRIVE_CLIENT_SECRET",
        "GOOGLE_FONTS_API_KEY",
        "MEMLORE_MAPKIT_TOKEN",
    ];

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../.env");
    for key in KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }

    let Ok(contents) = std::fs::read_to_string("../.env") else {
        return;
    };

    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((k, v)) = trimmed.split_once('=') else {
            continue;
        };
        let key = k.trim();
        if !KEYS.contains(&key) {
            continue;
        }
        // A real env var always wins over the .env file.
        if std::env::var_os(key).is_some() {
            continue;
        }
        let value = v.trim().trim_matches('"').trim_matches('\'');
        // Reject control characters (notably a bare CR) so a malformed `.env`
        // value cannot break out of the `cargo:rustc-env=...` directive and
        // inject a second cargo directive on the next "line" cargo sees.
        // `str::lines()` already strips `\n` / `\r\n`, but a lone `\r` would
        // survive into `value` and cargo would treat what follows as a new
        // line of stdout.
        if value.chars().any(|c| c.is_control()) {
            println!("cargo:warning=ignoring {key} from .env: value contains control characters");
            continue;
        }
        println!("cargo:rustc-env={key}={value}");
    }
}
