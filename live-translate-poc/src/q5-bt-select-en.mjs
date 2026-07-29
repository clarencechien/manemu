// Q5:bt-select 補 en 方向(or-plan2)。zh→en 輸出回譯繁中給不諳英文的使用者。
// 從 full-n3 en 結果直接取(150 筆,judge.adequacy 當標籤)。
// 用法:node src/q5-bt-select-en.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orChat, pmap } from "./or.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINES = ["anthropic/claude-haiku-4.5", "openai/gpt-5.4-nano", "qwen/qwen3.7-flash"];
const FIXED_JUDGE = "mistralai/mistral-large-2512";

const runDir = path.join(root, "out/runs/full-n3");
const items = fs.readdirSync(runDir)
  .filter((f) => f.endsWith(".json") && !f.includes("error"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8")))
  .filter((r) => r.dir === "en" && r.outputTranscript && r.judge);

const outFile = path.join(root, "out/experiments/q5-bt-select-en.json");
const state = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : { bt: {}, eq: {} };

const jobs = [];
for (const r of items) for (const engine of ENGINES) {
  const key = `${r.phraseId}-${r.repeat}|${engine}`;
  if (!state.eq[key]) jobs.push({ r, engine, key });
}
console.log(`jobs: ${jobs.length}`);
let done = 0;
await pmap(jobs, async ({ r, engine, key }) => {
  const t0 = performance.now();
  const bt = (await orChat(engine, `把下面這句英文翻譯成台灣繁體中文口語。只輸出譯文,不要任何說明。\n\n${r.outputTranscript}`, { maxTokens: 300 })).trim();
  const latencyMs = Math.round(performance.now() - t0);
  const eq = await orChat(FIXED_JUDGE,
    `使用者原話(中文):${r.zh}\nApp 回譯確認文字:${bt}\n只輸出 JSON:{"user_would_notice":bool}(一般使用者讀回譯時會不會察覺意思與原話不同)`,
    { json: true, maxTokens: 200 });
  state.bt[key] = { bt, latencyMs };
  state.eq[key] = { notice: !!eq.user_would_notice };
  if (++done % 50 === 0) { console.log(`${done}/${jobs.length}`); fs.writeFileSync(outFile, JSON.stringify(state, null, 1)); }
}, 8);

const pct = (arr, p) => { const v = [...arr].sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))] : null; };
const stats = {};
for (const engine of ENGINES) {
  const rows = items.map((r) => ({ r, key: `${r.phraseId}-${r.repeat}|${engine}` })).filter(({ key }) => state.eq[key]);
  const disaster = rows.filter(({ r }) => r.judge.adequacy <= 2);
  const good = rows.filter(({ r }) => r.judge.adequacy >= 4);
  const lats = rows.map(({ key }) => state.bt[key].latencyMs);
  stats[engine] = {
    n: rows.length, disaster_n: disaster.length,
    detection_rate: disaster.length ? +(disaster.filter(({ key }) => state.eq[key].notice).length / disaster.length).toFixed(3) : null,
    false_alarm_rate: good.length ? +(good.filter(({ key }) => state.eq[key].notice).length / good.length).toFixed(3) : null,
    latency_p50: pct(lats, 50), latency_p90: pct(lats, 90),
  };
}
state.stats = { fixedJudge: FIXED_JUDGE, dir: "en", engines: stats };
fs.writeFileSync(outFile, JSON.stringify(state, null, 1));
console.log(JSON.stringify(state.stats, null, 2));
