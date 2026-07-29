// Q1:STT 合理性偵測器(or-plan2)。模型「只看 STT 逐字稿」判斷是否疑似聽錯——
// 模擬真實 UI(沒有 ground truth)。標籤來自 rules.cer:>=0.15 = mishear、<=0.05 = clean。
// 用法:node src/q1-stt-plausibility.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orChat, pmap } from "./or.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DETECTORS = ["anthropic/claude-sonnet-5", "anthropic/claude-haiku-4.5", "openai/gpt-5.4-nano"];

const items = [];
for (const runId of ["full-n3", "gpt-n1"]) {
  const runDir = path.join(root, "out/runs", runId);
  for (const f of fs.readdirSync(runDir).filter((x) => x.endsWith(".json") && !x.includes("error"))) {
    const r = JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8"));
    if (!r.inputTranscript || r.dir !== "ja") continue; // 每句 STT 一次即可,取 ja 方向代表
    const cer = r.rules.cer;
    const label = cer >= 0.15 ? "mishear" : cer <= 0.05 ? "clean" : null;
    if (!label) continue;
    items.push({ key: `${runId}|${r.phraseId}-${r.repeat}`, stt: r.inputTranscript, zh: r.zh, cer, label });
  }
}
console.log(`items: ${items.length} (mishear=${items.filter((i) => i.label === "mishear").length}, clean=${items.filter((i) => i.label === "clean").length})`);

const outFile = path.join(root, "out/experiments/q1-stt-plausibility.json");
const state = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : { verdicts: {} };

const jobs = [];
for (const it of items) for (const m of DETECTORS) {
  const k = `${it.key}|${m}`;
  if (!state.verdicts[k]) jobs.push({ it, m, k });
}
console.log(`jobs: ${jobs.length}`);
let done = 0;
await pmap(jobs, async ({ it, m, k }) => {
  const v = await orChat(m,
    `這是旅行翻譯 app 的語音辨識逐字稿(使用者是講中文的旅客,在日本旅行情境)。
辨識可能有同音字/專名錯誤。只根據這句話本身的語境合理性判斷。只輸出 JSON:
{"suspect":bool,"word":"最可疑的詞,無則空字串","reason":"一句中文"}
逐字稿:${it.stt}`,
    { json: true, maxTokens: 300 });
  state.verdicts[k] = { suspect: !!v.suspect, word: v.word ?? "" };
  if (++done % 100 === 0) { console.log(`${done}/${jobs.length}`); fs.writeFileSync(outFile, JSON.stringify(state, null, 1)); }
}, 8);

const stats = {};
for (const m of DETECTORS) {
  const rows = items.map((it) => ({ it, v: state.verdicts[`${it.key}|${m}`] })).filter((r) => r.v);
  const mis = rows.filter((r) => r.it.label === "mishear");
  const clean = rows.filter((r) => r.it.label === "clean");
  stats[m] = {
    n: rows.length,
    detection_rate: mis.length ? +(mis.filter((r) => r.v.suspect).length / mis.length).toFixed(3) : null,
    mishear_n: mis.length,
    false_alarm_rate: clean.length ? +(clean.filter((r) => r.v.suspect).length / clean.length).toFixed(3) : null,
    clean_n: clean.length,
  };
}
state.stats = stats;
state.labeling = "mishear: cer>=0.15, clean: cer<=0.05, ja-direction only";
fs.writeFileSync(outFile, JSON.stringify(state, null, 1));
console.log(JSON.stringify(stats, null, 2));
