// Phase 2:產 ref_ko(sonnet 生成 → terra+qwen 交叉審,major 採納 better)→ 寫回 corpus.json。
// 用法:node src/ko-refs.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orChat, pmap } from "./or.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = path.join(root, "data/corpus.json");
const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
const GEN = "anthropic/claude-sonnet-5";
const REVIEWERS = ["openai/gpt-5.6-terra", "qwen/qwen3.7-max"];

// 1) 分批生成(每批 10 句)
const todo = corpus.phrases.filter((p) => !p.ref_ko);
for (let i = 0; i < todo.length; i += 10) {
  const batch = todo.slice(i, i + 10);
  const v = await orChat(GEN,
    `把下列台灣中文旅行口語翻成自然的韓語口語參考譯文(旅客對店員/站務員/路人說,존댓말 해요체/합니다체)。
保留數字、專名、否定與疑問語氣。只輸出 JSON:{"refs":[{"id":"...","ko":"..."}]}
${batch.map((p) => `${p.id}: ${p.zh}`).join("\n")}`,
    { json: true, maxTokens: 4000, timeoutMs: 240000 });
  for (const r of v.refs) {
    const p = corpus.phrases.find((x) => x.id === r.id);
    if (p) p.ref_ko = r.ko;
  }
  console.log(`generated ${Math.min(i + 10, todo.length)}/${todo.length}`);
  fs.writeFileSync(corpusPath, JSON.stringify(corpus, null, 2));
}

// 2) 交叉審
const reviews = {};
const jobs = [];
for (const p of corpus.phrases) for (const rv of REVIEWERS) jobs.push({ p, rv });
let done = 0;
await pmap(jobs, async ({ p, rv }) => {
  const v = await orChat(rv,
    `審核韓語參考譯文(旅行口譯評測用)。只輸出 JSON:{"severity":"none|minor|major","issue":"一句","better":"major 時給更好譯文,否則空字串"}
標準:語意完全正確、자연스러운 존댓말;風格小疵=minor;語意錯/반말/不自然=major。
中文原話:${p.zh}
韓語參考:${p.ref_ko}`,
    { json: true, maxTokens: 400 });
  (reviews[p.id] ??= {})[rv] = v;
  if (++done % 25 === 0) console.log(`review ${done}/${jobs.length}`);
}, 8);

// 3) 兩票 major → 換 better;一票 major 記錄不動
let replaced = 0, flagged = 0;
for (const p of corpus.phrases) {
  const vs = REVIEWERS.map((rv) => reviews[p.id]?.[rv]).filter(Boolean);
  const majors = vs.filter((v) => v.severity === "major");
  if (majors.length >= 2) {
    const better = majors.find((m) => m.better)?.better;
    if (better) { p.ref_ko = better; replaced++; }
  } else if (majors.length === 1) flagged++;
}
fs.writeFileSync(corpusPath, JSON.stringify(corpus, null, 2));
fs.writeFileSync(path.join(root, "out/experiments/ko-refs-review.json"), JSON.stringify(reviews, null, 1));
console.log(`done: ${corpus.phrases.filter((p) => p.ref_ko).length}/50 refs, replaced=${replaced}, single-major=${flagged}`);
