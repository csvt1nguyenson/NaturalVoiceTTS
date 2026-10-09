# NaturalVoice

App desktop (Windows) chuyển text/subtitle thành giọng nói hàng loạt qua AIVIE MCP API.

- `app/` – giao diện web (Tailwind) và `server.js` để chạy chế độ web.
- `desktop-tauri/` – bản desktop Tauri, backend viết bằng Rust, không cần Node khi chạy.

## Cài đặt
Tải installer mới nhất ở [Releases](https://github.com/csvt1nguyenson/NaturalVoiceTTS/releases). Mở app, dán API key AIVIE, bấm Kết nối.
App tự kiểm tra và báo khi có bản mới.

## Build
```powershell
cd app && npm install && npm run build:css
cd ../desktop-tauri && npm install && npm run build
```

## Phát hành bản mới
1. Tăng `version` trong `desktop-tauri/src-tauri/tauri.conf.json`.
2. `cd desktop-tauri && npm run release -- -Notes "Mô tả thay đổi"`.

Cần file khoá ký `desktop-tauri/.tauri-keys/naturalvoice.key` (không commit) và đã `gh auth login`.
