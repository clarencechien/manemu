// Q4:災難根因分類(or-plan2)。面板共識災難句(median≤2)+ 高分歧句,
// sonnet 做結構化根因分類 → Gate 報告用的錯誤分類表。
// 用法:node src/q4-taxonomy.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orChat, pmap } from "./or.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLASSIFIER = "anthropic/claude-sonnet-5";

const targets = [];
for (const runId of ["full-n3", "gpt-n1"]) {
  const panel = JSON.parse(fs.readFileSync(path.join(root, `out/experiments/panel-${runId}.json`), "utf8"));
  for (const [tag, c] of Object.entries(panel.consensus)) {
    if (c.adequacy_median <= 2) targets.push({ runId, tag });
  }
}
console.log(`consensus disasters: ${targets.length}`);

const outFile = path.join(root, "out/experiments/q4-taxonomy.json");
const state = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : { items: {} };

const jobs = targets.filter(({ runId, tag }) => !state.items[`${runId}|${tag}`]);
let done = 0;
await pmap(jobs, async ({ runId, tag }) => {
  const r = JSON.parse(fs.readFileSync(path.join(root, "out/runs", runId, `${tag}.json`), "utf8"));
  const v = await orChat(CLASSIFIER,
    `分析語音翻譯的失敗案例,判定根因。只輸出 JSON:
{"stage":"stt|translation|both|unknown","type":"homophone|proper_noun|question_particle|truncation|negation|number|hallucination|omission|other","evidence":"一句中文,指出關鍵詞"}
stage 判定:STT 逐字稿已與原話不符 → stt;逐字稿對但譯文錯 → translation。
中文原話:${r.zh}
STT 逐字稿:${r.inputTranscript || "(空)"}
譯文(→${r.dir}):${r.outputTranscript || "(空)"}
參考譯文:${r.reference}`,
    { json: true, maxTokens: 300 });
  state.items[`${runId}|${tag}`] = { runId, tag, model: r.model, ...v };
  if (++done % 10 === 0) fs.writeFileSync(outFile, JSON.stringify(state, null, 1));
}, 8);

// 彙整表:run × stage × type
const table = {};
for (const it of Object.values(state.items)) {
  const key = it.runId;
  ((table[key] ??= {})[it.stage] ??= {});
  table[key][it.stage][it.type] = (table[key][it.stage][it.type] ?? 0) + 1;
}
state.table = table;
fs.writeFileSync(outFile, JSON.stringify(state, null, 1));
console.log(JSON.stringify(table, null, 2));
