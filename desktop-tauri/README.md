# NaturalVoice Desktop (Tauri)

Bản desktop đóng gói từ web app trong `../app`. Người dùng cuối chỉ cần chạy installer,
mở app, dán API key AIVIE và bấm Kết nối. Không cần cài Node hay ffmpeg.

## Cấu trúc

- Giao diện: dùng thẳng `../app/public` (không copy, sửa web là sửa desktop).
- Backend: `../app/server.js` được bundle bằng esbuild rồi đóng thành 1 exe (Node SEA)
  tại `src-tauri/binaries/naturalvoice-server-x86_64-pc-windows-msvc.exe`. Tauri khởi động
  nó làm sidecar trên cổng ngẫu nhiên và tắt khi đóng app.
- ffmpeg: `src-tauri/resources/ffmpeg.exe` được đóng kèm.
- Config (API key): `%APPDATA%\vn.kavomedia.naturalvoice\local-config.json`
- Output mặc định: `Documents\NaturalVoice`

## Build

Yêu cầu: Node 22+, Rust stable, NSIS (Tauri tự tải).

```powershell
cd D:\NaturalVoice\desktop-tauri
npm install
npm run build
```

Installer: `src-tauri\target\release\bundle\nsis\NaturalVoice_1.0.0_x64-setup.exe`

Chạy thử không cài: `npm run dev`.

Chỉ build lại backend (sau khi sửa `server.js`): `npm run build:server`.
