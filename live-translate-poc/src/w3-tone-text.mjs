// W3:問句丟失歸因收尾。文字直翻(text-ceiling)的譯文也丟問句嗎?
// 丟 → 翻譯固有難題;不丟 → 語音模型 artifact。用法:node src/w3-tone-text.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orChat, pmap } from "./or.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLASSIFIER = "anthropic/claude-sonnet-5";
const tone = JSON.parse(fs.readFileSync(path.join(root, "out/experiments/tone-check.json"), "utf8"));
const questionPhrases = new Set(Object.values(tone.items).filter((i) => i.src_q).map((i) => i.phraseId));
const ceiling = JSON.parse(fs.readFileSync(path.join(root, "out/experiments/text-ceiling.json"), "utf8"));
const corpus = JSON.parse(fs.readFileSync(path.join(root, "data/corpus.json"), "utf8"));
const zhOf = Object.fromEntries(corpus.phrases.map((p) => [p.id, p.zh]));

const items = Object.entries(ceiling.translations)
  .map(([key, text]) => {
    const [pid, dir, ...m] = key.split("-");
    return { key, pid, dir, model: m.join("-"), text };
  })
  .filter((it) => questionPhrases.has(it.pid));
console.log(`question-phrase text translations: ${items.length}`);

const outFile = path.join(root, "out/experiments/w3-tone-text.json");
const state = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : { items: {} };
let done = 0;
await pmap(items.filter((it) => !state.items[it.key]), async (it) => {
  const v = await orChat(CLASSIFIER,
    `只輸出 JSON:{"out_is_question":bool}(譯文是否仍傳達疑問/徵詢語氣)
原文(疑問句): ${zhOf[it.pid]}
譯文(→${it.dir}): ${it.text}`,
    { json: true, maxTokens: 150 });
  state.items[it.key] = { pid: it.pid, dir: it.dir, model: it.model, out_q: !!v.out_is_question };
  if (++done % 50 === 0) { console.log(`${done}`); fs.writeFileSync(outFile, JSON.stringify(state, null, 1)); }
}, 8);

const rows = Object.values(state.items);
const byModel = {};
for (const r of rows) {
  const b = (byModel[r.model] ??= { n: 0, kept: 0 });
  b.n++; if (r.out_q) b.kept++;
}
for (const b of Object.values(byModel)) b.kept_rate = +(b.kept / b.n).toFixed(3);
state.stats = { byModel, speech_reference: { "full-n3": 0.91, "gpt-n1": 0.833 } };
fs.writeFileSync(outFile, JSON.stringify(state, null, 1));
console.log(JSON.stringify(byModel, null, 1));
