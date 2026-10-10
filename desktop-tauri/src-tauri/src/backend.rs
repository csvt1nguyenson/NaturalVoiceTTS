//! Port của app/server.js sang Rust. Mọi endpoint `/api/*` được gom vào một command `api`
//! nhận { method, path, body } và trả { status, body } để app.js dùng y như fetch cũ.

use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

const DEFAULT_MCP_URL: &str = "https://app.aivie.pro/api/v1/mcp";
const DRIVE_ALIASES: &[(&str, &str)] = &[
    ("Y:", r"\\kavomedia\TaiNguyen"),
    ("Z:", r"\\KAVO73NGXI\Tai Lieu"),
];

#[derive(Clone)]
struct McpSession {
    url: String,
    /// Key chính, dùng cho mọi lệnh không tạo job (list, get_job, link…).
    api_key: String,
    /// Toàn bộ key để xoay vòng khi tạo job. AIVIE giới hạn 60 job/giờ cho MỖI key.
    keys: Vec<String>,
    protocol_version: String,
    tools: Vec<Value>,
    selected_tool: String,
    initialized: bool,
}

struct RenderJob {
    filename: String,
    full_path: PathBuf,
}

/// Lượt tạo job đã dùng của từng key (theo đuôi key), tính trong 1 giờ trượt.
#[derive(Default)]
struct Quota {
    used: HashMap<String, Vec<u64>>,
    blocked: HashMap<String, u64>,
}
const JOBS_PER_HOUR: usize = 60;

pub struct Backend {
    session: Mutex<McpSession>,
    quota: Mutex<Quota>,
    render_jobs: Mutex<HashMap<String, RenderJob>>,
    logs: Mutex<Vec<String>>,
    pub data_dir: PathBuf,
    pub output_dir: PathBuf,
    pub ffmpeg: PathBuf,
    client: reqwest::Client,
}

#[derive(Deserialize)]
pub struct ApiRequest {
    #[serde(default = "default_method")]
    method: String,
    path: String,
    #[serde(default)]
    body: Value,
}
fn default_method() -> String {
    "GET".into()
}

type ApiResult = Result<Value, String>;

impl Backend {
    pub fn new(app: &AppHandle) -> Self {
        let data_dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("data"));
        let output_dir = app
            .path()
            .document_dir()
            .map(|d| d.join("NaturalVoice"))
            .unwrap_or_else(|_| PathBuf::from("output"));
        let resource_dir = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
        let candidates = [
            resource_dir.join("resources").join("ffmpeg.exe"),
            resource_dir.join("ffmpeg.exe"),
            PathBuf::from(r"D:\SON HOANG\2. DATA\DgtAutoEleven\ffmpeg.exe"),
        ];
        let ffmpeg = candidates.iter().find(|p| p.exists()).cloned().unwrap_or(candidates[0].clone());
        let _ = std::fs::create_dir_all(&data_dir);
        let _ = std::fs::create_dir_all(&output_dir);

        let mut session = McpSession {
            url: DEFAULT_MCP_URL.into(),
            api_key: String::new(),
            keys: vec![],
            protocol_version: "2024-11-05".into(),
            tools: vec![],
            selected_tool: String::new(),
            initialized: false,
        };
        let mut quota = Quota::default();
        if let Ok(text) = std::fs::read_to_string(data_dir.join("local-config.json")) {
            if let Ok(cfg) = serde_json::from_str::<Value>(&text) {
                if let Some(u) = cfg.get("mcpUrl").and_then(Value::as_str) {
                    session.url = u.into();
                }
                if let Some(k) = cfg.get("apiKey").and_then(Value::as_str) {
                    session.api_key = k.into();
                }
                if let Some(arr) = cfg.get("apiKeys").and_then(Value::as_array) {
                    session.keys = arr.iter().filter_map(Value::as_str).filter(|k| !k.is_empty()).map(String::from).collect();
                }
                if session.keys.is_empty() && !session.api_key.is_empty() {
                    session.keys = vec![session.api_key.clone()];
                }
                if let Some(first) = session.keys.first() {
                    session.api_key = first.clone();
                }
                if let Some(obj) = cfg.get("usage").and_then(Value::as_object) {
                    for (k, v) in obj {
                        let ts: Vec<u64> = v.as_array().map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
                        quota.used.insert(k.clone(), ts);
                    }
                }
                if let Some(obj) = cfg.get("blocked").and_then(Value::as_object) {
                    for (k, v) in obj {
                        if let Some(t) = v.as_u64() { quota.blocked.insert(k.clone(), t); }
                    }
                }
            }
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .expect("reqwest client");
        Self {
            session: Mutex::new(session),
            quota: Mutex::new(quota),
            render_jobs: Mutex::new(HashMap::new()),
            logs: Mutex::new(vec![]),
            data_dir,
            output_dir,
            ffmpeg,
            client,
        }
    }

    fn config_path(&self) -> PathBuf {
        self.data_dir.join("local-config.json")
    }

    fn log(&self, msg: impl AsRef<str>) {
        let line = format!("[{}] {}", chrono_time(), msg.as_ref());
        let mut logs = self.logs.lock().unwrap();
        logs.push(line);
        if logs.len() > 500 {
            logs.remove(0);
        }
    }

    fn save_config(&self) -> Result<(), String> {
        let s = self.session.lock().unwrap().clone();
        let (used, blocked) = {
            let q = self.quota.lock().unwrap();
            (json!(q.used), json!(q.blocked))
        };
        let v = json!({ "mcpUrl": s.url, "apiKey": s.api_key, "apiKeys": s.keys, "usage": used, "blocked": blocked });
        std::fs::write(self.config_path(), serde_json::to_string_pretty(&v).unwrap()).map_err(|e| e.to_string())
    }

    // ---------- MCP ----------

    async fn mcp_request(&self, method: &str, params: Value) -> ApiResult {
        let key = self.session.lock().unwrap().api_key.clone();
        self.mcp_request_key(&key, method, params).await
    }

    async fn mcp_request_key(&self, key: &str, method: &str, params: Value) -> ApiResult {
        let url = self.session.lock().unwrap().url.clone();
        let key = key.to_string();
        let payload = json!({
            "jsonrpc": "2.0",
            "id": format!("{}-{}", now_ms(), rand_suffix()),
            "method": method,
            "params": params
        });
        let mut req = self
            .client
            .post(&url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream");
        if !key.is_empty() {
            req = req.header("authorization", format!("Bearer {key}"));
        }
        let resp = req.json(&payload).send().await.map_err(|e| format!("MCP request lỗi: {e}"))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let mut message: String = text.chars().take(600).collect();
            if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
                if let Some(m) = parsed.get("message").or(parsed.get("error")).and_then(Value::as_str) {
                    message = m.into();
                }
            }
            return Err(format!("MCP HTTP {}: {}", status.as_u16(), message));
        }
        let body: Value = if text.trim_start().starts_with("event:") || text.contains("\ndata:") {
            match text.lines().find(|l| l.starts_with("data:")) {
                Some(line) => serde_json::from_str(line[5..].trim()).map_err(|e| e.to_string())?,
                None => json!({}),
            }
        } else if text.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&text).map_err(|e| format!("JSON lỗi: {e}"))?
        };
        if let Some(err) = body.get("error") {
            return Err(err.get("message").and_then(Value::as_str).map(String::from).unwrap_or_else(|| err.to_string()));
        }
        if body.pointer("/result/isError").and_then(Value::as_bool) == Some(true) {
            return Err(body
                .pointer("/result/content/0/text")
                .and_then(Value::as_str)
                .unwrap_or("AIVIE trả lỗi không xác định.")
                .into());
        }
        Ok(body.get("result").cloned().unwrap_or(body))
    }

    async fn call_tool(&self, name: &str, args: Value) -> ApiResult {
        if name.starts_with("create_") {
            return self.create_with_rotation(name, args).await;
        }
        self.mcp_request("tools/call", json!({ "name": name, "arguments": args })).await
    }

    // ---------- Xoay vòng key + đếm hạn mức 60 job/giờ mỗi key ----------

    /// Chọn key còn lượt và giữ chỗ luôn (để nhiều job song song không cùng lấy lượt cuối).
    /// Hết lượt ở mọi key thì trả về số giây cần chờ.
    fn reserve_key(&self) -> Result<String, u64> {
        let keys = self.session.lock().unwrap().keys.clone();
        let now = now_s();
        let mut q = self.quota.lock().unwrap();
        let mut wait = u64::MAX;
        for key in &keys {
            let label = key_label(key);
            let blocked_until = q.blocked.get(&label).copied().unwrap_or(0);
            let used = q.used.entry(label.clone()).or_default();
            used.retain(|t| now.saturating_sub(*t) < 3600);
            if blocked_until > now {
                wait = wait.min(blocked_until - now);
                continue;
            }
            if used.len() < JOBS_PER_HOUR {
                used.push(now);
                return Ok(key.clone());
            }
            let oldest = used.iter().min().copied().unwrap_or(now);
            wait = wait.min((oldest + 3600).saturating_sub(now));
        }
        Err(if wait == u64::MAX { 60 } else { wait + 1 })
    }

    fn release_key(&self, key: &str) {
        let mut q = self.quota.lock().unwrap();
        if let Some(v) = q.used.get_mut(&key_label(key)) {
            v.pop();
        }
    }

    fn block_key(&self, key: &str, secs: u64) {
        let mut q = self.quota.lock().unwrap();
        q.blocked.insert(key_label(key), now_s() + secs.clamp(10, 3600));
    }

    async fn create_with_rotation(&self, name: &str, args: Value) -> ApiResult {
        if self.session.lock().unwrap().keys.is_empty() {
            return Err("Chưa có API key. Hãy dán key và bấm Lưu key.".into());
        }
        loop {
            let key = match self.reserve_key() {
                Ok(k) => k,
                Err(wait) => {
                    let _ = self.save_config();
                    return Err(format!("Mọi API key đã hết lượt tạo job trong giờ này. Thử lại sau {wait} giây."));
                }
            };
            match self.mcp_request_key(&key, "tools/call", json!({ "name": name, "arguments": args.clone() })).await {
                Ok(v) => {
                    let _ = self.save_config();
                    return Ok(v);
                }
                Err(e) if is_rate_limit(&e) => {
                    // AIVIE đếm cả job tạo từ nơi khác bằng key này: khoá key theo thời gian họ báo, thử key kế tiếp.
                    self.release_key(&key);
                    let secs = parse_retry_secs(&e).unwrap_or(3600);
                    self.block_key(&key, secs);
                    self.log(format!("Key {} hết lượt (AIVIE báo chờ {secs} giây), chuyển key khác.", key_label(&key)));
                }
                Err(e) if e.contains("HTTP 401") => {
                    // Key sai hoặc đã thu hồi: bỏ qua key này 1 giờ, dùng key khác.
                    self.release_key(&key);
                    self.block_key(&key, 3600);
                    self.log(format!("Key {} không hợp lệ hoặc đã thu hồi, bỏ qua.", key_label(&key)));
                }
                Err(e) => {
                    self.release_key(&key);
                    return Err(e);
                }
            }
        }
    }

    fn quota_json(&self) -> Value {
        let keys = self.session.lock().unwrap().keys.clone();
        let now = now_s();
        let mut q = self.quota.lock().unwrap();
        let mut list = vec![];
        let mut used_total = 0usize;
        let mut free_total = 0usize;
        for key in &keys {
            let label = key_label(key);
            let blocked_for = q.blocked.get(&label).copied().unwrap_or(0).saturating_sub(now);
            let used = q.used.entry(label.clone()).or_default();
            used.retain(|t| now.saturating_sub(*t) < 3600);
            let n = if blocked_for > 0 { JOBS_PER_HOUR } else { used.len() };
            used_total += n;
            free_total += JOBS_PER_HOUR - n.min(JOBS_PER_HOUR);
            list.push(json!({ "label": label, "used": n, "limit": JOBS_PER_HOUR, "blockedFor": blocked_for }));
        }
        json!({ "keys": list, "keyCount": keys.len(), "used": used_total, "total": keys.len() * JOBS_PER_HOUR, "free": free_total })
    }

    async fn initialize(&self, url: Option<String>, api_key: Option<String>) -> ApiResult {
        {
            let mut s = self.session.lock().unwrap();
            if let Some(u) = url.filter(|u| !u.is_empty()) {
                s.url = u;
            }
            if let Some(k) = api_key.filter(|k| !k.trim().is_empty()) {
                let keys = parse_keys(&k);
                if let Some(first) = keys.first() {
                    s.api_key = first.clone();
                    s.keys = keys;
                }
            }
            s.initialized = false;
            s.tools.clear();
            s.selected_tool.clear();
        }
        let pv = self.session.lock().unwrap().protocol_version.clone();
        let init = self
            .mcp_request(
                "initialize",
                json!({ "protocolVersion": pv, "capabilities": {}, "clientInfo": { "name": "naturalvoice-desktop", "version": "1.0.0" } }),
            )
            .await?;
        let listed = self.mcp_request("tools/list", json!({})).await?;
        let tools = listed.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
        let selected = pick_default_tool(&tools);
        let url_out;
        {
            let mut s = self.session.lock().unwrap();
            s.initialized = true;
            if let Some(v) = init.get("protocolVersion").and_then(Value::as_str) {
                s.protocol_version = v.into();
            }
            s.tools = tools.clone();
            s.selected_tool = selected.clone();
            url_out = s.url.clone();
        }
        self.save_config()?;
        let quota = self.quota_json();
        Ok(json!({ "init": init, "tools": tools, "selectedTool": selected, "url": url_out, "keyCount": quota["keyCount"], "quota": quota }))
    }

    async fn resolve_voice_id(&self, voice: &str) -> Result<String, String> {
        let value = voice.trim();
        if value.is_empty() {
            return Ok(value.into());
        }
        let id_re = Regex::new(r"^[A-Za-z0-9_-]{20,64}$").unwrap();
        if id_re.is_match(value) {
            return Ok(value.into());
        }
        let listed = self.call_tool("list_voices", json!({ "search": value, "page_size": 10 })).await?;
        let data = content_json(&listed);
        let voices = data.get("voices").and_then(Value::as_array).cloned().unwrap_or_default();
        let exact = voices.iter().find(|v| {
            v.get("name").and_then(Value::as_str).map(|n| n.trim().eq_ignore_ascii_case(value)).unwrap_or(false)
        });
        Ok(exact
            .or(voices.first())
            .and_then(|v| v.get("id").and_then(Value::as_str))
            .unwrap_or(value)
            .into())
    }

    async fn wait_for_job(&self, job_id: &str) -> ApiResult {
        for _ in 0..120 {
            let result = self.call_tool("get_job", json!({ "job_id": job_id })).await?;
            let data = content_json(&result);
            let status = job_status(&data);
            if status == "completed" {
                return Ok(data);
            }
            if matches!(status.as_str(), "failed" | "cancelled" | "canceled") {
                let msg = data.get("error").or(data.get("message")).and_then(Value::as_str).unwrap_or("");
                return Err(format!("AIVIE job {status}: {msg}").trim().into());
            }
            let secs = data.get("poll_after_seconds").and_then(Value::as_f64).unwrap_or(2.0).max(1.0);
            tokio::time::sleep(Duration::from_secs_f64(secs)).await;
        }
        Err("AIVIE job timeout.".into())
    }

    async fn download_job_audio(&self, job_id: &str, full_path: &Path) -> Result<String, String> {
        let link = self.call_tool("get_audio_link", json!({ "job_id": job_id, "format": "mp3" })).await?;
        let data = content_json(&link);
        let url = ["url", "download_url", "link", "audio_url"]
            .iter()
            .find_map(|k| data.get(*k).and_then(Value::as_str))
            .ok_or("AIVIE không trả download URL.")?
            .to_string();
        let resp = self.client.get(&url).send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("Download audio HTTP {}", resp.status().as_u16()));
        }
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(full_path, &bytes).map_err(|e| e.to_string())?;
        Ok(url)
    }

    async fn prepare_tts(&self, body: &Value) -> Result<(Value, PathBuf, String), String> {
        let output_folder = body.get("outputFolder").and_then(Value::as_str).unwrap_or("single-import");
        let target_dir = self.resolve_target_directory(if output_folder.is_empty() { "single-import" } else { output_folder });
        let clip = body
            .get("clipNumber")
            .map(value_to_string)
            .filter(|s| !s.is_empty())
            .or_else(|| body.get("fileBaseName").and_then(Value::as_str).map(String::from).filter(|s| !s.is_empty()))
            .unwrap_or_else(|| "1".into());
        let filename = format!("{}.mp3", safe_name(&clip));
        let full_path = target_dir.join(&filename);
        std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

        let mut args = body.get("args").cloned().unwrap_or(json!({}));
        let obj = args.as_object_mut().ok_or("args phải là object")?;
        let voice_in = obj
            .get("voice")
            .or(obj.get("voice_id"))
            .map(value_to_string)
            .unwrap_or_default();
        let voice = self.resolve_voice_id(&voice_in).await?;
        obj.insert("voice".into(), Value::String(voice));
        obj.remove("voice_id");
        if obj.get("title").and_then(Value::as_str).map(|t| t.is_empty()).unwrap_or(true) {
            obj.insert("title".into(), Value::String(format!("clip-{clip}")));
        }
        let model = obj.get("model").map(value_to_string).unwrap_or_default().to_lowercase();
        if let Some(vp) = obj.get_mut("voice_params").and_then(Value::as_object_mut) {
            let lang_auto = vp.get("language").and_then(Value::as_str) == Some("auto");
            if model.contains("eleven") || lang_auto {
                vp.remove("language");
            }
        }
        Ok((args, full_path, filename))
    }

    async fn render_tts(&self, body: &Value) -> ApiResult {
        let (args, full_path, filename) = self.prepare_tts(body).await?;
        let result = self.call_tool("create_tts_job", args).await?;
        let job_id = find_job_id(&result).ok_or("AIVIE không trả job_id.")?;
        let job = self.wait_for_job(&job_id).await?;
        self.download_job_audio(&job_id, &full_path).await?;
        Ok(json!({
            "result": { "create": result, "job": job },
            "saved": { "filename": filename, "fullPath": full_path, "mimeType": "audio/mpeg", "jobId": job_id }
        }))
    }

    async fn start_render(&self, body: &Value) -> ApiResult {
        let (args, full_path, filename) = self.prepare_tts(body).await?;
        // tool: create_tts_job (từng dòng) hoặc create_lines_job (cả file trong 1 job).
        let tool = body.get("tool").and_then(Value::as_str).filter(|t| *t == "create_lines_job").unwrap_or("create_tts_job");
        let result = self.call_tool(tool, args).await?;
        let job_id = find_job_id(&result).ok_or("AIVIE không trả job_id.")?;
        self.render_jobs.lock().unwrap().insert(job_id.clone(), RenderJob { filename: filename.clone(), full_path });
        Ok(json!({ "jobId": job_id, "status": "queued", "filename": filename, "result": result }))
    }

    async fn poll_render(&self, job_id: &str) -> ApiResult {
        let (filename, full_path) = {
            let jobs = self.render_jobs.lock().unwrap();
            let j = jobs.get(job_id).ok_or("Không tìm thấy local render job.")?;
            (j.filename.clone(), j.full_path.clone())
        };
        let result = self.call_tool("get_job", json!({ "job_id": job_id })).await?;
        let data = content_json(&result);
        let status = job_status(&data);
        if status == "completed" {
            if !full_path.exists() {
                self.download_job_audio(job_id, &full_path).await?;
            }
            return Ok(json!({
                "status": status, "job": data,
                "saved": { "filename": filename, "fullPath": full_path, "mimeType": "audio/mpeg", "jobId": job_id }
            }));
        }
        if matches!(status.as_str(), "failed" | "cancelled" | "canceled") {
            let err = data
                .get("error")
                .or(data.get("message"))
                .and_then(Value::as_str)
                .map(String::from)
                .unwrap_or_else(|| format!("AIVIE job {status}"));
            return Ok(json!({ "status": status, "job": data, "error": err }));
        }
        let after = data.get("poll_after_seconds").cloned().unwrap_or(json!(3));
        Ok(json!({ "status": status, "job": data, "pollAfterSeconds": after }))
    }

    /// Hỏi trạng thái nhiều job bằng MỘT lần gọi list_jobs, để tiết kiệm hạn mức API.
    async fn poll_many(&self, ids: &[String]) -> ApiResult {
        if ids.is_empty() {
            return Ok(json!({ "jobs": {} }));
        }
        let listed = self.call_tool("list_jobs", json!({ "limit": 20 })).await?;
        let data = content_json(&listed);
        let arr = data.get("jobs").or(data.get("items")).and_then(Value::as_array).cloned()
            .or_else(|| data.as_array().cloned()).unwrap_or_default();
        let mut out = serde_json::Map::new();
        for id in ids {
            let found = arr.iter().find(|j| {
                j.get("job_id").or(j.get("id")).and_then(Value::as_str) == Some(id.as_str())
            }).cloned();
            let job = match found {
                Some(j) => j,
                None => {
                    // Job cũ không còn trong 50 job gần nhất: hỏi riêng.
                    match self.call_tool("get_job", json!({ "job_id": id })).await {
                        Ok(r) => content_json(&r),
                        Err(e) => { out.insert(id.clone(), json!({ "status": "unknown", "error": e })); continue; }
                    }
                }
            };
            let status = job_status(&job);
            if status == "completed" {
                let local = {
                    let jobs = self.render_jobs.lock().unwrap();
                    jobs.get(id).map(|j| (j.filename.clone(), j.full_path.clone()))
                };
                match local {
                    Some((filename, full_path)) => {
                        if !full_path.exists() {
                            if let Err(e) = self.download_job_audio(id, &full_path).await {
                                // AIVIE báo completed nhưng audio chưa lên CDN: chờ tiếp ở lượt poll sau.
                                if e.contains("chưa sẵn sàng") || e.contains("not_ready") || e.contains("HTTP 404") {
                                    out.insert(id.clone(), json!({ "status": "finalizing" }));
                                } else {
                                    out.insert(id.clone(), json!({ "status": "completed", "error": e }));
                                }
                                continue;
                            }
                        }
                        let duration = job.get("duration_seconds").cloned().unwrap_or(Value::Null);
                        out.insert(id.clone(), json!({ "status": "completed", "duration": duration, "saved": { "filename": filename, "fullPath": full_path, "jobId": id } }));
                    }
                    None => { out.insert(id.clone(), json!({ "status": "completed", "error": "Không tìm thấy local render job." })); }
                }
            } else if matches!(status.as_str(), "failed" | "cancelled" | "canceled") {
                let err = job.get("error").or(job.get("message")).and_then(Value::as_str).map(String::from).unwrap_or_else(|| format!("AIVIE job {status}"));
                out.insert(id.clone(), json!({ "status": status, "error": err }));
            } else {
                out.insert(id.clone(), json!({ "status": status }));
            }
        }
        Ok(json!({ "jobs": out }))
    }

    // ---------- Paths ----------

    fn resolve_target_directory(&self, output_folder: &str) -> PathBuf {
        if output_folder.is_empty() {
            return self.output_dir.clone();
        }
        let cleaned = normalize_folder_path(output_folder);
        if is_disk_path(&cleaned) {
            return resolve_folder_path(&cleaned);
        }
        let rel = safe_relative_path(&cleaned);
        if rel.as_os_str().is_empty() {
            self.output_dir.clone()
        } else {
            self.output_dir.join(rel)
        }
    }

    // ---------- Join / SRT ----------

    fn join_mp3_and_srt(&self, body: &Value) -> ApiResult {
        let output_folder = body.get("outputFolder").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("single-import");
        let target_dir = self.resolve_target_directory(output_folder);
        std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
        let parent_dir = target_dir.parent().map(Path::to_path_buf).unwrap_or(target_dir.clone());
        std::fs::create_dir_all(&parent_dir).map_err(|e| e.to_string())?;

        let mut items = body.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        items.sort_by_key(|i| i.get("part").and_then(Value::as_f64).unwrap_or(0.0) as i64);

        let mut cursor = 0.0f64;
        let mut srt = String::new();
        for (index, item) in items.iter().enumerate() {
            let text = item.get("text").and_then(Value::as_str).unwrap_or("");
            let start = item.get("startTime").and_then(Value::as_str).and_then(parse_srt_time).unwrap_or(cursor);
            let end = item
                .get("endTime")
                .and_then(Value::as_str)
                .and_then(parse_srt_time)
                .unwrap_or(start + estimate_duration(text));
            cursor = cursor.max(end);
            srt.push_str(&format!("{}\n{} --> {}\n{}\n\n", index + 1, srt_time(start), srt_time(end), text));
        }
        let srt = srt.trim_end_matches('\n').to_string() + "\n";
        let base = safe_name(body.get("baseName").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("joined"));
        let srt_file = parent_dir.join(format!("{base}.srt"));
        std::fs::write(&srt_file, &srt).map_err(|e| e.to_string())?;

        let mp3_files: Vec<PathBuf> = items
            .iter()
            .map(|i| target_dir.join(format!("{}.mp3", safe_name(&i.get("part").map(value_to_string).unwrap_or_default()))))
            .filter(|p| p.exists())
            .collect();

        let mut joined: Option<PathBuf> = None;
        let mut warning = String::new();
        if mp3_files.is_empty() {
            warning = "Chưa có file MP3 để ghép.".into();
        } else if !self.ffmpeg.exists() {
            warning = "Không tìm thấy ffmpeg.exe để ghép MP3.".into();
        } else {
            let list_file = parent_dir.join(format!(".temp-join-list-{}.txt", now_ms()));
            let list_text = mp3_files
                .iter()
                .map(|p| format!("file '{}'", p.display().to_string().replace('\'', "'\\''")))
                .collect::<Vec<_>>()
                .join("\n");
            std::fs::write(&list_file, list_text).map_err(|e| e.to_string())?;
            let out = parent_dir.join(format!("{base}_full.mp3"));
            let result = run_hidden(&self.ffmpeg)
                .args(["-y", "-f", "concat", "-safe", "0", "-i"])
                .arg(&list_file)
                .args(["-c", "copy"])
                .arg(&out)
                .current_dir(&parent_dir)
                .output();
            let _ = std::fs::remove_file(&list_file);
            let output = result.map_err(|e| e.to_string())?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(if stderr.is_empty() { format!("ffmpeg exited with {}", output.status) } else { stderr });
            }
            joined = Some(out);
        }
        Ok(json!({
            "targetDir": target_dir,
            "parentDir": parent_dir,
            "srt": srt_file.file_name().map(|s| s.to_string_lossy().to_string()),
            "srtPath": srt_file,
            "joinedMp3": joined.as_ref().and_then(|p| p.file_name()).map(|s| s.to_string_lossy().to_string()),
            "joinedMp3Path": joined,
            "warning": warning
        }))
    }

    // ---------- Dispatcher ----------

    pub async fn handle(&self, req: ApiRequest) -> ApiResult {
        let path = req.path.split('?').next().unwrap_or("").to_string();
        let query: HashMap<String, String> = req
            .path
            .split_once('?')
            .map(|(_, q)| {
                q.split('&')
                    .filter_map(|kv| kv.split_once('=').map(|(k, v)| (k.to_string(), url_decode(v))))
                    .collect()
            })
            .unwrap_or_default();
        let body = req.body;
        let s = |k: &str| body.get(k).and_then(Value::as_str).map(String::from);

        match path.as_str() {
            "/api/logs" => {
                let since: usize = query.get("since").and_then(|v| v.parse().ok()).unwrap_or(0);
                let logs = self.logs.lock().unwrap();
                let slice: Vec<&String> = logs.iter().skip(since).collect();
                Ok(json!({ "logs": slice, "total": logs.len() }))
            }
            "/api/quota" => Ok(self.quota_json()),
            "/api/status" => {
                let quota = self.quota_json();
                let s = self.session.lock().unwrap();
                Ok(json!({
                    "url": s.url, "connected": s.initialized, "tools": s.tools,
                    "keyCount": s.keys.len(), "quota": quota,
                    "selectedTool": s.selected_tool, "hasSavedApiKey": !s.api_key.is_empty(),
                    "outputDir": self.output_dir, "dataDir": self.data_dir, "ffmpeg": self.ffmpeg
                }))
            }
            "/api/connect" => self.initialize(s("url"), s("apiKey")).await,
            "/api/save-key" => {
                let keys = parse_keys(&s("apiKey").unwrap_or_default());
                if keys.is_empty() {
                    return Err("API key trống.".into());
                }
                let count = keys.len();
                {
                    let mut sess = self.session.lock().unwrap();
                    if let Some(u) = s("url").filter(|u| !u.is_empty()) {
                        sess.url = u;
                    }
                    sess.api_key = keys[0].clone();
                    sess.keys = keys;
                }
                self.save_config()?;
                Ok(json!({ "ok": true, "hasSavedApiKey": true, "keyCount": count }))
            }
            "/api/clear-key" => {
                {
                    let mut sess = self.session.lock().unwrap();
                    sess.api_key.clear();
                    sess.keys.clear();
                }
                let _ = std::fs::remove_file(self.config_path());
                Ok(json!({ "ok": true, "hasSavedApiKey": false }))
            }
            "/api/read-files" => {
                let mut files = vec![];
                for raw in body.get("paths").and_then(Value::as_array).cloned().unwrap_or_default() {
                    let full = resolve_folder_path(&normalize_folder_path(raw.as_str().unwrap_or("")));
                    let text = read_text(&full)?;
                    files.push(json!({
                        "name": full.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                        "fullPath": full, "dirPath": full.parent(), "text": text
                    }));
                }
                Ok(json!({ "count": files.len(), "files": files }))
            }
            "/api/scan-folder" => {
                let folder = s("folderPath").ok_or("Chưa nhập đường dẫn thư mục.")?;
                let exts: Vec<String> = body
                    .get("extensions")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).map(|e| format!(".{}", e.trim_start_matches('.').to_lowercase())).collect())
                    .filter(|v: &Vec<String>| !v.is_empty())
                    .unwrap_or_else(|| vec![".txt".into()]);
                let cleaned = normalize_folder_path(&folder);
                let resolved = resolve_folder_path(&cleaned);
                let meta = std::fs::metadata(&resolved).map_err(|e| match e.kind() {
                    std::io::ErrorKind::NotFound => format!("Không tìm thấy thư mục: {}", resolved.display()),
                    std::io::ErrorKind::PermissionDenied => format!("Không có quyền đọc thư mục: {}", resolved.display()),
                    _ => e.to_string(),
                })?;
                if !meta.is_dir() {
                    return Err("Đường dẫn không phải thư mục.".into());
                }
                let mut found = vec![];
                collect_files(&resolved, &resolved, &exts, &mut found)?;
                let root_name = resolved.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let mut files = vec![];
                for (full, rel) in found {
                    files.push(json!({
                        "name": full.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                        "fullPath": full, "dirPath": full.parent(),
                        "relativePath": format!("{root_name}/{rel}"),
                        "text": read_text(&full)?
                    }));
                }
                Ok(json!({ "folderPath": resolved, "count": files.len(), "files": files }))
            }
            "/api/call-tool" => {
                if !self.session.lock().unwrap().initialized {
                    return Err("Chưa kết nối MCP. Hãy bấm Kết nối trước.".into());
                }
                let tool = s("toolName").unwrap_or_default();
                if tool == "create_tts_job" {
                    return self.render_tts(&body).await;
                }
                let result = self.call_tool(&tool, body.get("args").cloned().unwrap_or(json!({}))).await?;
                Ok(json!({ "result": result, "saved": Value::Null }))
            }
            "/api/start-render" => {
                if !self.session.lock().unwrap().initialized {
                    return Err("Chưa kết nối MCP. Hãy bấm Kết nối trước.".into());
                }
                self.start_render(&body).await
            }
            "/api/poll-render" => self.poll_render(&s("jobId").ok_or("Thiếu jobId.")?).await,
            "/api/poll-many" => {
                let ids: Vec<String> = body.get("jobIds").and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default();
                self.poll_many(&ids).await
            }
            "/api/save-text" => {
                let name = safe_name(&s("filename").unwrap_or_default()).trim_end_matches('.').to_string();
                let name = if name.is_empty() { "output.txt".to_string() } else { name };
                let full = self.output_dir.join(&name);
                std::fs::write(&full, s("text").unwrap_or_default()).map_err(|e| e.to_string())?;
                Ok(json!({ "fullPath": full, "filename": name }))
            }
            "/api/join" => self.join_mp3_and_srt(&body),
            "/api/open-output" => {
                let target = self.resolve_target_directory(&s("outputFolder").unwrap_or_default());
                std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
                run_hidden("explorer.exe").arg(&target).spawn().map_err(|e| e.to_string())?;
                Ok(json!({ "path": target }))
            }
            "/api/open-path" => {
                // Desktop: thay cho link download, mở file bằng Explorer (chọn sẵn file).
                let raw = s("path").ok_or("Thiếu path")?;
                let p = PathBuf::from(&raw);
                let full = if p.is_absolute() {
                    p
                } else {
                    let dir = self.resolve_target_directory(&p.parent().map(|x| x.to_string_lossy().to_string()).unwrap_or_default());
                    dir.join(p.file_name().unwrap_or_default())
                };
                if !full.exists() {
                    return Err("File không tồn tại".into());
                }
                run_hidden("explorer.exe").arg(format!("/select,{}", full.display())).spawn().map_err(|e| e.to_string())?;
                Ok(json!({ "path": full }))
            }
            _ => Err(format!("Không có endpoint: {path}")),
        }
    }
}

#[tauri::command]
pub async fn api(backend: State<'_, Backend>, request: ApiRequest) -> Result<Value, String> {
    let path = request.path.clone();
    match backend.handle(request).await {
        Ok(body) => Ok(json!({ "status": 200, "body": body })),
        Err(message) => {
            if !path.starts_with("/api/logs") && !path.starts_with("/api/poll-render") {
                backend.log(format!("{path}: {message}"));
            }
            Ok(json!({ "status": 500, "body": { "error": message } }))
        }
    }
}

// ---------- Helpers ----------

fn run_hidden(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

fn now_s() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Nhãn ngắn của key để hiển thị và lưu lượt dùng, không lộ cả key.
fn key_label(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(5)..].iter().collect();
    format!("…{tail}")
}

/// Tách nhiều key từ nội dung dán vào (mỗi dòng một key, hoặc lẫn trong lệnh/JSON).
pub fn parse_keys(raw: &str) -> Vec<String> {
    let re = Regex::new(r"aiv_[A-Za-z0-9_\-]{10,}").unwrap();
    let mut out: Vec<String> = vec![];
    for m in re.find_iter(raw) {
        let k = m.as_str().to_string();
        if !out.contains(&k) {
            out.push(k);
        }
    }
    if out.is_empty() {
        let single = normalize_api_key(raw);
        if !single.is_empty() {
            out.push(single);
        }
    }
    out.truncate(10);
    out
}

fn is_rate_limit(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("quá nhanh") || m.contains("rate_limited") || m.contains("rate limit") || m.contains("http 429")
}

fn parse_retry_secs(msg: &str) -> Option<u64> {
    let re = Regex::new(r"(\d+)\s*(giây|seconds?|sec|s)").unwrap();
    re.captures(msg).and_then(|c| c[1].parse().ok())
}

fn chrono_time() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let local = secs as i64 + 7 * 3600; // múi giờ Việt Nam
    format!("{:02}:{:02}:{:02}", (local / 3600) % 24, (local / 60) % 60, local % 60)
}
fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}
fn rand_suffix() -> String {
    format!("{:x}", now_ms() ^ (std::process::id() as u128))
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

pub fn normalize_api_key(value: &str) -> String {
    let raw = value.trim();
    if raw.is_empty() {
        return String::new();
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
        if let Some(servers) = parsed.get("mcpServers").and_then(Value::as_object) {
            for server in servers.values() {
                let auth = server.pointer("/headers/Authorization").or(server.pointer("/headers/authorization"));
                if let Some(a) = auth.and_then(Value::as_str) {
                    return normalize_api_key(a);
                }
            }
        }
    }
    let re = Regex::new(r#"(?i)Authorization:\s*Bearer\s+([^\s"']+)"#).unwrap();
    if let Some(c) = re.captures(raw) {
        return c[1].to_string();
    }
    let re = Regex::new(r"(?i)^Bearer\s+(.+)$").unwrap();
    if let Some(c) = re.captures(raw) {
        return c[1].trim().trim_matches(|ch| ch == '"' || ch == '\'').to_string();
    }
    raw.trim_matches(|ch| ch == '"' || ch == '\'').to_string()
}

fn pick_default_tool(tools: &[Value]) -> String {
    let names = ["tts", "text_to_speech", "speech", "voice", "audio", "generate"];
    let mut best: Option<(usize, &Value)> = None;
    for tool in tools {
        let hay = format!(
            "{} {}",
            tool.get("name").and_then(Value::as_str).unwrap_or(""),
            tool.get("description").and_then(Value::as_str).unwrap_or("")
        )
        .to_lowercase();
        let score = names.iter().filter(|n| hay.contains(*n)).count();
        if best.map(|(s, _)| score > s).unwrap_or(true) {
            best = Some((score, tool));
        }
    }
    match best {
        Some((score, tool)) if score > 0 => tool.get("name").and_then(Value::as_str).unwrap_or("").into(),
        _ => tools.first().and_then(|t| t.get("name")).and_then(Value::as_str).unwrap_or("").into(),
    }
}

fn content_json(result: &Value) -> Value {
    if let Some(sc) = result.get("structuredContent") {
        return sc.clone();
    }
    if let Some(items) = result.get("content").and_then(Value::as_array) {
        for item in items {
            if item.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    if let Ok(v) = serde_json::from_str::<Value>(text) {
                        return v;
                    }
                }
            }
        }
    }
    result.clone()
}

fn job_status(data: &Value) -> String {
    data.get("status")
        .or(data.pointer("/job/status"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string()
}

fn find_job_id(result: &Value) -> Option<String> {
    let data = content_json(result);
    ["/job_id", "/id", "/job/id", "/job/job_id"]
        .iter()
        .find_map(|p| data.pointer(p).map(value_to_string).filter(|s| !s.is_empty()))
}

fn safe_name(name: &str) -> String {
    let name = if name.is_empty() { "clip" } else { name };
    name.chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20 { '_' } else { c })
        .take(80)
        .collect()
}

fn safe_relative_path(cleaned: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for part in cleaned.split(|c| c == '\\' || c == '/') {
        if part.is_empty() {
            continue;
        }
        let mut p = safe_name(part);
        if p.chars().all(|c| c == '.') {
            p = "_".into();
        }
        out.push(p);
    }
    out
}

fn normalize_folder_path(input: &str) -> String {
    input.trim().trim_matches(|c| c == '"' || c == '\'').replace(['\r', '\n'], "").trim().to_string()
}

fn is_disk_path(s: &str) -> bool {
    let b = s.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')) || s.starts_with("\\\\")
}

fn resolve_folder_path(input: &str) -> PathBuf {
    let cleaned = normalize_folder_path(input);
    let b = cleaned.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        let drive = cleaned[..2].to_uppercase();
        if Path::new(&format!("{drive}\\")).exists() {
            return PathBuf::from(&cleaned);
        }
        if let Some((_, alias)) = DRIVE_ALIASES.iter().find(|(d, _)| *d == drive) {
            let rest = cleaned[2..].trim_start_matches(['\\', '/']);
            return Path::new(alias).join(rest);
        }
    }
    PathBuf::from(cleaned)
}

fn read_text(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(String::from_utf8_lossy(&bytes).trim_start_matches('\u{feff}').to_string())
}

fn collect_files(root: &Path, current: &Path, exts: &[String], found: &mut Vec<(PathBuf, String)>) -> Result<(), String> {
    let mut entries: Vec<_> = std::fs::read_dir(current).map_err(|e| e.to_string())?.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, exts, found)?;
        } else if path.is_file() {
            let lower = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
            if exts.iter().any(|e| lower.ends_with(e)) {
                let rel = path.strip_prefix(root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                found.push((path, rel));
            }
        }
    }
    Ok(())
}

fn srt_time(total_seconds: f64) -> String {
    let total_ms = (total_seconds * 1000.0).round().max(0.0) as u64;
    let ms = total_ms % 1000;
    let total = total_ms / 1000;
    format!("{:02}:{:02}:{:02},{:03}", total / 3600, (total / 60) % 60, total % 60, ms)
}

fn parse_srt_time(value: &str) -> Option<f64> {
    let re = Regex::new(r"^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$").unwrap();
    let c = re.captures(value.trim())?;
    let n = |i: usize| c[i].parse::<f64>().unwrap_or(0.0);
    Some(n(1) * 3600.0 + n(2) * 60.0 + n(3) + n(4) / 1000.0)
}

fn estimate_duration(text: &str) -> f64 {
    ((text.chars().count() as f64) / 18.0).ceil().max(2.0)
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
