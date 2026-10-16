import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const elements = new Map();
const defaults = { provider: "eleven", voiceId: "abc123", speed: "1", model: "", language: "", stability: "0.5", similarity: "0.75", style: "0" };
const document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, { value: defaults[id] || "", checked: true, textContent: "", innerHTML: "", style: {}, scrollHeight: 0, scrollTop: 0 });
    return elements.get(id);
  },
};
const context = vm.createContext({
  document,
  window: { __TAURI__: { core: { invoke: async () => ({ status: 200, body: { hasKey: false } }) } } },
  Date, Intl, setTimeout, clearTimeout,
});
vm.runInContext(fs.readFileSync(new URL("./sonic.js", import.meta.url), "utf8"), context);
const evaluate = (expression) => vm.runInContext(expression, context);

test("every referenced Sonic control exists in the shared-layout HTML", () => {
  const html = fs.readFileSync(new URL("./sonic.html", import.meta.url), "utf8");
  const script = fs.readFileSync(new URL("./sonic.js", import.meta.url), "utf8");
  const ids = [...script.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(ids)].filter((id) => !html.includes(`id="${id}"`)), []);
  assert.match(html, /href="styles\.css"/);
  assert.match(html, /<option value="eleven" selected>ElevenLabs<\/option>/);
});

test("TXT lines become one batch payload with numbered filenames", () => {
  const job = evaluate('jobPayload([{ name: "chapter.txt", text: "First", part: 1 }, { name: "chapter.txt", text: "Second", part: 2 }], "batch")');
  assert.equal(job.kind, "batch");
  assert.deepEqual(Array.from(job.texts), ["First", "Second"]);
  assert.deepEqual(Array.from(job.filenames), ["1.mp3", "2.mp3"]);
  assert.equal(job.srt_out, true);
  assert.equal(job.text, undefined);
});

test("Eleven model payload sends only supported voice settings", () => {
  document.getElementById("provider").value = "eleven";
  document.getElementById("speed").value = "1";
  document.getElementById("model").value = "eleven_v3";
  let job = evaluate('jobPayload([{ name: "chapter.txt", text: "Hello", part: 1 }], "batch")');
  assert.equal(job.stability, 0.5);
  assert.equal(job.similarity_boost, undefined);
  assert.equal(job.style, undefined);
  assert.equal(job.use_speaker_boost, undefined);
  document.getElementById("model").value = "eleven_multilingual_v2";
  job = evaluate('jobPayload([{ name: "chapter.txt", text: "Hello", part: 1 }], "batch")');
  assert.equal(job.similarity_boost, 0.75);
  assert.equal(job.use_speaker_boost, true);
  document.getElementById("speed").value = "1.3";
  assert.throws(() => evaluate('jobPayload([{ name: "chapter.txt", text: "Hello", part: 1 }], "batch")'), /0.7 đến 1.2/);
  document.getElementById("provider").value = "mini";
  document.getElementById("speed").value = "1";
});

test("real SRT cues produce durations and reject unmatched cue counts", () => {
  context.srt = "1\n00:00:01,000 --> 00:00:03,250\nOne\n\n2\n00:00:03,250 --> 00:00:05,000\nTwo";
  assert.deepEqual(Array.from(evaluate("parseSrtCues(srt)")), [2.25, 1.75]);
});

test("SRT preserves original timing and never sends speed", () => {
  const source = "1\n00:00:01,000 --> 00:00:03,000\nHello\n";
  context.source = source;
  const job = evaluate('jobPayload([{ name: "captions.srt", srtText: source }], "srt")');
  assert.equal(job.kind, "srt");
  assert.equal(job.srt_text, source);
  assert.equal(job.srt_combine, true);
  assert.equal(job.speed, undefined);
});

test("batch grouping respects 200 items and source boundary", () => {
  const rows = Array.from({ length: 201 }, (_, i) => ({ source: "a.txt", text: `line ${i}` }));
  rows.push({ source: "b.txt", text: "last" });
  context.rows = rows;
  const groups = evaluate("batches(rows)");
  assert.deepEqual(Array.from(groups, (group) => group.length), [200, 1, 1]);
});

test("batch import and single import remain separate queues", () => {
  context.files = [{ name: "batch.txt", fullPath: "D:\\batch.txt", dirPath: "D:", text: "first\nsecond" }];
  evaluate('addFiles(files, "batch")');
  context.files = [{ name: "single.txt", fullPath: "D:\\single.txt", dirPath: "D:", text: "third" }];
  evaluate('addFiles(files, "single")');
  assert.equal(evaluate('state.rows.filter((row) => row.mode === "batch").length'), 2);
  assert.equal(evaluate('state.rows.filter((row) => row.mode === "single").length'), 1);
});

test("batch preview selects the first file and restarts row numbering for each file", () => {
  evaluate('state.rows = []; state.activeSource = ""');
  context.files = [
    { name: "part1.txt", fullPath: "Y:\\part1.txt", dirPath: "Y:", text: "One\nTwo" },
    { name: "part2.txt", fullPath: "Y:\\part2.txt", dirPath: "Y:", text: "Three\nFour" },
  ];
  evaluate('addFiles(files, "batch")');
  assert.equal(evaluate("state.rows.length"), 4);
  assert.deepEqual(Array.from(evaluate("state.rows.map((row) => row.part)")), [1, 2, 1, 2]);
  assert.equal(evaluate("state.activeSource"), "Y:\\part1.txt");
  assert.match(document.getElementById("summary").textContent, /2 tổng/);
  assert.match(document.getElementById("rows").innerHTML, /One/);
  assert.doesNotMatch(document.getElementById("rows").innerHTML, /Three/);
  evaluate('selectSource("Y:\\\\part2.txt")');
  assert.match(document.getElementById("rows").innerHTML, /Three/);
  assert.doesNotMatch(document.getElementById("rows").innerHTML, /One/);
  assert.match(document.getElementById("rows").innerHTML, /<td class="td">1<\/td>/);
  assert.match(document.getElementById("summary").textContent, /part2 · .*2 tổng/);
});

test("scanning a folder creates no output folders; running prepares them once per file", async () => {
  const calls = [];
  const original = context.window.__TAURI__.core.invoke;
  context.window.__TAURI__.core.invoke = async (_command, { request }) => {
    calls.push(request);
    if (request.path === "/api/scan-folder") {
      return { status: 200, body: { count: 3, folderPath: "Y:\\scan", files: [
        { name: "one.txt", fullPath: "Y:\\scan\\one.txt", dirPath: "Y:\\scan", text: "First\nSecond" },
        { name: "two.txt", fullPath: "Y:\\scan\\two.txt", dirPath: "Y:\\scan", text: "Third" },
        { name: "empty.txt", fullPath: "Y:\\scan\\empty.txt", dirPath: "Y:\\scan", text: "  " },
      ] } };
    }
    return { status: 200, body: { count: request.body.sourcePaths.length } };
  };
  try {
    await evaluate('scan("Y:\\\\scan")');
    assert.equal(calls.filter((c) => c.path === "/api/prepare-output-folders").length, 0);
    const rows = evaluate('state.rows.filter((row) => row.source.startsWith("Y:\\\\scan"))');
    assert.equal(rows.length, 3);
    context.pending = rows;
    await evaluate("prepareRowFolders(pending)");
    const prepares = calls.filter((c) => c.path === "/api/prepare-output-folders");
    assert.equal(prepares.length, 1);
    assert.deepEqual(Array.from(prepares[0].body.sourcePaths), ["Y:\\scan\\one.txt", "Y:\\scan\\two.txt"]);
  } finally {
    context.window.__TAURI__.core.invoke = original;
  }
});

test("artifact mapping uses the batch item group, not node array order", () => {
  context.job = { items: [
    { index: 0, group_key: "item-0", artifact_node_id: "probe-first" },
    { index: 1, group_key: "item-1", artifact_node_id: "probe-second" },
  ], nodes: [
    { id: "second", kind: "merge", group_key: "item-1", seq: 0, status: "done", result_url: "/audio2" },
    { id: "probe-first", kind: "probe", group_key: "item-0", seq: 0, status: "done", result_url: "/srt1" },
    { id: "first", kind: "merge", group_key: "item-0", seq: 0, status: "done", result_url: "/audio1" },
    { id: "final-first", kind: "ffmpeg", group_key: "item-0", seq: 0, status: "done", result_url: "/final1" },
  ] };
  assert.deepEqual(Array.from(evaluate("nodesForRow(job, 0)")), ["final-first"]);
  assert.deepEqual(Array.from(evaluate("nodesForRow(job, 1)")), ["second"]);
});

test("artifact mapping falls back to ordered audio chunks, never probe text", () => {
  context.job = { items: [{ index: 0, group_key: "item-0", artifact_node_id: "probe" }], nodes: [
    { id: "chunk-2", kind: "tts_chunk", group_key: "item-0", seq: 2, status: "done", result_url: "/2" },
    { id: "probe", kind: "probe", group_key: "item-0", seq: 0, status: "done", result_url: "/srt" },
    { id: "chunk-1", kind: "tts_chunk", group_key: "item-0", seq: 1, status: "done", result_url: "/1" },
  ] };
  assert.deepEqual(Array.from(evaluate("nodesForRow(job, 0)")), ["chunk-1", "chunk-2"]);
});

test("batchRows onclick forwards event and selects source correctly", async () => {
  evaluate('state.rows = []; state.activeSource = ""');
  context.files = [
    { name: "part1.txt", fullPath: "Y:\\part1.txt", dirPath: "Y:", text: "One" },
    { name: "part2.txt", fullPath: "Y:\\part2.txt", dirPath: "Y:", text: "Two" },
  ];
  evaluate('addFiles(files, "batch")');
  assert.equal(evaluate("state.activeSource"), "Y:\\part1.txt");

  const batchRows = document.getElementById("batchRows");
  const fakeEvent = {
    target: {
      closest(selector) {
        if (selector === "button[data-folder]") return null;
        if (selector === "tr[data-source]") return { dataset: { source: "Y:\\part2.txt" } };
        return null;
      }
    }
  };
  await batchRows.onclick(fakeEvent);
  assert.equal(evaluate("state.activeSource"), "Y:\\part2.txt");
});

test("Eleven reading languages come from the model and are sent as ISO codes", () => {
  evaluate('state.models = [{ model_id: "eleven_v4", languages: ["en", "vi", "fr"] }]');
  document.getElementById("provider").value = "eleven";
  document.getElementById("model").value = "eleven_v4";
  const options = evaluate("languageOptions()");
  assert.deepEqual(Array.from(options, (o) => o[0]), ["vi", "en", "fr"]);
  assert.equal(evaluate('languageValueFor("English")'), "en");
});

test("MiniMax reading languages use full English names", () => {
  document.getElementById("provider").value = "mini";
  assert.equal(evaluate('languageValueFor("en")'), "English");
  assert.equal(evaluate('languageValueFor("vi")'), "Vietnamese");
  assert.equal(evaluate('languageValueFor("xx")'), "");
  document.getElementById("language").value = "English";
  const job = evaluate('jobPayload([{ name: "a.txt", text: "In 2018.", part: 1 }], "batch")');
  assert.equal(job.language, "English");
  document.getElementById("provider").value = "eleven";
  document.getElementById("language").value = "";
});

test("digits are detected in text and in SRT dialogue, not in SRT timestamps", () => {
  assert.equal(evaluate('rowsHaveDigits([{ text: "In 2018, she left." }])'), true);
  assert.equal(evaluate('rowsHaveDigits([{ text: "She left." }])'), false);
  assert.equal(evaluate('rowsHaveDigits([{ srtText: "1\\n00:00:00,000 --> 00:00:02,000\\nHello there.\\n" }])'), false);
});

test("network errors are recognised so polling and job creation can recover", () => {
  assert.equal(evaluate('isNetworkError(new Error("error sending request for url (https://sonicvoice.pro/api/v1/tts/jobs)"))'), true);
  assert.equal(evaluate('isNetworkError(new Error("Mất kết nối tới SonicVoice (mất kết nối giữa chừng: connection closed)"))'), true);
  assert.equal(evaluate('isNetworkError(new Error("SonicVoice HTTP 422: Không tìm thấy giọng đọc"))'), false);
});

test("a dropped create call reuses the job SonicVoice already made", async () => {
  const original = context.window.__TAURI__.core.invoke;
  const now = new Date().toISOString();
  context.window.__TAURI__.core.invoke = async () => ({ status: 200, body: { items: [
    { id: "old", title: "Part_1", created_at: "2020-01-01T00:00:00Z", status: "succeeded" },
    { id: "new", title: "Part_1", created_at: now, status: "running" },
  ] } });
  try {
    context.since = Date.now();
    const found = await evaluate('findRecentJob("Part_1", since)');
    assert.equal(found.id, "new");
    const none = await evaluate('findRecentJob("Part_9", since)');
    assert.equal(none, null);
  } finally {
    context.window.__TAURI__.core.invoke = original;
  }
});

test("scanning the same folder twice in a row only scans once", async () => {
  const original = context.window.__TAURI__.core.invoke;
  let scans = 0;
  context.window.__TAURI__.core.invoke = async (_c, { request }) => { if (request.path === "/api/scan-folder") scans++; return { status: 200, body: { count: 0, folderPath: "Z:\\x", files: [] } }; };
  try {
    await evaluate('scan("Z:\\\\twice")');
    await evaluate('scan("Z:\\\\twice")');
    assert.equal(scans, 1);
  } finally {
    context.window.__TAURI__.core.invoke = original;
  }
});

test("failed rows and failed files show a retry button; finished ones do not", () => {
  evaluate(`state.rows = [
    { source: "Q:\\\\p1.txt", name: "p1.txt", folder: "Q:\\\\p1", mode: "batch", part: 1, text: "a", status: "Done", output: "x" },
    { source: "Q:\\\\p1.txt", name: "p1.txt", folder: "Q:\\\\p1", mode: "batch", part: 2, text: "b", status: "Error", output: "" },
    { source: "Q:\\\\p2.txt", name: "p2.txt", folder: "Q:\\\\p2", mode: "batch", part: 1, text: "c", status: "Done", output: "y" },
  ]; state.activeSource = "Q:\\\\p1.txt"; render();`);
  const rows = document.getElementById("rows").innerHTML;
  assert.equal((rows.match(/data-retry="/g) || []).length, 1);
  assert.match(rows, /data-retry="1"/);
  const files = document.getElementById("batchRows").innerHTML;
  assert.equal((files.match(/data-retry-source=/g) || []).length, 1);
  assert.match(files, /data-retry-source="Q:\\p1\.txt"/);
  evaluate("state.rows = []; state.activeSource = ''; render();");
});

test("retry sends only the chosen failed rows to SonicVoice", async () => {
  const original = context.window.__TAURI__.core.invoke;
  const created = [];
  context.window.__TAURI__.core.invoke = async (_c, { request }) => {
    const action = request.body?.action;
    if (action === "voice") return { status: 200, body: { id: "abc123", provider: "eleven", ready: true } };
    if (action === "create") { created.push(Array.from(request.body.job.texts || [])); return { status: 422, body: { error: "test stop" } }; }
    return { status: 200, body: { count: 1 } };
  };
  try {
    for (const [id, v] of Object.entries({ provider: "eleven", model: "", language: "", voiceId: "abc123", speed: "1" })) document.getElementById(id).value = v;
    evaluate(`state.models = [{ model_id: "eleven_v3", languages: ["en"] }]; state.hasKey = true; state.running = false;
    state.rows = [
      { source: "R:\\a.txt", name: "a.txt", folder: "R:\\a", mode: "batch", part: 1, text: "one", status: "Done", output: "x" },
      { source: "R:\\a.txt", name: "a.txt", folder: "R:\\a", mode: "batch", part: 2, text: "two", status: "Error", output: "" },
      { source: "R:\\a.txt", name: "a.txt", folder: "R:\\a", mode: "batch", part: 3, text: "three", status: "Error", output: "" },
    ];`);
    await evaluate("retryRows([state.rows[1]])");
    assert.deepEqual(created, [["two"]]);
    assert.equal(evaluate("state.rows[0].status"), "Done");
    assert.equal(evaluate("state.rows[2].status"), "Error");
  } finally {
    evaluate("state.rows = []; state.running = false; state.hasKey = false; render();");
    context.window.__TAURI__.core.invoke = original;
  }
});
