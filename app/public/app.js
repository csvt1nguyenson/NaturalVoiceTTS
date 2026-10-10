const state = {
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
  pausedUntil: 0
};

const $ = (id) => document.getElementById(id);
// Desktop (Tauri): toàn bộ backend nằm trong Rust, gọi qua invoke("api").
// Web: gọi HTTP tới server.js như cũ.
const TAURI = window.__TAURI__ || null;
const IS_DESKTOP = Boolean(TAURI?.core?.invoke);
const API_BASE = "http://127.0.0.1:3177";
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
document.addEventListener("click", (event) => {
  const link = event.target.closest("[data-open-path]");
  if (!link) return;
  event.preventDefault();
  apiFetch("/api/open-path", { method: "POST", body: JSON.stringify({ path: link.dataset.openPath }) })
    .then((r) => r.json()).then((d) => { if (d.error) log(d.error); }).catch((e) => log(e.message));
});
let logLines = 0;
function appendLog(text, cls = "") {
  const el = $("log");
  const line = document.createElement("span");
  if (cls) line.className = cls;
  line.textContent = text + "\n";
  el.appendChild(line);
  while (el.childNodes.length > 800) el.removeChild(el.firstChild);
  logLines += 1;
  if ($("logCount")) $("logCount").textContent = `${logLines} dòng`;
  el.scrollTop = el.scrollHeight;
}
const log = (message) => appendLog(`[${new Date().toLocaleTimeString()}] ${message}`, /lỗi|error|failed/i.test(String(message)) ? "log-error" : "");

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
setInterval(pollServerLogs, 2000);

const ACTIVE = new Set(["Creating job", "Waiting AIVIE", "Rendering", "Processing"]);
function isDone(item) { return item.status === "Done" || item.status === "Done (no audio)"; }
function isActive(item) { return ACTIVE.has(item.status) || /^AIVIE /.test(item.status || ""); }

function updateTitle() {
  const visible = visibleItems();
  const done = visible.filter(isDone).length;
  const active = visible.filter(isActive).length;
  const errors = visible.filter((item) => item.status === "Error").length;
  const name = state.activeSource ? fileStem(state.activeSource.split(/[\\/]/).pop()) : "";
  const parts = [];
  if (name) parts.push(name);
  parts.push(visible.length ? `${done} xong · ${active} đang chạy${errors ? ` · ${errors} lỗi` : ""} · ${visible.length} tổng` : "Chưa có dòng nào");
  if ($("queueSummary")) $("queueSummary").textContent = parts.join(" · ");
  updateStatusBar();
}

function updateStatusBar() {
  const all = state.items;
  const done = all.filter(isDone).length;
  const active = all.filter(isActive).length;
  const files = state.batchFiles.length;
  const filesDone = state.batchFiles.filter((file) => fileStatus(file.source) === "Done").length;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;
  if (!$("statusBar")) return;
  $("statusBar").style.width = `${pct}%`;
  $("statusLines").textContent = `${done} / ${all.length} dòng`;
  $("statusFiles").textContent = `File ${filesDone} / ${files}`;
  $("statusActive").textContent = `${active} job đang render`;
  $("statusLabel").textContent = state.running ? (state.pausedUntil > Date.now() ? $("statusLabel").textContent : "Đang chạy") : (all.length && done === all.length ? "Hoàn tất" : "Sẵn sàng");
  $("statusOutput").textContent = state.outputDir ? `Output: ${state.outputDir}` : "";
}

function statusPill(status, error) {
  const s = String(status || "Queued");
  let cls = "pill-queued"; let label = "Chờ";
  if (isDone({ status: s })) { cls = "pill-done"; label = "Done"; }
  else if (s === "Error") { cls = "pill-error"; label = "Lỗi"; }
  else if (s === "Creating job") { cls = "pill-run"; label = "Đang tạo job"; }
  else if (s === "Waiting AIVIE" || s === "AIVIE queued") { cls = "pill-run"; label = "AIVIE queued"; }
  else if (s === "Rendering" || s === "AIVIE rendering" || s === "Processing") { cls = "pill-run"; label = "Đang render"; }
  else if (s === "AIVIE finalizing") { cls = "pill-run"; label = "Chờ audio"; }
  else if (/^AIVIE /.test(s)) { cls = "pill-run"; label = s.replace("AIVIE ", ""); }
  return `<span class="pill ${cls}" title="${escapeHtml(error || s)}">${escapeHtml(label)}</span>`;
}

function visibleItems() {
  if (!state.activeSource) return state.items;
  return state.items.filter((item) => item.source === state.activeSource);
}

function renderRows() {
  $("rows").innerHTML = visibleItems().map((item, index) => {
    const filePath = item.fullPath || (item.output ? (item.output.includes(":\\") || item.output.startsWith("\\\\") ? item.output : `${item.outputFolder}/${item.output}`) : "");
    const display = item.output ? (item.output.includes("\\") || item.output.includes("/") ? item.output.split(/[\\/]/).pop() : item.output) : "";
    return `
    <tr>
      <td class="td text-ink-3">${index + 1}</td>
      <td class="td text-ink-2">${item.part || ""}</td>
      <td class="td" title="${escapeHtml(item.fileName || item.source || "")}">${escapeHtml(item.text)}</td>
      <td class="td">${statusPill(item.status, item.error)}</td>
      <td class="td">${display ? fileLink(filePath, display) : '<span class="text-ink-3">—</span>'}</td>
    </tr>`;
  }).join("") || '<tr><td class="td text-ink-3" colspan="5">Chưa có dòng nào. Nhập file .srt/.txt/.dgt hoặc kéo thả vào đây.</td></tr>';
  updateTitle();
}

function renderBatchFiles() {
  $("batchFilesRows").innerHTML = state.batchFiles.map((file, index) => {
    const items = state.items.filter((item) => item.source === file.source);
    const done = items.filter(isDone).length;
    const st = fileStatus(file.source);
    const pill = st === "Done" ? '<span class="pill pill-done">Hoàn tất</span>'
      : st === "Error" ? '<span class="pill pill-error">Lỗi</span>'
      : st === "Processing" ? '<span class="pill pill-run">Đang render</span>'
      : '<span class="pill pill-queued">Chờ</span>';
    const folder = items[0]?.outputFolder || "";
    return `
    <tr class="cursor-pointer" aria-selected="${file.source === state.activeSource}" data-source="${escapeHtml(file.source)}">
      <td class="td text-ink-3">${index + 1}</td>
      <td class="td truncate" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</td>
      <td class="td text-ink-2">${done} / ${items.length}</td>
      <td class="td">${pill}</td>
      <td class="td truncate text-xs text-ink-3" title="${escapeHtml(folder)}">${escapeHtml(folder)}</td>
    </tr>`;
  }).join("") || '<tr><td class="td text-ink-3" colspan="5">Chưa có file. Chọn thư mục chứa .txt rồi bấm Quét thư mục.</td></tr>';
  Array.from($("batchFilesRows").querySelectorAll("tr")).forEach((row) => {
    row.addEventListener("click", () => {
      state.activeSource = row.dataset.source;
      renderBatchFiles();
      renderRows();
    });
  });
}

function fileStatus(source) {
  const items = state.items.filter((item) => item.source === source);
  if (!items.length) return "";
  if (items.some(isActive)) return "Processing";
  if (items.some((item) => item.status === "Error")) return "Error";
  if (items.every(isDone)) return "Done";
  return "Queued";
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
  $("voiceResults").innerHTML = voices.map((voice, index) => {
    const models = voiceModels(voice).join(",");
    const label = `${voice.name || voiceId(voice)} | ${voice.language || ""} | ${voice.gender || ""} | ${models}`;
    return `<option value="${index}">${escapeHtml(label)}</option>`;
  }).join("");
  if (voices.length) {
    $("voiceResults").selectedIndex = 0;
    applyVoice(voices[0]);
  }
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

async function showDirectVoiceId(voiceIdValue) {
  $("voiceId").value = voiceIdValue;
  try {
    // Tra Shared Voice Library vì voice có thể chưa được add vào Library cá nhân.
    // Chỉ nhận kết quả khớp đúng ID, không lấy kết quả gần đúng.
    const data = await callMcpTool("search_voice_library", { search: voiceIdValue, page_size: 10 });
    const found = (data.voices || []).find((voice) => voiceId(voice) === voiceIdValue);
    if (found) {
      renderVoiceResults([found]);
      log(`Đã nhận voice ID và tên: ${found.name} (${voiceIdValue})`);
      return;
    }
  } catch {}
  renderVoiceResults([{ id: voiceIdValue, name: voiceIdValue, models: [$("model").value || "eleven_v3"] }]);
  log(`Đã nhận voice ID trực tiếp: ${voiceIdValue}`);
}

function applySelectedVoice() {
  const voice = state.voiceResults[Number($("voiceResults").value)];
  if (!voice) return;
  applyVoice(voice);
}

function applyVoice(voice) {
  $("voiceName").value = voice.name || "";
  $("voiceId").value = voiceId(voice);
  const models = voiceModels(voice);
  // AIVIE: model đầu tiên trong danh sách là mặc định tương thích với voice.
  if (models.length) {
    const current = $("model").value;
    $("model").value = models.includes(current) ? current : models[0];
  }
  const gender = voice.gender === "male" ? "nam" : voice.gender === "female" ? "nữ" : voice.gender || "";
  const meta = [voice.language ? `Ngôn ngữ gốc <strong class="font-medium text-ink-2">${escapeHtml(voice.language)}</strong>` : "", gender, models.length ? `chạy được ${escapeHtml(models.join(", "))}` : ""].filter(Boolean).join(" · ");
  if ($("voiceMeta")) $("voiceMeta").innerHTML = meta || "Chưa chọn voice.";
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
    const folder = mode === "folder" ? `folder-import/${fileStem(relative)}` : `single-import/${fileStem(entry.name)}`;
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
  $("creditBalance").textContent = data.balance ?? data.credits ?? data.aivie_credits ?? "-";
  const limit = Number(data.concurrent_render_limit ?? data.concurrent_limit ?? data.concurrency_limit ?? data.concurrency ?? 0);
  state.concurrentLimit = limit;
  $("concurrentLimit").textContent = limit || "-";
  if ($("concurrentHint")) $("concurrentHint").textContent = limit || "-";
  if (limit > 0 && $("concurrency")) {
    const sel = $("concurrency");
    const current = Number(sel.value) || 3;
    sel.innerHTML = Array.from({ length: Math.min(limit, 10) }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("");
    sel.value = String(Math.min(current, limit));
  }
  log("Balance: " + $("creditBalance").textContent + " credits.");
}

async function refreshJobs() {
  const data = await callMcpTool("list_jobs", { limit: 20 });
  const jobs = data.jobs || data.items || (Array.isArray(data) ? data : []);
  $("jobsRows").innerHTML = jobs.map((job) => {
    const id = job.job_id || job.id || "";
    const status = job.status || "unknown";
    const action = status === "queued" || status === "rendering" ? '<button data-cancel-job="' + escapeHtml(id) + '">Hủy</button>' : "";
    return '<tr><td title="' + escapeHtml(id) + '">' + escapeHtml(id.slice(0, 12)) + '</td><td>' + escapeHtml(job.title || "") + '</td><td>' + escapeHtml(status) + '</td><td>' + escapeHtml(String(job.credits ?? "-")) + '</td><td>' + action + '</td></tr>';
  }).join("") || '<tr><td colspan="5">Chưa có job.</td></tr>';
  log("Đã tải " + jobs.length + " job AIVIE.");
}

async function cancelJob(jobId) {
  await callMcpTool("cancel_job", { job_id: jobId });
  log("Đã yêu cầu hủy job " + jobId + ".");
  await refreshJobs();
}

function setConnection(stateName, text) {
  const chip = $("connectionStatus");
  if (!chip) return;
  chip.dataset.state = stateName;
  const cls = { on: "border-ok/40 bg-ok-soft text-ok", off: "border-line bg-raised text-ink-3", busy: "border-warn/40 bg-warn-soft text-warn", err: "border-bad/40 bg-bad-soft text-bad" }[stateName] || "";
  chip.className = `inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}`;
  ($("connectionText") || chip).textContent = text;
}

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
  $("keyHint").textContent = `Đã lưu ${data.keyCount || 1} key trên máy này. App tự xoay vòng khi một key hết lượt.`;
  log(`Đã lưu ${data.keyCount || 1} API key.`);
  refreshQuota();
}

async function clearKey() {
  const response = await apiFetch("/api/clear-key", { method: "POST" });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "Clear key failed");
  $("apiKey").value = "";
  $("keyHint").textContent = "Đã xoá key đã lưu.";
  renderQuota({ keys: [], used: 0, total: 0, free: 0 });
  log("Đã xoá API key đã lưu.");
}

async function callTool(item, index) {
  if (!state.batchMode) state.activeSource = item.source;
  item.status = "Creating job";
  renderBatchFiles();
  renderRows();
  if ($("toolSelect").value === "create_tts_job") {
    const renderArgs = { ...buildArgs(item.text), title: itemTitle(item) };
    if ($("estimateBeforeRender")?.checked) {
      const estimate = await callMcpTool("estimate_tts", renderArgs);
      const credits = Number(estimate.credits ?? estimate.aivie_credits ?? 0);
      const maxCredits = Number($("maxCredits")?.value || 0);
      if (maxCredits > 0 && credits > maxCredits) throw new Error("Estimate vượt Max credits.");
      log("Estimate dòng " + (item.part || index + 1) + ": " + (credits || "?") + " credits.");
    }
    renderArgs.idempotency_key = item.idempotencyKey || (item.idempotencyKey = crypto.randomUUID());
    const startResponse = await apiFetch("/api/start-render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        args: renderArgs,
        fileBaseName: `item-${index + 1}`,
        outputFolder: item.outputFolder || "single-import",
        clipNumber: item.part || index + 1
      })
    });
    const started = await startResponse.json();
    if (!startResponse.ok || started.error) throw new Error(started.error || "Start render failed");
    item.jobId = started.jobId;
    item.status = "Waiting AIVIE";
    log(`AIVIE job ${started.jobId}: queued`);
    renderBatchFiles();
    renderRows();
    // Chờ poller dùng chung báo kết quả (một request cho mọi job, tiết kiệm hạn mức API).
    const polled = await waitForJobResult(started.jobId, item);
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
function renderQuota(q) {
  if (!q) return;
  state.quota = q;
  if ($("statusQuota")) $("statusQuota").textContent = q.total ? `Lượt tạo job ${q.used}/${q.total} giờ này` : "Lượt tạo job -";
  if ($("keyQuota")) {
    $("keyQuota").innerHTML = (q.keys || []).map((k) => {
      const pct = Math.min(100, Math.round((k.used / k.limit) * 100));
      const note = k.blockedFor > 0 ? `nghỉ ${Math.ceil(k.blockedFor / 60)} phút` : `${k.used}/${k.limit}`;
      return `<div class="flex items-center gap-2 text-xs text-ink-3"><span class="w-14 shrink-0 font-mono">${escapeHtml(k.label)}</span><span class="h-1 flex-1 overflow-hidden rounded-full bg-raised"><span class="block h-full ${pct >= 100 ? "bg-bad" : "bg-brand"}" style="width:${pct}%"></span></span><span class="w-16 shrink-0 text-right tabular-nums">${note}</span></div>`;
    }).join("");
  }
}
async function refreshQuota() {
  try {
    const res = await apiFetch("/api/quota");
    if (res.ok) renderQuota(await res.json());
  } catch {}
}
setInterval(refreshQuota, 5000);

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
      else if (r.status === "completed" && r.error) { activeJobs.delete(id); entry.reject(new Error(r.error)); }
      else if (r.status === "failed" || r.status === "cancelled" || r.status === "canceled") { activeJobs.delete(id); entry.reject(new Error(`AIVIE job ${r.status}${r.error ? `: ${r.error}` : ""}`)); }
      else if (r.status === "finalizing" && (entry.finalizing = (entry.finalizing || 0) + 1) > 9) {
        // AIVIE báo completed nhưng 90 giây vẫn không có audio: dừng hỏi để không tốn hạn mức API.
        activeJobs.delete(id);
        entry.reject(new Error(`AIVIE báo job ${id} đã xong nhưng không trả audio. Nếu đang dùng create_lines_job, hãy đổi sang create_tts_job.`));
      }
      else {
        entry.item.status = r.status === "rendering" ? "Rendering" : `AIVIE ${r.status}`;
        if (Date.now() - entry.since > 15 * 60 * 1000) { activeJobs.delete(id); entry.reject(new Error(`AIVIE job ${id} chờ quá 15 phút, bỏ qua.`)); }
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
    if ($("statusLabel")) $("statusLabel").textContent = left ? `Chờ lượt ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : (state.running ? "Đang chạy" : "Sẵn sàng");
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
  if ($("estimateBeforeRender")?.checked) {
    const { max_credits, ...estimateArgs } = args;
    const estimate = await callMcpTool(useLines ? "estimate_lines" : "estimate_tts", estimateArgs);
    const credits = Number(estimate.credits ?? estimate.aivie_credits ?? 0);
    const maxCredits = Number($("maxCredits")?.value || 0);
    if (maxCredits > 0 && credits > maxCredits) throw new Error(`Estimate ${credits} vượt Max credit ${maxCredits}.`);
    log(`Estimate ${label}: ${credits || "?"} credits.`);
  }
  // Đổi tool thì dùng key khác, để AIVIE không trả lại job cũ của tool kia.
  const keyName = useLines ? "linesJobKey" : "fileJobKey";
  args.idempotency_key = first[keyName] || (first[keyName] = crypto.randomUUID());
  for (const item of items) item.status = "Creating job";
  renderBatchFiles(); renderRows();
  const outputFolder = parentFolderOf(first.outputFolder) || first.outputFolder || "single-import";
  const res = await apiFetch("/api/start-render", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: useLines ? "create_lines_job" : "create_tts_job", args, outputFolder, clipNumber: `${base}_full`, fileBaseName: base })
  });
  const started = await res.json();
  if (!res.ok || started.error) throw new Error(started.error || "Start render failed");
  log(`AIVIE ${useLines ? "lines job" : "job"} ${started.jobId}: cả file ${label} (${items.length} dòng, ${fullText.length} ký tự), queued`);
  for (const item of items) { item.status = "Waiting AIVIE"; item.jobId = started.jobId; }
  renderBatchFiles(); renderRows();
  const polled = await waitForJobResult(started.jobId, { set status(v) { for (const item of items) item.status = v; } });
  for (const item of items) {
    item.status = polled.saved ? "Done" : "Done (no audio)";
    item.output = polled.saved?.filename || "";
    item.fullPath = polled.saved?.fullPath || "";
  }
  log(`${label}: Done -> ${polled.saved?.fullPath || ""}`);
  // SRT: chia thời lượng thật theo tỉ lệ ký tự từng dòng (dòng SRT gốc giữ timing của nó).
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
async function runFilePool(groups) {
  let cursor = 0; let ok = 0; let failed = 0;
  const worker = async () => {
    while (state.running) {
      const g = groups[cursor]; cursor += 1;
      if (!g) return;
      try {
        await throttleCreate();
        if (!state.running) return;
        await renderWholeFile(g.items, g.label);
        ok += 1;
      } catch (error) {
        for (const item of g.items) { item.status = isRateLimitError(error) ? "Queued" : "Error"; item.error = error.message; }
        if (isRateLimitError(error)) { applyRateLimit(error); groups.push(g); }
        else { failed += 1; log(`${g.label}: ${error.message}`); }
        renderBatchFiles(); renderRows();
      }
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

async function runPool(queue, label) {
  const pending = queue.filter((item) => item.status === "Queued" || item.status === "Error");
  if (!pending.length) return { ok: 0, failed: 0 };
  let cursor = 0; let ok = 0; let failed = 0; const fatal = false;
  const worker = async () => {
    while (state.running) {
      const item = pending[cursor]; cursor += 1;
      if (!item) return;
      try {
        await throttleCreate();
        if (!state.running) { item.status = "Queued"; return; }
        await callTool(item, item.part || 1);
        ok += 1;
      } catch (error) {
        item.status = "Error";
        item.error = error.message;
        failed += 1;
        log(`${label} dòng ${item.part}: ${error.message}`);
        if (isRateLimitError(error)) {
          applyRateLimit(error);
          item.status = "Queued"; item.error = ""; failed -= 1;
          pending.push(item);
        }
        // Dòng lỗi giữ trạng thái Lỗi, các dòng khác vẫn chạy tiếp; cuối batch bấm "Chạy lại lỗi".
        renderBatchFiles(); renderRows();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency(), pending.length) }, worker));
  return { ok, failed, fatal };
}

async function startQueue() {
  if (state.running) return log("Đang có queue chạy, bỏ qua lần bấm trùng.");
  if (!$("toolSelect").value) return log("Chưa kết nối AIVIE.");
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
    log(result.failed ? `Batch xong, ${result.failed} file lỗi. Bấm "Chạy lại lỗi" rồi "Chạy hàng loạt".` : "Đã hoàn tất tất cả Batch Job. Full MP3 và SRT đã lưu cạnh file txt.");
    return;
  }
  for (const file of state.batchFiles) {
    if (!state.running) break;
    state.activeSource = file.source;
    normalizeSourceItems(file.source);
    renderBatchFiles(); renderRows();
    const queue = state.items.filter((item) => item.source === file.source);
    if (queue.every(isDone)) continue;
    log(`Batch bắt đầu: ${file.name} (${queue.length} dòng, ${concurrency()} song song)`);
    const result = await runPool(queue, file.name);
    log(`Batch kết thúc: ${file.name} -> ${fileStatus(file.source)}${result.failed ? ` (${result.failed} dòng lỗi)` : ""}`);
    if ($("autoSrt").checked && queue.some(isDone)) {
      try { await joinItems(queue, true); } catch (error) { log(`Ghép ${file.name}: ${error.message}`); }
    }
    if (result.fatal) { state.running = false; break; }
  }
  state.running = false; state.batchMode = false;
  updateStatusBar();
  const errors = state.items.filter((item) => item.status === "Error").length;
  log(state.batchFiles.every((file) => fileStatus(file.source) === "Done")
    ? "Đã hoàn tất tất cả Batch Job. Voice, SRT và full MP3 đã lưu vào thư mục."
    : errors ? `Batch xong nhưng có ${errors} dòng lỗi. Chọn file trong bảng Batch Job rồi bấm "Chạy lại lỗi", sau đó "Chạy hàng loạt".`
    : "Batch đã dừng. File chưa xong giữ trạng thái Chờ, bấm Chạy hàng loạt để tiếp tục.");
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
    body: JSON.stringify({ outputFolder: first?.outputFolder || "" })
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

$("connectBtn").addEventListener("click", () => connect().then(refreshBalance).catch((e) => {
  setConnection("err", "Kết nối lỗi");
  log(e.message);
}));
$("refreshBalanceBtn").addEventListener("click", () => refreshBalance().catch((e) => log(e.message)));
$("jobsBtn").addEventListener("click", async () => {
  const panel = $("jobsPanel");
  panel.hidden = !panel.hidden;
  $("jobsBtn").textContent = panel.hidden ? "Jobs" : "Đóng Jobs";
  if (!panel.hidden) await refreshJobs().catch((e) => log(e.message));
});
$("refreshJobsBtn").addEventListener("click", () => refreshJobs().catch((e) => log(e.message)));
$("jobsRows").addEventListener("click", (event) => {
  const button = event.target.closest("[data-cancel-job]");
  if (button) cancelJob(button.dataset.cancelJob).catch((e) => log(e.message));
});
$("searchVoiceBtn").addEventListener("click", () => searchVoiceLibrary().catch((e) => log(e.message)));
$("voiceLibraryBtn").addEventListener("click", () => loadVoiceLibrary().catch((e) => log(e.message)));
$("addVoiceBtn").addEventListener("click", () => addSelectedVoice().catch((e) => log(e.message)));
$("voiceResults").addEventListener("change", applySelectedVoice);
$("voiceResults").addEventListener("click", applySelectedVoice);
$("voiceResults").addEventListener("keyup", applySelectedVoice);
$("voiceResults").addEventListener("dblclick", applySelectedVoice);
$("saveKeyBtn").addEventListener("click", () => saveKey().catch((e) => log(e.message)));
$("clearKeyBtn").addEventListener("click", () => clearKey().catch((e) => log(e.message)));
$("batchFolderInput").addEventListener("change", (e) => addBatchFolder(e.target.files));
$("batchImportBtn").addEventListener("click", () => pickBatchFolder().then((handled) => { if (!handled) $("batchFolderInput").click(); }).catch((e) => log(e.message)));
$("scanPathBtn").addEventListener("click", scanBatchPath);
$("batchFolderName").addEventListener("paste", () => setTimeout(scanBatchPath, 50));
$("batchFolderName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") scanBatchPath();
});
$("singleFileInput").addEventListener("change", (e) => addSingleFiles(e.target.files));
$("singleFolderInput").addEventListener("change", (e) => addSingleFiles(e.target.files, "folder"));
$("importFileBtn").addEventListener("click", () => pickAndImportSingle("single").then((handled) => { if (!handled) $("singleFileInput").click(); }).catch((e) => log(e.message)));
$("importFolderBtn").addEventListener("click", () => pickAndImportSingle("folder").then((handled) => { if (!handled) $("singleFolderInput").click(); }).catch((e) => log(e.message)));
$("importVoiceBtn").addEventListener("click", () => log("Import Voice sẽ dùng khi có file voice library/template. Hiện chưa cần cho queue TTS."));
$("openOutputBtn").addEventListener("click", openOutput);
$("clearBtn").addEventListener("click", () => {
  if (state.running) return log("Đang chạy, hãy Stop trước khi xoá danh sách.");
  state.items = [];
  state.batchFiles = [];
  state.activeSource = "";
  renderBatchFiles();
  renderRows();
});
$("batchRunBtn").addEventListener("click", runBatchJobs);
$("batchStopBtn")?.addEventListener("click", stopAll);
$("startBtn").addEventListener("click", startQueue);
$("stopBtn").addEventListener("click", stopAll);
$("downloadAllAudioBtn").addEventListener("click", downloadAllAudio);
$("downloadSrtBtn").addEventListener("click", downloadSrt);
$("saveSrtBtn").addEventListener("click", toSrt);
$("joinBtn").addEventListener("click", () => joinItems(visibleItems(), true));
$("retryBtn").addEventListener("click", retryErrors);
$("showAdvanced")?.addEventListener("change", () => {
  $("advancedFields").hidden = !$("showAdvanced").checked;
});
$("toolSelect").addEventListener("change", () => {
  try { localStorage.setItem("nv.tool", $("toolSelect").value); } catch {}
  syncToolMode(true);
});
$("renderMode")?.addEventListener("change", () => syncToolMode(true));

for (const event of ["dragenter", "dragover"]) {
  $("dropZone").addEventListener(event, (e) => {
    e.preventDefault();
    $("dropZone").classList.add("active");
  });
}
for (const event of ["dragleave", "drop"]) {
  $("dropZone").addEventListener(event, (e) => {
    e.preventDefault();
    $("dropZone").classList.remove("active");
  });
}
$("dropZone").addEventListener("drop", (e) => {
  const files = Array.from(e.dataTransfer?.files || []);
  if (!files.length) return;
  addSingleFiles(files).catch((err) => log(err.message));
});


// ---------- Auto update (desktop) ----------
async function checkForUpdate(manual = false) {
  const updater = TAURI?.updater;
  if (!updater?.check) { if (manual) log("Kiểm tra cập nhật chỉ có trên bản desktop."); return; }
  try {
    if (TAURI?.app?.getVersion && $("appVersion")) $("appVersion").textContent = `v${await TAURI.app.getVersion()}`;
    const update = await updater.check();
    if (!update) { if (manual) log("Đang dùng phiên bản mới nhất."); return; }
    $("updateVersion").textContent = `Phiên bản ${update.version}${update.date ? ` · ${String(update.date).slice(0, 10)}` : ""}`;
    $("updateNotes").textContent = "Có bản cập nhật mới. Bấm Cập nhật ngay để tải và cài đặt, app sẽ tự mở lại.";
    $("updateModal").classList.remove("hidden"); $("updateModal").classList.add("flex");
    $("updateNowBtn").onclick = async () => {
      $("updateNowBtn").disabled = true; $("updateLaterBtn").disabled = true;
      $("updateProgress").classList.remove("hidden");
      let total = 0; let got = 0;
      try {
        await update.downloadAndInstall((event) => {
          if (event.event === "Started") total = event.data.contentLength || 0;
          else if (event.event === "Progress") {
            got += event.data.chunkLength;
            const pct = total ? Math.round((got / total) * 100) : 0;
            $("updateBar").style.width = `${pct}%`;
            $("updateProgressText").textContent = total ? `Đang tải ${pct}%` : `Đã tải ${(got / 1048576).toFixed(1)} MB`;
          } else if (event.event === "Finished") $("updateProgressText").textContent = "Đang cài đặt…";
        });
        await TAURI.process.relaunch();
      } catch (error) {
        log(`Cập nhật lỗi: ${error.message || error}`);
        $("updateProgressText").textContent = `Lỗi: ${error.message || error}`;
        $("updateNowBtn").disabled = false; $("updateLaterBtn").disabled = false;
      }
    };
    $("updateLaterBtn").onclick = () => { $("updateModal").classList.add("hidden"); $("updateModal").classList.remove("flex"); };
  } catch (error) {
    if (manual) log(`Không kiểm tra được cập nhật: ${error.message || error}`);
  }
}

async function bootConnection() {
  if ($("advancedFields")) $("advancedFields").hidden = true;
  setConnection("off", "Chưa kết nối");
  // Web: cho tải file về; desktop: file đã nằm trên máy nên ẩn hai nút tải.
  for (const id of ["downloadSrtBtn", "downloadAllAudioBtn"]) if ($(id)) $(id).hidden = IS_DESKTOP;
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
        $("keyHint").textContent = `Đang kết nối backend/API (lần ${attempt}/8)...`;
        await connect();
        await refreshBalance();
        $("keyHint").textContent = `Đang dùng ${data.keyCount || 1} key lưu trên máy. Dán danh sách key mới rồi bấm Lưu key để thay.`;
        log("Tự động kết nối API thành công!");
        return;
      }
      $("keyHint").textContent = "Chưa có API key. Hãy nhập hoặc lưu key.";
      return;
    } catch (err) {
      setConnection("busy", `Đang chờ backend (${attempt}/8)`);
      log(`Backend chưa sẵn sàng (${attempt}/8): ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  setConnection("err", "Không kết nối được backend");
  $("keyHint").textContent = "Backend chưa chạy. Hãy đóng app và mở lại.";
}
bootConnection();
setTimeout(() => checkForUpdate(false), 3000);
