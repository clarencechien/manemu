// P4:gold 參考譯文交叉校對。3 個強模型獨立審 50 句 × ja/en 的參考譯文,
// 多數決列出「可疑參考」清單,縮小人工校對範圍。用法:node src/gold-check.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orChat, pmap } from "./or.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(fs.readFileSync(path.join(root, "data/corpus.json"), "utf8"));
const REVIEWERS = ["anthropic/claude-sonnet-5", "openai/gpt-5.6-terra", "qwen/qwen3.7-max"];

const outFile = path.join(root, "out/experiments/gold-check.json");
const state = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : { reviews: {} };

const jobs = [];
for (const p of corpus.phrases) {
  for (const dir of ["ja", "en"]) {
    for (const reviewer of REVIEWERS) {
      const key = `${p.id}-${dir}|${reviewer}`;
      if (!state.reviews[key]) jobs.push({ p, dir, reviewer, key });
    }
  }
}
console.log(`gold-check jobs: ${jobs.length}`);
let done = 0;
await pmap(jobs, async ({ p, dir, reviewer, key }) => {
  const ref = dir === "ja" ? p.ref_ja : p.ref_en;
  const v = await orChat(reviewer,
    `審核旅行口譯評測的參考譯文。只輸出 JSON:
{"ref_ok":bool,"severity":"none|minor|major","issue":"一句中文;沒問題寫「無」","better":"若 major 給更好的譯文,否則空字串"}
ref_ok 標準:語意完全正確且是當地人自然口語(${dir === "ja" ? "日語含適切敬語" : "自然英語"});風格小差異算 minor 且 ref_ok=true;語意錯/不自然/敬語失當算 major。
原文(zh): ${p.zh}
參考譯文(${dir}): ${ref}`,
    { json: true, maxTokens: 400 });
  state.reviews[key] = v;
  if (++done % 50 === 0) { console.log(`${done}/${jobs.length}`); fs.writeFileSync(outFile, JSON.stringify(state, null, 1)); }
}, 8);

// 多數決
const suspicious = [];
for (const p of corpus.phrases) {
  for (const dir of ["ja", "en"]) {
    const votes = REVIEWERS.map((rv) => state.reviews[`${p.id}-${dir}|${rv}`]).filter(Boolean);
    const majors = votes.filter((v) => v.severity === "major");
    if (majors.length >= 2) {
      suspicious.push({ id: p.id, dir, issues: majors.map((m) => m.issue), better: majors.find((m) => m.better)?.better });
    }
  }
}
state.stats = {
  reviewers: REVIEWERS, total: corpus.phrases.length * 2,
  suspicious_n: suspicious.length, suspicious,
};
fs.writeFileSync(outFile, JSON.stringify(state, null, 1));
console.log(`suspicious refs (≥2 major votes): ${suspicious.length}`);
for (const s of suspicious) console.log(` ${s.id}-${s.dir}: ${s.issues[0]}`);
