//! WebKitGTK tuning for a drawing app on Linux.
//!
//! - GPU 2D canvas: without it WebKitGTK rasterizes canvases on the CPU and
//!   re-uploads them every frame, which drops a HiDPI board to ~30 fps.
//! - No 60 fps cap: WebKit throttles page rendering to ~60 fps even on faster
//!   displays, so on a 120 Hz screen the ink and overlays trail the cursor.

use std::ffi::{c_char, c_void, CStr};

use gtk::glib::{self, ObjectType};
use gtk::prelude::*;
use tauri::WebviewWindow;
use webkit2gtk::WebViewExt;

pub fn apply(window: &WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|wv| {
        let view: webkit2gtk::WebView = wv.inner();
        let Some(settings) = WebViewExt::settings(&view) else {
            return;
        };
        log("2d canvas acceleration", enable_canvas_acceleration(&settings));
        log("60 fps cap removed", disable_60fps_cap(&settings));
    })
}

fn log(what: &str, ok: bool) {
    if cfg!(debug_assertions) || !ok {
        eprintln!("notes: {what}: {}", if ok { "yes" } else { "not available in this WebKitGTK" });
    }
}

/// The setting was renamed across WebKitGTK versions; use whichever exists.
fn enable_canvas_acceleration(settings: &webkit2gtk::Settings) -> bool {
    for name in ["enable-2d-canvas-acceleration", "enable-accelerated-2d-canvas"] {
        if settings.find_property(name).is_some() {
            settings.set_property(name, true);
            return settings.property::<bool>(name);
        }
    }
    false
}

type GetAll = unsafe extern "C" fn() -> *mut c_void;
type ListLen = unsafe extern "C" fn(*mut c_void) -> usize;
type ListGet = unsafe extern "C" fn(*mut c_void, usize) -> *mut c_void;
type ListUnref = unsafe extern "C" fn(*mut c_void);
type FeatureId = unsafe extern "C" fn(*mut c_void) -> *const c_char;
type SetEnabled = unsafe extern "C" fn(*mut c_void, *mut c_void, glib::ffi::gboolean);

/// Looks a WebKitGTK function up at runtime, so a missing one disables the
/// tweak instead of stopping the app from starting.
unsafe fn sym<T: Copy>(name: &CStr) -> Option<T> {
    let p = libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr());
    (!p.is_null()).then(|| std::mem::transmute_copy(&p))
}

/// Turns off the `PreferPageRenderingUpdatesNear60FPS` feature through the
/// feature-list API (WebKitGTK 2.42+).
fn disable_60fps_cap(settings: &webkit2gtk::Settings) -> bool {
    unsafe {
        let (Some(get_all), Some(len), Some(get), Some(unref), Some(ident), Some(set)) = (
            sym::<GetAll>(c"webkit_settings_get_all_features"),
            sym::<ListLen>(c"webkit_feature_list_get_length"),
            sym::<ListGet>(c"webkit_feature_list_get"),
            sym::<ListUnref>(c"webkit_feature_list_unref"),
            sym::<FeatureId>(c"webkit_feature_get_identifier"),
            sym::<SetEnabled>(c"webkit_settings_set_feature_enabled"),
        ) else {
            return false;
        };
        let list = get_all();
        if list.is_null() {
            return false;
        }
        let mut found = false;
        for i in 0..len(list) {
            let feature = get(list, i);
            let id = ident(feature);
            if !id.is_null() && CStr::from_ptr(id).to_bytes() == b"PreferPageRenderingUpdatesNear60FPS" {
                set(settings.as_ptr() as *mut c_void, feature, glib::ffi::GFALSE);
                found = true;
                break;
            }
        }
        unref(list);
        found
    }
}
