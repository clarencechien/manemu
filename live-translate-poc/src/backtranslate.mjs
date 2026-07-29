// 實驗 1:回譯確認通道(docs/run2-plan.md)。
// 用法:node src/backtranslate.mjs <runId> [--dir ja]
// 對每筆 zh→ja 結果:outputTranscript 回譯繁中(量延遲)→ 語意等價評分 →
// 分組統計(災難組偵測率 vs 正常組誤報率)→ out/experiments/backtranslate-<runId>.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_KEY, REST_BASE } from "./config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = process.argv[2];
if (!runId) { console.error("usage: node src/backtranslate.mjs <runId> [--dir ja]"); process.exit(1); }
const dir = process.argv.includes("--dir") ? process.argv[process.argv.indexOf("--dir") + 1] : "ja";
const MODEL = "models/gemini-3.5-flash"; // 回譯要便宜快速,UI 上就會用這級

async function flashCall(prompt, schema) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0 },
  };
  if (schema) {
    body.generationConfig.responseMimeType = "application/json";
    body.generationConfig.responseJsonSchema = schema;
  }
  const res = await fetch(`${REST_BASE}/${MODEL}:generateContent`, {
    method: "POST",
    signal: AbortSignal.timeout(60000),
    headers: { "content-type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 150)}`);
  const d = await res.json();
  return d.candidates[0].content.parts[0].text;
}

const EQ_SCHEMA = {
  type: "object",
  properties: {
    equivalence: { type: "integer" },      // 1-5:回譯與原話語意等價程度
    user_would_notice: { type: "boolean" }, // 一般使用者讀回譯會察覺意思跑掉
    diff: { type: "string" },
  },
  required: ["equivalence", "user_would_notice", "diff"],
};

const runDir = path.join(root, "out/runs", runId);
const results = fs.readdirSync(runDir)
  .filter((f) => f.endsWith(".json") && !f.includes("error"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8")))
  .filter((r) => r.dir === dir && r.outputTranscript);
console.log(`backtranslating ${results.length} ${dir} outputs`);

const items = [];
let idx = 0;
async function worker() {
  while (idx < results.length) {
    const r = results[idx++];
    try {
      const t0 = performance.now();
      const bt = (await flashCall(
        `把下面這句${dir === "ja" ? "日文" : "英文"}翻譯成台灣繁體中文口語。只輸出譯文,不要任何說明。\n\n${r.outputTranscript}`,
      )).trim();
      const latencyMs = Math.round(performance.now() - t0);
      const eq = JSON.parse(await flashCall(
        `使用者原話(中文):${r.zh}\nApp 回譯確認文字(由譯文回譯):${bt}\n` +
        `評估:一般使用者讀「回譯確認文字」時,與自己剛說的原話相比,語意等價程度(equivalence 1-5,5=完全等價)、` +
        `會不會察覺意思跑掉(user_would_notice)、一句話說明差異(diff,無差異寫「無」)。只輸出 JSON。`,
        EQ_SCHEMA,
      ));
      items.push({
        phraseId: r.phraseId, repeat: r.repeat, zh: r.zh,
        output: r.outputTranscript, backtranslation: bt, latencyMs,
        equivalence: eq.equivalence, userWouldNotice: eq.user_would_notice, diff: eq.diff,
        judgeAdequacy: r.judge?.adequacy ?? null,
      });
      if (items.length % 25 === 0) console.log(`${items.length}/${results.length}`);
    } catch (err) {
      console.error(`${r.phraseId}-${r.repeat}: ${String(err.message).slice(0, 120)}`);
    }
  }
}
await Promise.all(Array.from({ length: 3 }, worker));

// 統計
const pct = (arr, p) => {
  const v = [...arr].sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))] : null;
};
const disaster = items.filter((i) => i.judgeAdequacy !== null && i.judgeAdequacy <= 2);
const good = items.filter((i) => i.judgeAdequacy !== null && i.judgeAdequacy >= 4);
const detected = disaster.filter((i) => i.userWouldNotice);
const falseAlarm = good.filter((i) => i.userWouldNotice);
const lat = items.map((i) => i.latencyMs);
const summary = {
  runId, dir, model: MODEL, n: items.length,
  latency_ms: { p50: pct(lat, 50), p90: pct(lat, 90), mean: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) },
  disaster_group: { n: disaster.length, detected: detected.length,
    detection_rate: disaster.length ? +(detected.length / disaster.length).toFixed(3) : null },
  good_group: { n: good.length, false_alarms: falseAlarm.length,
    false_alarm_rate: good.length ? +(falseAlarm.length / good.length).toFixed(3) : null },
  missed: disaster.filter((i) => !i.userWouldNotice).map((i) => ({ phraseId: i.phraseId, repeat: i.repeat, bt: i.backtranslation, diff: i.diff })),
  false_alarm_examples: falseAlarm.slice(0, 10).map((i) => ({ phraseId: i.phraseId, bt: i.backtranslation, diff: i.diff })),
};
const outDir = path.join(root, "out/experiments");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `backtranslate-${runId}-${dir}.json`), JSON.stringify({ summary, items }, null, 2));
console.log(JSON.stringify(summary, null, 2));
