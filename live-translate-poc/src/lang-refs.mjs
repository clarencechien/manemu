// 語言擴充 SOP:產 ref_<lang>(sonnet 生成 → terra+qwen 交叉審)→ 寫回 corpus.json。
// 用法:node src/lang-refs.mjs <lang>(vi|th|...)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orChat, pmap } from "./or.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lang = process.argv[2];
const LANG_DEF = {
  vi: { name: "越南語", register: "禮貌口語(適度 dạ/ạ,對店員/陌生人得體)" },
  th: { name: "泰語", register: "禮貌口語(句尾 ครับ/ค่ะ 一致)" },
};
if (!LANG_DEF[lang]) { console.error("usage: node src/lang-refs.mjs <vi|th>"); process.exit(1); }
const { name, register } = LANG_DEF[lang];
const field = `ref_${lang}`;

const corpusPath = path.join(root, "data/corpus.json");
const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
const GEN = "anthropic/claude-sonnet-5";
const REVIEWERS = ["openai/gpt-5.6-terra", "qwen/qwen3.7-max"];

const todo = corpus.phrases.filter((p) => !p[field]);
for (let i = 0; i < todo.length; i += 10) {
  const batch = todo.slice(i, i + 10);
  const v = await orChat(GEN,
    `把下列台灣中文旅行口語翻成自然的${name}口語參考譯文(旅客對店員/站務員/路人說,${register})。
保留數字、專名、否定與疑問語氣。只輸出 JSON:{"refs":[{"id":"...","t":"..."}]}
${batch.map((p) => `${p.id}: ${p.zh}`).join("\n")}`,
    { json: true, maxTokens: 4000, timeoutMs: 240000 });
  for (const r of v.refs) {
    const p = corpus.phrases.find((x) => x.id === r.id);
    if (p) p[field] = r.t;
  }
  console.log(`gen ${Math.min(i + 10, todo.length)}/${todo.length}`);
  fs.writeFileSync(corpusPath, JSON.stringify(corpus, null, 2));
}

const reviews = {};
const jobs = [];
for (const p of corpus.phrases) for (const rv of REVIEWERS) jobs.push({ p, rv });
let done = 0;
await pmap(jobs, async ({ p, rv }) => {
  const v = await orChat(rv,
    `審核${name}參考譯文(旅行口譯評測用)。只輸出 JSON:{"severity":"none|minor|major","issue":"一句","better":"major 時給更好譯文,否則空字串"}
標準:語意完全正確、自然的${register};風格小疵=minor;語意錯/失禮/不自然=major。
中文原話:${p.zh}
${name}參考:${p[field]}`,
    { json: true, maxTokens: 400 });
  (reviews[p.id] ??= {})[rv] = v;
  if (++done % 25 === 0) console.log(`review ${done}/${jobs.length}`);
}, 8);

let replaced = 0;
for (const p of corpus.phrases) {
  const majors = REVIEWERS.map((rv) => reviews[p.id]?.[rv]).filter((v) => v?.severity === "major");
  if (majors.length >= 2 && majors.find((m) => m.better)?.better) { p[field] = majors.find((m) => m.better).better; replaced++; }
}
fs.writeFileSync(corpusPath, JSON.stringify(corpus, null, 2));
fs.writeFileSync(path.join(root, `out/experiments/${lang}-refs-review.json`), JSON.stringify(reviews, null, 1));
console.log(`done: ${corpus.phrases.filter((p) => p[field]).length}/50 ${field}, replaced=${replaced}`);
