// Phase B 評測 runner:取音檔 → Live WS 即時送框 → 打點/逐字稿 → 規則檢測 → 寫單筆 JSON。
// 用法:node src/run.mjs [--dirs ja,en] [--repeats 3] [--only T001,...] [--limit 5]
//        [--concurrency 3] [--net-inject 0] [--run-id my-run] [--save-audio]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openSession } from "./providers/gemini-live.mjs";
import { runRules } from "./rules.mjs";
import { wavDecode, wavEncode, durationMs } from "./pcm.mjs";
import { OUTPUT_SAMPLE_RATE, INPUT_SAMPLE_RATE, TRANSLATE_MODEL } from "./config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(fs.readFileSync(path.join(root, "data/corpus.json"), "utf8"));

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const dirs = opt("dirs", "ja,en").split(",");
const repeats = Number(opt("repeats", "1"));
const only = args.includes("--only") ? new Set(opt("only").split(",")) : null;
const limit = Number(opt("limit", "0"));
const concurrency = Number(opt("concurrency", "3"));
const netInjectMs = Number(opt("net-inject", "0"));
const saveAudio = args.includes("--save-audio");
const runId = opt("run-id", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 17) + Math.random().toString(36).slice(2, 6));

let phrases = corpus.phrases.filter((p) => !only || only.has(p.id));
if (limit > 0) phrases = phrases.slice(0, limit);

const runDir = path.join(root, "out/runs", runId);
fs.mkdirSync(runDir, { recursive: true });

const jobs = [];
for (const phrase of phrases) {
  for (const dir of dirs) {
    for (let rep = 1; rep <= repeats; rep++) jobs.push({ phrase, dir, rep });
  }
}
console.log(`runId=${runId} jobs=${jobs.length} (phrases=${phrases.length} dirs=${dirs} repeats=${repeats} netInject=${netInjectMs}ms)`);

async function runOne({ phrase, dir, rep }) {
  const wav = wavDecode(fs.readFileSync(path.join(root, "data/audio", `${phrase.id}.wav`)));
  if (wav.sampleRate !== INPUT_SAMPLE_RATE) throw new Error(`${phrase.id}: unexpected sample rate ${wav.sampleRate}`);
  const inputDurMs = durationMs(wav.pcm, INPUT_SAMPLE_RATE);

  const session = await openSession({ targetLang: dir });
  try {
    await session.streamAudioRealtime(wav.pcm, { netInjectMs });
    const completed = await session.waitQuiescent({ idleMs: 2500, timeoutMs: 30000 });
    const t = session.t;
    // 裁掉尾端串流靜音,只留到最後有聲 chunk
    const outAudio = Buffer.concat(session.audioChunks).subarray(0, session.voicedEndByte);
    const outAudioDurMs = durationMs(outAudio, OUTPUT_SAMPLE_RATE);
    if (saveAudio && outAudio.length) {
      fs.writeFileSync(path.join(runDir, `${phrase.id}-${dir}-${rep}.wav`), wavEncode(outAudio, OUTPUT_SAMPLE_RATE));
    }
    const result = {
      runId, phraseId: phrase.id, category: phrase.category, traps: phrase.traps,
      dir, repeat: rep,
      zh: phrase.zh, reference: dir === "ja" ? phrase.ref_ja : phrase.ref_en,
      inputTranscript: session.inputTranscript.trim(),
      outputTranscript: session.outputTranscript.trim(),
      inputDurationMs: Math.round(inputDurMs),
      outputAudioMs: Math.round(outAudioDurMs),
      turnCompleted: completed,
      latency: {
        // §4.2:以「講完那一刻」(最後一框送出)為基準。
        // ttfa 用第一個「有聲」chunk(模型會先串流靜音框,首個 chunk ≠ 首音)。
        ttfa_from_end_ms: t.firstVoicedAudio !== null && t.lastFrameSent !== null
          ? Math.round(t.firstVoicedAudio - t.lastFrameSent) : null,
        ttft_from_end_ms: t.firstOutText !== null && t.lastFrameSent !== null
          ? Math.round(t.firstOutText - t.lastFrameSent) : null,
        // 譯音最後有聲 chunk 到達為止(≈ 對方聽完的下界)
        completion_lag_ms: (t.lastVoicedAudio ?? t.lastText) !== null && t.lastFrameSent !== null
          ? Math.round(Math.max(t.lastVoicedAudio ?? -1, t.lastText ?? -1) - t.lastFrameSent) : null,
        ttfa_from_start_ms: t.firstVoicedAudio !== null && t.firstFrameSent !== null
          ? Math.round(t.firstVoicedAudio - t.firstFrameSent) : null,
      },
      rules: runRules(phrase, dir, session.inputTranscript, session.outputTranscript),
      netInject_ms: netInjectMs, model: TRANSLATE_MODEL,
      runtime: "cc-web-node", ts: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(runDir, `${phrase.id}-${dir}-${rep}.json`), JSON.stringify(result, null, 2));
    return result;
  } finally {
    session.close();
  }
}

let idx = 0, done = 0, failed = 0;
async function worker(wid) {
  while (idx < jobs.length) {
    const job = jobs[idx++];
    const tag = `${job.phrase.id}-${job.dir}-${job.rep}`;
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const r = await runOne(job);
        ok = true;
        done++;
        console.log(`[w${wid}] ${tag} ok ttfa_end=${r.latency.ttfa_from_end_ms}ms out="${r.outputTranscript.slice(0, 40)}" (${done + failed}/${jobs.length})`);
      } catch (err) {
        console.error(`[w${wid}] ${tag} attempt ${attempt}: ${String(err.message).slice(0, 200)}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    if (!ok) {
      failed++;
      fs.writeFileSync(path.join(runDir, `${tag}.error.json`),
        JSON.stringify({ runId, tag, error: "failed after 3 attempts" }, null, 2));
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, (_, i) => worker(i + 1)));
console.log(`run complete: ok=${done} failed=${failed} → out/runs/${runId}/`);
