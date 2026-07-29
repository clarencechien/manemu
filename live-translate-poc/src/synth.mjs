// Phase A:用 Gemini TTS 把 50 句中文合成 16kHz PCM WAV,存 data/audio/。
// 語料不變就不用重跑;音檔進 git,保證每次評測輸入完全一致(可重現)。
// 用法:node src/synth.mjs [--only T001,T002] [--force]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_KEY, TTS_MODEL, REST_BASE, INPUT_SAMPLE_RATE } from "./config.mjs";
import { wavEncode, resample, durationMs } from "./pcm.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(fs.readFileSync(path.join(root, "data/corpus.json"), "utf8"));
const audioDir = path.join(root, "data/audio");
fs.mkdirSync(audioDir, { recursive: true });

const args = process.argv.slice(2);
const only = args.includes("--only")
  ? new Set(args[args.indexOf("--only") + 1].split(",")) : null;
const force = args.includes("--force");

// 固定 voice + 低變異,讓合成可重現、口音一致。
const VOICE = "Kore";

async function synthOne(phrase) {
  // TTS preview 偶發掛住不回應(3.1 必掛、2.5 偶發),一定要設 timeout 讓重試接手
  const res = await fetch(`${REST_BASE}/${TTS_MODEL}:generateContent`, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: { "content-type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: phrase.zh }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        temperature: 0.2,
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`TTS ${phrase.id}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error(`TTS ${phrase.id}: no audio in response`);
  const mime = part.inlineData.mimeType || "";
  const rateMatch = mime.match(/rate=(\d+)/);
  const srcRate = rateMatch ? Number(rateMatch[1]) : 24000;
  const pcm = resample(Buffer.from(part.inlineData.data, "base64"), srcRate, INPUT_SAMPLE_RATE);
  return { pcm, srcMime: mime };
}

const manifest = {};
for (const phrase of corpus.phrases) {
  if (only && !only.has(phrase.id)) continue;
  const file = path.join(audioDir, `${phrase.id}.wav`);
  if (!force && fs.existsSync(file)) {
    const st = fs.statSync(file);
    manifest[phrase.id] = { file: `data/audio/${phrase.id}.wav`, bytes: st.size, skipped: true };
    continue;
  }
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { pcm, srcMime } = await synthOne(phrase);
      fs.writeFileSync(file, wavEncode(pcm, INPUT_SAMPLE_RATE));
      manifest[phrase.id] = {
        file: `data/audio/${phrase.id}.wav`,
        durationMs: Math.round(durationMs(pcm, INPUT_SAMPLE_RATE)),
        srcMime, voice: VOICE,
      };
      console.log(`${phrase.id} ok ${manifest[phrase.id].durationMs}ms`);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      console.error(`${phrase.id} attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  if (lastErr) throw lastErr;
}
fs.writeFileSync(path.join(audioDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("done:", Object.keys(manifest).length, "files");
