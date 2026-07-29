// 實驗 2 分析:Gemini judge vs OpenAI judge_x 的一致性。用法:node src/agreement.mjs <runId>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = process.argv[2];
const runDir = path.join(root, "out/runs", runId);
const rs = fs.readdirSync(runDir)
  .filter((f) => f.endsWith(".json") && !f.includes("error"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8")))
  .filter((r) => r.judge && r.judge_x);
console.log(`paired judgements: ${rs.length}`);

const g = rs.map((r) => r.judge.adequacy), x = rs.map((r) => r.judge_x.adequacy);
const mean = (v) => v.reduce((s, y) => s + y, 0) / v.length;
const mg = mean(g), mx = mean(x);
const pearson = rs.length
  ? g.reduce((s, gi, i) => s + (gi - mg) * (x[i] - mx), 0) /
    Math.sqrt(g.reduce((s, gi) => s + (gi - mg) ** 2, 0) * x.reduce((s, xi) => s + (xi - mx) ** 2, 0))
  : null;

const within1 = rs.filter((r) => Math.abs(r.judge.adequacy - r.judge_x.adequacy) <= 1).length;
const gDisaster = new Set(rs.filter((r) => r.judge.adequacy <= 2).map((r) => `${r.phraseId}-${r.dir}-${r.repeat}`));
const xDisaster = new Set(rs.filter((r) => r.judge_x.adequacy <= 2).map((r) => `${r.phraseId}-${r.dir}-${r.repeat}`));
const overlap = [...gDisaster].filter((k) => xDisaster.has(k));

const flagAgree = {};
for (const flag of ["number_wrong", "negation_flipped", "honorific_off", "name_mangled", "omission", "hallucination"]) {
  const agree = rs.filter((r) => r.judge.flags[flag] === r.judge_x.flags[flag]).length;
  const gRate = rs.filter((r) => r.judge.flags[flag]).length;
  const xRate = rs.filter((r) => r.judge_x.flags[flag]).length;
  flagAgree[flag] = { agreement: +(agree / rs.length).toFixed(3), gemini_n: gRate, openai_n: xRate };
}

const out = {
  runId, n: rs.length,
  geminiJudge: rs[0]?.judgeModel, openaiJudge: rs[0]?.judge_xModel,
  adequacy: {
    gemini_mean: +mg.toFixed(3), openai_mean: +mx.toFixed(3),
    pearson_r: +pearson.toFixed(3), within_1_point: +(within1 / rs.length).toFixed(3),
  },
  disasters: {
    gemini_n: gDisaster.size, openai_n: xDisaster.size, overlap_n: overlap.length,
    overlap_of_gemini: gDisaster.size ? +(overlap.length / gDisaster.size).toFixed(3) : null,
    only_openai: [...xDisaster].filter((k) => !gDisaster.has(k)),
    only_gemini: [...gDisaster].filter((k) => !xDisaster.has(k)),
  },
  flags: flagAgree,
};
const outDir = path.join(root, "out/experiments");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `agreement-${runId}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
