// Q2:專有名詞 glossary 後修復(or-plan2)。live-translate 不吃術語表,
// 測「譯文產出後用行程 glossary 後修」能救回幾成專名災難、以及會不會誤傷好譯文。
// 用法:node src/q2-glossary-repair.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orChat, pmap } from "./or.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPAIRER = "openai/gpt-5.4-nano";   // UI 上會用便宜快的
const JUDGE = "anthropic/claude-sonnet-5";

// 「行程 glossary」:使用者出發前輸入/由行程自動生成的清單
const GLOSSARY = {
  ja: { 新宿: "新宿", 京都: "京都", 大阪: "大阪", 橫濱: "横浜", 淺草寺: "浅草寺", 晴空塔: "スカイツリー", "Shibuya Sky": "渋谷スカイ", 台北: "台北", 台灣: "台湾", BR198: "BR198", "IC卡": "ICカード" },
  en: { 新宿: "Shinjuku", 京都: "Kyoto", 大阪: "Osaka", 橫濱: "Yokohama", 淺草寺: "Sensoji Temple", 晴空塔: "Tokyo Skytree", "Shibuya Sky": "Shibuya Sky", 台北: "Taipei", 台灣: "Taiwan", BR198: "BR198", "IC卡": "IC card" },
};
const PN_PHRASES = new Set(["T002", "T005", "T010", "T012", "T028", "T042", "T047", "T049"]);
const CONTROL_PHRASES = new Set(["T001", "T014", "T020", "T030", "T044"]); // 無專名,測誤傷

const items = [];
for (const runId of ["full-n3", "gpt-n1"]) {
  const runDir = path.join(root, "out/runs", runId);
  for (const f of fs.readdirSync(runDir).filter((x) => x.endsWith(".json") && !x.includes("error"))) {
    const r = JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8"));
    if (!r.outputTranscript) continue;
    const group = PN_PHRASES.has(r.phraseId) ? "pn" : CONTROL_PHRASES.has(r.phraseId) ? "control" : null;
    if (!group) continue;
    items.push({ key: `${runId}|${r.phraseId}-${r.dir}-${r.repeat}`, r, group });
  }
}
console.log(`items: ${items.length} (pn=${items.filter((i) => i.group === "pn").length}, control=${items.filter((i) => i.group === "control").length})`);

const outFile = path.join(root, "out/experiments/q2-glossary-repair.json");
const state = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : { repairs: {} };

const jobs = items.filter((it) => !state.repairs[it.key]?.verdict);
console.log(`jobs: ${jobs.length}`);
let done = 0;
await pmap(jobs, async (it) => {
  const gloss = Object.entries(GLOSSARY[it.r.dir]).map(([zh, t]) => `${zh}→${t}`).join("、");
  const fixed = (await orChat(REPAIRER,
    `旅客的行程術語表:${gloss}
下面是翻譯 app 的譯文。若譯文中的地名/專有名詞疑似辨識錯誤(與術語表相近但不同、或明顯不存在),依術語表修正;其他內容一字不動。若無需修改,原樣輸出。只輸出譯文。
譯文(${it.r.dir}):${it.r.outputTranscript}`,
    { maxTokens: 400 })).trim();
  const verdict = await orChat(JUDGE,
    `只輸出 JSON:{"noun_ok_before":bool,"noun_ok_after":bool,"damaged":bool}
中文原話:${it.r.zh}
修復前譯文:${it.r.outputTranscript}
修復後譯文:${fixed}
noun_ok_before/after:譯文中的專有名詞(地名/站名/航班)是否正確對應原話。damaged:修復是否弄壞了專名以外的內容。若原話沒有專名,兩者皆視為 true。`,
    { json: true, maxTokens: 200 });
  state.repairs[it.key] = { group: it.group, dir: it.r.dir, before: it.r.outputTranscript, after: fixed, verdict };
  if (++done % 30 === 0) { console.log(`${done}/${jobs.length}`); fs.writeFileSync(outFile, JSON.stringify(state, null, 1)); }
}, 8);

const rows = Object.values(state.repairs).filter((r) => r.verdict);
const pn = rows.filter((r) => r.group === "pn");
const broken = pn.filter((r) => !r.verdict.noun_ok_before);
const stats = {
  repairer: REPAIRER, judge: JUDGE,
  pn_items: pn.length, broken_before: broken.length,
  repaired_rate: broken.length ? +(broken.filter((r) => r.verdict.noun_ok_after).length / broken.length).toFixed(3) : null,
  damage_rate_all: rows.length ? +(rows.filter((r) => r.verdict.damaged).length / rows.length).toFixed(3) : null,
  control_damage_rate: +(rows.filter((r) => r.group === "control" && r.verdict.damaged).length / Math.max(1, rows.filter((r) => r.group === "control").length)).toFixed(3),
};
state.stats = stats;
fs.writeFileSync(outFile, JSON.stringify(state, null, 1));
console.log(JSON.stringify(stats, null, 2));
