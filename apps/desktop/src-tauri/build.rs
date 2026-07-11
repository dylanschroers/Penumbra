fn main() {
    // Rerun when the sidecar asset drop-in dirs change, so fetching the model /
    // llama-server after a build still gets them copied into target as
    // resources (tauri-build only tracks its config files by default).
    println!("cargo:rerun-if-changed=binaries");
    println!("cargo:rerun-if-changed=models");
    tauri_build::build()
}
