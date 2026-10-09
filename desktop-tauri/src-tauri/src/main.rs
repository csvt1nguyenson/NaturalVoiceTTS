// Ẩn cửa sổ console đen khi chạy bản release trên Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    naturalvoice_desktop_lib::run();
}
