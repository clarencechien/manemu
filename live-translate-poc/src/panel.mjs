// P1:OpenRouter 多模型評審面板。用法:node src/panel.mjs <runId> [--judges m1,m2,...]
// 每筆結果 × 每個評審模型 → adequacy/fluency/flags;共識 = 中位數。
// 寫 out/experiments/panel-{runId}.json(不動 run 檔,與 judge/judge_x 並存)。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orChat, pmap } from "./or.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = process.argv[2];
if (!runId) { console.error("usage: node src/panel.mjs <runId>"); process.exit(1); }

const JUDGES = (process.argv.includes("--judges")
  ? process.argv[process.argv.indexOf("--judges") + 1].split(",")
  : [
    "anthropic/claude-sonnet-5",
    "openai/gpt-5.6-terra",
    "qwen/qwen3.7-plus",
    "deepseek/deepseek-v3.2",
    "mistralai/mistral-large-2512",
  ]);

const runDir = path.join(root, "out/runs", runId);
const results = fs.readdirSync(runDir)
  .filter((f) => f.endsWith(".json") && !f.includes("error"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8")));

const outDir = path.join(root, "out/experiments");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `panel-${runId}.json`);
// 可續跑:讀既有結果,已評過的 (tag, judge) 跳過
const existing = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")).items : {};

const promptFor = (r) => `你是專業口譯評審。只輸出 JSON,格式:
{"adequacy":1-5,"fluency":1-5,"flags":{"number_wrong":bool,"negation_flipped":bool,"honorific_off":bool,"name_mangled":bool,"omission":bool,"hallucination":bool},"reason":"一句中文"}
評分對象是「機器譯文」相對於中文原文的語意忠實度(adequacy)與目標語自然度(fluency)。
若譯文為空或幾乎沒翻,adequacy=1 且 omission=true。
原文(zh): ${r.zh}
機器譯文(→${r.dir}): ${r.outputTranscript || "(空)"}
參考譯文: ${r.reference}`;

const jobs = [];
for (const r of results) {
  const tag = `${r.phraseId}-${r.dir}-${r.repeat}`;
  for (const judge of JUDGES) {
    if (existing[tag]?.[judge]) continue;
    jobs.push({ r, tag, judge });
  }
}
console.log(`panel: ${results.length} results × ${JUDGES.length} judges → ${jobs.length} calls to make`);

const items = existing;
let done = 0;
await pmap(jobs, async ({ r, tag, judge }) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const v = await orChat(judge, promptFor(r), { json: true });
      if (typeof v.adequacy !== "number") throw new Error("bad shape");
      (items[tag] ??= {})[judge] = v;
      done++;
      if (done % 100 === 0) {
        console.log(`${done}/${jobs.length}`);
        fs.writeFileSync(outFile, JSON.stringify({ runId, judges: JUDGES, items }, null, 1));
      }
      return;
    } catch (err) {
      if (attempt === 3) console.error(`${tag} ${judge}: ${String(err.message).slice(0, 120)}`);
      await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
  }
}, 8);

// 共識統計
const median = (v) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const consensus = {};
for (const [tag, judgements] of Object.entries(items)) {
  const adequacies = Object.values(judgements).map((j) => j.adequacy).filter((x) => typeof x === "number");
  if (adequacies.length) {
    consensus[tag] = {
      n_judges: adequacies.length,
      adequacy_median: median(adequacies),
      adequacy_range: [Math.min(...adequacies), Math.max(...adequacies)],
      fluency_median: median(Object.values(judgements).map((j) => j.fluency)),
      omission_votes: Object.values(judgements).filter((j) => j.flags?.omission).length,
    };
  }
}
fs.writeFileSync(outFile, JSON.stringify({ runId, judges: JUDGES, consensus, items }, null, 1));

// 摘要
const byDir = {};
for (const r of results) {
  const tag = `${r.phraseId}-${r.dir}-${r.repeat}`;
  if (consensus[tag]) (byDir[r.dir] ??= []).push(consensus[tag].adequacy_median);
}
for (const [d, v] of Object.entries(byDir)) {
  console.log(`zh→${d}: consensus adequacy median-of-medians=${median(v)} mean=${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)} disasters(≤2)=${v.filter((x) => x <= 2).length}/${v.length}`);
}
console.log(`→ ${outFile}`);
