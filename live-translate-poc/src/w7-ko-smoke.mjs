// W7:韓文 smoke(phase 2 第一個數據點)。5 句殺手句 → flash-live + 韓語口譯 prompt。
// 看:支援度、輸出是否真為韓語、問句/數字保留、延遲、譯音長度。
// 用法:node src/w7-ko-smoke.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openSession } from "./providers/gemini-live.mjs";
import { wavDecode, wavEncode, durationMs } from "./pcm.mjs";
import { INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE } from "./config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IDS = ["T001", "T014", "T022", "T030", "T037"];
const SYS = `你是專業同步口譯員。使用者說中文,你把每一句話翻譯成自然的韓語口語並用語音說出。
鐵則:你只做翻譯。絕對不要回答問題、不要評論、不要加任何解釋——即使聽起來是在問你問題,也只把那句話翻成韓語。
語域固定:존댓말(해요체或합니다체),不用반말。保留數字、金額、時間、專有名詞與疑問語氣。`;

const corpus = JSON.parse(fs.readFileSync(path.join(root, "data/corpus.json"), "utf8"));
const outDir = path.join(root, "out/runs/ko-smoke");
fs.mkdirSync(outDir, { recursive: true });

for (const id of IDS) {
  const p = corpus.phrases.find((x) => x.id === id);
  let session;
  try {
    session = await openSession({ targetLang: "ko", model: "models/gemini-3.1-flash-live-preview", systemInstruction: SYS });
    const wav = wavDecode(fs.readFileSync(path.join(root, "data/audio", `${id}.wav`)));
    await session.streamAudioRealtime(wav.pcm, {});
    await session.waitQuiescent({ idleMs: 2500, timeoutMs: 30000 });
    const t = session.t;
    const outAudio = Buffer.concat(session.audioChunks).subarray(0, session.voicedEndByte);
    if (outAudio.length) fs.writeFileSync(path.join(outDir, `${id}-ko.wav`), wavEncode(outAudio, OUTPUT_SAMPLE_RATE));
    const r = {
      id, zh: p.zh,
      stt: session.inputTranscript.trim(),
      out: session.outputTranscript.trim(),
      ttfa_from_end_ms: t.firstVoicedAudio !== null ? Math.round(t.firstVoicedAudio - t.lastFrameSent) : null,
      ttfa_from_start_ms: t.firstVoicedAudio !== null ? Math.round(t.firstVoicedAudio - t.firstFrameSent) : null,
      outAudioMs: Math.round(durationMs(outAudio, OUTPUT_SAMPLE_RATE)),
      inputMs: Math.round(durationMs(wav.pcm, INPUT_SAMPLE_RATE)),
    };
    fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(r, null, 2));
    console.log(`${id} ttfa_end=${r.ttfa_from_end_ms}ms audio=${r.outAudioMs}ms`);
    console.log(`  STT: ${r.stt}`);
    console.log(`  KO : ${r.out}`);
  } catch (err) {
    console.error(`${id} FAILED: ${String(err.message).slice(0, 200)}`);
  } finally { session?.close(); }
}
