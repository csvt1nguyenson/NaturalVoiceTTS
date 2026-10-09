mod backend;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![backend::api])
        .setup(|app| {
            let backend = backend::Backend::new(app.handle());
            app.manage(backend);
            // Mở cửa sổ theo ~85% màn hình chính và căn giữa, để hợp với mọi độ phân giải.
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = win.current_monitor() {
                    let size = monitor.size();
                    let scale = monitor.scale_factor();
                    let w = ((size.width as f64 / scale) * 0.85).clamp(1100.0, 2200.0);
                    let h = ((size.height as f64 / scale) * 0.85).clamp(720.0, 1400.0);
                    let _ = win.set_size(tauri::LogicalSize::new(w, h));
                    let _ = win.center();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running NaturalVoice Desktop");
}
