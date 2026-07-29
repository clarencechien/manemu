// Q7:評審分歧分析(or-plan2)。純統計:每評審相對共識的偏差;
// 高分歧句(range≥3)列清單供人工檢視。用法:node src/q7-judge-bias.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = { byJudge: {}, highDisagreement: [] };

for (const runId of ["full-n3", "gpt-n1"]) {
  const panel = JSON.parse(fs.readFileSync(path.join(root, `out/experiments/panel-${runId}.json`), "utf8"));
  for (const [tag, judgements] of Object.entries(panel.items)) {
    const cons = panel.consensus[tag];
    if (!cons) continue;
    for (const [judge, v] of Object.entries(judgements)) {
      if (typeof v.adequacy !== "number") continue;
      const b = (out.byJudge[judge] ??= { n: 0, sumDelta: 0, sumAbs: 0, flags: {} });
      b.n++;
      b.sumDelta += v.adequacy - cons.adequacy_median;
      b.sumAbs += Math.abs(v.adequacy - cons.adequacy_median);
      for (const [f, on] of Object.entries(v.flags ?? {})) if (on) b.flags[f] = (b.flags[f] ?? 0) + 1;
    }
    if (cons.adequacy_range[1] - cons.adequacy_range[0] >= 3) {
      out.highDisagreement.push({ runId, tag, range: cons.adequacy_range,
        scores: Object.fromEntries(Object.entries(judgements).map(([j, v]) => [j.split("/")[1], v.adequacy])) });
    }
  }
}
for (const [j, b] of Object.entries(out.byJudge)) {
  b.mean_bias = +(b.sumDelta / b.n).toFixed(3);     // 正=比共識寬鬆
  b.mean_abs_dev = +(b.sumAbs / b.n).toFixed(3);
  delete b.sumDelta; delete b.sumAbs;
}
fs.writeFileSync(path.join(root, "out/experiments/q7-judge-bias.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out.byJudge, null, 2));
console.log(`high-disagreement items: ${out.highDisagreement.length}`);
