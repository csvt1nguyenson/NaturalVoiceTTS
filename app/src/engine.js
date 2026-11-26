export const state = {
  items: [],
  batchFiles: [],
  activeSource: "",
  running: false,
  done: 0,
  processing: 0,
  connectedTools: [],
  voiceResults: [],
  outputDir: "",
  concurrentLimit: 0,
  batchMode: false,
  pausedUntil: 0,
  ui: { logs: [], logCount: 0, connection: { kind: "off", text: "Chưa kết nối" }, credit: "-", concurrentLimit: "-", quota: null, statusLabel: "Sẵn sàng", statusOutput: "", voiceMeta: "Chưa chọn voice.", keyHint: "Key lưu trên máy này.", savedVoices: [], voiceToSave: null, confirm: null, run: null, lastRun: "", jobs: [], jobsOpen: false, modal: null, update: null }
};
const listeners = new Set();
let version = 0, scheduled = false;
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const getVersion = () => version;
export function notify() {
  if (scheduled) return;
  scheduled = true;
  const flush = () => { if (!scheduled) return; scheduled = false; version++; listeners.forEach((fn) => fn()); };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  setTimeout(flush, 100);
}

const $ = (id) => document.getElementById(id);
// Desktop (Tauri): toàn bộ backend nằm trong Rust, gọi qua invoke("api").
// Web: gọi HTTP tới server.js như cũ.
const TAURI = typeof window === "undefined" ? null : window.__TAURI__ || null;
const IS_DESKTOP = Boolean(TAURI?.core?.invoke);
const API_BASE = "";
const apiFetch = async (path, options = {}) => {
  if (!IS_DESKTOP) return fetch(`${API_BASE}${path}`, options);
  let body = {};
  if (options.body) {
    try { body = JSON.parse(options.body); } catch { body = {}; }
  }
  const res = await TAURI.core.invoke("api", { request: { method: options.method || "GET", path, body } });
  return { ok: res.status < 400, status: res.status, json: async () => res.body, text: async () => JSON.stringify(res.body) };
};
// Mở file/thư mục đã lưu trên máy (desktop) thay cho link tải về (web).
function fileLink(filePath, label) {
  if (!filePath) return "";
  if (IS_DESKTOP) return `<a href="#" class="file-link" data-open-path="${escapeHtml(filePath)}">${escapeHtml(label)}</a>`;
  return `<a class="file-link" href="${API_BASE}/api/download-file?path=${encodeURIComponent(filePath)}" target="_blank">${escapeHtml(label)}</a>`;
}
let logLines = 0;
function appendLog(text, cls = "") {
  const ui = state.ui;
  ui.logs.push({ id: ++logLines, text, kind: cls.replace("log-", "") || "normal" });
  if (ui.logs.length > 800) ui.logs.shift();
  ui.logCount = logLines;
  queueLogFile(`[AIVIE] ${text}`);
  notify();
}
const log = (message) => appendLog(`[${new Date().toLocaleTimeString("vi-VN")}] ${message}`, /lỗi|error|failed/i.test(String(message)) ? "log-error" : "");
// ---------- Log ghi ra file theo ngày (Documents\NaturalVoice\logs) ----------
const logFile = { queue: [], timer: 0 };
function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function queueLogFile(line) {
  logFile.queue.push(line);
  if (!logFile.timer) logFile.timer = setTimeout(flushLogFile, 400);
}
async function flushLogFile() {
  logFile.timer = 0;
  const lines = logFile.queue.splice(0);
  if (!lines.length) return;
  try { await apiFetch("/api/log-append", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: localDate(), lines }) }); } catch {}
}
// queueLogFile(`===== [AIVIE] Mở NaturalVoice ${localDate()} ${new Date().toLocaleTimeString("vi-VN")} =====`);


let lastServerLogIndex = 0;
async function pollServerLogs() {
  try {
    const res = await apiFetch(`/api/logs?since=${lastServerLogIndex}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.logs && data.logs.length) {
      for (const line of data.logs) appendLog(`[SERVER] ${line}`, "log-server");
      lastServerLogIndex = data.total;
    }
  } catch {}
}


const ACTIVE = new Set(["Creating job", "Waiting AIVIE", "Rendering", "Processing"]);
function isDone(item) { return item.status === "Done" || item.status === "Done (no audio)"; }
function isActive(item) { return ACTIVE.has(item.status) || /^AIVIE /.test(item.status || ""); }

function updateTitle() { updateStatusBar(); notify(); }

function updateStatusBar() {
  const all = state.items, done = all.filter(isDone).length;
  state.ui.statusLabel = state.running ? (state.pausedUntil > Date.now() ? state.ui.statusLabel : "Đang chạy") : (all.length && done === all.length ? "Hoàn tất" : "Sẵn sàng");
  state.ui.statusOutput = state.outputDir ? `Output: ${state.outputDir}` : "";
  notify();
}

function statusView(status, error) {
  const s = String(status || "Queued");
  if (isDone({ status: s })) return { kind: "done", label: "Done", title: error || s };
  if (s === "Error") return { kind: "error", label: "Lỗi", title: error || s };
  const labels = { "Creating job": "Đang tạo job", "Waiting AIVIE": "AIVIE queued", "AIVIE queued": "AIVIE queued", "Rendering": "Đang render", "AIVIE rendering": "Đang render", "Processing": "Đang render", "AIVIE finalizing": "Chờ audio" };
  return s in labels || s.startsWith("AIVIE ") ? { kind: "run", label: labels[s] || s.slice(6), title: error || s } : { kind: "queued", label: "Chờ", title: error || s };
}

function visibleItems() {
  if (!state.activeSource) return state.items;
  return state.items.filter((item) => item.source === state.activeSource);
}

function renderRows() { updateTitle(); }

function renderBatchFiles() { notify(); }

function fileStatus(source) {
  const items = state.items.filter((item) => item.source === source);
  if (!items.length) return "";
  if (items.some(isActive)) return "Processing";
  if (items.some((item) => item.status === "Error")) return "Error";
  if (items.every(isDone)) return "Done";
  return "Queued";
}

// Nạp lại cùng một file sẽ nhân đôi dòng và tốn credit gấp đôi.
function alreadyLoaded(source, name) {
  if (!state.items.some((item) => item.source === source)) return false;
  log(`Bỏ qua ${name}: đã có trong danh sách. Muốn nạp lại thì bấm Xoá danh sách trước.`);
  return true;
}
function registerBatchFile(source, name) {
  if (!state.batchFiles.some((file) => file.source === source)) {
    state.batchFiles.push({ source, name });
  }
  if (!state.activeSource) state.activeSource = source;
}

function selectBestTool(tools, selectedTool) {
  if (!tools.length) return "";
  if (selectedTool) return selectedTool;
  const keywords = ["tts", "text_to_speech", "speech", "voice", "audio", "generate"];
  return [...tools].sort((a, b) => scoreTool(b, keywords) - scoreTool(a, keywords))[0].name;
}

function scoreTool(tool, keywords) {
  const haystack = `${tool.name || ""} ${tool.description || ""}`.toLowerCase();
  return keywords.reduce((sum, keyword) => sum + (haystack.includes(keyword) ? 1 : 0), 0);
}

function toolHelp(toolName) {
  const tool = state.connectedTools.find((item) => item.name === toolName);
  if (!tool?.inputSchema) return "";
  return JSON.stringify(tool.inputSchema, null, 2);
}

function parseToolPayload(result) {
  if (result?.structuredContent) return result.structuredContent;
  for (const item of result?.content || []) {
    if (item.type === "text" && item.text) {
      try { return JSON.parse(item.text); } catch {}
    }
  }
  return result || {};
}

async function callMcpTool(toolName, args = {}) {
  const response = await apiFetch("/api/call-tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toolName, args, fileBaseName: "tool" })
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || `${toolName} failed`);
  return parseToolPayload(data.result);
}

function renderVoiceResults(voices = []) {
  state.voiceResults = voices;
  if (voices.length) applyVoice(voices[0]);
  notify();
}

function voiceId(voice) {
  return voice?.id || voice?.voice_id || "";
}

function voiceModels(voice) {
  if (voice?.models?.length) return voice.models;
  if (voice?.verified_languages?.length) {
    return [...new Set(voice.verified_languages.map((item) => item.model_id).filter(Boolean))];
  }
  return [];
}

async function resolveLibraryVoice(voice) {
  const id = voiceId(voice);
  if (!id) return voice;
  try {
    const search = voice.name && voice.name !== id ? voice.name : "";
    for (let page = 0; page < 20; page += 1) {
      const data = await callMcpTool("list_voices", { search, page, page_size: 50 });
      const found = (data.voices || []).find((item) => voiceId(item) === id);
      if (found) return found;
      if (!data.has_more) break;
    }
    return voice;
  } catch (error) {
    log(`Không kiểm tra được model library cho ${id}: ${error.message}`);
    return voice;
  }
}

async function validateVoiceModel() {
  if (!isAivieTtsTool()) return true;
  const id = $("voiceId").value.trim();
  if (!id) { log("Chưa chọn Voice ID."); return false; }
  const current = $("model").value;
  if (current.startsWith("el_") || current.startsWith("dv_")) return true;
  const voice = await resolveLibraryVoice({ id, name: $("voiceName").value.trim() });
  if (!voice.models?.length) {
    log(`Voice ${id} không có trong AIVIE Library hoặc chưa có model khả dụng. Hãy thêm voice vào Library trước khi chạy.`);
    return false;
  }
  applyVoice(voice);
  log(`Đã kiểm tra model cho ${voice.name}: ${$("model").value}.`);
  return true;
}

async function showDirectVoiceId(voiceIdValue) {
  $("voiceId").value = voiceIdValue;
  try {
    // Tra Shared Voice Library vì voice có thể chưa được add vào Library cá nhân.
    // Chỉ nhận kết quả khớp đúng ID, không lấy kết quả gần đúng.
    const data = await callMcpTool("search_voice_library", { search: voiceIdValue, page_size: 10 });
    const found = (data.voices || []).find((voice) => voiceId(voice) === voiceIdValue);
    if (found) {
      renderVoiceResults([await resolveLibraryVoice(found)]);
      log(`Đã nhận voice ID và tên: ${found.name} (${voiceIdValue})`);
      return;
    }
  } catch {}
  renderVoiceResults([{ id: voiceIdValue, name: voiceIdValue, models: [$("model").value || "eleven_v3"] }]);
  log(`Đã nhận voice ID trực tiếp: ${voiceIdValue}`);
}

async function applySelectedVoice() {
  const voice = state.voiceResults[Number($("voiceResults").value)];
  if (!voice) return;
  applyVoice(await resolveLibraryVoice(voice));
}

function applyVoice(voice) {
  $("voiceName").value = voice.name || "";
  $("voiceId").value = voiceId(voice);
  const models = voiceModels(voice);
  // AIVIE: model đầu tiên trong danh sách là mặc định tương thích với voice.
  if (models.length) {
    const current = $("model").value;
    let group = $("model").querySelector("#libraryModels");
    if (!group) {
      group = document.createElement("optgroup");
      group.id = "libraryModels";
      group.label = "Model của voice trong AIVIE Library";
      $("model").prepend(group);
    }
    group.replaceChildren(...models.filter((model) => !Array.from($("model").querySelectorAll("optgroup:not(#libraryModels) option")).some((option) => option.value === model))
      .map((model) => new Option(model, model)));
    if (!current.startsWith("el_") && !current.startsWith("dv_")) {
      $("model").value = models.find((model) => model === current)
        || models.find((model) => model === `${current}_b`)
        || models[0];
      syncOwnKeyFields();
    }
  }
  const gender = voice.gender === "male" ? "nam" : voice.gender === "female" ? "nữ" : voice.gender || "";
  const meta = [voice.language ? `Ngôn ngữ gốc <strong class="font-medium text-ink-2">${escapeHtml(voice.language)}</strong>` : "", gender, models.length ? `chạy được ${escapeHtml(models.join(", "))}` : ""].filter(Boolean).join(" · ");
  state.ui.voiceMeta = [voice.language ? `Ngôn ngữ gốc ${voice.language}` : "", gender, models.length ? `chạy được ${models.join(", ")}` : ""].filter(Boolean).join(" · ") || "Chưa chọn voice."; notify();
  log(`Chọn voice: ${voice.name || voiceId(voice)} (${voiceId(voice)})`);
}

async function searchVoiceLibrary() {
  const search = $("voiceName").value.trim();
  if (/^[A-Za-z0-9_-]{20,64}$/.test(search)) {
    await showDirectVoiceId(search);
    return;
  }
  const data = await callMcpTool("search_voice_library", {
    search,
    page_size: 20,
    ...( $("language").value && $("language").value !== "auto" ? { language: $("language").value } : {} )
  });
  renderVoiceResults(data.voices || []);
  if (data.voices?.length) applyVoice(await resolveLibraryVoice(data.voices[0]));
  log(`Search voice library: ${(data.voices || []).length}/${data.total ?? "?"} kết quả.`);
}

async function loadVoiceLibrary() {
  const search = $("voiceName").value.trim();
  if (/^[A-Za-z0-9_-]{20,64}$/.test(search)) {
    await showDirectVoiceId(search);
    return;
  }
  const data = await callMcpTool("list_voices", {
    search,
    page_size: 50,
    ...( $("language").value && $("language").value !== "auto" ? { language: $("language").value } : {} )
  });
  renderVoiceResults(data.voices || []);
  log(`Library: ${(data.voices || []).length}/${data.total ?? "?"} voice dùng được.`);
}

async function addSelectedVoice() {
  let voice = state.voiceResults[Number($("voiceResults").value)];
  if (!voice && $("voiceId").value.trim()) voice = { id: $("voiceId").value.trim(), name: $("voiceName").value.trim() };
  const id = voiceId(voice);
  if (!id) {
    log("Chưa chọn voice để add.");
    return;
  }
  await callMcpTool("add_library_voice", { voice_id: id });
  log(`Đã add vào library: ${voice.name || id}`);
  await loadVoiceLibrary();
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
}

function parseSrt(text) {
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  const parsed = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    const timing = timeIndex >= 0 ? lines[timeIndex].split("-->").map((value) => value.trim()) : [];
    const body = lines.slice(timeIndex >= 0 ? timeIndex + 1 : 0).join(" ").trim();
    if (body) parsed.push({ text: body, startTime: timing[0] || "", endTime: timing[1] || "" });
  }
  return parsed.length ? parsed : (text.trim() ? [{ text: text.trim(), startTime: "", endTime: "" }] : []);
}

function parseTxtByLine(text) {
  return text.replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
}

function splitItemIntoLines(item) {
  const chunks = parseTxtByLine(item.text);
  if (chunks.length <= 1) return [item];
  return chunks.map((chunk, index) => ({
    ...item,
    text: chunk,
    part: index + 1,
    status: "Queued",
    output: "",
    jobId: ""
  }));
}

function normalizeSourceItems(source) {
  const next = [];
  let changed = false;
  for (const item of state.items) {
    if (item.source === source) {
      const split = splitItemIntoLines(item);
      if (split.length > 1) changed = true;
      next.push(...split);
    } else {
      next.push(item);
    }
  }
  if (changed) {
    state.items = next;
    log(`Đã tách lại file ${source} theo từng dòng trước khi chạy.`);
    renderBatchFiles();
    renderRows();
  }
}

// Tách một dòng thành nhiều câu theo "Ký tự tách" (chỉ khi bật Tự tách câu file lẻ).
function splitText(text) {
  const line = String(text || "").trim();
  if (!line) return [];
  if (!$("autoSplit")?.checked) return [line];
  const chars = ($("splitChars")?.value || ".?!").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!chars) return [line];
  const re = new RegExp(`[^${chars}]+[${chars}]*`, "g");
  const parts = Array.from(line.matchAll(re)).map((m) => m[0].trim()).filter(Boolean);
  // Ghép mảnh quá ngắn (vd. "1." hay "Mr.") vào mảnh trước để không tạo clip rác.
  const merged = [];
  for (const part of parts) {
    if (merged.length && part.length < 12) merged[merged.length - 1] += " " + part;
    else merged.push(part);
  }
  return merged.length ? merged : [line];
}

function fileStem(name) {
  return String(name).replace(/\.[^.]+$/, "");
}

async function addSingleFiles(files, mode = "single") {
  const entries = [];
  for (const file of files) {
    entries.push({ name: file.name, text: await file.text(), relativePath: file.webkitRelativePath || file.name });
  }
  addSingleEntries(entries, mode);
}

// entries: [{ name, text, relativePath?, fullPath? }]
function addSingleEntries(entries, mode = "single") {
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    const chunks = lower.endsWith(".srt")
      ? parseSrt(entry.text)
      : parseTxtByLine(entry.text).flatMap(splitText).map((value) => ({ text: value }));
    const source = entry.fullPath || entry.relativePath || entry.name;
    const relative = entry.relativePath || entry.name;
    if (alreadyLoaded(source, entry.name)) continue;
    registerBatchFile(source, fileStem(entry.name));
    // Có đường dẫn thật (desktop): lưu cạnh file gốc như khi Quét thư mục.
    const dir = entry.fullPath ? entry.fullPath.replace(/[\\/][^\\/]*$/, "") : "";
    const folder = dir ? `${dir}\\${fileStem(entry.name)}` : mode === "folder" ? `folder-import/${fileStem(relative)}` : `single-import/${fileStem(entry.name)}`;
    chunks.forEach((chunk, index) => state.items.push({
      text: chunk.text,
      startTime: chunk.startTime || "",
      endTime: chunk.endTime || "",
      source,
      fileName: entry.name,
      outputFolder: folder,
      part: index + 1,
      status: "Queued",
      output: ""
    }));
    state.activeSource = source;
    log(`Import file riêng ${entry.name}: ${chunks.length} item(s)`);
  }
  renderBatchFiles();
  renderRows();
}

// Desktop: chọn file/thư mục bằng hộp thoại hệ thống rồi nhờ backend đọc nội dung.
async function pickAndImportSingle(mode) {
  const dialog = TAURI?.dialog;
  if (!dialog?.open) return false;
  if (mode === "folder") {
    const folder = await dialog.open({ directory: true, multiple: false, title: "Chọn thư mục chứa .srt/.txt/.dgt" });
    if (!folder) return true;
    log(`Đang quét: ${folder}`);
    const response = await apiFetch("/api/scan-folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folderPath: folder, extensions: [".srt", ".txt", ".dgt"] })
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || "Không quét được thư mục.");
    addSingleEntries(data.files.map((file) => ({ name: file.name, text: file.text, relativePath: file.relativePath, fullPath: file.fullPath })), "folder");
    return true;
  }
  const picked = await dialog.open({ multiple: true, directory: false, title: "Chọn file", filters: [{ name: "Subtitles/Text", extensions: ["srt", "txt", "dgt"] }] });
  if (!picked) return true;
  const paths = Array.isArray(picked) ? picked : [picked];
  const response = await apiFetch("/api/read-files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths })
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "Không đọc được file.");
  addSingleEntries(data.files.map((file) => ({ name: file.name, text: file.text, fullPath: file.fullPath })), "single");
  return true;
}

async function pickBatchFolder() {
  const dialog = TAURI?.dialog;
  if (!dialog?.open) return false;
  const folder = await dialog.open({ directory: true, multiple: false, title: "Chọn thư mục Batch Job (.txt)" });
  if (!folder) return true;
  $("batchFolderName").value = folder;
  await scanBatchPath();
  return true;
}

async function addBatchFolder(files) {
  const txtFiles = Array.from(files).filter((file) => file.name.toLowerCase().endsWith(".txt"));
  if (!txtFiles.length) {
    log("Batch Folder không thấy file .txt nào.");
    return;
  }
  const basePath = $("batchFolderName").value.trim();
  const isDiskPath = /^[a-zA-Z]:[\\/]|^\\\\/.test(basePath);
  for (const file of txtFiles) {
    const text = await file.text();
    const chunks = parseTxtByLine(text);
    const relative = file.webkitRelativePath || file.name;
    if (alreadyLoaded(relative, file.name)) continue;
    const stem = fileStem(file.name);
    // Nếu có đường dẫn ổ đĩa nhập ở ô batchFolderName thì lưu thẳng vào ổ đĩa kế bên txt
    const folder = isDiskPath ? `${basePath}\\${stem}` : `batch/${fileStem(relative)}`;
    registerBatchFile(relative, stem);
    chunks.forEach((chunk, index) => state.items.push({
      text: chunk,
      source: relative,
      fileName: file.name,
      outputFolder: folder,
      part: index + 1,
      status: "Queued",
      output: ""
    }));
    log(`Batch import ${relative}: ${chunks.length} dòng -> thư mục: ${folder}`);
  }
  renderBatchFiles();
  renderRows();
}

function addBatchTextFile(file) {
  if (alreadyLoaded(file.fullPath || file.relativePath || file.name, file.name)) return;
  const chunks = parseTxtByLine(file.text);
  // Tạo folder con mang tên file ngay tại nơi có file txt
  const stem = fileStem(file.name);
  const folder = file.dirPath ? `${file.dirPath}\\${stem}` : `batch/${fileStem(file.relativePath || file.name)}`;
  registerBatchFile(file.fullPath || file.relativePath || file.name, stem);
  chunks.forEach((chunk, index) => state.items.push({
    text: chunk,
    source: file.fullPath || file.relativePath || file.name,
    fileName: file.name,
    outputFolder: folder,
    part: index + 1,
    status: "Queued",
    output: ""
  }));
  log(`Batch import ${file.name}: ${chunks.length} dòng -> thư mục: ${folder}`);
}

async function scanBatchPath() {
  const folderPath = $("batchFolderName").value.trim();
  if (!folderPath) {
    log("Chưa nhập đường dẫn thư mục batch.");
    return;
  }
  log(`Đang quét: ${folderPath}`);
  const response = await apiFetch("/api/scan-folder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ folderPath })
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    log(data.error || "Không quét được thư mục.");
    return;
  }
  $("batchFolderName").value = data.folderPath;
  log(`Tìm thấy ${data.count} file .txt.`);
  data.files.forEach(addBatchTextFile);
  renderBatchFiles();
  renderRows();
}

function buildArgs(text) {
  if (isAivieTtsTool()) {
    const voice = $("voiceId").value || $("voiceName").value;
    const modelVal = $("model").value || "eleven_v3";
    const isOwnKey = modelVal.startsWith("el_") || modelVal.startsWith("dv_");
    const args = {
      title: "NaturalVoice TTS",
      text,
      voice,
      model: modelVal,
      render_mode: "fast",
      key_source: isOwnKey ? "own" : "aivie"
    };
    const maxCredits = Number($("maxCredits")?.value || 0);
    if (maxCredits > 0) args.max_credits = Math.floor(maxCredits);
    if ($("useSettings").checked) {
      args.voice_params = { speed: Number($("speed").value) };
      // Chỉ gửi language trong voice_params cho model KHÔNG phải ElevenLabs
      const isElevenLabs = modelVal.includes("eleven");
      if (!isElevenLabs && $("language").value && $("language").value !== "auto") {
        args.voice_params.language = $("language").value;
      }
    }
    return args;
  }
  const args = {};
  args[$("textField").value || "text"] = text;
  if ($("voiceId").value || $("voiceName").value) args[$("voiceField").value || "voice_id"] = $("voiceId").value || $("voiceName").value;
  if ($("model").value) args[$("modelField").value || "model"] = $("model").value;
  if ($("language").value && $("language").value !== "auto") args[$("languageField").value || "language"] = $("language").value;
  return args;
}

function itemTitle(item) {
  const name = fileStem(item.fileName || item.source || "AIVIE Local TTS");
  return `${name} - ${item.part || 1}`;
}

async function refreshBalance() {
  const data = await callMcpTool("get_balance");
  state.ui.credit = data.balance ?? data.credits ?? data.aivie_credits ?? "-";
  const limit = Number(data.concurrent_render_limit ?? data.concurrent_limit ?? data.concurrency_limit ?? data.concurrency ?? 0);
  state.concurrentLimit = limit; state.ui.concurrentLimit = limit || "-";
  if (limit > 0 && $("concurrency")) {
    const sel = $("concurrency"), current = Number(sel.value) || 3;
    sel.innerHTML = Array.from({ length: Math.min(limit, 10) }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("");
    sel.value = String(Math.min(current, limit));
  }
  log("Balance: " + state.ui.credit + " credits."); notify();
}

async function refreshJobs() {
  const data = await callMcpTool("list_jobs", { limit: 20 });
  state.ui.jobs = data.jobs || data.items || (Array.isArray(data) ? data : []);
  log("Đã tải " + state.ui.jobs.length + " job AIVIE."); notify();
}

async function cancelJob(jobId) {
  await callMcpTool("cancel_job", { job_id: jobId });
  log("Đã yêu cầu hủy job " + jobId + ".");
  await refreshJobs();
}

function setConnection(kind, text) { state.ui.connection = { kind, text }; notify(); }

async function connect() {
  setConnection("busy", "Đang kết nối…");
  const response = await apiFetch("/api/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: $("mcpUrl").value, apiKey: $("apiKey").value })
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "Connect failed");
  state.connectedTools = data.tools || [];
  const bestTool = selectBestTool(state.connectedTools, data.selectedTool);
  $("toolSelect").innerHTML = state.connectedTools.map((tool) =>
    `<option value="${escapeHtml(tool.name)}">${escapeHtml(tool.name)}${tool.description ? ` - ${escapeHtml(tool.description).slice(0, 80)}` : ""}</option>`
  ).join("");
  // Nhớ tool người dùng chọn lần trước (create_tts_job hoặc create_lines_job).
  let savedTool = "";
  try { savedTool = localStorage.getItem("nv.tool") || ""; } catch {}
  const pick = state.connectedTools.some((t) => t.name === savedTool) ? savedTool : bestTool;
  if (pick) $("toolSelect").value = pick;
  syncToolMode(false);
  setConnection("on", `Đã kết nối · ${data.keyCount || 1} key`);
  if (data.quota) renderQuota(data.quota);
  log(`MCP connected. Auto chọn tool: ${bestTool || "không có tool"}.`);
}

async function saveKey() {
  const response = await apiFetch("/api/save-key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: $("mcpUrl").value, apiKey: $("apiKey").value })
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "Save key failed");
  $("apiKey").value = "";
  state.ui.keyHint = `Đã lưu ${data.keyCount || 1} key trên máy này. App tự xoay vòng khi một key hết lượt.`;
  log(`Đã lưu ${data.keyCount || 1} API key.`);
  refreshQuota();
}

async function clearKey() {
  const response = await apiFetch("/api/clear-key", { method: "POST" });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "Clear key failed");
  $("apiKey").value = "";
  state.ui.keyHint = "Đã xoá key đã lưu.";
  renderQuota({ keys: [], used: 0, total: 0, free: 0 });
  log("Đã xoá API key đã lưu.");
}

// AIVIE báo v3/v4 tạm bảo trì (job.model_v2_only, chưa trừ credit): hỏi một lần, đồng ý thì gửi lại với accept_v2.
// Các dòng chạy song song gặp cùng lỗi thì chờ chung một popup. Đồng ý được nhớ tới khi đóng app.
let acceptV2 = false;
let v2Prompt = null;
function isV2OnlyError(error) { return /model_v2_only|accept_v2|bằng v2/i.test(String(error?.message || error)); }
function askAcceptV2(message) {
  if (acceptV2) return Promise.resolve(true);
  if (!state.running) return Promise.resolve(false);
  if (!v2Prompt) v2Prompt = new Promise((resolve) => {
    const close = (ok) => {
      state.ui.modal = null; v2Prompt = null;
      if (ok) { acceptV2 = true; log("Đã đồng ý render bằng Multilingual v2 trong lúc v3/v4 bảo trì."); }
      else { state.running = false; updateStatusBar(); log("Không đồng ý render bằng v2, đã dừng. Chạy lại sau hoặc đổi model/giọng khác."); }
      notify(); resolve(ok);
    };
    state.ui.modal = { message, confirm: () => close(true), cancel: () => close(false) }; notify();
  });
  return v2Prompt;
}
// Gọi /api/start-render. Idempotency key lưu ở holder[keyName]; khi có accept_v2 dùng key riêng vì nội dung gửi đã khác.
// V4 bảo trì: thử v3 (vẫn đọc audio tag) trước khi hỏi v2. Nhớ kết quả tới khi đóng app.
let v3Works = null;
const v3Of = (model) => (/^eleven_v4(_b)?$/.test(model || "") ? model.replace("v4", "v3") : "");
async function startRender(body, holder, keyName) {
  if (v3Works === true && v3Of(body.args.model)) body.args.model = v3Of(body.args.model);
  const send = async () => {
    const k = acceptV2 ? `${keyName}V2` : keyName;
    if (acceptV2) body.args.accept_v2 = true;
    // Mã chống trùng chỉ dùng lại khi nội dung y hệt; đổi model/giọng/text thì AIVIE báo "đã dùng cho nội dung khác".
    const { idempotency_key, ...rest } = body.args;
    const sig = JSON.stringify(rest);
    if (holder[`${k}Sig`] !== sig) { holder[k] = crypto.randomUUID(); holder[`${k}Sig`] = sig; }
    body.args.idempotency_key = holder[k];
    const res = await apiFetch("/api/start-render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Start render failed");
    return data;
  };
  try { return await send(); }
  catch (error) {
    if (!isV2OnlyError(error) || body.args.accept_v2) throw error;
    const v4 = body.args.model, v3 = v3Works === false ? "" : v3Of(v4);
    if (v3) {
      body.args.model = v3;
      try {
        const data = await send();
        if (v3Works !== true) log(`Eleven v4 đang bảo trì, chuyển sang ${v3} tới khi đóng app.`);
        v3Works = true;
        return data;
      } catch (e) {
        if (!isV2OnlyError(e)) throw e;
        v3Works = false; body.args.model = v4;
      }
    }
    if (!await askAcceptV2(error.message)) throw new Error("Không đồng ý render bằng v2 (v3/v4 đang bảo trì).");
    return await send();
  }
}

// Job đã tạo mà lỗi lúc chờ/tải: lần sau hỏi lại đúng job đó, không gửi yêu cầu tạo mới.
// Khác nội dung, giọng, model hoặc nơi lưu thì không dùng lại.
async function startOrResume(holder, request, keyName, prepare) {
  const signature = JSON.stringify(request);
  if (holder.pendingJob?.signature === signature) {
    log(`Hỏi lại AIVIE job ${holder.pendingJob.jobId}, không tạo job mới.`);
    return holder.pendingJob.jobId;
  }
  holder.pendingJob = null;
  await prepare?.();
  const { jobId } = await startRender(request, holder, keyName);
  holder.pendingJob = { jobId, signature };
  return jobId;
}
async function waitForPendingJob(holder, jobId, target) {
  try {
    const result = await waitForJobResult(jobId, target);
    holder.pendingJob = null;
    return result;
  } catch (error) {
    if (error.jobEnded) holder.pendingJob = null;
    // Job kẹt hàng chờ AIVIE: lần chạy lại tạo job mới ngay (mã chống trùng mới), không chờ lại job cũ.
    if (error.stale) for (const key of Object.keys(holder)) if (key.endsWith("Sig")) delete holder[key];
    throw error;
  }
}

async function callTool(item, index) {
  if (!state.batchMode) state.activeSource = item.source;
  item.status = "Creating job";
  renderBatchFiles();
  renderRows();
  if ($("toolSelect").value === "create_tts_job") {
    const renderArgs = { ...buildArgs(item.text), title: itemTitle(item) };
    const estimateFirst = async () => {
      if (!$("estimateBeforeRender")?.checked) return;
      const estimate = await callMcpTool("estimate_tts", renderArgs);
      const credits = Number(estimate.credits ?? estimate.aivie_credits ?? 0);
      const maxCredits = Number($("maxCredits")?.value || 0);
      if (maxCredits > 0 && credits > maxCredits) throw new Error("Estimate vượt Max credits.");
      log("Estimate dòng " + (item.part || index + 1) + ": " + (credits || "?") + " credits.");
    };
    const jobId = await startOrResume(item, {
      args: renderArgs,
      fileBaseName: `item-${index + 1}`,
      outputFolder: item.outputFolder || "single-import",
      clipNumber: item.part || index + 1
    }, "idempotencyKey", estimateFirst);
    item.jobId = jobId;
    item.status = "Waiting AIVIE";
    log(`AIVIE job ${jobId}: queued`);
    renderBatchFiles();
    renderRows();
    // Chờ poller dùng chung báo kết quả (một request cho mọi job, tiết kiệm hạn mức API).
    const polled = await waitForPendingJob(item, jobId, item);
    item.status = polled.saved ? "Done" : "Done (no audio)";
    item.output = polled.saved?.filename || "";
    item.fullPath = polled.saved?.fullPath || "";
    log(`${fileStem(item.fileName || "")} #${index}: ${item.status}${item.output ? ` -> ${item.output}` : ""}`);
    renderBatchFiles();
    renderRows();
    return;
  }
  item.status = "Processing";
  renderRows();
  const response = await apiFetch("/api/call-tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      toolName: $("toolSelect").value,
      args: buildArgs(item.text),
      fileBaseName: `item-${index + 1}`,
      outputFolder: item.outputFolder || "single-import",
      clipNumber: item.part || index + 1
    })
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "Tool call failed");
  item.status = data.saved ? "Done" : "Done (no audio)";
  item.output = data.saved?.filename || "";
  log(`Item ${index + 1}: ${item.status}${item.output ? ` -> ${item.output}` : ""}`);
  renderBatchFiles();
  renderRows();
}


// ---------- Hạn mức tạo job: 60 job/giờ cho mỗi key, app tự xoay key ----------
function renderQuota(q) { if (!q) return; state.quota = q; state.ui.quota = q; notify(); }
async function refreshQuota() {
  try {
    const res = await apiFetch("/api/quota");
    if (res.ok) renderQuota(await res.json());
  } catch {}
}


// ---------- Poller dùng chung: 1 request list_jobs cho tất cả job đang chạy ----------
const activeJobs = new Map(); // jobId -> { item, resolve, reject, since }
let pollerTimer = null;
const POLL_EVERY_MS = 10000;
function waitForJobResult(jobId, item) {
  return new Promise((resolve, reject) => {
    activeJobs.set(jobId, { item, resolve, reject, since: Date.now() });
    if (!pollerTimer) pollerTimer = setTimeout(pollActiveJobs, POLL_EVERY_MS);
  });
}
async function pollActiveJobs() {
  pollerTimer = null;
  if (!activeJobs.size) return;
  if (state.pausedUntil > Date.now()) { pollerTimer = setTimeout(pollActiveJobs, 5000); return; }
  const ids = Array.from(activeJobs.keys());
  try {
    const res = await apiFetch("/api/poll-many", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobIds: ids }) });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "poll-many failed");
    for (const id of ids) {
      const entry = activeJobs.get(id); const r = data.jobs?.[id];
      if (!entry || !r) continue;
      if (r.status === "completed" && r.saved) { activeJobs.delete(id); entry.resolve(r); }
      else if (r.status === "completed" && r.error) { activeJobs.delete(id); entry.reject(Object.assign(new Error(r.error), { jobEnded: /Không tìm thấy local render job/.test(r.error) })); }
      else if (r.status === "failed" || r.status === "cancelled" || r.status === "canceled") { activeJobs.delete(id); entry.reject(Object.assign(new Error(`AIVIE job ${r.status}${r.error ? `: ${r.error}` : ""}`), { jobEnded: true })); }
      else if (r.status === "finalizing" && (entry.finalizing = (entry.finalizing || 0) + 1) > 9) {
        // AIVIE báo completed nhưng 90 giây vẫn không có audio: dừng hỏi để không tốn hạn mức API.
        activeJobs.delete(id);
        entry.reject(new Error(`AIVIE báo job ${id} đã xong nhưng không trả audio. Nếu đang dùng create_lines_job, hãy đổi sang create_tts_job.`));
      }
      else {
        entry.item.status = r.status === "rendering" ? "Rendering" : `AIVIE ${r.status}`;
        if (Date.now() - entry.since > 15 * 60 * 1000) { activeJobs.delete(id); entry.reject(Object.assign(new Error(`AIVIE job ${id} chờ quá 15 phút, bỏ qua.`), { jobEnded: true, stale: true })); }
      }
    }
    renderBatchFiles(); renderRows();
  } catch (error) {
    if (isRateLimitError(error)) applyRateLimit(error);
    else log(`Poll lỗi: ${error.message}`);
  }
  if (activeJobs.size) pollerTimer = setTimeout(pollActiveJobs, POLL_EVERY_MS);
}

// AIVIE báo "Thử lại sau N giây": nghỉ đúng N giây, đếm ngược trên thanh trạng thái.
function retryAfterSeconds(error) {
  const m = String(error?.message || error).match(/(\d+)\s*(giây|s|sec|seconds?)/i);
  return m ? Number(m[1]) : 60;
}
let pauseTicker = null;
function applyRateLimit(error) {
  const secs = Math.max(10, retryAfterSeconds(error));
  const until = Date.now() + secs * 1000;
  if (until <= state.pausedUntil) return;
  state.pausedUntil = until;
  log(`Hết lượt tạo job ở mọi key. Tạm nghỉ ${Math.floor(secs / 60)} phút ${secs % 60} giây rồi tự chạy tiếp. Thêm key để không phải chờ.`);
  clearInterval(pauseTicker);
  pauseTicker = setInterval(() => {
    const left = Math.max(0, Math.ceil((state.pausedUntil - Date.now()) / 1000));
    state.ui.statusLabel = left ? `Chờ lượt ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : (state.running ? "Đang chạy" : "Sẵn sàng"); notify();
    if (!left) clearInterval(pauseTicker);
  }, 1000);
}


// ---------- Chế độ "cả file trong 1 job" (create_lines_job) ----------
function usingLinesTool() { return $("toolSelect")?.value === "create_lines_job"; }
function isAivieTtsTool() { return ["create_tts_job", "create_lines_job"].includes($("toolSelect")?.value); }
// create_lines_job luôn chạy theo kiểu "cả file trong 1 job"; create_tts_job theo ô Cách render.
function renderMode() {
  if (usingLinesTool()) return "file";
  return $("renderMode")?.value === "line" ? "line" : "file";
}
// Đồng bộ giao diện khi đổi tool: khoá ô Cách render và ghi rõ đang chạy kiểu nào.
function syncToolMode(announce = true) {
  const sel = $("renderMode");
  if (!sel) return;
  const lines = usingLinesTool();
  if (lines) sel.value = "file";
  sel.disabled = lines;
  sel.title = lines ? "create_lines_job luôn gửi cả file trong 1 job" : "";
  if (announce && isAivieTtsTool()) {
    log(lines
      ? "Đã chuyển sang create_lines_job: mỗi file gửi 1 job kèm mốc thời gian từng dòng, áp dụng cho cả Batch Job và Subtitles."
      : `Đã chuyển sang create_tts_job: ${renderMode() === "file" ? "mỗi file 1 job" : "mỗi dòng 1 job"}.`);
  }
}
function parseSrtSeconds(value) {
  const m = String(value || "").trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000 : null;
}
// Dòng có timing (SRT) thì giữ nguyên; dòng .txt thì ước lượng ~15 ký tự/giây, nghỉ 0.4s giữa các dòng.
function buildTimedLines(items) {
  let cursor = 0;
  return items.map((item) => {
    const text = String(item.text || "").trim();
    const parsedStart = parseSrtSeconds(item.startTime);
    const parsedEnd = parseSrtSeconds(item.endTime);
    const start = parsedStart ?? cursor;
    const end = parsedEnd ?? (start + Math.max(1.5, text.length / 15));
    cursor = Math.max(cursor, end) + 0.4;
    item.startTime = item.startTime || srtStamp(start);
    item.endTime = item.endTime || srtStamp(end);
    return { text, start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) };
  });
}
function srtStamp(sec) {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
}
function parentFolderOf(outputFolder) {
  const f = String(outputFolder || "");
  const idx = Math.max(f.lastIndexOf("\\"), f.lastIndexOf("/"));
  return idx > 0 ? f.slice(0, idx) : "";
}

// Render toàn bộ dòng của một file bằng MỘT create_tts_job (AIVIE nhận tới 100.000 ký tự).
// Kết quả: <tên file>_full.mp3 ở thư mục cha + .srt căn theo thời lượng thật.
async function renderWholeFile(items, label) {
  const first = items[0];
  const base = fileStem(first.fileName || first.source || "output");
  const fullText = items.map((i) => String(i.text || "").trim()).filter(Boolean).join("\n\n");
  if (fullText.length > 100000) throw new Error(`File quá dài (${fullText.length} ký tự, tối đa 100.000). Dùng chế độ Từng dòng.`);
  const useLines = usingLinesTool();
  const args = { ...buildArgs(fullText), title: base.slice(0, 120) };
  if (useLines) { delete args.text; args.lines = buildTimedLines(items); }
  const estimateFirst = async () => {
    if (!$("estimateBeforeRender")?.checked) return;
    const { max_credits, ...estimateArgs } = args;
    const estimate = await callMcpTool(useLines ? "estimate_lines" : "estimate_tts", estimateArgs);
    const credits = Number(estimate.credits ?? estimate.aivie_credits ?? 0);
    const maxCredits = Number($("maxCredits")?.value || 0);
    if (maxCredits > 0 && credits > maxCredits) throw new Error(`Estimate ${credits} vượt Max credit ${maxCredits}.`);
    log(`Estimate ${label}: ${credits || "?"} credits.`);
  };
  // Đổi tool thì dùng key khác, để AIVIE không trả lại job cũ của tool kia.
  const keyName = useLines ? "linesJobKey" : "fileJobKey";
  for (const item of items) item.status = "Creating job";
  renderBatchFiles(); renderRows();
  const outputFolder = parentFolderOf(first.outputFolder) || first.outputFolder || "single-import";
  const jobId = await startOrResume(first, { tool: useLines ? "create_lines_job" : "create_tts_job", args, outputFolder, clipNumber: `${base}_full`, fileBaseName: base }, keyName, estimateFirst);
  log(`AIVIE ${useLines ? "lines job" : "job"} ${jobId}: cả file ${label} (${items.length} dòng, ${fullText.length} ký tự), queued`);
  for (const item of items) { item.status = "Waiting AIVIE"; item.jobId = jobId; }
  renderBatchFiles(); renderRows();
  const polled = await waitForPendingJob(first, jobId, { set status(v) { for (const item of items) item.status = v; } });
  for (const item of items) {
    item.status = polled.saved ? "Done" : "Done (no audio)";
    item.output = polled.saved?.filename || "";
    item.fullPath = polled.saved?.fullPath || "";
  }
  log(`${label}: Done -> ${polled.saved?.fullPath || ""}`);
  // SRT: chia thời lượng thật theo tỉ lệ ký tự từng dòng (dòng SRT gốc giữ timing của nó).
  if (!$("autoSrt").checked) return;
  if (!useLines) assignTimingsByLength(items, Number(polled.duration) || 0);
  try {
    const r = await apiFetch("/api/join", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ outputFolder: first.outputFolder || "single-import", baseName: base, items: items.map((i) => ({ part: i.part, text: i.text, startTime: i.startTime, endTime: i.endTime })) })
    });
    const d = await r.json();
    if (d.srt) log(`Đã tạo SRT: ${d.srtPath || d.srt}`);
  } catch (error) { log(`Tạo SRT lỗi: ${error.message}`); }
  renderBatchFiles(); renderRows();
}

// Nếu dòng chưa có timing: chia tổng thời lượng theo số ký tự, chừa 0.35s nghỉ giữa các dòng.
function assignTimingsByLength(items, totalSeconds) {
  const untimed = items.filter((i) => !parseSrtSeconds(i.startTime) && !parseSrtSeconds(i.endTime));
  if (!untimed.length) return;
  const gap = 0.35;
  const chars = untimed.reduce((n, i) => n + Math.max(1, String(i.text || "").length), 0);
  const speakable = totalSeconds > 0 ? Math.max(1, totalSeconds - gap * (untimed.length - 1)) : chars / 15;
  let cursor = 0;
  for (const item of untimed) {
    const dur = (Math.max(1, String(item.text || "").length) / chars) * speakable;
    item.startTime = srtStamp(cursor);
    item.endTime = srtStamp(cursor + dur);
    cursor += dur + gap;
  }
}

// Chạy nhiều "task" (mỗi task là 1 file) song song, tôn trọng pausedUntil và delay giữa 2 lần tạo job.
// "Tự chạy lại khi lỗi": đưa lại về cuối hàng đợi, suất nào rảnh thì chạy. Tối đa 3 lần để không đốt quota.
const MAX_AUTO_RETRY = 3;
function retryLater(target, error) {
  if (!$("loopMode")?.checked || !state.running) return false;
  if (!isAivieTtsTool()) return false; // tool khác không có mã chống trùng, chạy lại có thể tạo 2 job
  if (/vượt Max credit|Không đồng ý render bằng v2/i.test(error.message)) return false;
  target.autoRetries = (target.autoRetries || 0) + 1;
  if (target.autoRetries > MAX_AUTO_RETRY) return false;
  if (target.status === "Error") { target.status = "Queued"; target.error = ""; }
  log(`Tự chạy lại lần ${target.autoRetries}/${MAX_AUTO_RETRY}: ${target.label || `${target.fileName} dòng ${target.part}`}`);
  return true;
}


async function runFilePool(groups) {
  groups.forEach((g) => { g.autoRetries = 0; });
  let cursor = 0; let ok = 0; let failed = 0; let active = 0;
  const worker = async () => {
    while (state.running) {
      if (cursor >= groups.length) {
        if (!active) return;
        await sleep(250); // file đang chạy có thể lỗi và quay lại hàng đợi
        continue;
      }
      const g = groups[cursor]; cursor += 1; active += 1;
      try {
        await throttleCreate();
        if (!state.running) return;
        await renderWholeFile(g.items, g.label);
        ok += 1;
      } catch (error) {
        for (const item of g.items) { item.status = isRateLimitError(error) ? "Queued" : "Error"; item.error = error.message; }
        if (isRateLimitError(error)) { applyRateLimit(error); groups.push(g); }
        else if (retryLater(g, error)) { g.items.forEach((item) => { item.status = "Queued"; }); log(`${g.label}: ${error.message}`); groups.push(g); }
        else { failed += 1; log(`${g.label}: ${error.message}`); }
        renderBatchFiles(); renderRows();
      } finally { active -= 1; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency(), groups.length) }, worker));
  return { ok, failed };
}

// ---------- Worker pool: chạy nhiều dòng song song ----------
function concurrency() {
  const n = Number($("concurrency")?.value || 3);
  const limit = state.concurrentLimit || 10;
  return Math.max(1, Math.min(n, limit));
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Cách nhau tối thiểu `callDelay` giây giữa hai lần tạo job, dùng chung cho mọi worker.
let nextCreateAt = 0;
async function throttleCreate() {
  const delayMs = Math.max(0, Number($("callDelay")?.value || 2)) * 1000;
  while (state.running && state.pausedUntil > Date.now()) await sleep(1000);
  const now = Date.now();
  const at = Math.max(now, nextCreateAt);
  nextCreateAt = at + delayMs;
  if (at > now) await sleep(at - now);
}

async function runPool(queue, label, onItemDone) {
  const pending = queue.filter((item) => item.status === "Queued" || item.status === "Error");
  if (!pending.length) return { ok: 0, failed: 0 };
  pending.forEach((item) => { item.autoRetries = 0; });
  let cursor = 0; let ok = 0; let failed = 0; let active = 0; const fatal = false;
  const worker = async () => {
    while (state.running) {
      if (cursor >= pending.length) {
        if (!active) return;
        await sleep(250); // dòng đang chạy có thể lỗi và quay lại hàng đợi
        continue;
      }
      const item = pending[cursor]; cursor += 1; active += 1;
      try {
        await throttleCreate();
        if (!state.running) { item.status = "Queued"; return; }
        await callTool(item, item.part || 1);
        ok += 1;
        onItemDone?.(item);
      } catch (error) {
        item.status = "Error";
        item.error = error.message;
        failed += 1;
        log(`${label || item.fileName} dòng ${item.part}: ${error.message}`);
        if (isRateLimitError(error)) {
          applyRateLimit(error);
          item.status = "Queued"; item.error = ""; failed -= 1;
          pending.push(item);
        } else if (retryLater(item, error)) {
          failed -= 1;
          pending.push(item);
        }
        // Dòng lỗi giữ trạng thái Lỗi, các dòng khác vẫn chạy tiếp; cuối batch bấm "Chạy lại lỗi".
        renderBatchFiles(); renderRows();
      } finally { active -= 1; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency(), pending.length) }, worker));
  return { ok, failed, fatal };
}

// Chạy lại riêng các dòng lỗi được chọn (một dòng, hoặc mọi dòng lỗi của một file).
// Dòng đã xong giữ nguyên; file đủ dòng thì tự ghép lại full MP3 + SRT.
async function retryItems(items, all = false) {
  if (state.running) return log("Đang chạy. Chờ xong hoặc bấm Stop rồi mới chạy lại dòng lỗi.");
  if (!$("toolSelect").value) return log("Chưa kết nối AIVIE.");
  const targets = items.filter((item) => item && (all || item.status === "Error"));
  if (!targets.length) return log("Không có dòng lỗi để chạy lại.");
  if (!await validateVoiceModel()) return;
  targets.forEach((item) => { item.status = "Queued"; item.error = ""; });
  state.running = true; state.batchMode = true;
  renderBatchFiles(); renderRows(); updateStatusBar();
  const label = fileStem(targets[0].fileName || targets[0].source || "");
  log(`Chạy lại ${targets.length} dòng${all ? "" : " lỗi"} của ${label}.`);
  try {
    if (renderMode() === "file") {
      const sources = [...new Set(targets.map((item) => item.source))];
      await runFilePool(sources.map((src) => ({ label: fileStem(src.split(/[\\/]/).pop()), items: targets.filter((item) => item.source === src) })));
    } else {
      await runPool(targets, label);
    }
  } finally {
    state.running = false; state.batchMode = false;
    updateStatusBar();
  }
  if (renderMode() === "line" && $("autoSrt").checked) {
    for (const src of new Set(targets.map((item) => item.source))) {
      const all = state.items.filter((item) => item.source === src);
      if (all.every(isDone)) {
        try { await joinItems(all, true); } catch (error) { log(`Ghép lại ${fileStem(src.split(/[\\/]/).pop())}: ${error.message}`); }
      }
    }
  }
  renderBatchFiles(); renderRows();
}

async function startQueue() {
  if (state.running) return log("Đang có queue chạy, bỏ qua lần bấm trùng.");
  if (!$("toolSelect").value) return log("Chưa kết nối AIVIE.");
  if (!await validateVoiceModel()) return;
  if (state.activeSource) normalizeSourceItems(state.activeSource);
  const queue = visibleItems();
  if (!queue.length) return log("Subtitles chưa có dòng nào để chạy.");
  state.running = true; state.batchMode = false;
  updateStatusBar();
  let result;
  if (renderMode() === "file") {
    const groups = [];
    for (const src of [...new Set(queue.map((i) => i.source))]) {
      const items = queue.filter((i) => i.source === src && (i.status === "Queued" || i.status === "Error"));
      if (items.length) groups.push({ items, label: fileStem(items[0].fileName || src) });
    }
    log(`Bắt đầu ${groups.length} file, mỗi file 1 job (cả file), ${concurrency()} song song.`);
    result = await runFilePool(groups);
  } else {
    log(`Bắt đầu ${queue.length} dòng, ${concurrency()} job song song.`);
    result = await runPool(queue, "Subtitles");
  }
  state.running = false;
  updateStatusBar();
  log(`Xong: ${result.ok} thành công, ${result.failed} lỗi.`);
}

async function runBatchJobs() {
  if (state.running) return log("Batch Job đang chạy, bỏ qua lần bấm trùng.");
  if (!$("toolSelect").value) return log("Chưa kết nối AIVIE.");
  if (!await validateVoiceModel()) return;
  if (!state.batchFiles.length) return log("Batch Job chưa có file nào.");
  state.running = true; state.batchMode = true;
  updateStatusBar();
  if (renderMode() === "file") {
    for (const file of state.batchFiles) normalizeSourceItems(file.source);
    const groups = state.batchFiles.map((file) => ({
      file, label: file.name,
      items: state.items.filter((i) => i.source === file.source && (i.status === "Queued" || i.status === "Error"))
    })).filter((g) => g.items.length);
    log(`Batch: ${groups.length} file, mỗi file 1 job, ${concurrency()} file song song.`);
    const result = await runFilePool(groups);
    state.running = false; state.batchMode = false;
    updateStatusBar();
    log(result.failed ? `Batch xong, ${result.failed} file lỗi. Bấm "Chạy lại lỗi" để chạy lại.` : "Đã hoàn tất tất cả file. Audio đã lưu vào thư mục.");
    return;
  }
  // Một pool chung cho mọi part: part ít dòng không làm trống suất song song.
  const queues = new Map();
  for (const file of state.batchFiles) {
    normalizeSourceItems(file.source);
    const queue = state.items.filter((item) => item.source === file.source);
    if (!queue.every(isDone)) queues.set(file.source, { file, queue });
  }
  const joined = new Set(); const joins = [];
  const finish = ({ file, queue }) => {
    if (joined.has(file.source)) return;
    joined.add(file.source);
    log(`Batch kết thúc: ${file.name} -> ${fileStatus(file.source)}`);
    if (!queue.every(isDone)) return; // thiếu dòng thì không ghép, chạy tiếp xong sẽ ghép
    if ($("autoSrt").checked) {
      joins.push(joinItems(queue, true).catch((error) => log(`Ghép ${file.name}: ${error.message}`)));
    }
  };
  if (queues.size) {
    state.activeSource = [...queues.keys()][0];
    renderBatchFiles(); renderRows();
    const all = [...queues.values()].flatMap((q) => q.queue);
    log(`Batch: ${queues.size} part, ${all.filter((i) => !isDone(i)).length} dòng, ${concurrency()} job song song chung.`);
    await runPool(all, "", (item) => {
      const q = queues.get(item.source);
      if (q.queue.every(isDone)) finish(q);
    });
    for (const q of queues.values()) finish(q); // ghi log cả part còn dở
    await Promise.all(joins);
  }
  state.running = false; state.batchMode = false;
  updateStatusBar();
  const errors = state.items.filter((item) => item.status === "Error").length;
  log(state.batchFiles.every((file) => fileStatus(file.source) === "Done")
    ? "Đã hoàn tất tất cả file. Audio đã lưu vào thư mục."
    : errors ? `Batch xong nhưng có ${errors} dòng lỗi. Bấm "Chạy lại lỗi" để chạy lại.`
    : "Batch đã dừng. File chưa xong giữ trạng thái Chờ, bấm Chạy tất cả để tiếp tục.");
}

function stopAll() {
  if (!state.running) return log("Không có gì đang chạy.");
  state.running = false;
  log("Đã yêu cầu dừng. Job đang render sẽ hoàn tất và lưu file, không tạo job mới.");
  updateStatusBar();
}

function retryErrors() {
  (state.batchFiles.length ? state.items : visibleItems()).forEach((item) => {
    if (item.status === "Error") {
      item.status = "Queued";
      item.error = "";
    }
  });
  renderRows();
  renderBatchFiles();
  log("Đã đưa các item lỗi về Queue.");
}

function toSrt() {
  const items = visibleItems();
  if (!items.length) return log("Không có subtitles để tạo SRT.");
  joinItems(items, false);
}

async function downloadAllAudio(targetItems = visibleItems()) {
  const items = targetItems.filter((item) => item.output || item.status === "Done");
  if (!items.length) {
    log("Chưa có file audio nào hoàn thành để tải.");
    return;
  }
  if (IS_DESKTOP) {
    log(`Audio đã nằm sẵn trên máy (${items.length} file). Đang mở thư mục...`);
    await apiFetch("/api/open-output", { method: "POST", body: JSON.stringify({ outputFolder: items[0].outputFolder || "" }) });
    return;
  }
  log(`Bắt đầu tải ${items.length} file audio...`);
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const link = document.createElement("a");
    link.href = `${API_BASE}/api/download-file?path=${encodeURIComponent(item.output || `${item.outputFolder}/${item.part}.mp3`)}`;
    link.download = `${item.part || i + 1}.mp3`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  log(`Đã gửi lệnh tải toàn bộ ${items.length} audio.`);
}

async function downloadSrt(targetItems = visibleItems()) {
  const items = targetItems;
  if (!items.length) {
    log("Chưa có subtitles để tải SRT.");
    return;
  }
  log("Đang tạo và tải SRT...");
  const first = items[0];
  const response = await apiFetch("/api/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      outputFolder: first.outputFolder || "single-import",
      baseName: fileStem(first.fileName || first.source || "subtitles"),
      items: items.map((item) => ({ part: item.part, text: item.text, startTime: item.startTime, endTime: item.endTime }))
    })
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    log(data.error || "Tạo SRT lỗi.");
    return;
  }
  const srtPath = data.srtPath || (data.srt ? `${first.outputFolder}/${data.srt}` : "");
  if (srtPath && IS_DESKTOP) {
    await apiFetch("/api/open-path", { method: "POST", body: JSON.stringify({ path: srtPath }) });
    log(`Đã tạo file SRT: ${srtPath}`);
  } else if (srtPath) {
    const link = document.createElement("a");
    link.href = `${API_BASE}/api/download-file?path=${encodeURIComponent(srtPath)}`;
    link.download = data.srt || "subtitles.srt";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    log(`Đã tải file SRT: ${data.srt}`);
  }
}

// Khoảng lặng giữa các câu khi ghép (giây). VD 0.5 đọc liền, 4 chừa chỗ chèn nhạc.
function joinGap() { const v = Number($("joinGap")?.value); return Number.isFinite(v) && v >= 0 ? Math.min(v, 60) : 0.5; }
async function joinItems(items = visibleItems(), includeMp3 = true) {
  if (!items.length) {
    log("Không có dòng nào để Join Mp3 & Tạo srt.");
    return;
  }
  const first = items[0];
  const response = await apiFetch("/api/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      outputFolder: first.outputFolder || "single-import",
      baseName: fileStem(first.fileName || first.source || "joined"),
      gapSeconds: joinGap(),
      items: items.map((item) => ({ part: item.part, text: item.text, startTime: item.startTime, endTime: item.endTime }))
    })
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    log(data.error || "Join Mp3 & Tạo srt lỗi.");
    return;
  }
  log(`Đã tạo SRT: ${data.srt} (tại ${data.parentDir || data.targetDir || data.folder})`);
  if (includeMp3 && data.joinedMp3) log(`Đã ghép MP3: ${data.joinedMp3} (tại ${data.parentDir || data.targetDir || data.folder})`);
  if (data.warning) log(data.warning);
}

async function openOutput() {
  const first = visibleItems()[0];
  const response = await apiFetch("/api/open-output", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ outputFolder: first?.outputFolder || $("batchFolderName")?.value.trim() || "" })
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    log(data.error || "Không mở được output.");
    return;
  }
  log(`Audio output: ${data.path}`);
}

function formatTime(total) {
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s},000`;
}

function isRateLimitError(error) {
  return /gọi quá nhanh|rate.?limit|rate_limited|too many|try again after|thử lại sau|429/i.test(String(error?.message || error));
}

const safe = (fn) => (...args) => Promise.resolve().then(() => fn(...args)).catch((e) => log(e.message));
// Chạy xong: cập nhật credit và ghi tổng kết (số dòng, lỗi, thời gian, credit đã dùng).
const runThenBalance = (fn) => safe(async (...args) => {
  const credit0 = Number(state.ui.credit), done0 = state.items.filter(isDone).length, start = Date.now();
  state.ui.run = { start, done0 }; state.ui.lastRun = ""; notify();
  try { await fn(...args); } finally {
    state.ui.run = null;
    if ($("toolSelect")?.value) await refreshBalance().catch(() => {});
    const secs = (Date.now() - start) / 1000;
    if (secs >= 3) state.ui.lastRun = runSummary(state.items.filter(isDone).length - done0, state.items.filter((i) => i.status === "Error").length, secs, credit0 - Number(state.ui.credit));
    if (state.ui.lastRun) log(`Tổng kết: ${state.ui.lastRun}.`);
    notify();
  }
});
function runSummary(done, errors, secs, used) {
  const credit = Number.isFinite(used) && used >= 0 ? `, dùng ${used.toLocaleString("vi-VN")} credit` : "";
  return `${done} dòng xong, ${errors} lỗi, ${clock(secs)}${credit}`;
}
function clock(secs) {
  const s = Math.max(0, Math.round(secs)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}
// Thời gian còn lại theo tốc độ trung bình của lần chạy này; chưa xong dòng nào thì chưa đoán.
function eta(run, doneNow, left, now = Date.now()) {
  const elapsed = (now - run.start) / 1000, rate = (doneNow - run.done0) / elapsed;
  return { elapsed, left: rate > 0 && left > 0 ? left / rate : null };
}
// Render lại: bỏ job cũ và mã chống trùng, nếu không AIVIE trả lại đúng job cũ.
function rerender(items) {
  const targets = items.filter(Boolean);
  if (state.running) return log("Đang chạy. Chờ xong hoặc bấm Stop rồi mới render lại.");
  if (!targets.length) return;
  const close = () => { state.ui.confirm = null; notify(); };
  state.ui.confirm = {
    title: `Render lại ${targets.length} dòng?`,
    message: "Tốn credit như render mới. File mp3 cũ sẽ bị thay khi bản mới tải xong.",
    cancel: close,
    ok: () => {
      close();
      for (const item of targets) { item.pendingJob = null; for (const key of Object.keys(item)) if (key.endsWith("Sig")) delete item[key]; }
      runThenBalance(() => retryItems(targets, true))();
    }
  };
  notify();
}
export const actions = {
  connect: safe(async () => { try { await connect(); await refreshBalance(); } catch (e) { setConnection("err", "Kết nối lỗi"); throw e; } }),
  saveKey: safe(saveKey), clearKey: safe(clearKey), refreshBalance: safe(refreshBalance),
  openJobs: safe(async () => { state.ui.jobsOpen = !state.ui.jobsOpen; notify(); if (state.ui.jobsOpen) await refreshJobs(); }),
  refreshJobs: safe(refreshJobs), cancelJob: safe(cancelJob), searchVoice: safe(searchVoiceLibrary), loadLibrary: safe(loadVoiceLibrary), addVoice: safe(addSelectedVoice),
  pickVoice: safe(async (index) => { const voice = state.voiceResults[Number(index)]; if (voice) applyVoice(await resolveLibraryVoice(voice)); }),
  pickBatchFolder: safe(async () => { if (!await pickBatchFolder()) $("batchFolderInput").click(); }),
  addBatchFiles: (files) => addBatchFolder(files), scanBatchPath: safe(scanBatchPath),
  clearBatch: () => { if (state.running) return log("Đang chạy, hãy Stop trước khi xoá danh sách."); state.items = []; state.batchFiles = []; state.activeSource = ""; renderRows(); renderBatchFiles(); },
  selectFile: (source) => { state.activeSource = source; renderRows(); renderBatchFiles(); },
  runBatch: runThenBalance(runBatchJobs), start: runThenBalance(startQueue), stop: stopAll, retryErrors, rerender, retryItem: runThenBalance((index) => retryItems([state.items[Number(index)]])),
  retryAll: runThenBalance(() => retryItems(state.items.filter((item) => item.status === "Error"))),
  retryFile: runThenBalance((source) => retryItems(state.items.filter((item) => item.source === source))),
  importFile: safe(async () => { if (!await pickAndImportSingle("single")) $("singleFileInput").click(); }),
  importFolder: safe(async () => { if (!await pickAndImportSingle("folder")) $("singleFolderInput").click(); }),
  importVoice: () => log("Import Voice sẽ dùng khi có file voice library/template. Hiện chưa cần cho queue TTS."),
  addSingleFiles: safe(addSingleFiles), dropFiles: safe((dataTransfer) => addSingleFiles(Array.from(dataTransfer?.files || []))),
  join: safe(() => joinItems(visibleItems(), true)), saveSrt: toSrt, openOutput: safe(openOutput),
  openPath: safe(async (path) => { const r = await apiFetch("/api/open-path", { method: "POST", body: JSON.stringify({ path }) }); const d = await r.json(); if (d.error) log(d.error); }),
  openLogFile: safe(async () => { await flushLogFile(); const r = await apiFetch("/api/log-open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: localDate() }) }); const d = await r.json(); if (d.error) log(d.error); }),
  toolChanged: () => { try { localStorage.setItem("nv.tool", $("toolSelect").value); } catch {} syncToolMode(true); },
  renderModeChanged: () => syncToolMode(true), modelChanged: syncOwnKeyFields,
  saveVoice: () => { const id = $("voiceId").value.trim(); if (!id) return log("Chưa có Voice ID để lưu."); const found = state.voiceResults.find((v) => voiceId(v) === id) || {}; const name = $("voiceName").value.trim() || found.name || id; const picked = loadSavedVoices().find((v) => v.key === $("savedVoices").value && v.id === id); state.ui.voiceToSave = { id, label: picked?.label || "", name, language: found.language || "", gender: found.gender || "", models: voiceModels(found) }; notify(); },
  cancelSaveVoice: () => { state.ui.voiceToSave = null; notify(); },
  confirmSaveVoice: (value) => { const voice = { ...state.ui.voiceToSave, label: value.trim() }; storeSavedVoices(upsertSavedVoice(loadSavedVoices(), voice)); state.ui.voiceToSave = null; renderSavedVoices(voice.label || voice.id); log(`Đã lưu voice: ${voice.label ? `${voice.label} · ` : ""}${voice.name} (${voice.id})`); },
  removeVoice: () => { const key = $("savedVoices").value; if (!key) return log("Chọn voice trong danh sách đã lưu để xoá."); storeSavedVoices(loadSavedVoices().filter((v) => v.key !== key)); renderSavedVoices(); log(`Đã bỏ voice ${key} khỏi danh sách lưu.`); },
  pickSavedVoice: (key) => { const v = loadSavedVoices().find((item) => item.key === key); if (!v) return; renderVoiceResults([v]); },
  downloadAllAudio: safe(() => downloadAllAudio()), downloadSrt: safe(() => downloadSrt())
};

async function bootConnection() {

  setConnection("off", "Chưa kết nối");
  // Web: cho tải file về; desktop: file đã nằm trên máy nên ẩn hai nút tải.

  renderBatchFiles();
  renderRows();
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const response = await apiFetch("/api/status");
      const data = await response.json();
      state.outputDir = data.outputDir || "";
      updateStatusBar();
      log(`${IS_DESKTOP ? "Desktop" : `Web backend ${API_BASE}`} | Output: ${data.outputDir || "-"}`);
      if (data.hasSavedApiKey) {
        state.ui.keyHint = `Đang kết nối backend/API (lần ${attempt}/8)...`;
        await connect();
        await refreshBalance();
        state.ui.keyHint = `Đang dùng ${data.keyCount || 1} key lưu trên máy. Dán danh sách key mới rồi bấm Lưu key để thay.`;
        log("Tự động kết nối API thành công!");
        return;
      }
      state.ui.keyHint = "Chưa có API key. Hãy nhập hoặc lưu key.";
      return;
    } catch (err) {
      setConnection("busy", `Đang chờ backend (${attempt}/8)`);
      log(`Backend chưa sẵn sàng (${attempt}/8): ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  setConnection("err", "Không kết nối được backend");
  state.ui.keyHint = "Backend chưa chạy. Hãy đóng app và mở lại.";
}
// ---------- Cột trái: khối gập/mở (nhớ trạng thái), ẩn ô chỉ dành cho key riêng ----------
function syncOwnKeyFields() { state.ui.ownKey = /^(el|dv)_/.test($("model")?.value || ""); notify(); }


// ---------- Voice đã lưu (localStorage, chỉ trên máy này) ----------
function loadSavedVoices() {
  try {
    const list = JSON.parse(localStorage.getItem("nv.savedVoices") || "[]");
    if (!Array.isArray(list)) return [];
    const text = (v) => (typeof v === "string" ? v : "");
    return list.filter((v) => v && text(v.id).trim()).map((v) => ({
      id: v.id, key: text(v.label) || v.id, label: text(v.label), name: text(v.name), language: text(v.language), gender: text(v.gender),
      models: Array.isArray(v.models) ? v.models.filter((m) => text(m)) : []
    }));
  } catch { return []; }
}
// Mỗi tên kênh giữ một voice; một voice dùng được cho nhiều kênh. Bản chưa đặt tên của voice đó được thay.
function upsertSavedVoice(list, voice) {
  return [voice, ...list.filter((v) => v.label ? v.label !== voice.label : v.id !== voice.id)];
}
const storeSavedVoices = (list) => { try { localStorage.setItem("nv.savedVoices", JSON.stringify(list)); } catch {} };
function renderSavedVoices(selected = "") { state.ui.savedVoices = loadSavedVoices(); state.ui.selectedSavedVoice = selected; notify(); }
let booted = false;
export function boot() {
  if (booted) return;
  booted = true;
  queueLogFile(`===== [AIVIE] Mở NaturalVoice ${localDate()} ${new Date().toLocaleTimeString("vi-VN")} =====`);
  setInterval(pollServerLogs, 2000); setInterval(refreshQuota, 5000);
  document.querySelectorAll("details[data-fold]").forEach((el) => {
    const key = `nv.fold.${el.dataset.fold}`;
    try { const value = localStorage.getItem(key); if (value !== null) el.open = value === "1"; } catch {}
    el.addEventListener("toggle", () => { try { localStorage.setItem(key, el.open ? "1" : "0"); } catch {} });
  });
  for (const id of ["autoSrt", "loopMode"]) {
    const el = $(id); if (!el) continue;
    try { const value = localStorage.getItem(`nv.${id}`); if (value !== null) el.checked = value === "1"; } catch {}
    el.addEventListener("change", () => { try { localStorage.setItem(`nv.${id}`, el.checked ? "1" : "0"); } catch {} });
  }
  { const el = $("joinGap"); try { const v = localStorage.getItem("nv.joinGap"); if (v !== null && el) el.value = v; } catch {} el?.addEventListener("change", () => { try { localStorage.setItem("nv.joinGap", el.value); } catch {} }); }
  syncOwnKeyFields(); renderSavedVoices(); bootConnection();
}
export const selectors = { clock, eta, voiceModels, visibleItems, fileStatus, statusView, isDone, isActive, summary: () => {
  const visible = visibleItems(), done = visible.filter(isDone).length, active = visible.filter(isActive).length, errors = visible.filter((item) => item.status === "Error").length;
  return { total: visible.length, done, active, errors, files: state.batchFiles.length, filesDone: state.batchFiles.filter((file) => fileStatus(file.source) === "Done").length };
} };
export const desktop = IS_DESKTOP;
export const activeJobCount = () => activeJobs.size;
export const logUpdate = log;
