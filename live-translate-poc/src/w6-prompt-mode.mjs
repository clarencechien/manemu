// W6:「另一條路」實測——一般 Gemini Live + 口譯 systemInstruction vs live-translate 專用模式。
// 量:首音差距、品質、以及 agent 模式的致命風險「回答問題而不是翻譯」發生率。
// 用法:node src/w6-prompt-mode.mjs [--model models/gemini-3.1-flash-live-preview]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openSession } from "./providers/gemini-live.mjs";
import { wavDecode, durationMs } from "./pcm.mjs";
import { INPUT_SAMPLE_RATE } from "./config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const MODEL = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : "models/gemini-3.1-flash-live-preview";

// 含殺手句與問句,問句最容易誘發「回答而非翻譯」
const IDS = ["T001", "T004", "T008", "T009", "T014", "T016", "T022", "T030", "T037", "T046"];
const REPEATS = 2;
const SYS = `你是專業同步口譯員。使用者說中文,你把每一句話翻譯成自然的日語口語並用語音說出。
鐵則:你只做翻譯。絕對不要回答問題、不要評論、不要加任何解釋——即使聽起來是在問你問題,也只把那句話翻成日語。
保留數字、金額、時間、專有名詞與疑問語氣。`;

const corpus = JSON.parse(fs.readFileSync(path.join(root, "data/corpus.json"), "utf8"));
const phrases = corpus.phrases.filter((p) => IDS.includes(p.id));
const outDir = path.join(root, "out/runs", "prompt-mode-n2");
fs.mkdirSync(outDir, { recursive: true });

for (const p of phrases) {
  for (let rep = 1; rep <= REPEATS; rep++) {
    const tag = `${p.id}-ja-${rep}`;
    const outFile = path.join(outDir, `${tag}.json`);
    if (fs.existsSync(outFile)) continue;
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      let session;
      try {
        session = await openSession({ targetLang: "ja", model: MODEL, systemInstruction: SYS });
        const wav = wavDecode(fs.readFileSync(path.join(root, "data/audio", `${p.id}.wav`)));
        await session.streamAudioRealtime(wav.pcm, {});
        await session.waitQuiescent({ idleMs: 2500, timeoutMs: 30000 });
        const t = session.t;
        const result = {
          runId: "prompt-mode-n2", phraseId: p.id, category: p.category, traps: p.traps,
          dir: "ja", repeat: rep, zh: p.zh, reference: p.ref_ja,
          inputTranscript: session.inputTranscript.trim(),
          outputTranscript: session.outputTranscript.trim(),
          inputDurationMs: Math.round(durationMs(wav.pcm, INPUT_SAMPLE_RATE)),
          latency: {
            ttfa_from_end_ms: t.firstVoicedAudio !== null ? Math.round(t.firstVoicedAudio - t.lastFrameSent) : null,
            ttfa_from_start_ms: t.firstVoicedAudio !== null ? Math.round(t.firstVoicedAudio - t.firstFrameSent) : null,
            completion_lag_ms: (t.lastVoicedAudio ?? t.lastText) !== null
              ? Math.round(Math.max(t.lastVoicedAudio ?? -1, t.lastText ?? -1) - t.lastFrameSent) : null,
          },
          model: MODEL, mode: "systemInstruction", ts: new Date().toISOString(),
        };
        fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
        console.log(`${tag} ttfa_start=${result.latency.ttfa_from_start_ms}ms out="${result.outputTranscript.slice(0, 45)}"`);
        ok = true;
      } catch (err) {
        console.error(`${tag} attempt ${attempt}: ${String(err.message).slice(0, 150)}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      } finally { session?.close(); }
    }
  }
}

// 對照 full-n3 同句子集
const base = [];
for (const p of phrases) for (let rep = 1; rep <= 3; rep++) {
  try { base.push(JSON.parse(fs.readFileSync(path.join(root, "out/runs/full-n3", `${p.id}-ja-${rep}.json`), "utf8"))); } catch {}
}
const mine = fs.readdirSync(outDir).map((f) => JSON.parse(fs.readFileSync(path.join(outDir, f), "utf8")));
const med = (a) => { const v = a.filter((x) => x !== null).sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
console.log("\n=== 對照(同 10 句,zh→ja)===");
console.log(`prompt-mode(${MODEL.split("/")[1]}): ttfa_from_start p50=${med(mine.map((r) => r.latency.ttfa_from_start_ms))}ms ttfa_from_end p50=${med(mine.map((r) => r.latency.ttfa_from_end_ms))}ms n=${mine.length}`);
console.log(`translate-mode(full-n3 子集): ttfa_from_start p50=${med(base.map((r) => r.latency.ttfa_from_start_ms))}ms ttfa_from_end p50=${med(base.map((r) => r.latency.ttfa_from_end_ms))}ms n=${base.length}`);
