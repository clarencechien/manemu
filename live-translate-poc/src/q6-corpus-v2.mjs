// Q6:語料 v2 草稿(or-plan2)。針對本輪暴露的弱點加重埋雷:
// 專名密集/多句連講/長句/數字+單位混合/問尾徵詢/同音字風險詞。
// 3 強模型各產 25 句 → 另兩家審(major 淘汰)→ 合併 50 句草稿。
// 用法:node src/q6-corpus-v2.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orChat, pmap } from "./or.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GENERATORS = ["anthropic/claude-sonnet-5", "openai/gpt-5.6-terra", "qwen/qwen3.7-max"];

const GEN_PROMPT = (model, n) => `為「中文→日文/英文即時口語翻譯」評測產生 ${n} 句台灣旅客的口語測試句(v2,加強版)。
本輪已知模型弱點,請每句至少埋 1–2 個對準弱點的雷:
- proper-noun-dense:一句含 2+ 個日本地名/車站/店名(實測「新宿→新竹」「Shibuya Sky→徐博雅」高錯誤率)
- homophone-risk:含易被聽成同音字的關鍵詞(實測「蝦子→瞎子」「辣→啦」「昏倒→婚」)
- question-final:徵詢/確認放句尾「…可以嗎?/…對吧?」(實測問句常被翻成陳述句)
- multi-clause:兩三個短句連講(轉折/條件在後半)
- number-unit-mix:數字+單位+時間混合(「兩張成人票一張兒童票總共四千三」)
- code-switch:夾雜英日文詞(避免商標詞如 Suica,TTS 會拒念)
類別沿用 v1:directions/transport/dining/shopping/hotel/emergency/appointment/smalltalk。
只輸出 JSON:{"phrases":[{"category":"...","traps":["..."],"zh":"...","ref_ja":"...","ref_en":"...","expect":{"numbers":["..."],"negation":bool,"min_len_ratio":0.5}}]}
zh 用台灣繁體口語;ref_ja 用自然日語含適切敬語;ref_en 自然口語。id 不用給。`;

const outFile = path.join(root, "out/experiments/q6-corpus-v2.json");
const state = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : { generated: {}, reviews: {} };

// 1) 生成
for (const g of GENERATORS) {
  if (state.generated[g]) continue;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const v = await orChat(g, GEN_PROMPT(g, 25), { json: true, maxTokens: 8000, timeoutMs: 300000 });
      if (!Array.isArray(v.phrases) || v.phrases.length < 15) throw new Error(`only ${v.phrases?.length}`);
      state.generated[g] = v.phrases;
      fs.writeFileSync(outFile, JSON.stringify(state, null, 1));
      console.log(`${g}: ${v.phrases.length} phrases`);
      break;
    } catch (err) { console.error(`${g} attempt ${attempt}: ${String(err.message).slice(0, 120)}`); }
  }
}

// 2) 交叉審(另兩家,major 即淘汰票)
const candidates = [];
for (const [g, phrases] of Object.entries(state.generated)) {
  phrases.forEach((p, i) => candidates.push({ gen: g, idx: i, p }));
}
const jobs = [];
for (const c of candidates) {
  for (const reviewer of GENERATORS.filter((r) => r !== c.gen)) {
    const key = `${c.gen}#${c.idx}|${reviewer}`;
    if (!state.reviews[key]) jobs.push({ c, reviewer, key });
  }
}
console.log(`review jobs: ${jobs.length}`);
let done = 0;
await pmap(jobs, async ({ c, reviewer, key }) => {
  const v = await orChat(reviewer,
    `審核旅行口譯評測句。只輸出 JSON:{"ok":bool,"severity":"none|minor|major","issue":"一句中文"}
標準:zh 是否自然台灣口語、ref_ja/ref_en 語意正確且自然(日語敬語合宜)、traps 標註是否符合句子內容。風格小疵 minor;語意錯/不自然/標註錯 major。
${JSON.stringify(c.p, null, 1)}`,
    { json: true, maxTokens: 300 });
  state.reviews[key] = v;
  if (++done % 30 === 0) { console.log(`${done}/${jobs.length}`); fs.writeFileSync(outFile, JSON.stringify(state, null, 1)); }
}, 8);
fs.writeFileSync(outFile, JSON.stringify(state, null, 1));

// 3) 合併:無 major 票的句子,輪流取滿 50
const approved = candidates.filter((c) =>
  GENERATORS.filter((r) => r !== c.gen).every((r) => state.reviews[`${c.gen}#${c.idx}|${r}`]?.severity !== "major"));
console.log(`approved: ${approved.length}/${candidates.length}`);
const merged = [];
const byGen = Object.groupBy(approved, (c) => c.gen);
let round = 0;
while (merged.length < 50) {
  let added = false;
  for (const g of GENERATORS) {
    const c = (byGen[g] ?? [])[round];
    if (c && merged.length < 50) { merged.push(c.p); added = true; }
  }
  if (!added) break;
  round++;
}
const v2 = {
  version: "v2-draft-2026-07-29",
  note: "or-plan2 Q6:3 模型生成+交叉審(無 major 票)。加重埋雷對準 full-n3/gpt-n1 實測弱點。未經真人校對;供真人錄音版與 M4 用。",
  phrases: merged.map((p, i) => ({ id: `V${String(i + 1).padStart(3, "0")}`, ...p })),
};
fs.writeFileSync(path.join(root, "data/corpus-v2-draft.json"), JSON.stringify(v2, null, 2));
console.log(`corpus-v2-draft.json: ${merged.length} phrases`);
