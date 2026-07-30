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
  vi: `你是專業同步口譯員。使用者說中文,你把每一句話翻譯成自然的越南語口語並用語音說出。
鐵則:你只做翻譯。絕對不要回答問題、不要評論、不要加任何解釋——即使聽起來是在問你問題,也只把那句話翻成越南語。
語域固定:禮貌體(適度使用 dạ/ạ 等敬語助詞,對店員/陌生人的得體口吻)。保留數字、金額、時間、專有名詞與疑問語氣。`,
  th: `你是專業同步口譯員。使用者說中文,你把每一句話翻譯成自然的泰語口語並用語音說出。
鐵則:你只做翻譯。絕對不要回答問題、不要評論、不要加任何解釋——即使聽起來是在問你問題,也只把那句話翻成泰語。
語域固定:禮貌體,句尾禮貌詞全程一致使用。保留數字、金額、時間、專有名詞與疑問語氣。`,
  // 反向:對方說外語 → 中文
  zh: `你是專業同步口譯員。對方說外語(日語/英語/韓語/越南語/泰語),你把每一句話翻譯成自然的台灣繁體中文口語並用語音說出。
鐵則:你只做翻譯。絕對不要回答問題、不要評論、不要加任何解釋。保留數字、金額、時間、專有名詞與疑問語氣。`,
};
// 泰語 ครับ/ค่ะ 隨說話者性別,模型無記憶會每 session 亂跳(findings §3.11)→ 由前端設定鎖死
const TH_GENDER_LINE = {
  m: "\n說話者是男性:句尾禮貌詞一律用 ครับ,絕不使用 ค่ะ。",
  f: "\n說話者是女性:句尾禮貌詞一律用 ค่ะ/คะ,絕不使用 ครับ。",
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
    // 額度上限由 Worker 依分級傳入(0 = 無上限);DO 只負責計數與執行
    const limitSeconds = url.searchParams.has("limit")
      ? Number(url.searchParams.get("limit")) : Number(this.env.DAILY_SECONDS_LIMIT || 1800);
    if (url.pathname === "/usage") {
      const { used } = await this.usage();
      return Response.json({ usedSeconds: Math.round(used), limitSeconds });
    }
    if (url.pathname === "/debug") {
      // 上一個 session 的完整事件統計:診斷「氣泡空白」時看鏈斷在哪
      return Response.json((await this.state.storage.get("lastSession")) ?? { note: "還沒有任何 session" });
    }
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });

    const { used } = await this.usage();
    if (limitSeconds > 0 && used >= limitSeconds) {
      return Response.json({ error: "quota_exceeded", usedSeconds: Math.round(used), limitSeconds }, { status: 429 });
    }

    const lang = SYS_PROMPTS[url.searchParams.get("lang")] ? url.searchParams.get("lang") : "ja";
    const engine = url.searchParams.get("engine") || "accurate";
    const gender = url.searchParams.get("gender") === "f" ? "f" : "m";
    const glossary = (url.searchParams.get("glossary") || "").slice(0, 500);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.pipe(server, { lang, engine, gender, glossary }).catch((e) => {
      try { server.send(JSON.stringify({ type: "error", message: String(e.message).slice(0, 200) })); server.close(); } catch {}
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async pipe(client, { lang, engine, gender, glossary }) {
    const model = engine === "fast" ? this.env.FAST_MODEL : this.env.ACCURATE_MODEL;
    const t0 = Date.now();
    const hardCapMs = Number(this.env.SESSION_HARD_CAP_S) * 1000;
    // 診斷統計:每一環節都計數,寫進 lastSession 供 /api/debug 查
    const stats = { ts: new Date().toISOString(), lang, engine, model,
      hasKey: !!this.env.GEMINI_API_KEY, transport: null, upstreamStatus: null, upstreamOpened: false,
      setupComplete: false, upstreamMsgs: 0, parseFails: 0, firstMsgSample: null,
      framesIn: 0, bytesIn: 0, inTxChars: 0, outTxChars: 0,
      audioChunks: 0, upstreamCloseCode: null, upstreamCloseReason: null, endSignal: false, finishReason: null };
    const saveStats = () => this.state.storage.put("lastSession", stats).catch(() => {});

    // 上游:Gemini Live(金鑰只存在這裡)。
    // 首選 Workers 原生 WebSocket client(與 harness 語意一致);
    // 實測 fetch-upgrade 會握手成功(101)但收不到任何訊息 → 降為備援。
    const upstreamUrl = `${LIVE_WS}?key=${this.env.GEMINI_API_KEY}`;
    let upstream = null;
    try {
      upstream = new WebSocket(upstreamUrl);
      upstream.binaryType = "arraybuffer"; // 預設 Blob,TextDecoder 解不了 → 之前 parseFails 9/9 的根因
      stats.transport = "ws-client";
      await new Promise((res, rej) => {
        upstream.addEventListener("open", res, { once: true });
        upstream.addEventListener("error", () => rej(new Error("open-error")), { once: true });
        upstream.addEventListener("close", (e) => rej(new Error(`closed-before-open ${e.code}`)), { once: true });
        setTimeout(() => rej(new Error("open-timeout")), 10000);
      });
      stats.upstreamStatus = "open";
    } catch (e) {
      stats.upstreamStatus = `ws-client failed: ${String(e.message).slice(0, 80)}`;
      try { upstream?.close(); } catch {}
      upstream = null;
    }
    if (!upstream) {
      // 備援:fetch upgrade
      try {
        const resp = await fetch(upstreamUrl.replace("wss", "https"), { headers: { Upgrade: "websocket" } });
        stats.transport = "fetch-upgrade";
        stats.upstreamStatus += ` | fetch:${resp.status}`;
        upstream = resp.webSocket;
        upstream?.accept();
      } catch (e) { stats.upstreamStatus += ` | fetch-error:${String(e.message).slice(0, 80)}`; }
    }
    if (!upstream) { stats.finishReason = "upstream-unavailable"; saveStats(); throw new Error(`upstream unavailable (${stats.upstreamStatus})`); }
    stats.upstreamOpened = true;
    saveStats();

    let ended = false, lastVoiced = 0, gotOutput = false, closed = false;
    const finish = (reason) => {
      if (closed) return;
      closed = true;
      stats.finishReason = reason;
      const seconds = (Date.now() - t0) / 1000;
      // 失敗不計費:沒有任何輸出的 session(連不上/沒聽到/逾時)不扣額度
      stats.charged = gotOutput;
      saveStats();
      if (gotOutput) this.addUsage(seconds).catch(() => {});
      try { client.send(JSON.stringify({ type: "done", reason, seconds: Math.round(seconds), charged: gotOutput, stats })); } catch {}
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

    upstream.addEventListener("message", async (ev) => {
      stats.upstreamMsgs++;
      let raw;
      try {
        const d = ev.data;
        if (typeof d === "string") raw = d;
        else if (d && typeof d.text === "function") raw = await d.text(); // Blob
        else raw = new TextDecoder().decode(d);                           // ArrayBuffer/TypedArray
      } catch (e) { stats.parseFails++; if (!stats.firstMsgSample) { stats.firstMsgSample = `decode-error: ${String(e.message).slice(0, 80)}`; saveStats(); } return; }
      if (stats.firstMsgSample === null) { stats.firstMsgSample = raw.slice(0, 160); saveStats(); }
      let msg;
      try { msg = JSON.parse(raw); } catch { stats.parseFails++; return; }
      if (msg.setupComplete) { stats.setupComplete = true; saveStats(); client.send(JSON.stringify({ type: "ready" })); return; }
      const sc = msg.serverContent;
      if (!sc) return;
      if (sc.inputTranscription?.text) { stats.inTxChars += sc.inputTranscription.text.length;
        client.send(JSON.stringify({ type: "inTx", text: sc.inputTranscription.text })); }
      if (sc.outputTranscription?.text) { lastVoiced = Date.now(); gotOutput = true; stats.outTxChars += sc.outputTranscription.text.length;
        client.send(JSON.stringify({ type: "outTx", text: sc.outputTranscription.text })); }
      for (const part of sc.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          stats.audioChunks++;
          const bytes = Uint8Array.from(atob(part.inlineData.data), (c) => c.charCodeAt(0));
          if (chunkRms(bytes) > VOICE_RMS_THRESHOLD) { lastVoiced = Date.now(); gotOutput = true; }
          client.send(JSON.stringify({ type: "audio", data: part.inlineData.data }));
        }
      }
      if (sc.turnComplete) finish("turn-complete");
    });
    upstream.addEventListener("close", (ev) => { stats.upstreamCloseCode = ev.code; stats.upstreamCloseReason = String(ev.reason || "").slice(0, 200); finish("upstream-closed"); });
    upstream.addEventListener("error", () => finish("upstream-error"));

    client.addEventListener("message", async (ev) => {
      if (typeof ev.data === "string") {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "end") { ended = true; stats.endSignal = true; lastVoiced = Date.now();
            upstream.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); }
        } catch {}
        return;
      }
      // 二進位 = 16kHz PCM16 100ms 框。
      // 注意:new Uint8Array(非 ArrayBuffer) 會「靜默」得到長度 0(framesIn 41/bytesIn 0 的根因嫌疑)
      // → 對每種可能型別顯式轉換,並記錄第一框的實際型別/長度。
      let bytes;
      const d = ev.data;
      try {
        if (d instanceof ArrayBuffer) bytes = new Uint8Array(d);
        else if (ArrayBuffer.isView(d)) bytes = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        else if (d && typeof d.arrayBuffer === "function") bytes = new Uint8Array(await d.arrayBuffer());
        else { stats.badFrames = (stats.badFrames || 0) + 1; return; }
      } catch { stats.badFrames = (stats.badFrames || 0) + 1; return; }
      if (stats.firstFrameType === undefined) {
        stats.firstFrameType = Object.prototype.toString.call(d);
        stats.firstFrameBytes = bytes.length;
        saveStats();
      }
      if (bytes.length === 0 || bytes.length > 12800) { stats.badFrames = (stats.badFrames || 0) + 1; return; }
      stats.framesIn++; stats.bytesIn += bytes.length;
      upstream.send(JSON.stringify({ realtimeInput: { audio: { data: b64(bytes), mimeType: "audio/pcm;rate=16000" } } }));
    });
    client.addEventListener("close", () => finish("client-closed"));
    client.addEventListener("error", () => finish("client-error"));

    // 監聽都掛好後才送 setup(避免任何早到訊息落空)
    const sys = SYS_PROMPTS[lang]
      + (lang === "th" ? TH_GENDER_LINE[gender] : "")
      + (glossary ? `\n行程術語表(專有名詞以此為準):${glossary}` : "");
    upstream.send(JSON.stringify({
      setup: engine === "fast"
        ? { model, generationConfig: { responseModalities: ["AUDIO"], translationConfig: { targetLanguageCode: lang, echoTargetLanguage: false } },
            inputAudioTranscription: {}, outputAudioTranscription: {} }
        : { model, generationConfig: { responseModalities: ["AUDIO"] },
            systemInstruction: { parts: [{ text: sys }] },
            inputAudioTranscription: {}, outputAudioTranscription: {} },
    }));
  }
}
