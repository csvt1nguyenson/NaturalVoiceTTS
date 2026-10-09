# Handoff: AIVIE Local TTS Studio

## Mục tiêu

Dựng app nội bộ mô phỏng workflow `Dgt Auto TTS Subtitles (evlabs) 5.21`, dùng AIVIE MCP API thay vì automation browser cũ.

App chạy local tại:

```text
http://127.0.0.1:3177
```

Source:

```text
C:\Users\MTC\Documents\Codex\2026-10-09\https-app-aivie-pro-api-v1\app
```

Chạy:

```powershell
cd C:\Users\MTC\Documents\Codex\2026-10-09\https-app-aivie-pro-api-v1\app
npm start
```

## File chính

```text
app\server.js
app\public\index.html
app\public\app.js
app\public\styles.css
app\data\local-config.json
app\output\
```

`local-config.json` lưu API key cục bộ. Không commit/share file này nếu có key thật.

## AIVIE MCP endpoint

```text
https://app.aivie.pro/api/v1/mcp
```

Auth header:

```text
Authorization: Bearer <aivie_api_key>
```

App đã hỗ trợ ô API Key nhận:

- raw key `aiv_...`
- `Bearer aiv_...`
- lệnh Claude MCP
- JSON MCP config

Sau khi bấm `Lưu key`, key được lưu tại:

```text
app\data\local-config.json
```

## MCP tools đã thấy

Qua `/api/status` sau khi connect:

```text
get_balance
list_voices
search_voice_library
add_library_voice
estimate_tts
estimate_dialogue
estimate_lines
create_tts_job
create_dialogue_job
create_lines_job
get_job
list_jobs
cancel_job
get_audio_link
```

Quan trọng: `create_tts_job` KHÔNG trả audio trực tiếp. Flow đúng:

1. `create_tts_job`
2. lấy `job_id`
3. poll `get_job`
4. khi `status === completed`, gọi `get_audio_link`
5. tải mp3 về local output

## Voice library

UI đã có:

- `Search`: gọi `search_voice_library`
- `+ Add to Library`: gọi `add_library_voice`
- `Library (Vip+)`: gọi `list_voices`
- kết quả render trong `#voiceResults`

Bug đã sửa:

- `search_voice_library` trả field `voice_id`, còn `list_voices` trả `id`.
- Code hiện có `voiceId(voice)` để support cả hai.
- Nếu nhập/paste chuỗi giống voice ID, ví dụ:

```text
TyV764UpbFWIbpktlOOT
```

thì app set thẳng `Voice ID`, không gọi search shared library, tránh nhảy sang voice khác.

Test UI đã pass:

- Input `TyV764UpbFWIbpktlOOT` -> `Voice ID = TyV764UpbFWIbpktlOOT`
- Input `David Documentary` -> search ra 10 kết quả, first là `David - Audiobook & Documentary`, id `cCYjmrGZaI86GUJ7F2Nn`

## Batch Job logic yêu cầu

Batch Job và Subtitles là hai luồng riêng giống app gốc.

App gốc metadata trong `DgtAutoTTS.exe` có:

```text
btnBatch_Click
BatchJob
dgvBatchJob
btnStart_Click
dgvSubtitles
btnJoinMp3
btnOpenOutput
btnImportVoice
```

### Batch Job

- Dùng để import cả thư mục lớn chứa nhiều `.txt`.
- UI có bảng file riêng: `Id / FileName / Status`.
- Mỗi file `.txt` tạo một thư mục output riêng.
- Mỗi dòng không trống trong file `.txt` tạo một clip voice riêng.
- Nếu file có 5 dòng, output:

```text
1.mp3
2.mp3
3.mp3
4.mp3
5.mp3
```

Nút `Chạy hàng loạt` chỉ chạy Batch Job, không phải Subtitles.

### Subtitles

- `Import File (*.srt;*.txt;*.dgt)` dùng cho file lẻ.
- `.srt`: tách theo block subtitle.
- `.txt/.dgt`: tách theo từng dòng không trống.
- `Start` chỉ chạy file/rows đang hiển thị hiện tại.

Đã thêm guard: trước khi chạy, nếu row còn chứa nhiều dòng thì `normalizeSourceItems(source)` tách lại theo dòng để không gửi cả file/cả cục text lên AIVIE.

## NAS path

Người dùng dùng NAS mapped drive:

```text
Y: = \\kavomedia\TaiNguyen
Z: = \\KAVO73NGXI\Tai Lieu
```

Trong `server.js` có `driveAliases` để đổi `Y:\...` sang UNC nếu process không thấy mapped drive.

Server cần chạy với quyền ngoài sandbox để đọc NAS và mở Explorer.

## Output

Output root:

```text
app\output
```

Ví dụ:

```text
app\output\batch\<folder>\<file>\1.mp3
app\output\single-import\<file>\1.mp3
```

`Open Audio Output` gọi `/api/open-output` và mở Explorer.

`Join Mp3 & Tạo srt` gọi `/api/join`:

- tạo `.srt`
- dùng `D:\SON HOANG\2. DATA\DgtAutoEleven\ffmpeg.exe`
- ghép `1.mp3`, `2.mp3`, ... thành `<base>_full.mp3`

> [!IMPORTANT]
> **Quy tắc tổ chức file Output:**
> - Các file voice clip lẻ (`1.mp3`, `2.mp3`, `3.mp3`...) được lưu trong thư mục con mang tên file.
> - **3 file tổng hợp bắt buộc phải nằm ở thư mục cha bên ngoài folder voice lẻ:**
>   1. `<tên_file>_full.mp3` (file ghép audio hoàn chỉnh)
>   2. `<tên_file>.srt` (file phụ đề)
>   3. `join-list.txt` (danh sách file ghép)

Nếu chưa có mp3, vẫn tạo SRT và warning `Chưa có file MP3 để ghép.`

## Vấn đề hiện tại / cần sửa tiếp

### 1. AIVIE job vẫn queued

Job test đã tạo:

```text
job_id: 3b78aa28-a17f-476a-865d-1988e3ca1a1c
status: queued
title: AIVIE Local TTS
voice: ppLqTilh7rH7fbUVlXsf
model: eleven_v3
characters: 118
credits: 118
created_at: 2026-10-09T04:16:26.543Z
```

AIVIE UI báo `Đang chờ`.

Có thể do:

- AIVIE đang sự cố/mất điện.
- queue model `eleven_v3` bị kẹt.
- concurrent limit.

Nên thêm UI:

- `Refresh jobs`
- `Cancel queued job`
- hiển thị list_jobs gần nhất
- nếu job queued lâu, suggest cancel/retry model khác

### 2. Pipeline poll render mới thêm nhưng cần test kỹ

Đã thêm endpoint:

```text
POST /api/start-render
POST /api/poll-render
```

Frontend `callTool()` flow mới:

```text
Creating job -> Waiting AIVIE -> Rendering/AIVIE queued -> Done
```

Cần test sau khi AIVIE queue hoạt động lại.

### 3. Không tự confirm cost

AIVIE tool description bảo nên gọi `estimate_*` và confirm cost trước `create_*`.

App hiện tạo job trực tiếp. Vì đây là app nội bộ user muốn tự động batch, có thể chấp nhận, nhưng nên thêm:

- checkbox `Estimate before render`
- hoặc field `max_credits`

Hiện `create_tts_job` args chưa truyền `max_credits`.

### 4. Voice settings mapping còn thiếu

AIVIE `voice_params` chỉ support:

```text
speed
pitch
volume
emotion
language
```

App UI còn có:

```text
stability
similarity
style
speaker boost
```

Những field này là ElevenLabs cũ, AIVIE MCP schema hiện không nhận trong `voice_params`. Hiện code chỉ gửi `speed` và `language`, bỏ các field còn lại để tránh schema reject.

Cần quyết định:

- ẩn các field không dùng khi provider là AIVIE
- hoặc map nếu AIVIE bổ sung schema sau

### 5. Import Voice placeholder

`Import Voice` hiện chỉ log placeholder:

```js
log("Import Voice sẽ dùng khi có file voice library/template...")
```

Cần hỏi user file import voice là format gì trong app gốc.

### 6. Advanced settings còn thiếu

Từ metadata app gốc còn các option:

```text
nThread
nMaxTextLength
ckSplitSrt
ckFixedSplit
txtAutoSplitData
ckDelayBySrt
ckDelayJoin
nDelayJoinTime
ckSilentByCharacter
nSilent1
nSilent2
ckAutoCut
ckAutoNormal
ckHide
ckTcpHook
ckUseLocalToken
nLocalTokenPort
nDgtTokenTabs
cbbDownloadMode
cbbDownloadType
```

Chưa làm.

### 7. UI hiện còn hơi khác app gốc

Người dùng rất nhạy việc UI/logic lệch app gốc. Những điểm đã bị phàn nàn và đã sửa:

- Batch Job không được hiện `Choose File`, phải là folder path + `...`/`Import Folder`.
- Batch file list phải hiện file `.txt` riêng trong `dgvBatchJob`.
- Subtitles dưới chỉ hiện segments của file đang chọn/đang chạy.
- `Chạy hàng loạt` là riêng Batch Job.
- Import file lẻ cũng phải tách theo dòng/block.
- Source column chỉ hiển thị tên file, không full path.
- Search voice ID phải set đúng voice ID, không tự nhảy kết quả khác.
- Không default `David`.

## Suggested next work order

1. Test `start-render/poll-render` khi AIVIE queue chạy lại.
2. Add Jobs panel:
   - `list_jobs`
   - status
   - `cancel_job`
   - `get_audio_link` for completed.
3. Add `max_credits` or estimate step.
4. Polish UI to match original:
   - Voice row buttons alignment
   - Proxy box placeholder if needed
   - Options box on right
5. Implement `Import Voice` only after confirming file format.

