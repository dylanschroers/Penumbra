fn main() {
    // tauri-build only tracks its own config, so rerun when assets are dropped in.
    println!("cargo:rerun-if-changed=binaries");
    println!("cargo:rerun-if-changed=models");
    tauri_build::build()
}
