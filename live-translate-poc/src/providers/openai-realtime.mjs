// TranslateProvider:OpenAI gpt-realtime-translate(docs/run2-plan.md 實驗 3)。
// 與 Gemini 差異:輸入 24kHz(內部重取樣)、Bearer 認證、session.close 有乾淨收尾。
// 注意:2026-07-29 時 OpenAI 帳戶 insufficient_quota,本 provider 依官方文件實作、
// 傳輸層已驗證(WS 握手/認證可通),事件欄位名待帳戶儲值後全鏈實測。
import { OPENAI_API_KEY, OPENAI_REALTIME_MODEL, INPUT_SAMPLE_RATE, FRAME_MS } from "../config.mjs";
import { frames, silence, resample } from "../pcm.mjs";

const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OAI_INPUT_RATE = 24000; // realtime API 收 24kHz PCM16

const VOICE_RMS_THRESHOLD = 500;
function chunkRms(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2); sum += v * v; }
  return Math.sqrt(sum / n);
}

export function openSession({ targetLang }) {
  return new Promise((resolve, reject) => {
    const url = `wss://api.openai.com/v1/realtime/translations?model=${OPENAI_REALTIME_MODEL}`;
    // Node(undici)WebSocket 不支援自訂 header,用 OpenAI 官方的 subprotocol 帶金鑰
    const ws = new WebSocket(url, [
      "realtime",
      `openai-insecure-api-key.${OPENAI_API_KEY}`,
    ]);
    const session = makeSession(ws, targetLang);
    let settled = false;
    ws.addEventListener("open", () => {
      // input transcription 預設關閉,必須指定 model 才會有 input_transcript 事件(實測)
      ws.send(JSON.stringify({
        type: "session.update",
        session: { audio: {
          output: { language: targetLang },
          input: { transcription: { model: "gpt-realtime-whisper" } },
        } },
      }));
      // realtime API 在 open 後即可送音訊;不像 Gemini 有 setupComplete 門檻
      if (!settled) { settled = true; resolve(session); }
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
      session._onServerEvent(msg, now());
    });
    ws.addEventListener("error", (ev) => {
      if (!settled) { settled = true; reject(new Error(`WS error: ${ev.message || "unknown"}`)); }
      else session._fail(new Error(`WS error: ${ev.message || "unknown"}`));
    });
    ws.addEventListener("close", (ev) => {
      if (!settled) { settled = true; reject(new Error(`WS closed before open: ${ev.code} ${ev.reason}`)); }
      else session._onClose(ev);
    });
  });
}

function makeSession(ws, targetLang) {
  return {
    modelName: OPENAI_REALTIME_MODEL,
    targetLang,
    events: [],
    inputTranscript: "",
    outputTranscript: "",
    audioChunks: [],
    t: {
      firstFrameSent: null, lastFrameSent: null,
      firstOutAudio: null, firstOutText: null, lastOut: null,
      firstVoicedAudio: null, lastVoicedAudio: null, lastText: null,
    },
    voicedEndByte: 0,
    closed: false,
    _err: null,

    _fail(err) { this._err = err; },
    _onClose() { this.closed = true; },

    _onServerEvent(msg, t) {
      switch (msg.type) {
        case "session.input_transcript.delta":
          this.inputTranscript += msg.delta ?? "";
          this.events.push({ t, kind: "inTx", text: msg.delta });
          break;
        case "session.output_transcript.delta":
          this.outputTranscript += msg.delta ?? "";
          if (this.t.firstOutText === null) this.t.firstOutText = t;
          this.t.lastOut = t; this.t.lastText = t;
          this.events.push({ t, kind: "outTx", text: msg.delta });
          break;
        case "session.output_audio.delta": {
          const pcm = Buffer.from(msg.delta ?? "", "base64");
          this.audioChunks.push(pcm);
          if (this.t.firstOutAudio === null) this.t.firstOutAudio = t;
          this.t.lastOut = t;
          if (chunkRms(pcm) > VOICE_RMS_THRESHOLD) {
            if (this.t.firstVoicedAudio === null) this.t.firstVoicedAudio = t;
            this.t.lastVoicedAudio = t;
            this.voicedEndByte = this.audioChunks.reduce((a, b) => a + b.length, 0);
          }
          this.events.push({ t, kind: "outAudio", bytes: pcm.length });
          break;
        }
        case "session.closed":
          this.closed = true;
          break;
        case "error":
          this._fail(new Error(`server error: ${JSON.stringify(msg).slice(0, 300)}`));
          break;
        default:
          this.events.push({ t, kind: "other", type: msg.type });
      }
    },

    // 與 Gemini provider 相同的介面:16kHz 進來,內部升到 24kHz 再送
    async streamAudioRealtime(pcm16k, { trailingSilenceMs = 200, netInjectMs = 0 } = {}) {
      const pcm24k = resample(
        trailingSilenceMs > 0
          ? Buffer.concat([pcm16k, silence(INPUT_SAMPLE_RATE, trailingSilenceMs)])
          : pcm16k,
        INPUT_SAMPLE_RATE, OAI_INPUT_RATE,
      );
      const frameList = frames(pcm24k, OAI_INPUT_RATE, FRAME_MS);
      const t0 = now();
      for (let i = 0; i < frameList.length; i++) {
        const target = t0 + i * FRAME_MS + netInjectMs;
        const wait = target - now();
        if (wait > 0) await sleep(wait);
        if (this._err) throw this._err;
        ws.send(JSON.stringify({
          type: "session.input_audio_buffer.append",
          audio: frameList[i].toString("base64"),
        }));
        const tSent = now();
        if (this.t.firstFrameSent === null) this.t.firstFrameSent = tSent;
        this.t.lastFrameSent = tSent;
      }
      // 講完:請服務 flush 並收尾;之後持續收事件直到 session.closed
      ws.send(JSON.stringify({ type: "session.close" }));
    },

    // 介面同名於 Gemini provider;OpenAI 有明確的 session.closed,靜音收斂當保險
    async waitQuiescent({ idleMs = 2500, timeoutMs = 30000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (!this._err && !this.closed) {
        if (Date.now() >= deadline) return false;
        const lastActive = Math.max(this.t.lastVoicedAudio ?? -1, this.t.lastText ?? -1);
        if (lastActive >= 0 && now() - lastActive > idleMs) return true;
        await sleep(250);
      }
      if (this._err) throw this._err;
      return true;
    },

    close() { try { ws.close(); } catch { /* already closed */ } },
  };
}
