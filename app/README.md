# NaturalVoice

App nội bộ mô phỏng workflow Dgt Auto TTS: import `.srt`/`.txt`, chia item, gọi AIVIE MCP, lưu audio vào máy.

## Chạy

```powershell
cd C:\Users\MTC\Documents\Codex\2026-10-09\https-app-aivie-pro-api-v1\app
npm start
```

Mở:

```text
http://127.0.0.1:3177
```

## Kết nối AIVIE

1. Vào AIVIE > Kết nối API > Khoá API & MCP.
2. Tạo/copy API key.
3. Dán vào ô `API Key` trong app.
4. Bấm `Kết nối`.
5. Chọn tool TTS mà AIVIE trả về trong danh sách.

Endpoint mặc định:

```text
https://app.aivie.pro/api/v1/mcp
```

## Output

Audio và file SRT tạo ra được lưu tại:

```text
C:\Users\MTC\Documents\Codex\2026-10-09\https-app-aivie-pro-api-v1\app\output
```

## Hai luồng import

### Subtitles

Dùng các nút trong thanh `Subtitles`:

- `Import File (*.srt;*.txt;*.dgt)`: import từng file riêng.
- `Import Folder`: import một thư mục file lẻ `.srt/.txt/.dgt`.
- `Start`: chạy queue hiện tại.

File lẻ được lưu dưới:

```text
app\output\single-import\<ten-file>\1.mp3
```

### Batch Job

Dùng ô chọn folder trong phần `Batch Job`.

- Chỉ lấy file `.txt`.
- Mỗi file `.txt` tạo một thư mục con riêng chứa các voice clip lẻ: `1.mp3`, `2.mp3`, `3.mp3`...
- **3 file kết quả tổng hợp nằm ở thư mục cha bên ngoài folder voice lẻ (cùng cấp với folder voice lẻ):**
  1. `<Tên file>_full.mp3` (file audio ghép hoàn chỉnh)
  2. `<Tên file>.srt` (file phụ đề)
  3. `join-list.txt` (danh sách ghép ffmpeg)

Ví dụ cấu trúc output:
```text
Thư mục gốc/
  story-a.txt
  story-a.srt
  story-a_full.mp3
  join-list.txt
  story-a/
    1.mp3
    2.mp3
    3.mp3
```

## Lưu ý

App sẽ tự chọn tool có vẻ liên quan tới TTS nhất sau khi kết nối. Nếu chọn sai, đổi ở dropdown tool.

Phần `Cài đặt nâng cao` cho phép đổi tên field gửi lên MCP. Mặc định app gửi:

- `text`: nội dung cần đọc
- `voice_id`: tên hoặc voice ID
- `model`: model
- `voice_settings`: speed/stability/similarity/style/speaker boost
- `language`: ngôn ngữ

Nếu AIVIE trả schema khác, chỉnh các ô field cho khớp tên tham số.
