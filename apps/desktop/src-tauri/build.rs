fn main() {
    // tauri-build embeds the Common-Controls v6 manifest into the application binary, but cargo
    // gives test binaries no manifest at all. Without it the Windows loader binds comctl32 v5,
    // which lacks the `TaskDialogIndirect` entry point that tauri's dialog and tray stack imports,
    // so every test binary dies at load with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139) before a
    // single test runs. Embedding the same dependency into test binaries only leaves the
    // application manifest, and therefore the app's visual styles, untouched.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let manifest = std::path::PathBuf::from(
            std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string()),
        )
        .join("tests")
        .join("windows-test.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }

    tauri_build::build()
}
