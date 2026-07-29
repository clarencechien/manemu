// W1:corpus v2 補完。sonnet 上次 25 句一次生成 JSON 截斷 → 改分批(8 句/次)。
// 生成補到候選池 ≥75 → 沿用 q6 交叉審 → 合併 50+ 句 corpus-v2.json(非 draft)。
// 用法:node src/w1-corpus-v2-complete.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orChat, pmap } from "./or.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GENERATORS = ["anthropic/claude-sonnet-5", "openai/gpt-5.6-terra", "qwen/qwen3.7-max"];

const GEN_PROMPT = (n, exclude) => `為「中文→日文/英文即時口語翻譯」評測產生 ${n} 句台灣旅客的口語測試句。
每句埋 1–2 個雷,對準已知弱點:proper-noun-dense(2+ 日本地名/站名)、homophone-risk(蝦子/辣/昏倒類同音風險詞)、question-final(徵詢在句尾)、multi-clause(轉折在後半)、number-unit-mix(數字+單位+時間)、code-switch(夾英日文詞,避免商標)。
類別:directions/transport/dining/shopping/hotel/emergency/appointment/smalltalk。
避免與這些既有句重複:${exclude}
只輸出 JSON:{"phrases":[{"category":"...","traps":["..."],"zh":"...","ref_ja":"...","ref_en":"...","expect":{"numbers":["..."],"negation":bool,"min_len_ratio":0.5}}]}
zh 台灣繁體口語;ref_ja 自然日語含適切敬語;ref_en 自然口語。`;

const outFile = path.join(root, "out/experiments/q6-corpus-v2.json"); // 延用 q6 state
const state = JSON.parse(fs.readFileSync(outFile, "utf8"));

// 1) 分批補生成(每模型池到 25)
for (const g of GENERATORS) {
  state.generated[g] ??= [];
  while (state.generated[g].length < 25) {
    const existing = Object.values(state.generated).flat().map((p) => p.zh).slice(0, 60).join(" / ");
    try {
      const v = await orChat(g, GEN_PROMPT(8, existing), { json: true, maxTokens: 4000, timeoutMs: 240000 });
      if (!Array.isArray(v.phrases) || !v.phrases.length) throw new Error("empty");
      state.generated[g].push(...v.phrases);
      fs.writeFileSync(outFile, JSON.stringify(state, null, 1));
      console.log(`${g}: pool=${state.generated[g].length}`);
    } catch (err) { console.error(`${g}: ${String(err.message).slice(0, 100)}`); break; }
  }
}

// 2) 交叉審缺漏的
const candidates = [];
for (const [g, phrases] of Object.entries(state.generated)) phrases.forEach((p, i) => candidates.push({ gen: g, idx: i, p }));
const jobs = [];
for (const c of candidates) for (const reviewer of GENERATORS.filter((r) => r !== c.gen)) {
  const key = `${c.gen}#${c.idx}|${reviewer}`;
  if (!state.reviews[key]) jobs.push({ c, reviewer, key });
}
console.log(`review jobs: ${jobs.length}`);
let done = 0;
await pmap(jobs, async ({ c, reviewer, key }) => {
  const v = await orChat(reviewer,
    `審核旅行口譯評測句。只輸出 JSON:{"ok":bool,"severity":"none|minor|major","issue":"一句中文"}
標準:zh 自然台灣口語、ref_ja/ref_en 語意正確且自然(日語敬語合宜)、traps 符合內容。風格小疵 minor;語意錯/不自然/標註錯 major。
${JSON.stringify(c.p, null, 1)}`,
    { json: true, maxTokens: 300 });
  state.reviews[key] = v;
  if (++done % 30 === 0) { console.log(`${done}/${jobs.length}`); fs.writeFileSync(outFile, JSON.stringify(state, null, 1)); }
}, 8);
fs.writeFileSync(outFile, JSON.stringify(state, null, 1));

// 3) 合併正式版
const approved = candidates.filter((c) =>
  GENERATORS.filter((r) => r !== c.gen).every((r) => state.reviews[`${c.gen}#${c.idx}|${r}`]?.severity !== "major"));
console.log(`approved: ${approved.length}/${candidates.length}`);
const merged = [];
const byGen = Object.groupBy(approved, (c) => c.gen);
let round = 0;
while (merged.length < 55) {
  let added = false;
  for (const g of GENERATORS) {
    const c = (byGen[g] ?? [])[round];
    if (c && merged.length < 55) { merged.push(c.p); added = true; }
  }
  if (!added) break;
  round++;
}
fs.writeFileSync(path.join(root, "data/corpus-v2.json"), JSON.stringify({
  version: "v2-2026-07-29",
  note: "3 模型分批生成 + 交叉審(無 major 票)。加重埋雷對準 full-n3/gpt-n1 實測弱點。建議真人快掃後用於下輪評測。",
  phrases: merged.map((p, i) => ({ id: `V${String(i + 1).padStart(3, "0")}`, ...p })),
}, null, 2));
console.log(`corpus-v2.json: ${merged.length} phrases`);
