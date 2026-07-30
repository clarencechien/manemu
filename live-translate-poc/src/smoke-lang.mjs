// 語言 smoke:5 句殺手句 → flash-live + 該語言口譯 prompt。用法:node src/smoke-lang.mjs <lang>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openSession } from "./providers/gemini-live.mjs";
import { wavDecode, wavEncode, durationMs } from "./pcm.mjs";
import { OUTPUT_SAMPLE_RATE } from "./config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lang = process.argv[2];
const SYS = {
  vi: `你是專業同步口譯員。使用者說中文,你把每一句話翻譯成自然的越南語口語並用語音說出。
鐵則:你只做翻譯,不回答不評論。語域固定:禮貌體(適度 dạ/ạ)。保留數字、專名、疑問語氣。`,
  th: `你是專業同步口譯員。使用者說中文,你把每一句話翻譯成自然的泰語口語並用語音說出。
鐵則:你只做翻譯,不回答不評論。語域固定:禮貌體(句尾 ครับ/ค่ะ 一致)。保留數字、專名、疑問語氣。`,
}[lang];
if (!SYS) { console.error("usage: node src/smoke-lang.mjs <vi|th>"); process.exit(1); }

const IDS = ["T001", "T014", "T022", "T030", "T037"];
const corpus = JSON.parse(fs.readFileSync(path.join(root, "data/corpus.json"), "utf8"));
const outDir = path.join(root, `out/runs/${lang}-smoke`);
fs.mkdirSync(outDir, { recursive: true });

for (const id of IDS) {
  const p = corpus.phrases.find((x) => x.id === id);
  let session;
  try {
    session = await openSession({ targetLang: lang, model: "models/gemini-3.1-flash-live-preview", systemInstruction: SYS });
    const wav = wavDecode(fs.readFileSync(path.join(root, "data/audio", `${id}.wav`)));
    await session.streamAudioRealtime(wav.pcm, {});
    await session.waitQuiescent({ idleMs: 2500, timeoutMs: 30000 });
    const t = session.t;
    const outAudio = Buffer.concat(session.audioChunks).subarray(0, session.voicedEndByte);
    if (outAudio.length) fs.writeFileSync(path.join(outDir, `${id}-${lang}.wav`), wavEncode(outAudio, OUTPUT_SAMPLE_RATE));
    console.log(`${id} ttfa_end=${t.firstVoicedAudio !== null ? Math.round(t.firstVoicedAudio - t.lastFrameSent) : "?"}ms audio=${Math.round(durationMs(outAudio, OUTPUT_SAMPLE_RATE))}ms`);
    console.log(`  STT: ${session.inputTranscript.trim()}`);
    console.log(`  ${lang.toUpperCase()} : ${session.outputTranscript.trim()}`);
  } catch (err) {
    console.error(`${id} FAILED: ${String(err.message).slice(0, 150)}`);
  } finally { session?.close(); }
}
