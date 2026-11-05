// ---------- Auto update (desktop), dùng chung cho trang AIVIE và Sonic ----------
// Kiểm tra lúc mở app và mỗi 30 phút khi app đang mở. Đang chạy batch thì chờ xong mới hiện popup,
// vì "Cập nhật ngay" sẽ khởi động lại app. Bấm "Để sau" thì không nhắc lại bản đó tới lần mở app sau.
const UPDATE_CHECK_EVERY_MS = 30 * 60 * 1000;
let skippedUpdateVersion = "";
try { skippedUpdateVersion = sessionStorage.getItem("nv.skipUpdate") || ""; } catch {}
let waitingUpdate = null;

function appBusy() {
  if (typeof state !== "undefined" && state.running) return true;
  // Trang AIVIE: sau khi bấm Stop, job đang render vẫn chạy nốt và tải file về.
  return typeof activeJobs !== "undefined" && activeJobs.size > 0;
}

async function checkForUpdate() {
  const tauri = window.__TAURI__;
  if (!tauri?.updater?.check) return;
  try {
    if (tauri.app?.getVersion && $("appVersion")) $("appVersion").textContent = `v${await tauri.app.getVersion()}`;
    const update = await tauri.updater.check();
    if (!update || update.version === skippedUpdateVersion || !$("updateModal").classList.contains("hidden")) return;
    const startWaiting = !waitingUpdate;
    waitingUpdate = update;
    if (startWaiting) showUpdateWhenIdle();
  } catch {}
}

function showUpdateWhenIdle() {
  if (appBusy()) { setTimeout(showUpdateWhenIdle, 10000); return; }
  const update = waitingUpdate;
  waitingUpdate = null;
  if (update) showUpdate(update);
}

function showUpdate(update) {
  const tauri = window.__TAURI__;
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
      await tauri.process.relaunch();
    } catch (error) {
      if (typeof log === "function") log(`Cập nhật lỗi: ${error.message || error}`);
      $("updateProgressText").textContent = `Lỗi: ${error.message || error}`;
      $("updateNowBtn").disabled = false; $("updateLaterBtn").disabled = false;
    }
  };
  $("updateLaterBtn").onclick = () => {
    skippedUpdateVersion = update.version;
    try { sessionStorage.setItem("nv.skipUpdate", update.version); } catch {}
    $("updateModal").classList.add("hidden"); $("updateModal").classList.remove("flex");
  };
}

setTimeout(checkForUpdate, 3000);
setInterval(checkForUpdate, UPDATE_CHECK_EVERY_MS);
