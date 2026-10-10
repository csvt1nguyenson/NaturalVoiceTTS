import { createServer } from "node:http";
import { readFile, mkdir, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Cấu hình đường dẫn: ưu tiên tham số dòng lệnh (--port, --data-dir, --output-dir, --ffmpeg),
// sau đó biến môi trường, cuối cùng là mặc định cạnh server.js (chế độ web cũ).
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) out[arg.slice(2, eq)] = arg.slice(eq + 1);
    else { out[arg.slice(2)] = argv[i + 1]; i += 1; }
  }
  return out;
}
const cliArgs = parseArgs(process.argv.slice(2));
const isSea = typeof process.execPath === "string" && !/node(\.exe)?$/i.test(process.execPath);
const __dirname = isSea ? path.dirname(process.execPath) : path.dirname(fileURLToPath(import.meta.url));
const publicDir = cliArgs["public-dir"] || process.env.NV_PUBLIC_DIR || path.join(__dirname, "public");
const outputDir = path.resolve(cliArgs["output-dir"] || process.env.NV_OUTPUT_DIR || path.join(__dirname, "output"));
const dataDir = path.resolve(cliArgs["data-dir"] || process.env.NV_DATA_DIR || path.join(__dirname, "data"));
const configPath = path.join(dataDir, "local-config.json");
const defaultMcpUrl = "https://app.aivie.pro/api/v1/mcp";
const ffmpegCandidates = [
  cliArgs.ffmpeg,
  process.env.NV_FFMPEG,
  path.join(__dirname, "ffmpeg.exe"),
  path.join(__dirname, "resources", "ffmpeg.exe"),
  "D:\\SON HOANG\\2. DATA\\DgtAutoEleven\\ffmpeg.exe"
].filter(Boolean);
const ffmpegPath = ffmpegCandidates.find((candidate) => existsSync(candidate)) || ffmpegCandidates[0];
const driveAliases = {
  "Y:": "\\\\kavomedia\\TaiNguyen",
  "Z:": "\\\\KAVO73NGXI\\Tai Lieu"
};

let mcpSession = {
  url: defaultMcpUrl,
  apiKey: "",
  protocolVersion: "2024-11-05",
  tools: [],
  selectedTool: "",
  initialized: false
};
const renderJobs = new Map();
const serverLogs = [];
function addServerLog(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  serverLogs.push(line);
  if (serverLogs.length > 500) serverLogs.shift();
  console.log(line);
}

async function loadLocalConfig() {
  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return {};
  }
}

async function saveLocalConfig(config) {
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}


// ---------- Nhiều key + hạn mức 60 job/giờ mỗi key ----------
const JOBS_PER_HOUR = 60;
const quota = { used: {}, blocked: {} };
const nowS = () => Math.floor(Date.now() / 1000);
const keyLabel = (key) => `…${String(key).slice(-5)}`;
function parseKeys(raw) {
  const found = [...new Set(String(raw || "").match(/aiv_[A-Za-z0-9_\-]{10,}/g) || [])];
  if (!found.length) { const single = normalizeApiKey(raw); if (single) found.push(single); }
  return found.slice(0, 10);
}
function reserveKey() {
  const now = nowS(); let wait = Infinity;
  for (const key of mcpSession.keys || []) {
    const label = keyLabel(key);
    const used = (quota.used[label] = (quota.used[label] || []).filter((t) => now - t < 3600));
    const blockedUntil = quota.blocked[label] || 0;
    if (blockedUntil > now) { wait = Math.min(wait, blockedUntil - now); continue; }
    if (used.length < JOBS_PER_HOUR) { used.push(now); return { key }; }
    wait = Math.min(wait, Math.min(...used) + 3600 - now);
  }
  return { wait: Number.isFinite(wait) ? wait + 1 : 60 };
}
function quotaJson() {
  const now = nowS(); let usedTotal = 0; let free = 0;
  const keys = (mcpSession.keys || []).map((key) => {
    const label = keyLabel(key);
    const used = (quota.used[label] = (quota.used[label] || []).filter((t) => now - t < 3600));
    const blockedFor = Math.max(0, (quota.blocked[label] || 0) - now);
    const n = blockedFor > 0 ? JOBS_PER_HOUR : used.length;
    usedTotal += n; free += JOBS_PER_HOUR - n;
    return { label, used: n, limit: JOBS_PER_HOUR, blockedFor };
  });
  return { keys, keyCount: keys.length, used: usedTotal, total: keys.length * JOBS_PER_HOUR, free };
}
const isRateLimit = (msg) => /quá nhanh|rate_limited|rate limit|HTTP 429/i.test(String(msg));
async function persistConfig() {
  await saveLocalConfig({ mcpUrl: mcpSession.url, apiKey: mcpSession.apiKey, apiKeys: mcpSession.keys || [], usage: quota.used, blocked: quota.blocked });
}
async function createWithRotation(params) {
  if (!(mcpSession.keys || []).length) throw new Error("Chưa có API key. Hãy dán key và bấm Lưu key.");
  for (;;) {
    const pick = reserveKey();
    if (!pick.key) { await persistConfig(); throw new Error(`Mọi API key đã hết lượt tạo job trong giờ này. Thử lại sau ${pick.wait} giây.`); }
    try {
      const result = await mcpRequest("tools/call", params, pick.key);
      await persistConfig();
      return result;
    } catch (error) {
      quota.used[keyLabel(pick.key)]?.pop();
      if (/HTTP 401/.test(error.message)) {
        quota.blocked[keyLabel(pick.key)] = nowS() + 3600;
        addServerLog(`Key ${keyLabel(pick.key)} không hợp lệ hoặc đã thu hồi, bỏ qua.`);
        continue;
      }
      if (!isRateLimit(error.message)) throw error;
      const m = String(error.message).match(/(\d+)\s*(giây|seconds?|sec|s)/);
      const secs = Math.min(3600, Math.max(10, m ? Number(m[1]) : 3600));
      quota.blocked[keyLabel(pick.key)] = nowS() + secs;
      addServerLog(`Key ${keyLabel(pick.key)} hết lượt (AIVIE báo chờ ${secs} giây), chuyển key khác.`);
    }
  }
}

function normalizeApiKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    const servers = parsed.mcpServers || {};
    for (const server of Object.values(servers)) {
      const authorization = server?.headers?.Authorization || server?.headers?.authorization;
      if (authorization) return normalizeApiKey(authorization);
    }
  } catch {}
  const commandHeader = raw.match(/Authorization:\s*Bearer\s+([^\s"']+)/i);
  if (commandHeader) return commandHeader[1];
  const bearer = raw.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim().replace(/^["']|["']$/g, "");
  return raw.replace(/^["']|["']$/g, "");
}

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS"
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function mcpHeaders(extra = {}, key = mcpSession.apiKey) {
  const headers = {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
    ...extra
  };
  if (key) {
    headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

async function parseMcpResponse(response) {
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 600);
    try {
      const parsed = JSON.parse(text);
      message = parsed.message || parsed.error || message;
    } catch {}
    throw new Error(`MCP HTTP ${response.status}: ${message}`);
  }
  if (text.trim().startsWith("event:") || text.includes("\ndata:")) {
    const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
    if (!dataLine) return {};
    return JSON.parse(dataLine.slice(5).trim());
  }
  return text ? JSON.parse(text) : {};
}

async function mcpRequest(method, params = {}, keyOverride = "") {
  // Mọi lệnh tạo job đi qua bộ xoay key.
  if (!keyOverride && method === "tools/call" && String(params?.name || "").startsWith("create_")) {
    return createWithRotation(params);
  }
  const payload = {
    jsonrpc: "2.0",
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    method,
    params
  };
  const response = await fetch(mcpSession.url, {
    method: "POST",
    headers: mcpHeaders({}, keyOverride || mcpSession.apiKey),
    body: JSON.stringify(payload)
  });
  const body = await parseMcpResponse(response);
  if (body.error) {
    const errMsg = String(body.error.message || JSON.stringify(body.error));
    throw new Error(errMsg);
  }
  if (body.result?.isError) {
    const errorMsg = body.result.content?.[0]?.text || "AIVIE trả lỗi không xác định.";
    throw new Error(errorMsg);
  }
  return body.result ?? body;
}

function contentJson(result) {
  if (result?.structuredContent) return result.structuredContent;
  for (const item of result?.content || []) {
    if (item.type === "text" && item.text) {
      try {
        return JSON.parse(item.text);
      } catch {}
    }
  }
  return result || {};
}

async function initializeMcp({ url, apiKey }) {
  const newKeys = apiKey ? parseKeys(apiKey) : [];
  if (newKeys.length) mcpSession.keys = newKeys;
  const normalizedKey = newKeys[0] || mcpSession.apiKey;
  mcpSession = {
    ...mcpSession,
    url: url || mcpSession.url || defaultMcpUrl,
    apiKey: normalizedKey,
    initialized: false,
    tools: [],
    selectedTool: ""
  };
  const init = await mcpRequest("initialize", {
    protocolVersion: mcpSession.protocolVersion,
    capabilities: {},
    clientInfo: { name: "aivie-local-tts-studio", version: "0.1.0" }
  });
  mcpSession.initialized = true;
  if (init.protocolVersion) mcpSession.protocolVersion = init.protocolVersion;
  const listed = await mcpRequest("tools/list", {});
  mcpSession.tools = listed.tools || [];
  mcpSession.selectedTool = pickDefaultTool(mcpSession.tools);
  await persistConfig();
  return { init, tools: mcpSession.tools, selectedTool: mcpSession.selectedTool, url: mcpSession.url, keyCount: (mcpSession.keys || []).length, quota: quotaJson() };
}

function pickDefaultTool(tools) {
  const names = ["tts", "text_to_speech", "speech", "voice", "audio", "generate"];
  const scored = [...tools].map((tool) => {
    const haystack = `${tool.name || ""} ${tool.description || ""}`.toLowerCase();
    return {
      tool,
      score: names.reduce((sum, keyword) => sum + (haystack.includes(keyword) ? 1 : 0), 0)
    };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.score ? scored[0].tool.name : tools[0]?.name || "";
}

function extractAudio(result) {
  const content = result?.content || [];
  for (const item of content) {
    if (item.type === "audio" && item.data) {
      return { buffer: Buffer.from(item.data, "base64"), mimeType: item.mimeType || "audio/mpeg" };
    }
    if (item.type === "resource" && item.resource?.blob) {
      return {
        buffer: Buffer.from(item.resource.blob, "base64"),
        mimeType: item.resource.mimeType || "audio/mpeg"
      };
    }
    if (item.type === "text" && item.text) {
      try {
        const parsed = JSON.parse(item.text);
        const nested = extractAudio(parsed);
        if (nested) return nested;
      } catch {}
    }
  }
  if (result?.audioBase64) {
    return { buffer: Buffer.from(result.audioBase64, "base64"), mimeType: result.mimeType || "audio/mpeg" };
  }
  if (result?.audio_base64) {
    return { buffer: Buffer.from(result.audio_base64, "base64"), mimeType: result.mime_type || "audio/mpeg" };
  }
  if (result?.data && typeof result.data === "string" && result.data.length > 200) {
    return { buffer: Buffer.from(result.data, "base64"), mimeType: result.mimeType || result.mime_type || "audio/mpeg" };
  }
  return null;
}

async function resolveVoiceId(voice) {
  const value = String(voice || "").trim();
  if (!value) return value;
  if (/^[A-Za-z0-9_-]{20,64}$/.test(value) && !value.includes(" ")) return value;
  const listed = await mcpRequest("tools/call", {
    name: "list_voices",
    arguments: { search: value, page_size: 10 }
  });
  const data = contentJson(listed);
  const exact = (data.voices || []).find((item) => item.name?.trim().toLowerCase() === value.toLowerCase());
  return (exact || data.voices?.[0])?.id || value;
}

function findJobId(result) {
  const data = contentJson(result);
  return data.job_id || data.id || data.job?.id || data.job?.job_id;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJob(jobId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await mcpRequest("tools/call", {
      name: "get_job",
      arguments: { job_id: jobId }
    });
    const data = contentJson(result);
    const status = data.status || data.job?.status;
    if (status === "completed") return data;
    if (status === "failed" || status === "cancelled" || status === "canceled") {
      throw new Error(`AIVIE job ${status}: ${data.error || data.message || ""}`.trim());
    }
    await sleep(Math.max(1000, Number(data.poll_after_seconds || 2) * 1000));
  }
  throw new Error("AIVIE job timeout.");
}

async function downloadJobAudio(jobId, fullPath) {
  const linkResult = await mcpRequest("tools/call", {
    name: "get_audio_link",
    arguments: { job_id: jobId, format: "mp3" }
  });
  const data = contentJson(linkResult);
  const audioUrl = data.url || data.download_url || data.link || data.audio_url;
  if (!audioUrl) throw new Error("AIVIE không trả download URL.");
  const response = await fetch(audioUrl);
  if (!response.ok) throw new Error(`Download audio HTTP ${response.status}`);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, Buffer.from(await response.arrayBuffer()));
  return audioUrl;
}

async function renderAivieTts({ args, outputFolder, clipNumber, fileBaseName }) {
  const targetDir = resolveTargetDirectory(outputFolder || "single-import");
  const filename = `${safeName(clipNumber || fileBaseName || "1")}.mp3`;
  const fullPath = path.join(targetDir, filename);
  await mkdir(targetDir, { recursive: true });
  const normalized = { ...args };
  normalized.voice = await resolveVoiceId(normalized.voice || normalized.voice_id);
  delete normalized.voice_id;
  normalized.title = normalized.title || `clip-${clipNumber || fileBaseName || Date.now()}`;
  if (normalized.voice_params) {
    normalized.voice_params = { ...normalized.voice_params };
    const modelStr = String(normalized.model || "").toLowerCase();
    if (modelStr.includes("eleven") || normalized.voice_params.language === "auto") {
      delete normalized.voice_params.language;
    }
  }
  const result = await mcpRequest("tools/call", {
    name: "create_tts_job",
    arguments: normalized
  });
  const jobId = findJobId(result);
  if (!jobId) throw new Error("AIVIE không trả job_id.");
  const job = await waitForJob(jobId);
  await downloadJobAudio(jobId, fullPath);
  return {
    result: { create: result, job },
    saved: { filename, fullPath, mimeType: "audio/mpeg", jobId }
  };
}

async function startAivieRender({ args, outputFolder, clipNumber, fileBaseName, tool }) {
  const targetDir = resolveTargetDirectory(outputFolder || "single-import");
  const filename = `${safeName(clipNumber || fileBaseName || "1")}.mp3`;
  const fullPath = path.join(targetDir, filename);
  await mkdir(targetDir, { recursive: true });
  const normalized = { ...args };
  normalized.voice = await resolveVoiceId(normalized.voice || normalized.voice_id);
  delete normalized.voice_id;
  normalized.title = normalized.title || `clip-${clipNumber || fileBaseName || Date.now()}`;
  if (normalized.voice_params) {
    normalized.voice_params = { ...normalized.voice_params };
    // AIVIE không cho phép tham số language với các model ElevenLabs
    const modelStr = String(normalized.model || "").toLowerCase();
    if (modelStr.includes("eleven") || normalized.voice_params.language === "auto") {
      delete normalized.voice_params.language;
    }
  }
  const result = await mcpRequest("tools/call", {
    name: tool === "create_lines_job" ? "create_lines_job" : "create_tts_job",
    arguments: normalized
  });
  const jobId = findJobId(result);
  if (!jobId) throw new Error("AIVIE không trả job_id.");
  renderJobs.set(jobId, {
    targetDir,
    filename,
    fullPath,
    createdAt: Date.now()
  });
  return { jobId, status: "queued", filename, result };
}

async function pollAivieRender(jobId) {
  const local = renderJobs.get(jobId);
  if (!local) throw new Error("Không tìm thấy local render job.");
  const result = await mcpRequest("tools/call", {
    name: "get_job",
    arguments: { job_id: jobId }
  });
  const data = contentJson(result);
  const status = data.status || data.job?.status || "unknown";
  if (status === "completed") {
    if (!existsSync(local.fullPath)) {
      await downloadJobAudio(jobId, local.fullPath);
    }
    return {
      status,
      job: data,
      saved: { filename: local.filename, fullPath: local.fullPath, mimeType: "audio/mpeg", jobId }
    };
  }
  if (status === "failed" || status === "cancelled" || status === "canceled") {
    return { status, job: data, error: data.error || data.message || `AIVIE job ${status}` };
  }
  return { status, job: data, pollAfterSeconds: data.poll_after_seconds || 3 };
}

function safeName(name) {
  return String(name || "clip").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 80);
}

function safeRelativePath(parts) {
  return parts.map((part) => safeName(part).replace(/^\.+$/, "_")).filter(Boolean).join("/");
}

function normalizeFolderPath(input) {
  return String(input || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\r?\n/g, "")
    .trim();
}

function resolveFolderPath(input) {
  const cleaned = normalizeFolderPath(input);
  const driveMatch = cleaned.match(/^([a-zA-Z]:)([\\/].*)?$/);
  if (!driveMatch) return path.resolve(cleaned);
  if (existsSync(`${driveMatch[1]}\\`)) return path.resolve(cleaned);
  const alias = driveAliases[driveMatch[1].toUpperCase()];
  if (!alias) return path.resolve(cleaned);
  const rest = (driveMatch[2] || "").replace(/^[\\/]/, "");
  return path.join(alias, rest);
}

function resolveTargetDirectory(outputFolder) {
  if (!outputFolder) return outputDir;
  const cleaned = normalizeFolderPath(outputFolder);
  if (/^[a-zA-Z]:[\\/]|^\\\\/.test(cleaned)) {
    return resolveFolderPath(cleaned);
  }
  const folder = safeRelativePath(cleaned.split(/[\\/]+/));
  return folder ? path.join(outputDir, folder) : outputDir;
}

function srtTime(totalSeconds) {
  const totalMs = Math.max(0, Math.round(totalSeconds * 1000));
  const ms = String(totalMs % 1000).padStart(3, "0");
  const total = Math.floor(totalMs / 1000);
  const s = String(total % 60).padStart(2, "0");
  const m = String(Math.floor(total / 60) % 60).padStart(2, "0");
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  return `${h}:${m}:${s},${ms}`;
}

function parseSrtTime(value) {
  const match = String(value || "").trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function estimateDurationSeconds(text) {
  return Math.max(2, Math.ceil(String(text || "").length / 18));
}

function runProcess(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with ${code}`));
    });
  });
}

async function joinMp3AndCreateSrt({ outputFolder, items, baseName }) {
  const targetDir = resolveTargetDirectory(outputFolder || "single-import");
  await mkdir(targetDir, { recursive: true });
  // Thư mục cha (nơi chứa file txt gốc hoặc thư mục gốc chứa folder voice con)
  const parentDir = path.dirname(targetDir);
  await mkdir(parentDir, { recursive: true });

  const ordered = [...(items || [])].sort((a, b) => Number(a.part || 0) - Number(b.part || 0));
  let cursor = 0;
  const srt = ordered.map((item, index) => {
    const parsedStart = parseSrtTime(item.startTime);
    const parsedEnd = parseSrtTime(item.endTime);
    const startSeconds = parsedStart ?? cursor;
    const endSeconds = parsedEnd ?? (startSeconds + estimateDurationSeconds(item.text));
    cursor = Math.max(cursor, endSeconds);
    return `${index + 1}\n${srtTime(startSeconds)} --> ${srtTime(endSeconds)}\n${item.text || ""}\n`;
  }).join("\n");
  const safeBase = safeName(baseName || "joined");
  // 3 file tổng hợp (srt, join-list.txt, full mp3) được lưu ở thư mục cha, ngoài folder voice lẻ
  const srtFile = path.join(parentDir, `${safeBase}.srt`);
  await writeFile(srtFile, srt, "utf8");

  const mp3Files = ordered
    .map((item) => path.join(targetDir, `${safeName(item.part || "")}.mp3`))
    .filter((file) => existsSync(file));
  let joinedMp3 = null;
  let joinWarning = "";
  if (mp3Files.length) {
    const listFile = path.join(parentDir, `.temp-join-list-${Date.now()}.txt`);
    const listText = mp3Files.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n");
    await writeFile(listFile, listText, "utf8");
    joinedMp3 = path.join(parentDir, `${safeBase}_full.mp3`);
    if (existsSync(ffmpegPath)) {
      try {
        await runProcess(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", joinedMp3], parentDir);
      } finally {
        try { await unlink(listFile); } catch {}
      }
    } else {
      try { await unlink(listFile); } catch {}
      joinWarning = "Không tìm thấy ffmpeg.exe để ghép MP3.";
      joinedMp3 = null;
    }
  } else {
    joinWarning = "Chưa có file MP3 để ghép.";
  }
  return {
    targetDir,
    parentDir,
    srt: path.basename(srtFile),
    srtPath: srtFile,
    joinedMp3: joinedMp3 ? path.basename(joinedMp3) : null,
    joinedMp3Path: joinedMp3,
    warning: joinWarning
  };
}

async function collectTxtFiles(root, current = root, found = [], exts = [".txt"]) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectTxtFiles(root, fullPath, found, exts);
    } else if (entry.isFile() && exts.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
      const relativePath = path.relative(root, fullPath).replace(/\\/g, "/");
      found.push({ fullPath, relativePath });
    }
  }
  return found;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir)) return json(res, 403, { error: "Forbidden" });
  if (!existsSync(filePath)) return json(res, 404, { error: "Not found" });
  const ext = path.extname(filePath).toLowerCase();
  const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json" };
  res.writeHead(200, { "content-type": `${types[ext] || "application/octet-stream"}; charset=utf-8` });
  res.end(await readFile(filePath));
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET,POST,OPTIONS"
      });
      res.end();
      return;
    }
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/logs") {
      const since = Number(url.searchParams.get("since") || 0);
      return json(res, 200, { logs: serverLogs.slice(since), total: serverLogs.length });
    }
    if (req.method === "GET" && url.pathname === "/api/quota") {
      return json(res, 200, quotaJson());
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      return json(res, 200, {
        url: mcpSession.url,
        connected: mcpSession.initialized,
        tools: mcpSession.tools,
        selectedTool: mcpSession.selectedTool,
        hasSavedApiKey: Boolean(mcpSession.apiKey),
        keyCount: (mcpSession.keys || []).length,
        quota: quotaJson(),
        outputDir
      });
    }
    if (req.method === "POST" && url.pathname === "/api/connect") {
      return json(res, 200, await initializeMcp(await readJson(req)));
    }
    if (req.method === "POST" && url.pathname === "/api/save-key") {
      const { url: mcpUrl, apiKey } = await readJson(req);
      const keys = parseKeys(apiKey);
      if (!keys.length) throw new Error("API key trống.");
      mcpSession.url = mcpUrl || mcpSession.url || defaultMcpUrl;
      mcpSession.keys = keys;
      mcpSession.apiKey = keys[0];
      await persistConfig();
      return json(res, 200, { ok: true, hasSavedApiKey: true, keyCount: keys.length });
    }
    if (req.method === "POST" && url.pathname === "/api/clear-key") {
      mcpSession.apiKey = "";
      mcpSession.keys = [];
      try { await unlink(configPath); } catch {}
      return json(res, 200, { ok: true, hasSavedApiKey: false });
    }
    if (req.method === "POST" && url.pathname === "/api/read-files") {
      // Desktop (Tauri): nhận danh sách đường dẫn tuyệt đối từ hộp thoại chọn file.
      const { paths } = await readJson(req);
      const list = Array.isArray(paths) ? paths : [];
      const files = [];
      for (const raw of list) {
        const fullPath = resolveFolderPath(raw);
        files.push({
          name: path.basename(fullPath),
          fullPath,
          dirPath: path.dirname(fullPath),
          text: await readFile(fullPath, "utf8")
        });
      }
      return json(res, 200, { count: files.length, files });
    }
    if (req.method === "POST" && url.pathname === "/api/scan-folder") {
      const { folderPath, extensions } = await readJson(req);
      const exts = Array.isArray(extensions) && extensions.length
        ? extensions.map((ext) => String(ext).toLowerCase().replace(/^\.?/, "."))
        : [".txt"];
      if (!folderPath) throw new Error("Chưa nhập đường dẫn thư mục.");
      const cleaned = normalizeFolderPath(folderPath);
      const resolved = resolveFolderPath(cleaned);
      let info;
      try {
        info = await stat(resolved);
      } catch (error) {
        const driveMatch = cleaned.match(/^([a-zA-Z]:)[\\/]/);
        const alias = driveMatch ? driveAliases[driveMatch[1].toUpperCase()] : "";
        if (error?.code === "EACCES" || error?.code === "EPERM") {
          throw new Error(`Không có quyền đọc thư mục: ${resolved}`);
        }
        if (error?.code === "ENOENT") {
          throw new Error(alias
            ? `Không tìm thấy thư mục sau khi đổi ${driveMatch[1]} sang NAS: ${resolved}`
            : `Không tìm thấy thư mục: ${resolved}`);
        }
        throw error;
      }
      if (!info.isDirectory()) throw new Error("Đường dẫn không phải thư mục.");
      const files = await collectTxtFiles(resolved, resolved, [], exts);
      const payload = [];
      for (const file of files) {
        payload.push({
          name: path.basename(file.fullPath),
          fullPath: file.fullPath,
          dirPath: path.dirname(file.fullPath),
          relativePath: `${path.basename(resolved)}/${file.relativePath}`,
          text: await readFile(file.fullPath, "utf8")
        });
      }
      return json(res, 200, { folderPath: resolved, count: payload.length, files: payload });
    }
    if (req.method === "POST" && url.pathname === "/api/call-tool") {
      if (!mcpSession.initialized) throw new Error("Chưa kết nối MCP. Hãy bấm Kết nối trước.");
      const { toolName, args, fileBaseName, outputFolder, clipNumber } = await readJson(req);
      if (toolName === "create_tts_job") {
        return json(res, 200, await renderAivieTts({ args: args || {}, outputFolder, clipNumber, fileBaseName }));
      }
      const result = await mcpRequest("tools/call", { name: toolName, arguments: args || {} });
      const audio = extractAudio(result);
      let saved = null;
      if (audio) {
        const ext = audio.mimeType.includes("wav") ? "wav" : audio.mimeType.includes("ogg") ? "ogg" : "mp3";
        const folder = safeRelativePath(String(outputFolder || "single-import").split(/[\\/]+/));
        const filename = `${safeName(clipNumber || fileBaseName || "1")}.${ext}`;
        const targetDir = path.join(outputDir, folder);
        const fullPath = path.join(targetDir, filename);
        await mkdir(targetDir, { recursive: true });
        await writeFile(fullPath, audio.buffer);
        saved = { filename: `${folder}/${filename}`, fullPath, mimeType: audio.mimeType };
      }
      return json(res, 200, { result, saved });
    }
    if (req.method === "POST" && url.pathname === "/api/start-render") {
      if (!mcpSession.initialized) throw new Error("Chưa kết nối MCP. Hãy bấm Kết nối trước.");
      return json(res, 200, await startAivieRender(await readJson(req)));
    }
    if (req.method === "POST" && url.pathname === "/api/poll-render") {
      const { jobId } = await readJson(req);
      if (!jobId) throw new Error("Thiếu jobId.");
      return json(res, 200, await pollAivieRender(jobId));
    }
    if (req.method === "POST" && url.pathname === "/api/poll-many") {
      const { jobIds } = await readJson(req);
      const ids = Array.isArray(jobIds) ? jobIds : [];
      const out = {};
      if (ids.length) {
        const listed = contentJson(await mcpRequest("tools/call", { name: "list_jobs", arguments: { limit: 20 } }));
        const arr = listed.jobs || listed.items || (Array.isArray(listed) ? listed : []);
        for (const id of ids) {
          let job = arr.find((j) => (j.job_id || j.id) === id);
          if (!job) {
            try { job = contentJson(await mcpRequest("tools/call", { name: "get_job", arguments: { job_id: id } })); }
            catch (e) { out[id] = { status: "unknown", error: e.message }; continue; }
          }
          const status = job.status || job.job?.status || "unknown";
          if (status === "completed") {
            const local = renderJobs.get(id);
            if (!local) { out[id] = { status, error: "Không tìm thấy local render job." }; continue; }
            try {
              if (!existsSync(local.fullPath)) await downloadJobAudio(id, local.fullPath);
              out[id] = { status, duration: job.duration_seconds ?? null, saved: { filename: local.filename, fullPath: local.fullPath, jobId: id } };
            } catch (e) {
              out[id] = /chưa sẵn sàng|not_ready|HTTP 404/.test(e.message) ? { status: "finalizing" } : { status, error: e.message };
            }
          } else if (status === "failed" || status === "cancelled" || status === "canceled") {
            out[id] = { status, error: job.error || job.message || `AIVIE job ${status}` };
          } else out[id] = { status };
        }
      }
      return json(res, 200, { jobs: out });
    }
    if (req.method === "POST" && url.pathname === "/api/save-text") {
      const { filename, text } = await readJson(req);
      const safe = safeName(filename).replace(/\.+$/, "") || "output.txt";
      const fullPath = path.join(outputDir, safe);
      await writeFile(fullPath, text || "", "utf8");
      return json(res, 200, { fullPath, filename: safe });
    }
    if (req.method === "POST" && url.pathname === "/api/join") {
      return json(res, 200, await joinMp3AndCreateSrt(await readJson(req)));
    }
    if (req.method === "POST" && url.pathname === "/api/open-output") {
      const { outputFolder } = await readJson(req);
      const target = resolveTargetDirectory(outputFolder || "");
      await mkdir(target, { recursive: true });
      spawn("explorer.exe", [target], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      return json(res, 200, { path: target });
    }
    if (req.method === "GET" && url.pathname === "/api/download-file") {
      const targetPath = url.searchParams.get("path");
      if (!targetPath) return json(res, 400, { error: "Thiếu path" });
      const resolved = resolveTargetDirectory(path.dirname(targetPath));
      const fullPath = path.isAbsolute(targetPath) ? targetPath : path.join(resolved, path.basename(targetPath));
      if (!existsSync(fullPath)) return json(res, 404, { error: "File không tồn tại" });
      const filename = path.basename(fullPath);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${encodeURIComponent(filename)}"`
      });
      res.end(await readFile(fullPath));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/output/")) {
      const filePath = path.normalize(path.join(outputDir, decodeURIComponent(url.pathname.slice(8))));
      if (!filePath.startsWith(outputDir) || !existsSync(filePath)) return json(res, 404, { error: "Not found" });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(await readFile(filePath));
      return;
    }
    if (req.method === "GET") return serveStatic(req, res);
    json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    json(res, 500, { error: error.message || String(error) });
  }
});

async function main() {
  await mkdir(outputDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const localConfig = await loadLocalConfig();
  if (localConfig.mcpUrl) mcpSession.url = localConfig.mcpUrl;
  if (localConfig.apiKey) mcpSession.apiKey = localConfig.apiKey;
  mcpSession.keys = Array.isArray(localConfig.apiKeys) && localConfig.apiKeys.length ? localConfig.apiKeys : (mcpSession.apiKey ? [mcpSession.apiKey] : []);
  if (mcpSession.keys[0]) mcpSession.apiKey = mcpSession.keys[0];
  Object.assign(quota.used, localConfig.usage || {});
  Object.assign(quota.blocked, localConfig.blocked || {});
  // Desktop: tự thoát khi tiến trình cha (Tauri) không còn, kể cả khi bị kill cứng.
  const parentPid = Number(cliArgs["parent-pid"] || 0);
  if (parentPid > 0) {
    setInterval(() => {
      try { process.kill(parentPid, 0); } catch { process.exit(0); }
    }, 2000).unref();
  }
  const port = Number(cliArgs.port || process.env.PORT || 3177);
  server.listen(port, "127.0.0.1", () => {
    console.log(`NaturalVoice Studio: http://127.0.0.1:${port}`);
    console.log(`Output: ${outputDir}`);
    console.log(`Data: ${dataDir}`);
    console.log(`ffmpeg: ${ffmpegPath}`);
  });
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
