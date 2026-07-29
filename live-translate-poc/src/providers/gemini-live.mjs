// TranslateProvider:唯一碰 Gemini Live WS 的地方(附錄 A 介面)。
// 之後要搬 Cloudflare Worker 或並測 OpenAI,只換這一層。
import {
  API_KEY, TRANSLATE_MODEL, LIVE_WS_URL, INPUT_SAMPLE_RATE, FRAME_MS,
} from "../config.mjs";
import { frames, silence } from "../pcm.mjs";

const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 24kHz PCM16 chunk 的 RMS;>500 視為有聲(實測靜音框 RMS≈0,語音框數千)。
const VOICE_RMS_THRESHOLD = 500;
function chunkRms(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2); sum += v * v; }
  return Math.sqrt(sum / n);
}

async function messageToJson(data) {
  if (typeof data === "string") return JSON.parse(data);
  if (data instanceof Blob) return JSON.parse(await data.text());
  return JSON.parse(Buffer.from(data).toString("utf8"));
}

export function openSession({ targetLang }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${LIVE_WS_URL}?key=${API_KEY}`);
    const session = makeSession(ws);
    let settled = false;
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        // 注意:inputAudioTranscription/outputAudioTranscription 在 setup 層,
        // 不在 generationConfig 內(實測 2026-07-29;放錯會被 1007 拒絕)。
        setup: {
          model: TRANSLATE_MODEL,
          generationConfig: {
            responseModalities: ["AUDIO"],
            translationConfig: {
              targetLanguageCode: targetLang,
              echoTargetLanguage: false,
            },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      }));
    });
    ws.addEventListener("message", async (ev) => {
      const msg = await messageToJson(ev.data);
      if (msg.setupComplete && !settled) { settled = true; resolve(session); return; }
      session._onServerMessage(msg, now());
    });
    ws.addEventListener("error", (ev) => {
      if (!settled) { settled = true; reject(new Error(`WS error: ${ev.message || "unknown"}`)); }
      else session._fail(new Error(`WS error: ${ev.message || "unknown"}`));
    });
    ws.addEventListener("close", (ev) => {
      if (!settled) { settled = true; reject(new Error(`WS closed before setup: ${ev.code} ${ev.reason}`)); }
      else session._onClose(ev);
    });
  });
}

function makeSession(ws) {
  const s = {
    events: [],            // {t, kind, ...} 全事件時間軸(除錯用)
    inputTranscript: "",
    outputTranscript: "",
    audioChunks: [],       // 譯音 24kHz PCM buffers
    t: {                   // §4.2 打點
      firstFrameSent: null, lastFrameSent: null,
      firstOutAudio: null, firstOutText: null, lastOut: null,
      // live-translate 是連續 session:譯完後仍會一直串流「靜音」音框,
      // turnComplete 不會來(smoke 實測 3.2s 輸入 → 45s 音訊,4.2s 後全靜音)。
      // 所以「播完」要用最後一個「有聲」chunk 的到達時間。
      firstVoicedAudio: null, lastVoicedAudio: null, lastText: null,
    },
    voicedEndByte: 0,      // 最後有聲 chunk 結尾的 byte offset(存檔裁靜音用)
    turnComplete: false,
    generationComplete: false,
    _err: null,
    _closed: false,
    _waiters: [],

    _fail(err) { this._err = err; this._notify(); },
    _onClose() { this._closed = true; this._notify(); },
    _notify() { for (const w of this._waiters.splice(0)) w(); },

    _onServerMessage(msg, t) {
      const sc = msg.serverContent;
      if (!sc) return;
      if (sc.inputTranscription?.text) {
        this.inputTranscript += sc.inputTranscription.text;
        this.events.push({ t, kind: "inTx", text: sc.inputTranscription.text });
      }
      if (sc.outputTranscription?.text) {
        this.outputTranscript += sc.outputTranscription.text;
        if (this.t.firstOutText === null) this.t.firstOutText = t;
        this.t.lastOut = t;
        this.t.lastText = t;
        this.events.push({ t, kind: "outTx", text: sc.outputTranscription.text });
      }
      for (const part of sc.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          const pcm = Buffer.from(part.inlineData.data, "base64");
          this.audioChunks.push(pcm);
          if (this.t.firstOutAudio === null) this.t.firstOutAudio = t;
          this.t.lastOut = t;
          if (chunkRms(pcm) > VOICE_RMS_THRESHOLD) {
            if (this.t.firstVoicedAudio === null) this.t.firstVoicedAudio = t;
            this.t.lastVoicedAudio = t;
            this.voicedEndByte = this.audioChunks.reduce((a, b) => a + b.length, 0);
          }
          this.events.push({ t, kind: "outAudio", bytes: pcm.length });
        }
      }
      if (sc.generationComplete) this.generationComplete = true;
      if (sc.turnComplete) { this.turnComplete = true; this._notify(); }
    },

    // 即時節奏送框:每 100ms 一框,嚴禁 burst(§4.3-1)。
    // netInjectMs 在送端加固定延遲,模擬行動網路上行(§4.3-4)。
    async streamAudioRealtime(pcm16k, { trailingSilenceMs = 200, netInjectMs = 0 } = {}) {
      const payload = trailingSilenceMs > 0
        ? Buffer.concat([pcm16k, silence(INPUT_SAMPLE_RATE, trailingSilenceMs)])
        : pcm16k;
      const frameList = frames(payload, INPUT_SAMPLE_RATE, FRAME_MS);
      const t0 = now();
      for (let i = 0; i < frameList.length; i++) {
        const target = t0 + i * FRAME_MS + netInjectMs;
        const wait = target - now();
        if (wait > 0) await sleep(wait);
        if (this._err) throw this._err;
        ws.send(JSON.stringify({
          realtimeInput: {
            audio: {
              data: frameList[i].toString("base64"),
              mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
            },
          },
        }));
        const tSent = now();
        if (this.t.firstFrameSent === null) this.t.firstFrameSent = tSent;
        this.t.lastFrameSent = tSent; // 最後一次賦值即「講完那一刻」
      }
      ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    },

    // 等輸出收斂:已有輸出、且連續 idleMs 沒有新「有聲音訊/文字」就視為講完
    //(turnComplete 在 live-translate 連續 session 不會來,見上)。
    async waitQuiescent({ idleMs = 2500, timeoutMs = 30000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (!this._err && !this._closed && !this.turnComplete) {
        const remain = deadline - Date.now();
        if (remain <= 0) return false;
        const lastActive = Math.max(this.t.lastVoicedAudio ?? -1, this.t.lastText ?? -1);
        if (lastActive >= 0 && now() - lastActive > idleMs) return true;
        await sleep(Math.min(remain, 250));
      }
      if (this._err) throw this._err;
      return true;
    },

    close() { try { ws.close(); } catch { /* already closed */ } },
  };
  return s;
}
