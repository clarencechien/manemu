// Q3:問句語氣修復(or-plan2)。P5 抓到的 lost-question + 對照組:
// UI 端已知原文是問句(從 input 逐字稿判)→ 譯文非問句時用便宜模型改回問句形。
// 用法:node src/q3-tone-repair.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orChat, pmap } from "./or.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPAIRER = "openai/gpt-5.4-nano";
const JUDGE = "anthropic/claude-sonnet-5";

const tone = JSON.parse(fs.readFileSync(path.join(root, "out/experiments/tone-check.json"), "utf8"));
const lost = Object.entries(tone.items).filter(([, i]) => i.src_q && !i.out_q);
const kept = Object.entries(tone.items).filter(([, i]) => i.src_q && i.out_q).slice(0, 20); // 對照:應該不動
console.log(`lost=${lost.length} kept-control=${kept.length}`);

// 找回原始譯文
function loadResult(item) {
  const f = path.join(root, "out/runs", item.runId, `${item.phraseId}-${item.dir}-${item.repeat}.json`);
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

const outFile = path.join(root, "out/experiments/q3-tone-repair.json");
const state = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : { repairs: {} };

const jobs = [...lost.map(([k, i]) => ({ k, i, group: "lost" })), ...kept.map(([k, i]) => ({ k, i, group: "control" }))]
  .filter(({ k }) => !state.repairs[k]?.verdict);
let done = 0;
await pmap(jobs, async ({ k, i, group }) => {
  const r = loadResult(i);
  const fixed = (await orChat(REPAIRER,
    `翻譯 app 偵測到:使用者的原話是「疑問/徵詢」語氣。檢查譯文——若譯文已是疑問/徵詢語氣,原樣輸出;若被翻成了肯定句,把它改回自然的疑問形(${i.dir === "ja" ? "日語:〜ですか/〜でいいですか等" : "English: is it ok / could you / right? etc."}),內容不變。只輸出譯文。
譯文(${i.dir}):${r.outputTranscript}`,
    { maxTokens: 300 })).trim();
  const verdict = await orChat(JUDGE,
    `只輸出 JSON:{"now_question":bool,"meaning_preserved":bool,"changed":bool}
中文原話(疑問):${r.zh}
修復前譯文:${r.outputTranscript}
修復後譯文:${fixed}`,
    { json: true, maxTokens: 200 });
  state.repairs[k] = { group, dir: i.dir, before: r.outputTranscript, after: fixed, verdict };
  if (++done % 10 === 0) fs.writeFileSync(outFile, JSON.stringify(state, null, 1));
}, 6);

const rows = Object.values(state.repairs).filter((r) => r.verdict);
const lostRows = rows.filter((r) => r.group === "lost");
const ctrl = rows.filter((r) => r.group === "control");
state.stats = {
  repairer: REPAIRER, judge: JUDGE,
  lost_n: lostRows.length,
  fixed_rate: lostRows.length ? +(lostRows.filter((r) => r.verdict.now_question && r.verdict.meaning_preserved).length / lostRows.length).toFixed(3) : null,
  control_n: ctrl.length,
  control_needless_change_rate: ctrl.length ? +(ctrl.filter((r) => r.verdict.changed).length / ctrl.length).toFixed(3) : null,
};
fs.writeFileSync(outFile, JSON.stringify(state, null, 1));
console.log(JSON.stringify(state.stats, null, 2));
