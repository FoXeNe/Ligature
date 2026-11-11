//! Pinch-to-zoom on Linux.
//!
//! WebKitGTK handles a touchpad or touchscreen pinch itself by magnifying the
//! whole page, and (as of 2.54) has neither an API to turn that off nor a way
//! to pass the gesture to the page. So the app switches WebKit's own zoom
//! gesture off and installs its own, forwarding each step to the frontend as a
//! `pinch` event; the canvas and the graph then zoom themselves.

use std::cell::Cell;
use std::ffi::CString;
use std::rc::Rc;

use gtk::glib;
use gtk::glib::translate::{FromGlibPtrNone, ToGlibPtr};
use gtk::prelude::*;
use serde::Serialize;
use tauri::{Emitter, WebviewWindow};

/// One pinch step. `x`/`y` are in CSS pixels relative to the webview.
#[derive(Clone, Serialize)]
struct Pinch {
    factor: f64,
    x: f64,
    y: f64,
}

pub fn install(window: &WebviewWindow) -> tauri::Result<()> {
    let emitter = window.clone();
    window.with_webview(move |wv| {
        let view: webkit2gtk::WebView = wv.inner();
        if !disable_webkit_zoom(&view) {
            eprintln!("notes: WebKit zoom gesture not found; pinch may still zoom the page");
        }

        let gesture = gtk::GestureZoom::new(&view);
        // Capture phase runs before WebKit's own handlers on the same widget.
        gesture.set_propagation_phase(gtk::PropagationPhase::Capture);

        let last = Rc::new(Cell::new(1.0_f64));
        {
            let last = last.clone();
            gesture.connect_begin(move |g, _| {
                last.set(1.0);
                g.set_state(gtk::EventSequenceState::Claimed);
            });
        }
        gesture.connect_scale_changed(move |g, scale| {
            if scale <= 0.0 {
                return;
            }
            // GTK reports the scale since the gesture began; the frontend wants steps.
            let factor = scale / last.get();
            last.set(scale);
            let (x, y) = g.bounding_box_center().unwrap_or((0.0, 0.0));
            let _ = emitter.emit("pinch", Pinch { factor, x, y });
        });

        // The gesture must live as long as the view; the view owns it from here.
        unsafe { view.set_data("notes-pinch-gesture", gesture) };
    })
}

/// WebKitGTK keeps its pinch gesture as object data on the view. Setting its
/// phase to `None` stops it from handling events without touching WebKit's
/// signal handlers. Returns false if this WebKit version stores it elsewhere.
fn disable_webkit_zoom(view: &webkit2gtk::WebView) -> bool {
    let key = CString::new("wk-view-zoom-gesture").expect("static key");
    unsafe {
        let obj: *mut glib::gobject_ffi::GObject = view.upcast_ref::<glib::Object>().to_glib_none().0;
        let ptr = glib::gobject_ffi::g_object_get_data(obj, key.as_ptr());
        if ptr.is_null() {
            return false;
        }
        let gesture = gtk::Gesture::from_glib_none(ptr as *mut gtk::ffi::GtkGesture);
        gesture.set_propagation_phase(gtk::PropagationPhase::None);
    }
    true
}
