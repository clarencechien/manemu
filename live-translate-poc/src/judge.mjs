// §3b LLM 評審:adequacy/fluency/flags/理由。用法:node src/judge.mjs <runId>
// 注意:預設評審應為異家模型(OpenAI)降低自評偏誤;此環境僅有 Gemini 金鑰,
// 以 Gemini 文字模型代打(與翻譯模型不同),報告會標註此假設。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_KEY, JUDGE_MODEL, REST_BASE } from "./config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = process.argv[2];
if (!runId) { console.error("usage: node src/judge.mjs <runId>"); process.exit(1); }
const runDir = path.join(root, "out/runs", runId);

const SCHEMA = {
  type: "object",
  properties: {
    adequacy: { type: "integer" }, fluency: { type: "integer" },
    flags: {
      type: "object",
      properties: {
        number_wrong: { type: "boolean" }, negation_flipped: { type: "boolean" },
        honorific_off: { type: "boolean" }, name_mangled: { type: "boolean" },
        omission: { type: "boolean" }, hallucination: { type: "boolean" },
      },
      required: ["number_wrong", "negation_flipped", "honorific_off", "name_mangled", "omission", "hallucination"],
    },
    reason: { type: "string" },
  },
  required: ["adequacy", "fluency", "flags", "reason"],
};

async function judgeOne(r) {
  const prompt = `你是專業口譯評審。以下為中文原文、機器口譯譯文(語音翻譯的逐字稿)、參考譯文。
評 adequacy(語意忠實 1-5)與 fluency(目標語自然度 1-5),並標記錯誤旗標。
若譯文為空或幾乎沒翻,adequacy=1 且 omission=true。
原文(zh): ${r.zh}
機器譯文(→${r.dir}): ${r.outputTranscript || "(空)"}
參考譯文: ${r.reference}`;
  const res = await fetch(`${REST_BASE}/${JUDGE_MODEL}:generateContent`, {
    method: "POST",
    signal: AbortSignal.timeout(60000),
    headers: { "content-type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseJsonSchema: SCHEMA,
      },
    }),
  });
  if (!res.ok) throw new Error(`judge HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return JSON.parse(data.candidates[0].content.parts[0].text);
}

const files = fs.readdirSync(runDir).filter((f) => f.endsWith(".json") && !f.includes("error"));
let n = 0, idx = 0;
async function worker() {
  while (idx < files.length) {
    const f = files[idx++];
    const r = JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8"));
    if (r.judge) { n++; continue; } // 已評過(可續跑)
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        r.judge = await judgeOne(r);
        r.judgeModel = JUDGE_MODEL;
        fs.writeFileSync(path.join(runDir, f), JSON.stringify(r, null, 2));
        ok = true; n++;
        console.log(`${f} adequacy=${r.judge.adequacy} fluency=${r.judge.fluency}${Object.entries(r.judge.flags).filter(([, v]) => v).map(([k]) => " " + k).join("")}`);
      } catch (err) {
        console.error(`${f} attempt ${attempt}: ${String(err.message).slice(0, 150)}`);
        // pro-preview 每分鐘配額低,429 要等久一點
        const backoff = String(err.message).includes("429") ? 20000 : 2000 * attempt;
        await new Promise((res2) => setTimeout(res2, backoff));
      }
    }
  }
}
await Promise.all(Array.from({ length: 2 }, worker));
console.log(`judged ${n}/${files.length}`);
