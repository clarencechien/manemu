// 兩個 run 的並列對照表(markdown)。用法:node src/compare.mjs <runA> <runB>
// 需先對兩個 run 跑過 report.mjs(讀 out/reports/{runId}/summary.json)。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [a, b] = process.argv.slice(2);
if (!a || !b) { console.error("usage: node src/compare.mjs <runA> <runB>"); process.exit(1); }
const load = (id) => JSON.parse(fs.readFileSync(path.join(root, "out/reports", id, "summary.json"), "utf8"));
const A = load(a), B = load(b);
const fmt = (x, d = 0) => (x === null || x === undefined ? "—" : Number(x).toFixed(d));

let md = `# Run 對照:\`${a}\` vs \`${b}\`\n\n`;
md += `| | ${a} | ${b} |\n|---|---|---|\n`;
md += `| model | ${A.model} | ${B.model} |\n`;
md += `| judge | ${A.judgeModel} | ${B.judgeModel} |\n`;
md += `| n(筆) | ${A.totals.results} | ${B.totals.results} |\n\n`;

for (const dir of Object.keys(A.byDir)) {
  const da = A.byDir[dir], db = B.byDir[dir];
  if (!db) continue;
  md += `## zh → ${dir}\n\n| 指標 | ${a} | ${b} |\n|---|---|---|\n`;
  for (const [label, key] of [
    ["ttfa_from_end p50 (ms)", "p50"], ["ttfa_from_end p90 (ms)", "p90"], ["ttfa_from_end p95 (ms)", "p95"],
  ]) md += `| ${label} | ${fmt(da.latency.ttfa_from_end_ms[key])} | ${fmt(db.latency.ttfa_from_end_ms[key])} |\n`;
  for (const [label, key] of [["completion_lag p50 (ms)", "p50"], ["completion_lag p90 (ms)", "p90"]])
    md += `| ${label} | ${fmt(da.latency.completion_lag_ms[key])} | ${fmt(db.latency.completion_lag_ms[key])} |\n`;
  md += `| ttfa_from_start p50 (ms) | ${fmt(da.latency.ttfa_from_start_ms.p50)} | ${fmt(db.latency.ttfa_from_start_ms.p50)} |\n`;
  md += `| adequacy 平均 | ${fmt(da.quality.adequacy_mean, 2)} | ${fmt(db.quality.adequacy_mean, 2)} |\n`;
  md += `| fluency 平均 | ${fmt(da.quality.fluency_mean, 2)} | ${fmt(db.quality.fluency_mean, 2)} |\n`;
  md += `| 數字保留率 | ${fmt(da.quality.number_ok_rate * 100, 1)}% | ${fmt(db.quality.number_ok_rate * 100, 1)}% |\n`;
  md += `| 否定保留率 | ${fmt(da.quality.negation_ok_rate * 100, 1)}% | ${fmt(db.quality.negation_ok_rate * 100, 1)}% |\n`;
  md += `| 覆蓋率 | ${fmt(da.quality.coverage_mean, 2)} | ${fmt(db.quality.coverage_mean, 2)} |\n`;
  md += `| STT CER | ${fmt(da.quality.cer_mean, 3)} | ${fmt(db.quality.cer_mean, 3)} |\n`;
  md += `| omission 旗標 | ${fmt(da.quality.flags.omission * 100, 1)}% | ${fmt(db.quality.flags.omission * 100, 1)}% |\n\n`;
}
md += `> 注意:completion_lag 是「最後有聲 chunk 到達」;OpenAI 以快於即時的 burst 回音訊,` +
  `Gemini 近即時串流,所以兩家的 completion_lag 語意不同。跨家比較「對方聽完」請用 ` +
  `ttfa_from_end + 譯音長度(playback-bound 下界)。\n`;

const outFile = path.join(root, "out/reports", `compare-${a}-vs-${b}.md`);
fs.writeFileSync(outFile, md);
console.log(md);
console.log(`→ ${outFile}`);
