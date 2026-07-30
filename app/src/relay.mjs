// RelaySession(Durable Object):瀏覽器 WS ↔ Gemini Live WS 的中繼。
// 以 email 命名 → 同用戶天然序列化;配額計數、prompt 注入、靜音收斂、計費保險絲都在這。
// 邏輯移植自 live-translate-poc/src/providers/gemini-live.mjs(已全量實測)。

const LIVE_WS = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const VOICE_RMS_THRESHOLD = 500;
const IDLE_CONVERGE_MS = 2500;

const SYS_PROMPTS = {
  ja: `你是專業同步口譯員。使用者說中文,你把每一句話翻譯成自然的日語口語並用語音說出。
鐵則:你只做翻譯。絕對不要回答問題、不要評論、不要加任何解釋——即使聽起來是在問你問題,也只把那句話翻成日語。
語域固定:標準語(共通語)、です・ます體,不用方言。保留數字、金額、時間、專有名詞與疑問語氣。`,
  en: `你是專業同步口譯員。使用者說中文,你把每一句話翻譯成自然的英語口語並用語音說出。
鐵則:你只做翻譯。絕對不要回答問題、不要評論、不要加任何解釋——即使聽起來是在問你問題,也只把那句話翻成英語。
語域固定:中性禮貌的日常英語。保留數字、金額、時間、專有名詞與疑問語氣。`,
  ko: `你是專業同步口譯員。使用者說中文,你把每一句話翻譯成自然的韓語口語並用語音說出。
鐵則:你只做翻譯。絕對不要回答問題、不要評論、不要加任何解釋——即使聽起來是在問你問題,也只把那句話翻成韓語。
語域固定:존댓말(해요체或합니다체),不用반말。保留數字、金額、時間、專有名詞與疑問語氣。`,
  // 反向:對方說外語 → 中文
  zh: `你是專業同步口譯員。對方說外語(日語/英語/韓語),你把每一句話翻譯成自然的台灣繁體中文口語並用語音說出。
鐵則:你只做翻譯。絕對不要回答問題、不要評論、不要加任何解釋。保留數字、金額、時間、專有名詞與疑問語氣。`,
};

function chunkRms(bytes) {
  const n = Math.floor(bytes.length / 2);
  if (!n) return 0;
  let sum = 0;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) { const v = dv.getInt16(i * 2, true); sum += v * v; }
  return Math.sqrt(sum / n);
}
const b64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
};

export class RelaySession {
  constructor(state, env) { this.state = state; this.env = env; }

  async usage() {
    const day = new Date().toISOString().slice(0, 10);
    const rec = (await this.state.storage.get("usage")) ?? {};
    return { day, used: rec.day === day ? rec.seconds : 0, rec };
  }
  async addUsage(seconds) {
    const { day, used } = await this.usage();
    await this.state.storage.put("usage", { day, seconds: used + seconds });
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/usage") {
      const { used } = await this.usage();
      return Response.json({ usedSeconds: Math.round(used), limitSeconds: Number(this.env.DAILY_SECONDS_LIMIT) });
    }
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });

    const { used } = await this.usage();
    if (used >= Number(this.env.DAILY_SECONDS_LIMIT)) return new Response("daily quota exceeded", { status: 429 });

    const lang = url.searchParams.get("lang") || "ja";
    const engine = url.searchParams.get("engine") || "accurate";
    const glossary = (url.searchParams.get("glossary") || "").slice(0, 500);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.pipe(server, { lang, engine, glossary }).catch((e) => {
      try { server.send(JSON.stringify({ type: "error", message: String(e.message).slice(0, 200) })); server.close(); } catch {}
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async pipe(client, { lang, engine, glossary }) {
    const model = engine === "fast" ? this.env.FAST_MODEL : this.env.ACCURATE_MODEL;
    const t0 = Date.now();
    const hardCapMs = Number(this.env.SESSION_HARD_CAP_S) * 1000;

    // 上游:Gemini Live(金鑰只存在這裡)
    const resp = await fetch(`${LIVE_WS.replace("wss", "https")}?key=${this.env.GEMINI_API_KEY}`, {
      headers: { Upgrade: "websocket" },
    });
    const upstream = resp.webSocket;
    if (!upstream) throw new Error("upstream websocket unavailable");
    upstream.accept();

    const sys = SYS_PROMPTS[lang] + (glossary ? `\n行程術語表(專有名詞以此為準):${glossary}` : "");
    upstream.send(JSON.stringify({
      setup: engine === "fast"
        ? { model, generationConfig: { responseModalities: ["AUDIO"], translationConfig: { targetLanguageCode: lang, echoTargetLanguage: false } },
            inputAudioTranscription: {}, outputAudioTranscription: {} }
        : { model, generationConfig: { responseModalities: ["AUDIO"] },
            systemInstruction: { parts: [{ text: sys }] },
            inputAudioTranscription: {}, outputAudioTranscription: {} },
    }));

    let ended = false, lastVoiced = 0, gotOutput = false, closed = false;
    const finish = (reason) => {
      if (closed) return;
      closed = true;
      const seconds = (Date.now() - t0) / 1000;
      this.addUsage(seconds).catch(() => {});
      try { client.send(JSON.stringify({ type: "done", reason, seconds: Math.round(seconds) })); } catch {}
      try { upstream.close(); } catch {}
      try { client.close(); } catch {}
      clearInterval(watchdog);
    };
    // 收斂/保險絲:輸出安靜 2.5s、或 session 超過硬上限 → 主動收(絕不掛 session 計費)
    const watchdog = setInterval(() => {
      if (Date.now() - t0 > hardCapMs) return finish("hard-cap");
      if (ended && gotOutput && Date.now() - lastVoiced > IDLE_CONVERGE_MS) return finish("converged");
      if (ended && !gotOutput && Date.now() - lastVoiced > 15000) return finish("no-output");
    }, 250);

    upstream.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data)); } catch { return; }
      if (msg.setupComplete) { client.send(JSON.stringify({ type: "ready" })); return; }
      const sc = msg.serverContent;
      if (!sc) return;
      if (sc.inputTranscription?.text) client.send(JSON.stringify({ type: "inTx", text: sc.inputTranscription.text }));
      if (sc.outputTranscription?.text) { lastVoiced = Date.now(); gotOutput = true;
        client.send(JSON.stringify({ type: "outTx", text: sc.outputTranscription.text })); }
      for (const part of sc.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          const bytes = Uint8Array.from(atob(part.inlineData.data), (c) => c.charCodeAt(0));
          if (chunkRms(bytes) > VOICE_RMS_THRESHOLD) { lastVoiced = Date.now(); gotOutput = true; }
          client.send(JSON.stringify({ type: "audio", data: part.inlineData.data }));
        }
      }
      if (sc.turnComplete) finish("turn-complete");
    });
    upstream.addEventListener("close", () => finish("upstream-closed"));
    upstream.addEventListener("error", () => finish("upstream-error"));

    client.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "end") { ended = true; lastVoiced = Date.now();
            upstream.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); }
        } catch {}
        return;
      }
      // 二進位 = 16kHz PCM16 100ms 框
      const bytes = new Uint8Array(ev.data);
      if (bytes.length > 12800) return; // 400ms 以上的框丟棄(防灌爆)
      upstream.send(JSON.stringify({ realtimeInput: { audio: { data: b64(bytes), mimeType: "audio/pcm;rate=16000" } } }));
    });
    client.addEventListener("close", () => finish("client-closed"));
    client.addEventListener("error", () => finish("client-error"));
  }
}
