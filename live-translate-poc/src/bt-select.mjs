// P3:回譯引擎選型。重用實驗 1 的 150 筆(zh→ja 輸出 + adequacy 標籤),
// 3 個便宜模型各自回譯 → 固定評審(mistral,非候選廠牌)判 user_would_notice →
// 每引擎的偵測率/誤報率/延遲。用法:node src/bt-select.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orChat, pmap } from "./or.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exp1 = JSON.parse(fs.readFileSync(path.join(root, "out/experiments/backtranslate-full-n3-ja.json"), "utf8"));
const items = exp1.items.filter((i) => i.judgeAdequacy !== null);

const ENGINES = ["anthropic/claude-haiku-4.5", "openai/gpt-5.4-nano", "qwen/qwen3.7-flash"];
const FIXED_JUDGE = "mistralai/mistral-large-2512"; // 非候選廠牌,固定不變

const outFile = path.join(root, "out/experiments/bt-select.json");
const state = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : { bt: {}, eq: {} };

const jobs = [];
for (const it of items) {
  for (const engine of ENGINES) {
    const key = `${it.phraseId}-${it.repeat}|${engine}`;
    if (!state.eq[key]) jobs.push({ it, engine, key });
  }
}
console.log(`bt-select jobs: ${jobs.length}`);
let done = 0;
await pmap(jobs, async ({ it, engine, key }) => {
  const t0 = performance.now();
  const bt = (await orChat(engine, `把下面這句日文翻譯成台灣繁體中文口語。只輸出譯文,不要任何說明。\n\n${it.output}`, { maxTokens: 300 })).trim();
  const latencyMs = Math.round(performance.now() - t0);
  const eq = await orChat(FIXED_JUDGE,
    `使用者原話(中文):${it.zh}\nApp 回譯確認文字:${bt}\n` +
    `只輸出 JSON:{"user_would_notice":bool}(一般使用者讀回譯時會不會察覺意思與原話不同)`,
    { json: true, maxTokens: 200 });
  state.bt[key] = { bt, latencyMs };
  state.eq[key] = { notice: !!eq.user_would_notice };
  if (++done % 50 === 0) { console.log(`${done}/${jobs.length}`); fs.writeFileSync(outFile, JSON.stringify(state, null, 1)); }
}, 8);

// 統計
const pct = (arr, p) => { const v = [...arr].sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))] : null; };
const stats = {};
for (const engine of ENGINES) {
  const rows = items.map((it) => ({ it, key: `${it.phraseId}-${it.repeat}|${engine}` }))
    .filter(({ key }) => state.eq[key]);
  const disaster = rows.filter(({ it }) => it.judgeAdequacy <= 2);
  const good = rows.filter(({ it }) => it.judgeAdequacy >= 4);
  const lats = rows.map(({ key }) => state.bt[key].latencyMs);
  stats[engine] = {
    n: rows.length,
    detection_rate: disaster.length ? +(disaster.filter(({ key }) => state.eq[key].notice).length / disaster.length).toFixed(3) : null,
    disaster_n: disaster.length,
    false_alarm_rate: good.length ? +(good.filter(({ key }) => state.eq[key].notice).length / good.length).toFixed(3) : null,
    latency_p50: pct(lats, 50), latency_p90: pct(lats, 90),
  };
}
state.stats = { fixedJudge: FIXED_JUDGE, engines: stats };
fs.writeFileSync(outFile, JSON.stringify(state, null, 1));
console.log(JSON.stringify(state.stats, null, 2));
