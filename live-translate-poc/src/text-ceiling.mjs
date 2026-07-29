// P2:文字翻譯品質天花板(docs/or-plan.md)。
// 50 句「文字直接餵」5 個強模型翻 ja/en(跳過語音管線)→ 異廠面板評分(剔除同廠評審)
// → 對照 live-translate 的品質,拆解損失來自「聽」還是「譯」。
// 用法:node src/text-ceiling.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orChat, pmap } from "./or.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(fs.readFileSync(path.join(root, "data/corpus.json"), "utf8"));

const TRANSLATORS = [
  "anthropic/claude-sonnet-5",
  "openai/gpt-5.6-terra",
  "qwen/qwen3.7-max",
  "deepseek/deepseek-v3.2",
  "google/gemini-3.6-flash",
];
const JUDGES = [
  "anthropic/claude-sonnet-5",
  "openai/gpt-5.6-terra",
  "qwen/qwen3.7-plus",
  "deepseek/deepseek-v3.2",
  "mistralai/mistral-large-2512",
];
const vendor = (m) => m.split("/")[0];

const outDir = path.join(root, "out/experiments");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "text-ceiling.json");
const state = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : { translations: {}, judgements: {} };

// 1) 翻譯
const tJobs = [];
for (const p of corpus.phrases) {
  for (const dir of ["ja", "en"]) {
    for (const model of TRANSLATORS) {
      const key = `${p.id}-${dir}-${model}`;
      if (!state.translations[key]) tJobs.push({ p, dir, model, key });
    }
  }
}
console.log(`translate jobs: ${tJobs.length}`);
let tDone = 0;
await pmap(tJobs, async ({ p, dir, model, key }) => {
  const lang = dir === "ja" ? "日文" : "英文";
  const out = (await orChat(model,
    `你是旅行情境的口譯。把下面這句台灣中文口語翻成自然的${lang}口語(對著當地店員/路人說)。只輸出譯文。\n\n${p.zh}`,
    { maxTokens: 500 })).trim();
  state.translations[key] = out;
  if (++tDone % 50 === 0) { console.log(`t ${tDone}/${tJobs.length}`); fs.writeFileSync(outFile, JSON.stringify(state, null, 1)); }
}, 6);
fs.writeFileSync(outFile, JSON.stringify(state, null, 1));

// 2) 面板評分(剔除同廠)
const jJobs = [];
for (const p of corpus.phrases) {
  for (const dir of ["ja", "en"]) {
    for (const model of TRANSLATORS) {
      const key = `${p.id}-${dir}-${model}`;
      const text = state.translations[key];
      if (!text) continue;
      for (const judge of JUDGES) {
        if (vendor(judge) === vendor(model)) continue;
        const jkey = `${key}|${judge}`;
        if (!state.judgements[jkey]) jJobs.push({ p, dir, text, judge, jkey });
      }
    }
  }
}
console.log(`judge jobs: ${jJobs.length}`);
let jDone = 0;
await pmap(jJobs, async ({ p, dir, text, judge, jkey }) => {
  const v = await orChat(judge, `你是專業翻譯評審。只輸出 JSON:{"adequacy":1-5,"fluency":1-5}
原文(zh): ${p.zh}
譯文(→${dir}): ${text}
參考譯文: ${dir === "ja" ? p.ref_ja : p.ref_en}`, { json: true, maxTokens: 400 });
  if (typeof v.adequacy !== "number") throw new Error("bad shape");
  state.judgements[jkey] = v;
  if (++jDone % 100 === 0) { console.log(`j ${jDone}/${jJobs.length}`); fs.writeFileSync(outFile, JSON.stringify(state, null, 1)); }
}, 8);
fs.writeFileSync(outFile, JSON.stringify(state, null, 1));

// 3) 統計:每翻譯模型 × 方向的 adequacy/fluency 平均(異廠評審均值)
const stats = {};
for (const model of TRANSLATORS) {
  for (const dir of ["ja", "en"]) {
    const adequacies = [], fluencies = [];
    for (const p of corpus.phrases) {
      const scores = JUDGES.filter((j) => vendor(j) !== vendor(model))
        .map((j) => state.judgements[`${p.id}-${dir}-${model}|${j}`]).filter(Boolean);
      if (scores.length) {
        adequacies.push(scores.reduce((s, v) => s + v.adequacy, 0) / scores.length);
        fluencies.push(scores.reduce((s, v) => s + v.fluency, 0) / scores.length);
      }
    }
    (stats[model] ??= {})[dir] = {
      n: adequacies.length,
      adequacy: +(adequacies.reduce((a, b) => a + b, 0) / adequacies.length).toFixed(3),
      fluency: +(fluencies.reduce((a, b) => a + b, 0) / fluencies.length).toFixed(3),
    };
  }
}
state.stats = stats;
fs.writeFileSync(outFile, JSON.stringify(state, null, 1));
console.log(JSON.stringify(stats, null, 2));
