// W5:M4 真機 dogfood 劇本。8 個多輪情境(check-in/議價/急難…),
// 含每輪的中文台詞、預期譯意、檢核點。產出 docs/m4-scripts.md。
// 用法:node src/w5-m4-scripts.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orChat } from "./or.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCENARIOS = [
  "飯店 check-in(含訂房糾紛:訂了兩晚被記成一晚)", "拉麵店點餐(過敏+客製+分開結帳)",
  "電器行議價(折扣百分比+退稅+比價)", "車站問路+買票(轉乘+末班車時間)",
  "藥局買藥(症狀描述+過敏史)", "遺失物報案(物品描述+時間地點)",
  "餐廳改約(改時間不取消+人數變更)", "計程車溝通(目的地+趕時間+車資確認)",
];

let md = `# M4 真機 dogfood 劇本(W5 生成,2026-07-29)

用法:兩人一組(一人扮旅客講中文、一人扮日方看譯文/聽譯音),照台詞走,
每輪記錄:逐字稿對不對、譯文對不對、回譯有沒有讓你抓到錯、體感延遲(碼表)。
檢核點 = 該輪的「埋雷」,對應 harness 的錯誤型態。

`;
for (const sc of SCENARIOS) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const v = await orChat("anthropic/claude-sonnet-5",
        `寫一個旅行即時翻譯 app 的真機測試劇本:「${sc}」。
5-7 輪對話。只輸出 JSON:
{"title":"...","turns":[{"speaker":"旅客|店員","zh":"台詞(旅客用台灣中文;店員台詞也寫中文供扮演者理解,實際用日語說)","expect":"這輪譯文必須傳達的關鍵語意","trap":"這輪埋的雷(同音字/數字/專名/問尾/無)"}]}`,
        { json: true, maxTokens: 3000, timeoutMs: 180000 });
      md += `## ${v.title}\n\n| # | 說話者 | 台詞 | 必須傳達 | 埋雷 |\n|---|---|---|---|---|\n`;
      v.turns.forEach((t, i) => { md += `| ${i + 1} | ${t.speaker} | ${t.zh} | ${t.expect} | ${t.trap} |\n`; });
      md += "\n";
      console.log(`${sc}: ${v.turns.length} turns`);
      break;
    } catch (err) { console.error(`${sc} attempt ${attempt}: ${String(err.message).slice(0, 100)}`); }
  }
}
fs.writeFileSync(path.join(root, "docs/m4-scripts.md"), md);
console.log("→ docs/m4-scripts.md");
