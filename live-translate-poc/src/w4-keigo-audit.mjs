// W4:敬語專項報告(ja)。150 筆 zh→ja 輸出:敬語層級是否合宜、失敬方向、按情境分組。
// 用法:node src/w4-keigo-audit.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orChat, pmap } from "./or.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDITOR = "openai/gpt-5.6-terra"; // 異於 Gemini 的強模型;sonnet 已用很多,分散偏誤

const runDir = path.join(root, "out/runs/full-n3");
const items = fs.readdirSync(runDir)
  .filter((f) => f.endsWith(".json") && !f.includes("error"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8")))
  .filter((r) => r.dir === "ja" && r.outputTranscript);
console.log(`ja outputs: ${items.length}`);

const outFile = path.join(root, "out/experiments/w4-keigo-audit.json");
const state = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : { items: {} };
let done = 0;
await pmap(items.filter((r) => !state.items[`${r.phraseId}-${r.repeat}`]), async (r) => {
  const v = await orChat(AUDITOR,
    `評估日語譯文的敬語/語域是否適合情境(台灣旅客在日本對店員/站務員/路人/醫護說話)。
只輸出 JSON:{"keigo":"appropriate|too_casual|too_stiff|mixed","acceptable":bool,"note":"一句中文"}
acceptable:雖不完美但當面說出來不失禮即為 true。
情境類別:${r.category}
中文原話:${r.zh}
日語譯文:${r.outputTranscript}`,
    { json: true, maxTokens: 300 });
  state.items[`${r.phraseId}-${r.repeat}`] = { phraseId: r.phraseId, category: r.category, repeat: r.repeat,
    keigo: v.keigo, acceptable: !!v.acceptable, note: v.note };
  if (++done % 30 === 0) { console.log(`${done}`); fs.writeFileSync(outFile, JSON.stringify(state, null, 1)); }
}, 8);

const rows = Object.values(state.items);
const byCat = {};
for (const r of rows) {
  const b = (byCat[r.category] ??= { n: 0, acceptable: 0, too_casual: 0, too_stiff: 0, mixed: 0 });
  b.n++; if (r.acceptable) b.acceptable++;
  if (r.keigo in b) b[r.keigo]++;
}
for (const b of Object.values(byCat)) b.acceptable_rate = +(b.acceptable / b.n).toFixed(3);
state.stats = { auditor: AUDITOR, byCat };
fs.writeFileSync(outFile, JSON.stringify(state, null, 1));
console.log(JSON.stringify(byCat, null, 1));
