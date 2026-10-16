"use strict";

const $ = (id) => document.getElementById(id);
const state = { rows: [], activeSource: "", running: false, stop: false, hasKey: false, models: [], voices: [], voiceOffset: 0, voiceTotal: 0, activeJobId: "", cancelling: false, voiceLookup: 0 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const log = (message) => {
  const now = new Date().toLocaleTimeString("vi-VN");
  queueLogFile(`[Sonic] [${now}] ${message}`);
  $("log").textContent += `[${now}] ${message}\n`;
  $("log").scrollTop = $("log").scrollHeight;
  $("logCount").textContent = `${$("log").textContent.trimEnd().split("\n").length} dòng`;
};

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
  try { await api("/api/log-append", { date: localDate(), lines }); } catch {}
}

async function api(path, body = {}) {
  if (!window.__TAURI__?.core?.invoke) throw new Error("Hãy mở bằng NaturalVoice Desktop.");
  const result = await window.__TAURI__.core.invoke("api", { request: { method: "POST", path, body } });
  if (result.status >= 400) throw new Error(result.body?.error || `HTTP ${result.status}`);
  return result.body;
}
const sonic = (action, extra = {}) => api("/api/sonic", { action, ...extra });
const nameStem = (name) => name.replace(/\.[^.]+$/, "");
const outputFolder = (file) => `${file.dirPath}\\${nameStem(file.name)}`;

function parseFile(file) {
  return file.text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

function parseSrt(file) {
  return file.text.replace(/^\uFEFF/, "").split(/\r?\n\s*\r?\n/).map((block) => {
    const lines = block.split(/\r?\n/);
    const timing = lines.findIndex((line) => line.includes("-->"));
    return timing >= 0 ? lines.slice(timing + 1).join(" ").trim() : "";
  }).filter(Boolean);
}

function parseSrtCues(source) {
  const seconds = (stamp) => {
    const match = stamp.match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
    return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000 : NaN;
  };
  return source.replace(/^\uFEFF/, "").split(/\r?\n\s*\r?\n/).map((block) => {
    const line = block.split(/\r?\n/).find((item) => item.includes("-->"));
    if (!line) return null;
    const [start, end] = line.trim().split(/\s*-->\s*/);
    const duration = seconds(end) - seconds(start);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  }).filter((duration) => duration !== null);
}

// ---------- Ngôn ngữ đọc ----------
// MiniMax cần tên tiếng Anh đầy đủ ("Vietnamese"); ElevenLabs nhận mã ISO nằm trong languages của model.
const MINIMAX_LANGUAGES = [
  ["Vietnamese", "Tiếng Việt", "vi"], ["English", "Tiếng Anh", "en"], ["Chinese", "Tiếng Trung", "zh"],
  ["Chinese,Yue", "Tiếng Quảng Đông", "yue"], ["Japanese", "Tiếng Nhật", "ja"], ["Korean", "Tiếng Hàn", "ko"],
  ["Thai", "Tiếng Thái", "th"], ["Indonesian", "Tiếng Indonesia", "id"], ["Malay", "Tiếng Mã Lai", "ms"],
  ["Filipino", "Tiếng Philippines", "fil"], ["Hindi", "Tiếng Hindi", "hi"], ["French", "Tiếng Pháp", "fr"],
  ["German", "Tiếng Đức", "de"], ["Spanish", "Tiếng Tây Ban Nha", "es"], ["Portuguese", "Tiếng Bồ Đào Nha", "pt"],
  ["Italian", "Tiếng Ý", "it"], ["Russian", "Tiếng Nga", "ru"], ["Arabic", "Tiếng Ả Rập", "ar"],
  ["Turkish", "Tiếng Thổ Nhĩ Kỳ", "tr"], ["Dutch", "Tiếng Hà Lan", "nl"], ["Polish", "Tiếng Ba Lan", "pl"],
  ["Ukrainian", "Tiếng Ukraina", "uk"],
];
const LANGUAGE_PRIORITY = ["vi", "en", "zh", "ja", "ko"];
function languageLabel(code) {
  const known = MINIMAX_LANGUAGES.find((entry) => entry[2] === code);
  if (known) return known[1];
  try { const name = new Intl.DisplayNames(["vi"], { type: "language" }).of(code); return name && name !== code ? name : code; } catch { return code; }
}
// Danh sách [giá trị gửi đi, nhãn hiển thị, mã ISO] theo nhà cung cấp và model đang chọn.
function languageOptions() {
  if ($("provider").value !== "eleven") return MINIMAX_LANGUAGES.map(([value, label, code]) => [value, `${label} (${value})`, code]);
  const modelId = $("model").value || "eleven_v3";
  const codes = (state.models.find((model) => model.model_id === modelId)?.languages || []).map((code) => String(code).toLowerCase());
  const rank = (code) => { const i = LANGUAGE_PRIORITY.indexOf(code); return i < 0 ? 99 : i; };
  return [...new Set(codes)].sort((a, b) => rank(a) - rank(b) || languageLabel(a).localeCompare(languageLabel(b), "vi"))
    .map((code) => [code, `${languageLabel(code)} (${code})`, code]);
}
// Đổi giá trị cũ (tên hoặc mã) sang giá trị hợp lệ cho nhà cung cấp hiện tại.
function languageValueFor(valueOrCode) {
  if (!valueOrCode) return "";
  const raw = String(valueOrCode);
  const code = (MINIMAX_LANGUAGES.find((entry) => entry[0].toLowerCase() === raw.toLowerCase())?.[2] || raw).toLowerCase();
  const option = languageOptions().find((entry) => entry[2] === code || entry[0].toLowerCase() === raw.toLowerCase());
  return option ? option[0] : "";
}
function renderLanguageOptions() {
  const select = $("language");
  const previous = select.value;
  const options = languageOptions();
  select.innerHTML = '<option value="">Tự nhận diện (dễ đọc sai chữ số)</option>' + options.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("");
  select.value = languageValueFor(previous);
}
// Tự điền ngôn ngữ đọc theo ngôn ngữ của giọng vừa chọn.
function setLanguageFromVoice(code) {
  const value = languageValueFor(code);
  if (!value || $("language").value === value) return;
  $("language").value = value;
  state.languageWarned = false;
  log(`Ngôn ngữ đọc: ${languageLabel(String(code).toLowerCase())}, theo giọng đã chọn. Đổi ở ô Ngôn ngữ đọc nếu cần.`);
}
// Văn bản có chữ số mà để Tự nhận diện thì Sonic dễ đọc số theo ngôn ngữ khác (vd 2018 thành tiếng Việt).
function isNetworkError(error) {
  return /Mất kết nối tới SonicVoice|error sending request|timed out|HTTP 50[234]/i.test(String(error?.message || error));
}
// Sau khi rớt mạng lúc tạo job: tìm job cùng tiêu đề vừa tạo mà chưa gán cho dòng nào.
async function findRecentJob(title, since) {
  const used = new Set(state.rows.map((row) => row.jobId).filter(Boolean));
  try {
    const list = await sonic("find-job", { title });
    return (list.items || []).find((job) => job.title === title && !used.has(job.id)
      && Date.parse(job.created_at) >= since - 120000 && !["failed", "cancelled"].includes(job.status)) || null;
  } catch { return null; }
}
function rowsHaveDigits(rows) {
  return rows.some((row) => /\d/.test(row.srtText ? parseSrt({ text: row.srtText }).join(" ") : row.text));
}

function addFiles(files, mode = "single") {
  for (const file of files) {
    const isSrt = /\.srt$/i.test(file.name);
    const lines = isSrt ? parseSrt(file) : parseFile(file);
    if (!lines.length) { log(`${file.name}: không có đoạn văn bản hợp lệ.`); continue; }
    const folder = outputFolder(file);
    if (state.rows.some((row) => row.source === file.fullPath)) {
      log(`${file.name}: đã có trong danh sách.`);
      continue;
    }
    if (isSrt) {
      state.rows.push({ source: file.fullPath, name: file.name, folder, mode, part: 1, text: `SRT · ${lines.length} cue`, srtText: file.text, cueCount: lines.length, status: "Queued", output: "", jobId: "" });
    } else {
      lines.forEach((text, index) => state.rows.push({ source: file.fullPath, name: file.name, folder, mode, part: index + 1, text, status: "Queued", output: "", jobId: "" }));
    }
    log(`${file.name}: ${lines.length} đoạn.`);
  }
  const currentBatch = state.rows.filter((row) => row.mode === "batch");
  if (mode === "batch" && (!state.activeSource || !currentBatch.some((row) => row.source === state.activeSource))) {
    state.activeSource = files[0]?.fullPath || currentBatch[0]?.source || "";
  } else if (mode === "single" && files.length) {
    state.activeSource = files[0].fullPath;
  }
  render();
}

// Chỉ tạo thư mục output khi bấm chạy, cho đúng các file sắp render (không tạo lúc quét/nhập).
async function prepareRowFolders(rows) {
  const sources = [...new Set(rows.map((row) => row.source).filter(Boolean))];
  if (!sources.length) return;
  const result = await api("/api/prepare-output-folders", { sourcePaths: sources });
  log(`Đã tạo ${result.count} thư mục output cạnh file nguồn.`);
}

function render() {
  const done = state.rows.filter((row) => row.status === "Done").length;
  const batchFiles = [...new Set(state.rows.filter((row) => row.mode === "batch").map((row) => row.source))];
  if (batchFiles.length && (!state.activeSource || !state.rows.some((row) => row.source === state.activeSource))) {
    state.activeSource = batchFiles[0];
  }
  const visible = state.activeSource
    ? state.rows.filter((row) => row.source === state.activeSource)
    : state.rows;
  const visibleDone = visible.filter((row) => row.status === "Done").length;
  $("summary").textContent = visible.length ? `${nameStem(visible[0].name)} · ${visibleDone} xong · ${visible.length - visibleDone} còn lại · ${visible.length} tổng` : "Chưa có dòng nào";
  $("run").disabled = state.running;
  $("start").disabled = state.running;
  $("retry").disabled = state.running;
  for (const id of ["provider", "voiceId", "voice", "model", "language", "speed", "stability", "similarity", "style", "boost", "clearQueue", "importFile", "importFolder", "chooseFolder", "scanFolder", "voiceLanguage", "voiceGender", "voicePrev", "voiceNext", "searchVoice"]) $(id).disabled = state.running;
  applyModelSettings();
  const badge = (status) => status === "Done" ? "pill-done" : status === "Error" ? "pill-error" : /running|admitted|Submitting/i.test(status) ? "pill-run" : "pill-queued";
  const files = [...new Set(state.rows.filter((row) => row.mode === "batch").map((row) => row.source))];
  $("batchRows").innerHTML = files.map((source, index) => {
    const group = state.rows.filter((row) => row.source === source);
    const complete = group.filter((row) => row.status === "Done").length;
    const status = group.some((row) => row.status === "Error") ? "Error" : complete === group.length ? "Done" : group.some((row) => /running|admitted|Submitting/i.test(row.status)) ? "Running" : "Queued";
    return `<tr class="cursor-pointer" data-source="${escapeHtml(source)}" aria-selected="${source === state.activeSource}"><td class="td">${index + 1}</td><td class="td truncate" title="${escapeHtml(group[0].name)}">${escapeHtml(group[0].name)}</td><td class="td">${complete}/${group.length}</td><td class="td"><span class="pill ${badge(status)}">${status}</span></td><td class="td truncate"><button class="file-link text-left" data-folder="${escapeHtml(group[0].folder)}" title="Mở thư mục output">${escapeHtml(group[0].folder)}</button></td></tr>`;
  }).join("");
  $("rows").innerHTML = visible.map((row, index) => `<tr><td class="td">${index + 1}</td><td class="td">${row.part}</td><td class="td"><div class="max-h-20 overflow-y-auto break-words leading-[18px]">${escapeHtml(row.text)}</div></td><td class="td"><span class="pill ${badge(row.status)}">${escapeHtml(row.status)}</span></td><td class="td">${row.output ? `<button class="file-link" data-open="${state.rows.indexOf(row)}" title="Mở file audio">${escapeHtml(row.part)}.mp3</button>` : ""}</td></tr>`).join("") || '<tr><td class="td text-ink-3" colspan="5">Chưa có dòng nào. Nhập file .txt/.srt hoặc kéo thả vào đây.</td></tr>';
  $("statusLabel").textContent = state.running ? "Đang chạy" : state.rows.length && done === state.rows.length ? "Hoàn tất" : "Sẵn sàng";
  $("statusBar").style.width = `${state.rows.length ? Math.round(done / state.rows.length * 100) : 0}%`;
  $("statusLines").textContent = `${done} / ${state.rows.length} dòng`;
  $("statusFiles").textContent = `File ${files.filter((source) => state.rows.filter((row) => row.source === source).every((row) => row.status === "Done")).length} / ${files.length}`;
  $("statusOutput").textContent = visible[0]?.folder || "";
}

function selectSource(source) {
  if (!state.rows.some((row) => row.source === source)) return;
  state.activeSource = source;
  render();
}

async function refreshBalance() {
  const balance = await sonic("balance");
  $("balance").textContent = `Số dư: ${balance.available_chars ?? balance.balance_chars ?? "-"} ký tự`;
  $("status").textContent = "Đã kết nối SonicVoice";
  $("status").className = "pill pill-done";
}

async function refreshVoices() {
  const response = await sonic("voices", { provider: $("provider").value, search: $("voiceSearch").value.trim(), language: $("voiceLanguage").value, gender: $("voiceGender").value, offset: state.voiceOffset });
  const voices = response.items || [];
  state.voices = voices;
  state.voiceTotal = response.total ?? voices.length;
  const current = $("voiceId").value.trim();
  $("voice").innerHTML = '<option value="">Chọn voice</option>' + voices.map((voice) => `<option value="${escapeHtml(voice.id)}">${escapeHtml(voice.name)} (${escapeHtml(voice.id)})</option>`).join("");
  if (voices.some((voice) => voice.id === current)) $("voice").value = current;
  $("voicePageInfo").textContent = `${voices.length ? state.voiceOffset + 1 : 0}-${state.voiceOffset + voices.length} / ${state.voiceTotal}`;
  $("voicePrev").disabled = state.voiceOffset === 0;
  $("voiceNext").disabled = state.voiceOffset + voices.length >= state.voiceTotal;
  log(`Tìm được ${state.voiceTotal} voice ${$("provider").value}.`);
}

async function lookupVoiceId() {
  const id = $("voiceId").value.trim();
  const token = ++state.voiceLookup;
  if (!id || !state.hasKey) { $("voiceMeta").textContent = ""; return; }
  $("voiceMeta").textContent = "Đang tìm voice...";
  try {
    const voice = await sonic("voice", { voiceId: id });
    if (token !== state.voiceLookup || $("voiceId").value.trim() !== id) return;
    $("voiceMeta").textContent = voice.name ? `${voice.name}${voice.language ? ` · ${voice.language}` : ""}` : "API không trả tên voice này";
    setLanguageFromVoice(voice.language);
  } catch (error) {
    if (token === state.voiceLookup) $("voiceMeta").textContent = `Không tìm thấy voice: ${error.message}`;
  }
}

function modelFeatures(provider, modelId) {
  if (provider !== "eleven") return { stability: false, similarity: false, style: false, boost: false };
  if (["eleven_v4", "eleven_v4_turbo"].includes(modelId)) return { stability: true, similarity: true, style: false, boost: false };
  if (["eleven_flash_v2", "eleven_turbo_v2"].includes(modelId)) return { stability: false, similarity: false, style: false, boost: false };
  if (["eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5"].includes(modelId)) return { stability: true, similarity: true, style: true, boost: true };
  return { stability: true, similarity: false, style: false, boost: false };
}

function applyModelSettings() {
  const provider = $("provider").value;
  const features = modelFeatures(provider, $("model").value || "eleven_v3");
  $("elevenSettings").hidden = provider !== "eleven";
  for (const id of ["stability", "similarity", "style", "boost"]) {
    $(id).disabled = !features[id] || state.running;
    $(id).parentElement?.classList.toggle("opacity-50", !features[id]);
  }
  $("speed").min = provider === "eleven" ? "0.7" : "0.5";
  $("speed").max = provider === "eleven" ? "1.2" : "2";
  $("speedHint").textContent = provider === "eleven" ? "ElevenLabs: 0.7-1.2" : "MiniMax: 0.5-2";
}

async function refreshModels() {
  const response = await sonic("models", { provider: $("provider").value });
  const models = Array.isArray(response) ? response : response.items || [];
  state.models = models;
  const currentModel = $("model").value;
  $("model").innerHTML = '<option value="">Mặc định</option>' + models.map((model) => `<option value="${escapeHtml(model.model_id)}">${escapeHtml(model.model_id)}${model.max_chars ? ` · ${model.max_chars} ký tự` : ""}</option>`).join("");
  if (models.some((model) => model.model_id === currentModel)) $("model").value = currentModel;
  applyModelSettings();
  renderLanguageOptions();
}

async function connected() {
  await refreshBalance();
  await Promise.all([refreshVoices(), refreshModels()]);
  await lookupVoiceId();
}

async function scan(path, extensions = ["txt"], mode = "batch") {
  if (!path.trim()) return;
  // Enter rồi rời ô nhập sẽ kích hoạt 2 lần; bỏ lần quét trùng trong 3 giây.
  const scanKey = `${mode}|${path.trim()}`;
  if (state.lastScanKey === scanKey && Date.now() - state.lastScanAt < 3000) return;
  state.lastScanKey = scanKey;
  state.lastScanAt = Date.now();
  const result = await api("/api/scan-folder", { folderPath: path.trim(), extensions });
  addFiles(result.files || [], mode);
  log(`Quét ${result.count} file từ ${result.folderPath}.`);
}

function jobPayload(rows, kind) {
  const provider = $("provider").value;
  const voiceId = $("voiceId").value.trim();
  if (!voiceId) throw new Error("Chưa chọn Voice ID.");
  const speed = Number($("speed").value);
  const minSpeed = provider === "eleven" ? 0.7 : 0.5;
  const maxSpeed = provider === "eleven" ? 1.2 : 2;
  if (kind !== "srt" && (!Number.isFinite(speed) || speed < minSpeed || speed > maxSpeed)) throw new Error(`Tốc độ phải từ ${minSpeed} đến ${maxSpeed}.`);
  const job = { kind, provider, voice_id: voiceId, title: nameStem(rows[0].name) };
  if (kind === "srt") {
    job.srt_text = rows[0].srtText;
    job.srt_combine = true;
  } else {
    job.texts = rows.map((row) => row.text);
    job.filenames = rows.map((row) => `${row.part}.mp3`);
    job.speed = speed;
    job.srt_out = true;
  }
  if ($("model").value) job.model = $("model").value;
  if ($("language").value.trim()) job.language = $("language").value.trim();
  if (provider === "eleven") {
    const features = modelFeatures(provider, $("model").value || "eleven_v3");
    if (features.stability) job.stability = Number($("stability").value);
    if (features.similarity) job.similarity_boost = Number($("similarity").value);
    if (features.style) job.style = Number($("style").value);
    if (features.boost) job.use_speaker_boost = $("boost").checked;
  }
  return job;
}

async function validateSelection(pending) {
  const provider = $("provider").value;
  const voiceId = $("voiceId").value.trim();
  if (!voiceId) throw new Error("Chưa chọn Voice ID.");
  const voice = await sonic("voice", { voiceId });
  if (voice.ready === false) throw new Error("Voice chưa sẵn sàng.");
  if (voice.provider && provider === "eleven" && voice.provider !== "eleven") throw new Error("Voice ID không thuộc ElevenLabs.");
  if (voice.provider && provider === "mini" && !["mini", "minimax"].includes(voice.provider)) throw new Error("Voice ID không thuộc MiniMax.");
  const modelId = $("model").value || (provider === "eleven" ? "eleven_v3" : "");
  const model = modelId ? state.models.find((item) => item.model_id === modelId) : null;
  if (modelId && !model) throw new Error(`Model ${modelId} không có trong danh sách SonicVoice.`);
  const language = $("language").value.trim();
  if (provider === "eleven" && language && model?.languages?.length) {
    const english = new Intl.DisplayNames(["en"], { type: "language" });
    const supported = model.languages.some((code) => code.toLowerCase() === language.toLowerCase() || english.of(code)?.toLowerCase() === language.toLowerCase());
    if (!supported) throw new Error(`Model ${modelId} không hỗ trợ ngôn ngữ ${language}.`);
  }
  for (const row of pending) {
    if (row.srtText) {
      if (row.cueCount > 400) throw new Error(`${row.name}: tối đa 400 cue SRT mỗi job.`);
      if (row.srtText.length > 200000) throw new Error(`${row.name}: vượt 200.000 ký tự mỗi job.`);
      if (model?.max_chars && parseSrt({ text: row.srtText }).some((cue) => cue.length > model.max_chars)) throw new Error(`${row.name}: có cue dài hơn giới hạn ${model.max_chars} ký tự của ${modelId}.`);
    } else if (model?.max_chars && row.text.length > model.max_chars) {
      throw new Error(`${row.name} #${row.part}: ${row.text.length} ký tự, model ${modelId} tối đa ${model.max_chars}.`);
    } else if (row.text.length > 200000) {
      throw new Error(`${row.name} #${row.part}: vượt 200.000 ký tự.`);
    }
  }
  return voice;
}

function batches(rows) {
  const groups = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && last[0].source === row.source && !row.srtText && (last[0].jobId || "") === (row.jobId || "") && last.length < 200 && last.reduce((sum, item) => sum + item.text.length, 0) + row.text.length <= 200000) last.push(row);
    else groups.push([row]);
  }
  return groups;
}

async function waitForJob(jobId, rows) {
  const deadline = Date.now() + 15 * 60 * 1000;
  let lastProgress = "";
  let lastNodeError = "";
  for (;;) {
    if (state.stop) throw new Error("Đã dừng theo yêu cầu.");
    let job;
    try { job = await sonic("job", { jobId }); }
    catch (error) {
      if (!isNetworkError(error)) throw error;
      if (Date.now() > deadline) throw new Error(`${error.message}. Quá 15 phút không hỏi được trạng thái; chạy lại để tiếp tục theo dõi job.`);
      log(`${rows[0].name}: ${error.message}. Job vẫn chạy trên SonicVoice, app hỏi lại sau 5 giây.`);
      await sleep(5000);
      continue;
    }
    const progress = `${job.progress_done ?? 0}/${job.progress_total ?? "?"}`;
    const started = Date.parse(job.created_at || "") || Date.now();
    const elapsed = Math.floor((Date.now() - started) / 60000);
    const status = ["running", "admitted"].includes(job.status) ? `${job.status} · ${progress} · ${elapsed} phút` : (job.status || "Running");
    rows.forEach((row) => { row.status = status; });
    render();
    if (progress !== lastProgress) { log(`${rows[0].name}: ${job.status} ${progress}.`); lastProgress = progress; }
    const nodeError = (job.nodes || []).find((node) => node.error)?.error || "";
    if (nodeError && nodeError !== lastNodeError) { log(`${rows[0].name}: SonicVoice báo ở bước render: ${nodeError}`); lastNodeError = nodeError; }
    if (job.status === "succeeded") return job;
    if (["failed", "partial", "cancelled"].includes(job.status)) {
      rows.forEach((row) => { row.jobId = ""; });
      throw new Error(job.error || `Job ${job.status}`);
    }
    if (Date.now() > deadline) throw new Error("Quá 15 phút chưa xong; chạy lại để tiếp tục theo dõi job.");
    await sleep(3000);
  }
}

function nodesForRow(job, index) {
  const item = (job.items || []).find((entry) => entry.index === index);
  const groupKey = item?.group_key || `item-${index}`;
  const nodes = (job.nodes || []).filter((node) => node.group_key === groupKey && node.status === "done" && node.result_url);
  for (const kind of ["ffmpeg", "merge"]) {
    const output = nodes.find((node) => node.kind === kind);
    if (output) return [output.id];
  }
  const chunks = nodes.filter((node) => node.kind === "tts_chunk");
  if (chunks.length) return chunks.sort((a, b) => a.seq - b.seq).map((node) => node.id);
  return [];
}

async function runRows(mode, onlyErrors = false) {
  if (state.running) return;
  if (!state.hasKey) { log("Hãy lưu SonicVoice API key trước."); return; }
  const pending = state.rows.filter((row) => row.mode === mode && (onlyErrors ? row.status === "Error" : row.status === "Queued" || row.status === "Error"));
  if (!pending.length) { log("Không có đoạn cần chạy."); return; }
  try { jobPayload([pending[0]], pending[0].srtText ? "srt" : "batch"); await validateSelection(pending); }
  catch (error) { log(error.message); return; }
  if (!$("language").value && rowsHaveDigits(pending) && !state.languageWarned) {
    state.languageWarned = true;
    log("Cảnh báo: văn bản có chữ số nhưng Ngôn ngữ đọc đang là Tự nhận diện. Sonic có thể đọc số sai ngôn ngữ, ví dụ 2018 đọc thành tiếng Việt. Hãy chọn Ngôn ngữ đọc, hoặc bấm lại một lần nữa để vẫn chạy.");
    return;
  }
  state.languageWarned = false;
  try { await prepareRowFolders(pending); }
  catch (error) { log(`Không tạo được thư mục output: ${error.message}`); return; }
  state.running = true;
  state.stop = false;
  render();
  for (const group of batches(pending)) {
    if (state.stop) break;
    try {
      if (group[0]?.source && state.activeSource !== group[0].source) {
        state.activeSource = group[0].source;
      }
      group.forEach((row) => { row.status = "Submitting"; });
      render();
      const existing = group.map((row) => row.jobId).filter(Boolean);
      if (new Set(existing).size > 1 || (existing.length && existing.length !== group.length)) throw new Error("Nhóm job chưa đồng nhất; hãy chạy lại từng đoạn lỗi.");
      let jobId = existing[0];
      if (!jobId) {
        const payload = jobPayload(group, group[0].srtText ? "srt" : "batch");
        const startedAt = Date.now();
        let created;
        try {
          created = await sonic("create", { job: payload });
        } catch (error) {
          if (!isNetworkError(error)) throw error;
          log(`${group[0].name}: ${error.message}. Đang kiểm tra trên SonicVoice xem job đã được tạo chưa...`);
          await sleep(3000);
          created = await findRecentJob(payload.title, startedAt);
          if (!created) throw new Error("SonicVoice chưa nhận job này, không bị tính ký tự. Bấm chạy lại để tạo mới.");
          log(`${group[0].name}: tìm thấy job ${created.id} đã tạo, theo dõi tiếp, không tạo lại.`);
        }
        jobId = created.id;
        if (!jobId) throw new Error("SonicVoice không trả về job ID.");
        group.forEach((row, index) => { row.jobId = jobId; row.groupIndex = index; row.groupSize = group.length; });
        log(`${group[0].name}: job ${jobId}, ${group.length} đoạn.`);
      }
      state.activeJobId = jobId;
      if (state.stop) {
        await cancelActiveJob();
        throw new Error("Đã dừng theo yêu cầu.");
      }
      const job = await waitForJob(jobId, group);
      state.activeJobId = "";
      state.cancelling = false;
      if (!group[0].srtText) {
        try {
          const singleLineFile = state.rows.filter((item) => item.source === group[0].source).length === 1;
          const srt = await sonic("srt", singleLineFile ? { jobId, outputFolder: group[0].folder, baseName: nameStem(group[0].name) } : { jobId });
          if (singleLineFile && srt.savedPath) {
            group[0].sonicSrt = true;
            log(`${group[0].name}: đã lưu SRT theo câu từ SonicVoice (${parseSrtCues(srt.text || "").length} câu).`);
          }
          const durations = parseSrtCues(srt.text || "");
          if (singleLineFile) { group[0].durationSeconds = durations.reduce((sum, value) => sum + value, 0) || undefined; throw new Error("skip"); }
          if (durations.length !== group.length) throw new Error(`API trả ${durations.length} cue cho ${group.length} đoạn`);
          group.forEach((row, index) => { row.durationSeconds = durations[index]; });
        } catch (error) { if (error.message !== "skip") log(`${group[0].name}: chưa có thời gian SRT từ API (${error.message}).`); }
      }
      for (let index = 0; index < group.length; index++) {
        const row = group[index];
        if (row.output) { row.status = "Done"; continue; }
        let saved;
        if (row.srtText || row.groupSize === 1) {
          saved = await sonic("download", { jobId, outputFolder: row.folder, part: String(row.part) });
        } else {
          const nodeIds = nodesForRow(job, row.groupIndex);
          if (!nodeIds.length) throw new Error(`Không tìm thấy artifact cho đoạn ${row.part} (item ${row.groupIndex}); job ${jobId}.`);
          saved = await sonic("download-group", { jobId, nodeIds, outputFolder: row.folder, part: String(row.part) });
        }
        row.output = saved.fullPath;
        row.status = "Done";
        log(`${row.name} #${row.part}: ${saved.filename}`);
        render();
      }
      const siblings = state.rows.filter((item) => item.source === group[0].source);
      if (!group[0].srtText && siblings.every((item) => item.status === "Done")) {
        const sonicSrt = siblings.length === 1 && siblings[0].sonicSrt;
        const writeSrt = !sonicSrt && siblings.every((item) => Number.isFinite(item.durationSeconds));
        try { await api("/api/join", { outputFolder: group[0].folder, baseName: nameStem(group[0].name), writeSrt, items: siblings.map((item) => ({ part: item.part, text: item.text, durationSeconds: item.durationSeconds })) }); log(`${group[0].name}: đã ghép MP3${sonicSrt ? ", SRT lấy từ SonicVoice" : writeSrt ? " và tạo SRT theo thời gian API" : "; chưa tạo SRT vì thiếu thời gian thực"}.`); }
        catch (error) { log(`${group[0].name}: audio đã lưu, nhưng ghép file lỗi: ${error.message}`); }
      }
      render();
    } catch (error) {
      state.activeJobId = "";
      state.cancelling = false;
      group.filter((row) => row.status !== "Done").forEach((row) => { row.status = "Error"; });
      log(`${group[0].name}: ${error.message}`);
      render();
      if (/HTTP 401|HTTP 402|HTTP 429/.test(error.message)) break;
    }
  }
  state.running = false;
  render();
}

function action(handler) { return async (...args) => { try { await handler(...args); } catch (error) { log(error.message || String(error)); } }; }
async function cancelActiveJob() {
  const jobId = state.activeJobId;
  if (!jobId || state.cancelling) return;
  state.cancelling = true;
  log(`Đang hủy job ${jobId} trên SonicVoice...`);
  try {
    const result = await sonic("cancel", { jobId });
    state.rows.filter((row) => row.jobId === jobId && row.status !== "Done").forEach((row) => { row.jobId = ""; });
    log(`Đã gửi lệnh hủy ${jobId}. Đã tính: ${result.charged_chars ?? "-"}; hoàn: ${result.refunded_chars ?? "-"} ký tự.`);
  } catch (error) { log(`Không hủy được job ${jobId}: ${error.message}`); }
  finally { state.cancelling = false; }
}
$("saveKey").onclick = action(async () => {
  const key = $("sonicKey").value.trim();
  if (key) await sonic("save-key", { key });
  state.hasKey = (await sonic("status")).hasKey;
  $("sonicKey").value = "";
  await connected();
});
$("clearKey").onclick = action(async () => { await sonic("clear-key"); state.hasKey = false; $("status").textContent = "Chưa kết nối"; $("status").className = "pill pill-queued"; $("balance").textContent = "Số dư: -"; });
$("provider").onchange = action(async () => { $("voiceId").value = ""; $("voiceMeta").textContent = ""; state.voiceOffset = 0; applyModelSettings(); renderLanguageOptions(); if (state.hasKey) await connected(); });
$("model").onchange = () => { applyModelSettings(); renderLanguageOptions(); };
$("language").onchange = () => { state.languageWarned = false; };
$("searchVoice").onclick = action(async () => { state.voiceOffset = 0; await refreshVoices(); });
for (const id of ["voiceLanguage", "voiceGender"]) $(id).onchange = action(async () => { state.voiceOffset = 0; await refreshVoices(); });
$("voicePrev").onclick = action(async () => { state.voiceOffset = Math.max(0, state.voiceOffset - 50); await refreshVoices(); });
$("voiceNext").onclick = action(async () => { state.voiceOffset += 50; await refreshVoices(); });
$("voiceSearch").onkeydown = (event) => { if (event.key === "Enter") $("searchVoice").click(); };
$("voice").onchange = () => { $("voiceId").value = $("voice").value; const selected = state.voices.find((item) => item.id === $("voice").value); $("voiceMeta").textContent = selected?.name || ""; setLanguageFromVoice(selected?.language); };
let voiceLookupTimer;
$("voiceId").oninput = () => { clearTimeout(voiceLookupTimer); voiceLookupTimer = setTimeout(lookupVoiceId, 400); };
$("switchProvider").onclick = () => { if (!state.running) window.location.href = "index.html"; else log("Hãy Stop và chờ job hiện tại trước khi đổi dịch vụ."); };
$("chooseFolder").onclick = action(async () => { const path = await window.__TAURI__.dialog.open({ directory: true }); if (path) { $("folderPath").value = path; await scan(path); } });
$("scanFolder").onclick = action(() => scan($("folderPath").value));
$("folderPath").onkeydown = (event) => { if (event.key === "Enter") $("scanFolder").click(); };
$("folderPath").onchange = () => $("scanFolder").click();
$("importFile").onclick = action(async () => { const paths = await window.__TAURI__.dialog.open({ multiple: true, filters: [{ name: "Text / Subtitles", extensions: ["txt", "srt"] }] }); if (paths) { const files = (await api("/api/read-files", { paths: Array.isArray(paths) ? paths : [paths] })).files || []; addFiles(files, "single"); } });
$("importFolder").onclick = action(async () => { const path = await window.__TAURI__.dialog.open({ directory: true }); if (path) await scan(path, ["txt", "srt"], "single"); });
$("run").onclick = () => runRows("batch");
$("start").onclick = () => runRows("single");
$("retry").onclick = () => runRows("single", true);
const stop = action(async () => {
  if (state.stop || state.cancelling) return;
  state.stop = true;
  if (!state.activeJobId) { log("Đã dừng; sẽ hủy nếu job đang tạo trả về ID."); return; }
  await cancelActiveJob();
});
$("stop").onclick = stop;
$("batchStop").onclick = stop;
$("clearQueue").onclick = () => { if (!state.running) { state.rows = state.rows.filter((row) => row.mode !== "batch"); if (!state.rows.some((row) => row.source === state.activeSource)) state.activeSource = state.rows[0]?.source || ""; render(); } };
$("openLogFile").onclick = action(async (event) => { event?.preventDefault(); event?.stopPropagation(); await flushLogFile(); await api("/api/log-open", { date: localDate() }); });
$("openOutput").onclick = action(() => api("/api/open-output", { outputFolder: state.rows.find((row) => row.source === state.activeSource)?.folder || "" }));
$("rows").onclick = action(async (event) => { const button = event.target.closest("button[data-open]"); if (button) await api("/api/open-path", { path: state.rows[Number(button.dataset.open)].output }); });
$("batchRows").onclick = action(async (event) => { const button = event.target.closest("button[data-folder]"); if (button) { await api("/api/open-output", { outputFolder: button.dataset.folder }); return; } const row = event.target.closest("tr[data-source]"); if (row) selectSource(row.dataset.source); });

queueLogFile(`===== [Sonic] Mở trang SonicVoice ${localDate()} ${new Date().toLocaleTimeString("vi-VN")} =====`);
render();
applyModelSettings();
renderLanguageOptions();
action(async () => {
  const status = await sonic("status");
  state.hasKey = !!status.hasKey;
  if (state.hasKey) await connected();
  else log("Nhập SonicVoice API key để bắt đầu.");
})();
