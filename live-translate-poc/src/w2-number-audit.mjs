// W2:數字語意深度稽核。規則層只查數字出現與否,查不出「打八折→80% off」語意反轉。
// 對 number-trap 句的全部輸出做強模型語意核對。用法:node src/w2-number-audit.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orChat, pmap } from "./or.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDITOR = "anthropic/claude-sonnet-5";
const corpus = JSON.parse(fs.readFileSync(path.join(root, "data/corpus.json"), "utf8"));
const numberPhrases = new Set(corpus.phrases.filter((p) => p.traps.includes("number")).map((p) => p.id));

const items = [];
for (const runId of ["full-n3", "gpt-n1"]) {
  const runDir = path.join(root, "out/runs", runId);
  for (const f of fs.readdirSync(runDir).filter((x) => x.endsWith(".json") && !x.includes("error"))) {
    const r = JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8"));
    if (!numberPhrases.has(r.phraseId) || !r.outputTranscript) continue;
    items.push({ key: `${runId}|${r.phraseId}-${r.dir}-${r.repeat}`, runId, r });
  }
}
console.log(`number-trap outputs: ${items.length}`);

const outFile = path.join(root, "out/experiments/w2-number-audit.json");
const state = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : { items: {} };
let done = 0;
await pmap(items.filter((it) => !state.items[it.key]), async (it) => {
  const v = await orChat(AUDITOR,
    `稽核翻譯中所有「數量語意」:金額、折扣、時間、張數、人數、房號、比率。
特別注意:中文「打八折」= 8折 = 20% off(不是 80% off);「六點半」=6:30;量詞對應。
只輸出 JSON:{"numbers_ok":bool,"issues":["每個數量語意錯誤一句中文,無則空陣列"]}
中文原話:${it.r.zh}
譯文(→${it.r.dir}):${it.r.outputTranscript}`,
    { json: true, maxTokens: 400 });
  state.items[it.key] = { runId: it.runId, phraseId: it.r.phraseId, dir: it.r.dir, repeat: it.r.repeat,
    numbers_ok: !!v.numbers_ok, issues: v.issues ?? [] };
  if (++done % 30 === 0) { console.log(`${done}`); fs.writeFileSync(outFile, JSON.stringify(state, null, 1)); }
}, 8);

const rows = Object.values(state.items);
const byRun = {};
for (const r of rows) {
  const b = (byRun[r.runId] ??= { n: 0, ok: 0, badPhrases: {} });
  b.n++; if (r.numbers_ok) b.ok++;
  else (b.badPhrases[`${r.phraseId}-${r.dir}`] ??= []).push(...r.issues);
}
for (const b of Object.values(byRun)) b.semantic_ok_rate = +(b.ok / b.n).toFixed(3);
state.stats = byRun;
fs.writeFileSync(outFile, JSON.stringify(state, null, 1));
for (const [k, b] of Object.entries(byRun)) console.log(`${k}: numbers semantically ok ${b.ok}/${b.n} (${(b.semantic_ok_rate * 100).toFixed(1)}%)`);
console.log("bad:", JSON.stringify(Object.fromEntries(Object.entries(byRun).map(([k, b]) => [k, Object.keys(b.badPhrases)])), null, 1));
