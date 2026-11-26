import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { spawnSync } from "node:child_process";

const src = fs.readFileSync(new URL("./src/engine.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const grab = (head) => {
  const at = src.indexOf(head);
  assert.notEqual(at, -1, head);
  return src.slice(at, src.indexOf("\n}\n", at) + 3);
};
const code = ["const MAX_AUTO_RETRY = 3;", ...["function retryLater(", "async function runFilePool(", "async function runPool("].map(grab)].join("\n");

function setup(kind, loop, job) {
  const ctx = {
    state: { running: true }, $: () => ({ checked: loop }), log() {}, renderBatchFiles() {}, renderRows() {},
    isRateLimitError: () => false, isAivieTtsTool: () => true, applyRateLimit() {}, concurrency: () => 4, throttleCreate: async () => {},
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    callTool: job, renderWholeFile: (items) => job(items[0])
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  const items = [1, 2, 3, 4].map((part) => ({ part, status: "Queued", fileName: "a.txt" }));
  const run = () => kind === "line" ? ctx.runPool(items, "") : ctx.runFilePool(items.map((i) => ({ items: [i], label: `${i.part}` })));
  return { ctx, items, run };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

for (const kind of ["line", "file"]) {
  test(`${kind}: failed work is retried immediately, in parallel`, async () => {
    let active = 0, peakRetry = 0; const tries = {};
    const { run } = setup(kind, true, async (item) => {
      tries[item.part] = (tries[item.part] || 0) + 1; active += 1;
      if (tries[item.part] === 2) peakRetry = Math.max(peakRetry, active);
      await wait(item.part <= 2 ? 1 : tries[item.part] === 1 ? 30 : 40);
      active -= 1;
      if (item.part > 2 && tries[item.part] === 1) throw new Error("x");
      item.status = "Done";
    });
    const r = await run();
    assert.equal(r.ok, 4); assert.equal(r.failed, 0); assert.equal(peakRetry, 2);
  });
  test(`${kind}: permanent error stops after 3 retries`, async () => {
    let calls = 0;
    const { run } = setup(kind, true, async (item) => { if (item.part === 1) { calls += 1; throw new Error("x"); } });
    const r = await run();
    assert.equal(calls, 4); assert.equal(r.failed, 1); assert.equal(r.ok, 3);
  });
  test(`${kind}: no retry when off, no requeue after Stop`, async () => {
    let calls = 0;
    const off = setup(kind, false, async () => { calls += 1; throw new Error("x"); });
    assert.equal((await off.run()).failed, 4); assert.equal(calls, 4);
    const stop = setup(kind, true, async () => { stop.ctx.state.running = false; throw new Error("x"); });
    await stop.run();
    assert.equal(stop.items[0].status, "Error");
  });
}

function load(heads, extra) {
  const ctx = { state: { running: true }, log() {}, renderBatchFiles() {}, renderRows() {}, updateStatusBar() {}, ...extra };
  vm.createContext(ctx); vm.runInContext("const MAX_AUTO_RETRY = 3;\n" + heads.map(grab).join("\n"), ctx);
  return ctx;
}

test("retryLater skips tools without idempotency and pointless errors", () => {
  let aivie = true;
  const c = load(["function retryLater("], { $: () => ({ checked: true }), isAivieTtsTool: () => aivie });
  assert.equal(c.retryLater({}, new Error("x")), true);
  assert.equal(c.retryLater({}, new Error("Estimate 9 vượt Max credit 5.")), false);
  assert.equal(c.retryLater({}, new Error("Không đồng ý render bằng v2 (v3/v4 đang bảo trì).")), false);
  aivie = false;
  assert.equal(c.retryLater({}, new Error("x")), false);
});

test("a created job is resumed, not resubmitted, unless it ended or the request changed", async () => {
  let creates = 0, fail;
  const c = load(["async function startOrResume(", "async function waitForPendingJob("], {
    startRender: async (req) => { req.args.idempotency_key = "k"; creates += 1; return { jobId: `j${creates}` }; },
    waitForJobResult: async () => { if (fail) throw fail; return { saved: {} }; }
  });
  const h = {}; const req = (text) => ({ args: { text } });
  fail = new Error("download");
  await assert.rejects(c.waitForPendingJob(h, await c.startOrResume(h, req("a"), "k"), h));
  assert.equal(await c.startOrResume(h, req("a"), "k"), "j1");
  assert.equal(creates, 1);
  assert.equal(await c.startOrResume(h, req("b"), "k"), "j2");
  fail = Object.assign(new Error("failed"), { jobEnded: true });
  await assert.rejects(c.waitForPendingJob(h, "j2", h));
  assert.equal(await c.startOrResume(h, req("b"), "k"), "j3");
  fail = null; await c.waitForPendingJob(h, "j3", h);
  assert.equal(h.pendingJob, null);
});

for (const stopped of [true, false]) {
  test(`batch joins only complete parts (${stopped ? "stopped" : "finished"})`, async () => {
    const files = ["a", "b"].map((s) => ({ source: s, name: s }));
    const items = ["a", "a", "b"].map((source) => ({ source, status: "Queued" }));
    const joined = [];
    const state = { running: false, batchFiles: files, items };
    const c = load(["async function runBatchJobs("], {
      state, $: () => ({ value: "create_tts_job", checked: true }), validateVoiceModel: async () => true,
      renderMode: () => "line", normalizeSourceItems() {}, isDone: (i) => i.status === "Done", concurrency: () => 4, fileStatus: () => "",
      joinItems: async (q) => { joined.push(q[0].source); },
      runPool: async (q, _l, done) => { for (const i of stopped ? q.slice(1) : q) { i.status = "Done"; done(i); } return {}; }
    });
    await c.runBatchJobs();
    assert.deepEqual(joined, stopped ? ["b"] : ["a", "b"]);
  });
}

test("broken saved voices never throw", () => {
  let raw;
  const c = load(["function loadSavedVoices("], { localStorage: { getItem: () => raw } });
  for (raw of ["{}", "null", "[", "[null,1,{\"id\":5}]"]) assert.equal(c.loadSavedVoices().length, 0);
  raw = '[{"id":"x","name":7,"models":["m",1]}]';
  const [v] = c.loadSavedVoices();
  assert.equal(v.name, ""); assert.equal(v.models.join(), "m");
});

test("saved voices are keyed by channel name", () => {
  const { upsertSavedVoice: up } = load(["function upsertSavedVoice("], {});
  const show = (list) => list.map((v) => `${v.label}:${v.id}`).join();
  let list = up([{ id: "x", label: "" }], { id: "x", label: "A" });
  assert.equal(show(list), "A:x");
  list = up(list, { id: "x", label: "B" });
  assert.equal(show(list), "B:x,A:x");
  assert.equal(show(up(list, { id: "y", label: "A" })), "A:y,B:x");
});

test("idempotency key changes only when the request content changes", async () => {
  const sent = [];
  const c = load(["async function startRender("], {
    acceptV2: false, crypto: { randomUUID: (() => { let n = 0; return () => `k${++n}`; })() },
    apiFetch: async (_u, o) => { sent.push(JSON.parse(o.body).args.idempotency_key); return { ok: true, json: async () => ({ jobId: "j" }) }; }
  });
  const holder = {};
  await c.startRender({ args: { text: "a", model: "v4" } }, holder, "idempotencyKey");
  await c.startRender({ args: { text: "a", model: "v4" } }, holder, "idempotencyKey");
  await c.startRender({ args: { text: "a", model: "v3" } }, holder, "idempotencyKey");
  assert.deepEqual(sent, ["k1", "k1", "k2"]);
});

test("engine import exposes a quiet store without browser globals", () => {
  const code = `import { state, subscribe, getVersion, notify, actions, selectors, boot } from './src/engine.js';
    if (getVersion() !== 0 || state.items.length || !state.ui || typeof boot !== 'function' || !actions.start || !selectors.visibleItems) process.exit(2);
    let called = 0; const stop = subscribe(() => called++); notify(); setTimeout(() => { stop(); process.exit(called === 1 && getVersion() === 1 ? 0 : 3); }, 130);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: new URL(".", import.meta.url), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("loading the same file twice never duplicates lines", () => {
  const state = { items: [], batchFiles: [], activeSource: "" };
  const c = load(["function alreadyLoaded(", "function registerBatchFile(", "function addBatchTextFile(", "function addSingleEntries("], {
    state, fileStem: (n) => n.replace(/\.[^.]+$/, ""), parseTxtByLine: (t) => t.split("\n"), splitText: (t) => [t]
  });
  const file = { name: "a.txt", fullPath: "D:/x/a.txt", dirPath: "D:/x", text: "1\n2" };
  c.addBatchTextFile(file); c.addBatchTextFile(file);
  c.addSingleEntries([{ name: "b.txt", text: "3" }]); c.addSingleEntries([{ name: "b.txt", text: "3" }]);
  assert.equal(state.items.length, 3);
  assert.deepEqual(state.batchFiles.map((f) => f.name), ["a", "b"]);
});
