//! Hardware-accelerated 2D canvas on Linux.
//!
//! Without it WebKitGTK rasterizes canvases on the CPU and re-uploads them every
//! frame. On a HiDPI window the two full-size canvas layers then drop panning
//! and pen input to ~30 fps; with acceleration they hold 60 fps.

use gtk::prelude::*;
use tauri::WebviewWindow;
use webkit2gtk::WebViewExt;

/// The setting was renamed across WebKitGTK versions; use whichever exists,
/// so the app still starts on older system WebKitGTK builds.
const NAMES: [&str; 2] = ["enable-2d-canvas-acceleration", "enable-accelerated-2d-canvas"];

pub fn enable(window: &WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|wv| {
        let view: webkit2gtk::WebView = wv.inner();
        let Some(settings) = WebViewExt::settings(&view) else {
            return;
        };
        for name in NAMES {
            if settings.find_property(name).is_some() {
                settings.set_property(name, true);
                #[cfg(debug_assertions)]
                eprintln!("notes: {name} = {}", settings.property::<bool>(name));
                return;
            }
        }
        eprintln!("notes: this WebKitGTK has no 2D canvas acceleration setting");
    })
}
