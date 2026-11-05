// Saving a drawing from the Paint module.
//
// The save dialog runs here rather than in JS, and the path it returns never
// crosses to the webview before the write. That keeps this from being a "write
// any bytes to any path" command, which fs.rs has so far avoided being.

use tauri::ipc::{InvokeBody, Request};
use tauri_plugin_dialog::DialogExt;

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(PNG_SIGNATURE)
}

/// Ask where to save, then write the PNG in the request's raw body. Returns the
/// path written, or `None` if the user cancelled the dialog.
#[tauri::command]
pub async fn paint_save_png(
    app: tauri::AppHandle,
    request: Request<'_>,
) -> Result<Option<String>, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the PNG as a raw request body.".into());
    };
    if !is_png(bytes) {
        return Err("That is not a PNG.".into());
    }
    let bytes = bytes.clone();

    // A blocking worker because the dialog waits on the user, and it can't be
    // the main thread, which the dialog itself runs on.
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .set_file_name("drawing.png")
            .add_filter("PNG image", &["png"])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = path.into_path().map_err(|e| e.to_string())?;
        std::fs::write(&path, &bytes).map_err(|e| format!("Could not save: {e}"))?;
        Ok(Some(path.display().to_string()))
    })
    .await
    .map_err(|e| format!("Could not save: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::is_png;

    #[test]
    fn accepts_only_the_png_signature() {
        assert!(is_png(b"\x89PNG\r\n\x1a\nrest"));
        assert!(!is_png(b"\x89PNG"));
        assert!(!is_png(b"#!/bin/sh\n"));
        assert!(!is_png(b""));
    }
}
