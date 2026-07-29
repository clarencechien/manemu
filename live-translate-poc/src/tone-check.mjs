// P5:語氣(疑問)保留全量掃描。對 run 裡每筆:原文是否疑問句、譯文是否仍是疑問/請求語氣。
// 量 T022 型「問句變陳述」災難的廣度,跨 provider 對照。用法:node src/tone-check.mjs <runId> [runId2...]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orChat, pmap } from "./or.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runIds = process.argv.slice(2);
if (!runIds.length) { console.error("usage: node src/tone-check.mjs <runId> [runId2...]"); process.exit(1); }
const CLASSIFIER = "anthropic/claude-sonnet-5";

const outFile = path.join(root, "out/experiments", `tone-check.json`);
const state = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : { items: {} };

const jobs = [];
for (const runId of runIds) {
  const runDir = path.join(root, "out/runs", runId);
  for (const f of fs.readdirSync(runDir).filter((x) => x.endsWith(".json") && !x.includes("error"))) {
    const r = JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8"));
    const key = `${runId}|${r.phraseId}-${r.dir}-${r.repeat}`;
    if (!state.items[key]) jobs.push({ r, runId, key });
  }
}
console.log(`tone-check jobs: ${jobs.length}`);
let done = 0;
await pmap(jobs, async ({ r, runId, key }) => {
  const v = await orChat(CLASSIFIER,
    `分析口譯的「語氣保留」。只輸出 JSON:
{"src_is_question":bool,"out_is_question":bool,"tone_preserved":bool,"note":"一句中文"}
src_is_question:原文是否為疑問/徵詢(含句尾嗎/吧/可以嗎等)。
out_is_question:譯文是否仍傳達疑問/徵詢語氣(疑問形、依賴句/ですか/right?/could you 等都算)。
tone_preserved:譯文語氣是否忠實(問句仍是問句、請求仍是請求)。
原文(zh): ${r.zh}
譯文(→${r.dir}): ${r.outputTranscript || "(空)"}`,
    { json: true, maxTokens: 300 });
  state.items[key] = { runId, phraseId: r.phraseId, dir: r.dir, repeat: r.repeat,
    model: r.model, src_q: !!v.src_is_question, out_q: !!v.out_is_question,
    preserved: !!v.tone_preserved, note: v.note };
  if (++done % 100 === 0) { console.log(`${done}/${jobs.length}`); fs.writeFileSync(outFile, JSON.stringify(state, null, 1)); }
}, 8);

// 統計:每 run 的問句保留率
const stats = {};
for (const runId of runIds) {
  const rows = Object.values(state.items).filter((i) => i.runId === runId);
  const q = rows.filter((i) => i.src_q);
  stats[runId] = {
    n: rows.length, questions: q.length,
    question_kept_rate: q.length ? +(q.filter((i) => i.out_q).length / q.length).toFixed(3) : null,
    tone_preserved_rate: rows.length ? +(rows.filter((i) => i.preserved).length / rows.length).toFixed(3) : null,
    lost_questions: q.filter((i) => !i.out_q).map((i) => `${i.phraseId}-${i.dir}-${i.repeat}`),
  };
}
state.stats = { classifier: CLASSIFIER, byRun: stats };
fs.writeFileSync(outFile, JSON.stringify(state, null, 1));
for (const [k, s] of Object.entries(stats)) {
  console.log(`${k}: questions=${s.questions}/${s.n} kept=${(s.question_kept_rate * 100).toFixed(1)}% tone_preserved=${(s.tone_preserved_rate * 100).toFixed(1)}% lost=${s.lost_questions.length}`);
}
