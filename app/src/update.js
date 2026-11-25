import { state, notify, activeJobCount, logUpdate } from './engine.js';
const EVERY = 30 * 60 * 1000;
let skipped = '', waiting = null, started = false;
export function bootUpdate() {
  if (started) return; started = true;
  try { skipped = sessionStorage.getItem('nv.skipUpdate') || ''; } catch {}
  setTimeout(check, 3000); setInterval(check, EVERY);
}
async function check() {
  const tauri = window.__TAURI__;
  if (!tauri?.updater?.check) return;
  try {
    if (tauri.app?.getVersion) { state.ui.appVersion = `v${await tauri.app.getVersion()}`; notify(); }
    const update = await tauri.updater.check();
    if (!update || update.version === skipped || state.ui.update) return;
    waiting = update; showWhenIdle();
  } catch {}
}
function showWhenIdle() {
  if (state.running || activeJobCount()) { setTimeout(showWhenIdle, 10000); return; }
  const update = waiting; waiting = null;
  if (!update) return;
  const ui = { version: update.version, date: update.date ? String(update.date).slice(0, 10) : '', progressText: 'Có bản cập nhật mới. Bấm Cập nhật ngay để tải và cài đặt, app sẽ tự mở lại.', pct: 0, busy: false,
    now: async () => {
      ui.busy = true; notify(); let total = 0, got = 0;
      try {
        await update.downloadAndInstall((event) => {
          if (event.event === 'Started') total = event.data.contentLength || 0;
          else if (event.event === 'Progress') { got += event.data.chunkLength; ui.pct = total ? Math.round(got / total * 100) : 0; ui.progressText = total ? `Đang tải ${ui.pct}%` : `Đã tải ${(got / 1048576).toFixed(1)} MB`; }
          else if (event.event === 'Finished') ui.progressText = 'Đang cài đặt…';
          notify();
        });
        await window.__TAURI__.process.relaunch();
      } catch (error) { logUpdate(`Cập nhật lỗi: ${error.message || error}`); ui.progressText = `Lỗi: ${error.message || error}`; ui.busy = false; notify(); }
    },
    later: () => { skipped = update.version; try { sessionStorage.setItem('nv.skipUpdate', skipped); } catch {} state.ui.update = null; notify(); }
  };
  state.ui.update = ui; notify();
}
