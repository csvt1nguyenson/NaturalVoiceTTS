import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { actions, boot, desktop, getVersion, selectors, state, subscribe } from "./engine.js";
import { bootUpdate } from "./update.js";
import { LANGUAGES, MODELS } from "./options.js";

const useStore = () => useSyncExternalStore(subscribe, getVersion);
const TONE = { queued: "bg-muted text-muted-foreground", run: "bg-warn-soft text-warn", done: "bg-ok-soft text-ok", error: "bg-bad-soft text-bad" };
const CONNECTION = { on: TONE.done, off: TONE.queued, busy: TONE.run, err: TONE.error };

const Btn = ({ className = "", ...props }) => <Button type="button" size="sm" variant="outline" className={`rounded-full ${className}`} {...props} />;
const Danger = (props) => <Btn className="text-bad hover:text-bad" {...props} />;
const Pill = ({ kind, children, title }) => <Badge variant="secondary" className={TONE[kind]} title={title}>{children}</Badge>;
const Field = ({ label, children, ...props }) => <label className="field" {...props}><span>{label}</span>{children}</label>;
const Check = ({ label, ...props }) => <label className="check"><input type="checkbox" {...props} />{label}</label>;
const Select = (props) => <div className="[&>div]:w-full"><NativeSelect size="sm" {...props} /></div>;
const Fold = ({ id, title, children, ...props }) => (
  <details className="fold" data-fold={id} {...props}><summary>{title}</summary><div className="space-y-2.5 px-4 pb-4">{children}</div></details>
);
const Head = ({ cols }) => <TableHeader className="sticky top-0 z-10 bg-muted"><TableRow>{cols.map(([name, cls], i) => <TableHead key={i} className={cls}>{name}</TableHead>)}</TableRow></TableHeader>;
const Empty = ({ cols, children }) => <TableRow><TableCell colSpan={cols} className="text-muted-foreground">{children}</TableCell></TableRow>;
const fileInput = (onFiles, accept, folder) => ({
  type: "file", hidden: true, multiple: true, accept, ...(folder ? { webkitdirectory: "" } : {}),
  onChange: (e) => { const files = Array.from(e.target.files); e.target.value = ""; onFiles(files); }
});

function Header() {
  useStore();
  const { ui } = state;
  return (
    <header className="flex items-center justify-between border-b px-4">
      <div className="flex items-baseline gap-3">
        <span className="text-[15px] font-semibold tracking-tight">NaturalVoice</span>
        <span className="text-xs text-muted-foreground">{ui.appVersion}</span>
        <span className="text-xs text-muted-foreground">Text &amp; subtitle sang giọng nói qua AIVIE</span>
      </div>
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span>Credit <strong className="text-foreground">{ui.credit}</strong></span>
        <span>Render đồng thời <strong className="text-foreground">{ui.concurrentLimit}</strong></span>
        <Badge variant="secondary" className={CONNECTION[ui.connection.kind]}>● {ui.connection.text}</Badge>
      </div>
    </header>
  );
}

// ---- Cột trái: ô nhập để engine đọc theo id, React không render lại (memo, không props). ----
const Text = ({ get }) => { useStore(); return get(); };
function KeyQuota() {
  useStore();
  return <div className="space-y-1">{(state.ui.quota?.keys || []).map((k, i) => {
    const pct = Math.min(100, Math.round((k.used / (k.usable || k.limit)) * 100));
    return (
      <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="w-14 shrink-0 font-mono">{k.label}</span>
        <Progress aria-label={`Lượt của key ${k.label}`} value={pct} className={`h-1 flex-1 ${pct >= 100 ? "[&>*]:bg-bad" : ""}`} />
        <span className="w-16 shrink-0 text-right tabular-nums">{k.blockedFor > 0 ? `nghỉ ${Math.ceil(k.blockedFor / 60)} phút` : `${k.used}/${k.limit}`}</span>
      </div>
    );
  })}</div>;
}
function SavedVoices() {
  useStore();
  const ref = useRef(null);
  const { savedVoices, selectedSavedVoice } = state.ui;
  useLayoutEffect(() => { ref.current.value = selectedSavedVoice || ""; }, [savedVoices]);
  return (
    <Select ref={ref} id="savedVoices" aria-label="Voice đã lưu" onChange={(e) => actions.pickSavedVoice(e.target.value)}>
      <option value="">{savedVoices.length ? "— Chọn voice đã lưu —" : "Chưa lưu voice nào"}</option>
      {savedVoices.map((v) => <option key={v.key} value={v.key}>{v.label ? `${v.label} · ` : ""}{v.name || v.id}{v.language ? ` · ${v.language}` : ""}</option>)}
    </Select>
  );
}
function VoiceResults() {
  useStore();
  const ref = useRef(null);
  const voices = state.voiceResults;
  useLayoutEffect(() => { ref.current.selectedIndex = voices.length ? 0 : -1; }, [voices]);
  return (
    <select ref={ref} id="voiceResults" size={4} aria-label="Kết quả tìm voice" className="h-auto w-full rounded-lg border bg-input/30 p-1 text-sm"
      onChange={(e) => actions.pickVoice(e.target.value)} onDoubleClick={(e) => actions.pickVoice(e.currentTarget.value)}>
      {voices.map((v, i) => <option key={i} value={i}>{`${v.name || v.id || v.voice_id} | ${v.language || ""} | ${v.gender || ""} | ${selectors.voiceModels(v).join(",")}`}</option>)}
    </select>
  );
}
function OwnKey({ children }) { useStore(); return <div hidden={!state.ui.ownKey} className="space-y-2.5">{children}</div>; }

const Sidebar = memo(function Sidebar() {
  return (
    <aside className="min-h-0 overflow-y-auto border-r">
      <Fold id="key" title="Key AIVIE">
        <Field label="Endpoint"><Input id="mcpUrl" defaultValue="https://app.aivie.pro/api/v1/mcp" /></Field>
        <Field label="API key · mỗi dòng một key, tối đa 10"><Textarea id="apiKey" rows={3} spellCheck={false} className="resize-none font-mono text-xs" style={{ WebkitTextSecurity: "disc" }} placeholder={"aiv_…\naiv_…"} /></Field>
        <div className="flex gap-1.5">
          <Btn variant="default" className="flex-1" onClick={actions.connect}>Kết nối</Btn>
          <Btn onClick={actions.saveKey}>Lưu key</Btn>
          <Btn onClick={actions.clearKey}>Xoá</Btn>
        </div>
        <Select id="toolSelect" aria-label="Tool AIVIE" onChange={actions.toolChanged} />
        <div className="flex gap-1.5">
          <Btn onClick={actions.refreshBalance}>Cập nhật credit</Btn>
          <Btn onClick={actions.openJobs}><Text get={() => (state.ui.jobsOpen ? "Đóng Jobs" : "Jobs")} /></Btn>
        </div>
        <p className="text-xs text-muted-foreground"><Text get={() => state.ui.keyHint} /></p>
        <KeyQuota />
      </Fold>

      <Fold id="voice" title="Voice" open>
        <div className="field"><span>Voice đã lưu</span>
          <div className="flex gap-1.5"><div className="min-w-0 flex-1"><SavedVoices /></div><Btn title="Lưu voice đang dùng" onClick={actions.saveVoice}>Lưu</Btn><Btn title="Bỏ voice đang chọn khỏi danh sách" onClick={actions.removeVoice}>Xoá</Btn></div>
        </div>
        <div className="field"><label htmlFor="voiceName">Tên hoặc Voice ID</label>
          <div className="flex gap-1.5"><Input id="voiceName" placeholder="Tên voice hoặc Voice ID" /><Btn onClick={actions.searchVoice}>Tìm</Btn></div>
        </div>
        <Field label="Voice ID đang dùng"><Input id="voiceId" className="font-mono text-xs" placeholder="Chọn từ kết quả tìm hoặc dán ID" /></Field>
        <p className="text-xs text-muted-foreground"><Text get={() => state.ui.voiceMeta} /></p>
        <VoiceResults />
        <div className="flex gap-1.5"><Btn onClick={actions.addVoice}>+ Thêm vào Library</Btn><Btn onClick={actions.loadLibrary}>Library (Vip+)</Btn></div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Model"><Select id="model" defaultValue="eleven_v4" onChange={actions.modelChanged}>
            {MODELS.map(([group, list]) => <optgroup key={group} label={group}>{list.map(([v, name]) => <option key={v} value={v}>{name}</option>)}</optgroup>)}
          </Select></Field>
          <Field label="Ngôn ngữ"><Select id="language">{LANGUAGES.map(([v, name]) => <option key={v} value={v}>{name}</option>)}</Select></Field>
        </div>
      </Fold>

      <Fold id="settings" title="Tuỳ chỉnh giọng">
        <Check id="useSettings" label="Gửi tuỳ chỉnh khi render" defaultChecked />
        <Field label="Tốc độ"><Input id="speed" type="number" step="0.01" defaultValue="1" /></Field>
        <OwnKey>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Stability"><Input id="stability" type="number" defaultValue="50" /></Field>
            <Field label="Similarity"><Input id="similarity" type="number" defaultValue="75" /></Field>
            <Field label="Style"><Input id="style" type="number" defaultValue="1" /></Field>
          </div>
          <Check id="speakerBoost" label="Speaker boost" defaultChecked />
        </OwnKey>
      </Fold>

      <Fold id="run" title="Tuỳ chọn chạy" open>
        <Field label="Cách render"><Select id="renderMode" onChange={actions.renderModeChanged}>
          <option value="line">Từng dòng → clip lẻ 1.mp3, 2.mp3…</option>
          <option value="file">Cả file trong 1 job → 1 file MP3</option>
        </Select></Field>
        <Check id="autoSrt" label="Tự tạo SRT và ghép full MP3" />
        <Check id="loopMode" label="Tự chạy lại khi lỗi" />
        <Check id="autoSplit" label="Tự tách câu file lẻ" />
        <Check id="estimateBeforeRender" label="Ước tính credit trước khi render" />
        <div className="grid grid-cols-2 gap-2">
          <Field label="Job song song"><Select id="concurrency" defaultValue="3">{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</Select></Field>
          <Field label="Delay giữa 2 job (giây)"><Input id="callDelay" type="number" min="0" max="60" step="0.5" defaultValue="2" /></Field>
          <Field label="Ký tự tách"><Input id="splitChars" defaultValue=".,?!?。" /></Field>
          <Field label="Max credit"><Input id="maxCredits" type="number" min="1" placeholder="∞" /></Field>
        </div>
        <p className="text-xs text-muted-foreground">AIVIE cho phép tối đa <strong><Text get={() => state.ui.concurrentLimit} /></strong> job cùng lúc. Clip vẫn lưu đúng thư mục và số thứ tự dù xong không theo thứ tự.</p>
      </Fold>

      {/* Tên trường gửi lên MCP: engine đọc, không hiện trên giao diện (như bản cũ). */}
      <div id="advancedFields" hidden>
        {[["textField", "text"], ["voiceField", "voice_id"], ["modelField", "model"], ["settingsField", "voice_settings"], ["languageField", "language"]].map(([id, v]) => <input key={id} id={id} defaultValue={v} />)}
      </div>
    </aside>
  );
});

const FILE_STATUS = { Done: ["done", "Hoàn tất"], Error: ["error", "Lỗi"], Processing: ["run", "Đang render"] };
const pending = (item) => item.status === "Queued" || item.status === "Error";

// Nguồn → Chạy → Kết quả: một danh sách, một nút chạy, một nút Stop.
const Source = memo(function Source() {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
      <input id="batchFolderInput" {...fileInput(actions.addBatchFiles, ".txt", true)} />
      <input id="singleFileInput" {...fileInput((f) => actions.addSingleFiles(f), ".srt,.txt,.dgt")} />
      <input id="singleFolderInput" {...fileInput((f) => actions.addSingleFiles(f, "folder"), ".srt,.txt,.dgt", true)} />
      <h2 className="mr-2 text-sm font-semibold">Nguồn</h2>
      <Input id="batchFolderName" aria-label="Thư mục chứa .txt" className="h-8 min-w-40 flex-1" placeholder="Dán đường dẫn thư mục chứa .txt"
        onPaste={() => setTimeout(actions.scanBatchPath, 50)} onKeyDown={(e) => { if (e.key === "Enter") actions.scanBatchPath(); }} />
      <Btn title="Chọn thư mục .txt, audio lưu cạnh file gốc" onClick={actions.pickBatchFolder}>Chọn thư mục</Btn>
      <Btn onClick={actions.scanBatchPath}>Quét</Btn>
      <span className="mx-1 text-xs text-muted-foreground">hoặc</span>
      <Btn title="Thêm file .srt, .txt, .dgt lẻ, audio lưu trong thư mục output của app" onClick={actions.importFile}>Thêm file</Btn>
      <Btn title="Thêm cả thư mục .srt, .txt, .dgt, audio lưu trong thư mục output của app" onClick={actions.importFolder}>Thêm thư mục SRT</Btn>
    </div>
  );
});
function RunBar() {
  useStore();
  const { items, running } = state;
  const todo = items.filter(pending).length;
  const errors = items.filter((item) => item.status === "Error").length;
  const done = items.filter(selectors.isDone).length;
  const active = items.filter(selectors.isActive).length;
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Btn variant="default" disabled={running || !todo} onClick={actions.runBatch}>Chạy tất cả{todo ? ` (${todo} dòng)` : ""}</Btn>
      <Btn disabled={running || !errors} title="Chạy lại ngay các dòng lỗi của mọi file" onClick={actions.retryAll}>Chạy lại lỗi{errors ? ` (${errors})` : ""}</Btn>
      <Progress aria-label="Tiến độ" value={items.length ? Math.round((done / items.length) * 100) : 0} className="mx-2 h-2 flex-1" />
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{done} / {items.length} xong · {active} đang chạy{errors ? ` · ${errors} lỗi` : ""}</span>
      <Danger disabled={!running} onClick={actions.stop}>Stop</Danger>
    </div>
  );
}
function FileList() {
  useStore();
  const groups = new Map();
  for (const item of state.items) { if (!groups.has(item.source)) groups.set(item.source, []); groups.get(item.source).push(item); }
  return (
    <Card className="grid min-h-0 grid-rows-[auto_1fr] gap-0 overflow-hidden rounded-2xl py-0 shadow-none">
      <div className="flex h-11 items-center justify-between border-b px-3">
        <h2 className="text-sm font-semibold">File <span className="ml-1 font-normal text-muted-foreground">{state.batchFiles.length || ""}</span></h2>
        <Btn size="xs" disabled={state.running || !state.batchFiles.length} onClick={actions.clearBatch}>Xoá danh sách</Btn>
      </div>
      <ul className="min-h-0 overflow-y-auto p-1.5">
        {!state.batchFiles.length && <li className="p-2 text-sm text-muted-foreground">Chưa có file. Dán đường dẫn, chọn thư mục hoặc kéo thả file vào đây.</li>}
        {state.batchFiles.map((file) => {
          const items = groups.get(file.source) || [];
          const done = items.filter(selectors.isDone).length;
          const status = selectors.fileStatus(file.source);
          const [kind, label] = FILE_STATUS[status] || ["queued", "Chờ"];
          const selected = file.source === state.activeSource;
          return (
            <li key={file.source} className={`rounded-lg ${selected ? "bg-accent" : "hover:bg-muted"}`}>
              <button type="button" aria-pressed={selected} title={items[0]?.outputFolder} className="w-full space-y-1.5 rounded-lg px-2.5 py-2 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" onClick={() => actions.selectFile(file.source)}>
                <span className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{file.name}</span><Pill kind={kind}>{label}</Pill></span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums"><Progress aria-label={`Tiến độ ${file.name}`} value={items.length ? (done / items.length) * 100 : 0} className="h-1 flex-1" />{done} / {items.length}</span>
              </button>
              {status === "Error" && <div className="px-2.5 pb-2"><Btn size="xs" disabled={state.running} onClick={() => actions.retryFile(file.source)}>Chạy lại lỗi file này</Btn></div>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// Item bị engine sửa tại chỗ nên truyền từng giá trị, chỉ dòng đổi mới render lại.
const QueueRow = memo(function QueueRow({ part, text, title, status, error, path, name, itemIndex, done }) {
  const view = selectors.statusView(status, error);
  return (
    <TableRow>
      <TableCell className="text-muted-foreground">{part || ""}</TableCell>
      <TableCell className="whitespace-normal break-words" title={title}>{text}</TableCell>
      <TableCell><Pill kind={view.kind} title={view.title}>{view.label}</Pill>{itemIndex >= 0 && <Btn size="xs" className="ml-1" title={done ? "Render lại dòng này, thay file cũ" : "Chỉ chạy lại dòng này"} onClick={() => done ? actions.rerender([state.items[itemIndex]]) : actions.retryItem(itemIndex)}>{done ? "Render lại" : "Chạy lại"}</Btn>}</TableCell>
      <TableCell>{!name ? "—" : desktop
        ? <button type="button" className="text-primary hover:underline" onClick={() => actions.openPath(path)}>{name}</button>
        : <a className="text-primary hover:underline" target="_blank" rel="noreferrer" href={`/api/download-file?path=${encodeURIComponent(path)}`}>{name}</a>}</TableCell>
    </TableRow>
  );
});
function QueueRows() {
  useStore();
  const items = selectors.visibleItems();
  if (!items.length) return <Empty cols={4}>Chọn một file bên trái để xem từng dòng.</Empty>;
  return items.map((item, i) => {
    const out = item.output || "";
    const path = item.fullPath || (!out || out.includes(":\\") || out.startsWith("\\\\") ? out : `${item.outputFolder}/${out}`);
    return <QueueRow key={i} part={item.part} text={item.text} title={item.fileName || item.source} status={item.status} error={item.error}
      path={path} name={out.split(/[\\/]/).pop()} itemIndex={item.status === "Error" || selectors.isDone(item) ? state.items.indexOf(item) : -1} done={selectors.isDone(item)} />;
  });
}
function Lines() {
  useStore();
  const s = selectors.summary();
  const name = state.batchFiles.find((file) => file.source === state.activeSource)?.name;
  const items = selectors.visibleItems();
  const none = !items.length;
  const todo = items.filter(pending).length;
  return (
    <Card className="grid min-h-0 grid-rows-[auto_1fr] gap-0 overflow-hidden rounded-2xl py-0 shadow-none">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b px-3 py-1.5">
        <h2 className="min-w-0 truncate text-sm font-semibold">{name || "Chi tiết"} {!none && <span className="ml-1 font-normal text-muted-foreground">{s.done} / {s.total} xong{s.errors ? ` · ${s.errors} lỗi` : ""}</span>}</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <Btn size="xs" disabled={state.running || !todo} title="Chỉ chạy file đang chọn" onClick={actions.start}>Chạy file này</Btn>
          <Btn size="xs" disabled={state.running || none} title="Render lại mọi dòng của file đang chọn, thay file cũ" onClick={() => actions.rerender(items)}>Render lại file</Btn>
          <span className="mx-1 h-4 w-px bg-border" />
          <Btn size="xs" disabled={none} onClick={actions.join}>Ghép MP3 + SRT</Btn>
          <Btn size="xs" disabled={none} onClick={actions.saveSrt}>Chỉ tạo SRT</Btn>
          {!desktop && <><Btn size="xs" disabled={none} onClick={actions.downloadSrt}>Tải SRT</Btn><Btn size="xs" disabled={none} onClick={actions.downloadAllAudio}>Tải audio</Btn></>}
          <Btn size="xs" onClick={actions.openOutput}>Mở output</Btn>
        </div>
      </div>
      <div className="min-h-0 overflow-y-auto [&>div]:overflow-visible">
        <Table className="table-fixed"><Head cols={[["#", "w-12"], ["Text"], ["Trạng thái", "w-44"], ["Output", "w-28"]]} /><TableBody><QueueRows /></TableBody></Table>
      </div>
    </Card>
  );
}
function Main() {
  const [over, setOver] = useState(false);
  return (
    <main className={`flex min-h-0 flex-col gap-3 overflow-hidden p-3 [&>*]:shrink-0 [&>*:nth-child(2)]:min-h-0 [&>*:nth-child(2)]:flex-1 [&>*:nth-child(2)]:shrink ${over ? "outline-2 -outline-offset-4 outline-dashed outline-primary" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) actions.dropFiles(e.dataTransfer); }}>
      <Card className="gap-0 overflow-hidden rounded-2xl py-0 shadow-none"><Source /><RunBar /></Card>
      <div className="grid grid-cols-[minmax(200px,1fr)_minmax(0,2.6fr)] gap-3"><FileList /><Lines /></div>
      <Log /><Jobs />
    </main>
  );
}

const LogLine = memo(({ text, kind }) => <span className={kind === "error" ? "text-bad" : kind === "server" ? "text-muted-foreground" : ""}>{text + "\n"}</span>);
function Log() {
  useStore();
  const ref = useRef(null);
  const { logs, logCount } = state.ui;
  useLayoutEffect(() => { ref.current.scrollTop = ref.current.scrollHeight; }, [logCount]);
  return (
    <Card className="gap-0 overflow-hidden rounded-2xl py-0 shadow-none">
      <details open>
        <summary className="flex h-9 cursor-pointer items-center justify-between px-3 text-sm font-semibold">
          <span>Log</span>
          <span className="flex items-center gap-2"><Btn size="xs" title="Mở file log của hôm nay" onClick={(e) => { e.preventDefault(); actions.openLogFile(); }}>Mở file log</Btn><span className="text-xs font-normal text-muted-foreground">{logCount} dòng</span></span>
        </summary>
        <pre ref={ref} className="h-[120px] overflow-y-auto whitespace-pre-wrap border-t px-3 py-2 font-mono text-xs leading-[18px]">{logs.map((l) => <LogLine key={l.id} text={l.text} kind={l.kind} />)}</pre>
      </details>
    </Card>
  );
}

function Jobs() {
  useStore();
  if (!state.ui.jobsOpen) return null;
  return (
    <Card className="max-h-56 gap-0 overflow-y-auto rounded-2xl py-0 shadow-none">
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-3"><h2 className="text-sm font-semibold">Jobs AIVIE</h2><Btn onClick={actions.refreshJobs}>Cập nhật</Btn></div>
      <Table><Head cols={[["Job ID"], ["Tiêu đề"], ["Trạng thái"], ["Credit"], [""]]} /><TableBody>
        {state.ui.jobs.map((job, i) => {
          const id = job.job_id || job.id || "";
          return <TableRow key={id || i}><TableCell title={id}>{id.slice(0, 12)}</TableCell><TableCell>{job.title}</TableCell><TableCell>{job.status || "unknown"}</TableCell><TableCell>{job.credits ?? "-"}</TableCell>
            <TableCell>{["queued", "rendering"].includes(job.status) && <Btn size="xs" onClick={() => actions.cancelJob(id)}>Hủy</Btn>}</TableCell></TableRow>;
        })}
        {!state.ui.jobs.length && <Empty cols={5}>Chưa có job.</Empty>}
      </TableBody></Table>
    </Card>
  );
}

function StatusBar() {
  useStore();
  const { ui, items } = state;
  const s = selectors.summary();
  const done = items.filter(selectors.isDone).length;
  return (
    <footer className="flex items-center gap-3 border-t px-4 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{ui.statusLabel}</span>
      <span>{done} / {items.length} dòng · File {s.filesDone} / {s.files} · {items.filter(selectors.isActive).length} job đang render</span>
      <span title="AIVIE cho mỗi key 60 job mỗi giờ. App đổi key ở lượt 59 để không bị khoá.">· Lượt tạo job {ui.quota?.total ? `${ui.quota.used}/${ui.quota.total} giờ này` : "-"}</span>
      <span className="ml-auto truncate">{ui.statusOutput}</span>
    </footer>
  );
}

// Esc không đóng: bấm nhầm Esc ở hộp v2 sẽ dừng cả batch.
const Dialog = ({ title, desc, children, footer, onEscape }) => (
  <AlertDialog open><AlertDialogContent onEscapeKeyDown={(e) => { e.preventDefault(); onEscape?.(); }}>
    <AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>{desc}</AlertDialogDescription></AlertDialogHeader>
    {children}<AlertDialogFooter>{footer}</AlertDialogFooter>
  </AlertDialogContent></AlertDialog>
);
function Dialogs() {
  useStore();
  const { modal, update, voiceToSave, confirm } = state.ui;
  if (modal) return (
    <Dialog title="Render bằng Multilingual v2?" desc={modal.message} footer={<><Btn onClick={modal.cancel}>Huỷ</Btn><Btn variant="default" onClick={modal.confirm}>Đồng ý</Btn></>}>
      <p className="text-xs text-muted-foreground">Đồng ý: áp dụng cho mọi dòng còn lại tới khi đóng app; audio tag như [pause] sẽ bị bỏ vì v2 đọc thành tiếng. Huỷ: dừng lần chạy này.</p>
    </Dialog>
  );
  if (confirm) return (
    <Dialog title={confirm.title} desc={confirm.message} onEscape={confirm.cancel}
      footer={<><Btn onClick={confirm.cancel}>Huỷ</Btn><Btn variant="default" onClick={confirm.ok}>Render lại</Btn></>} />
  );
  if (voiceToSave) return (
    <Dialog title="Lưu voice" desc={`${voiceToSave.name}. Đặt tên kênh để dễ phân biệt; để trống thì dùng tên voice. Trùng tên kênh thì thay voice cũ.`} onEscape={actions.cancelSaveVoice}
      footer={<><Btn onClick={actions.cancelSaveVoice}>Huỷ</Btn><Btn variant="default" type="submit" form="saveVoiceForm">Lưu</Btn></>}>
      <form id="saveVoiceForm" onSubmit={(e) => { e.preventDefault(); actions.confirmSaveVoice(e.currentTarget.elements.label.value); }}>
        <Input name="label" aria-label="Tên kênh" autoFocus autoComplete="off" defaultValue={voiceToSave.label} placeholder={voiceToSave.name} />
      </form>
    </Dialog>
  );
  if (update) return (
    <Dialog title="Có phiên bản mới" desc={`Phiên bản ${update.version}${update.date ? ` · ${update.date}` : ""}`}
      footer={<><Btn disabled={update.busy} onClick={update.later}>Để sau</Btn><Btn variant="default" disabled={update.busy} onClick={update.now}>Cập nhật ngay</Btn></>}>
      <p className="text-sm">{update.progressText}</p>{update.busy && <Progress aria-label="Tiến độ cập nhật" value={update.pct} />}
    </Dialog>
  );
  return null;
}

export default function App() {
  useEffect(() => { boot(); bootUpdate(); }, []);
  return (
    <div className="grid h-full grid-rows-[44px_minmax(0,1fr)_28px]">
      <Header />
      <div className="grid min-h-0 grid-cols-[320px_minmax(0,1fr)]">
        <Sidebar />
        <Main />
      </div>
      <StatusBar />
      <Dialogs />
    </div>
  );
}
