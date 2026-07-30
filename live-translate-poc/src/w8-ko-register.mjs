// Phase 2:韓語語域稽核(W4 的 존댓말 版)。150 筆 ko 輸出:語域是否合宜、失禮方向。
// 用法:node src/w8-ko-register.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orChat, pmap } from "./or.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDITOR = "openai/gpt-5.6-terra";

const runDir = path.join(root, "out/runs/ko-full-n3");
const items = fs.readdirSync(runDir)
  .filter((f) => f.endsWith(".json") && !f.includes("error"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8")))
  .filter((r) => r.outputTranscript);
console.log(`ko outputs: ${items.length}`);

const outFile = path.join(root, "out/experiments/w8-ko-register.json");
const state = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : { items: {} };
let done = 0;
await pmap(items.filter((r) => !state.items[`${r.phraseId}-${r.repeat}`]), async (r) => {
  const v = await orChat(AUDITOR,
    `評估韓語譯文的語域(존댓말)是否適合情境(台灣旅客在韓國對店員/站務員/路人/醫護說話)。
只輸出 JSON:{"register":"appropriate|too_casual|too_stiff|banmal|mixed","acceptable":bool,"note":"一句中文"}
banmal=出現반말(嚴重);acceptable=當面說出來不失禮即為 true。
情境類別:${r.category}
中文原話:${r.zh}
韓語譯文:${r.outputTranscript}`,
    { json: true, maxTokens: 300 });
  state.items[`${r.phraseId}-${r.repeat}`] = { phraseId: r.phraseId, category: r.category, repeat: r.repeat,
    register: v.register, acceptable: !!v.acceptable, note: v.note };
  if (++done % 30 === 0) { console.log(done); fs.writeFileSync(outFile, JSON.stringify(state, null, 1)); }
}, 8);

const rows = Object.values(state.items);
const byCat = {};
for (const r of rows) {
  const b = (byCat[r.category] ??= { n: 0, acceptable: 0, too_casual: 0, too_stiff: 0, banmal: 0, mixed: 0 });
  b.n++; if (r.acceptable) b.acceptable++;
  if (r.register in b) b[r.register]++;
}
for (const b of Object.values(byCat)) b.acceptable_rate = +(b.acceptable / b.n).toFixed(3);
state.stats = { auditor: AUDITOR, byCat, banmal_total: rows.filter((r) => r.register === "banmal").length };
fs.writeFileSync(outFile, JSON.stringify(state, null, 1));
console.log(JSON.stringify(state.stats, null, 1));
