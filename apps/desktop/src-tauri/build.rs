fn main() {
    // tauri-build embeds the Common-Controls v6 manifest into the application binary, but cargo
    // gives test binaries no manifest at all. Without one, the Windows loader binds comctl32 v5,
    // which has no `TaskDialogIndirect` entry point - the one tauri's dialog and tray stack
    // imports - so test binaries abort at load with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)
    // before a single test runs.
    //
    // Cargo offers no per-target link argument for a library's unit-test binary: `-tests` applies
    // only to integration-test targets, and a plain link argument also reaches the application
    // binary, where tauri-build already supplies the same manifest resource (a second RT_MANIFEST
    // with id 1 would be a duplicate-resource link error). The manifest is therefore embedded only
    // when IRIS_TEST_MANIFEST is set, which the release and verify workflows set for the Windows
    // test step; that step runs `cargo test --lib`, so no bin target is linked in the same
    // invocation and the application manifest is never affected.
    println!("cargo:rerun-if-env-changed=IRIS_TEST_MANIFEST");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var_os("IRIS_TEST_MANIFEST").is_some()
    {
        let manifest = std::path::PathBuf::from(
            std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string()),
        )
        .join("windows-test.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }

    tauri_build::build()
}
