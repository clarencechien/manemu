// RelaySession(Durable Object):瀏覽器 WS ↔ Gemini Live WS 的中繼。
// 以 email 命名 → 同用戶天然序列化;配額計數、prompt 注入、靜音收斂、計費保險絲都在這。
// 邏輯移植自 live-translate-poc/src/providers/gemini-live.mjs(已全量實測)。

const LIVE_WS = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
// 全域計數器 DO 的固定名稱(email 不可能長這樣 → 不會跟真人撞名)
export const GLOBAL_COUNTER = "__global__";

// 全站日預算:0 或未設 = 不啟用。查全域計數 DO,超標即暫停翻譯(登入與其他功能照常)。
// 查不到就放行——保險絲壞掉不該把整站鎖死,每人配額仍在。
export async function globalBudget(env) {
  const limit = Number(env.GLOBAL_DAILY_SECONDS || 0);
  if (!(limit > 0)) return { paused: false, limit: 0, used: 0 };
  try {
    const u = await (await env.RELAY.get(env.RELAY.idFromName(GLOBAL_COUNTER)).fetch("https://do/usage?limit=0")).json();
    return { paused: u.usedSeconds >= limit, limit, used: u.usedSeconds };
  } catch { return { paused: false, limit, used: 0 }; }
}
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

/** 同一個帳號同時進行中的 session 上限。PTT 產品一次只講一句;留 2 容忍斷線重連的重疊 */
const MAX_LIVE_SESSIONS = 2;
/** 一直在送音框卻始終沒有任何輸出:30 秒就收,不要燒到 hard cap */
const NO_SPEECH_MS = 30_000;
/** 每日「沒有輸出所以不計費」的秒數上限。失敗不扣額度是對使用者的體貼,
 *  但上游是按**輸入音訊**計費的,不能讓它同時變成錢包保險絲的豁免。 */
const UNBILLED_DAILY_S = 600;
/** 回譯折算成固定秒數計入配額(單次成本低,但它原本是唯一無保險絲直達付費 API 的路徑) */
const BACKTX_EQUIV_S = 2;

export class RelaySession {
  constructor(state, env) { this.state = state; this.env = env; }

  /* 進行中但還沒結算的 session。pipe() 是 fire-and-forget,同一顆 DO 可以同時掛
     任意多條 WS,而扣款要等 session 結束 —— 沒有這個集合,並行 N 條時每條進門
     讀到的 used 都是同一個舊值,額度就是 N 倍。只存在記憶體是對的:DO 被回收
     代表沒有連線在跑。 */
  live = new Set();

  /** 進行中 session 已經燒掉、但還沒寫回 storage 的秒數 */
  liveSeconds() {
    const now = Date.now();
    let s = 0;
    for (const e of this.live) s += (now - e.t0) / 1000;
    return s;
  }

  async usage() {
    const day = new Date().toISOString().slice(0, 10);
    const rec = (await this.state.storage.get("usage")) ?? {};
    const same = rec.day === day;
    return { day, used: same ? rec.seconds : 0, unbilled: same ? (rec.unbilled ?? 0) : 0, rec };
  }
  async addUsage(seconds) {
    const { day, used, unbilled } = await this.usage();
    await this.state.storage.put("usage", { day, seconds: used + seconds, unbilled });
  }
  /** 沒有輸出、因此不扣使用者額度的秒數。仍然要記 —— 上游照樣收了錢 */
  async addUnbilled(seconds) {
    const { day, used, unbilled } = await this.usage();
    await this.state.storage.put("usage", { day, seconds: used, unbilled: unbilled + seconds });
  }
  // 全站日預算(GLOBAL_DAILY_SECONDS):每人配額擋單人濫用,擋不住「帳號數 × 配額」的總爆量。
  // 用固定名稱的 DO 當全域計數器;它只走 /usage 與 /add,永遠不會走 pipe(),不會遞迴。
  globalStub() { return this.env.RELAY.get(this.env.RELAY.idFromName(GLOBAL_COUNTER)); }
  /** ⚠️ 不論這一場有沒有輸出都要累加:上游是按輸入音訊計費的,
   *  「失敗不計費」只該豁免使用者的額度,不該連全站預算一起豁免。 */
  async bumpGlobal(seconds) {
    if (!(Number(this.env.GLOBAL_DAILY_SECONDS) > 0)) return;
    try { await this.globalStub().fetch(`https://do/add?seconds=${seconds}`, { method: "POST" }); } catch {}
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
    // 全域計數器專用:累加(只有 relay 自己在扣款時呼叫)
    if (url.pathname === "/add" && req.method === "POST") {
      await this.addUsage(Number(url.searchParams.get("seconds")) || 0);
      const { used } = await this.usage();
      return Response.json({ usedSeconds: Math.round(used) });
    }
    // 回譯:折算固定秒數計進當日配額(它也是付費呼叫,不該完全沒有上限)
    if (url.pathname === "/backtx" && req.method === "POST") {
      await this.addUsage(BACKTX_EQUIV_S);
      this.bumpGlobal(BACKTX_EQUIV_S);
      const { used } = await this.usage();
      return Response.json({ usedSeconds: Math.round(used) });
    }
    if (url.pathname === "/debug") {
      // 上一個 session 的完整事件統計:診斷「氣泡空白」時看鏈斷在哪
      return Response.json((await this.state.storage.get("lastSession")) ?? { note: "還沒有任何 session" });
    }
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });

    // 併發閘門:扣款要等 session 結束才寫回,所以同一個 cookie 同時開 N 條時
    // 每條看到的都是舊值 —— 沒有這一段,每日額度等於「額度 × 並行數」。
    if (this.live.size >= MAX_LIVE_SESSIONS) {
      return Response.json({ error: "too_many_sessions", live: this.live.size }, { status: 429 });
    }
    const { used, unbilled } = await this.usage();
    if (limitSeconds > 0 && used + this.liveSeconds() >= limitSeconds) {
      return Response.json({ error: "quota_exceeded", usedSeconds: Math.round(used + this.liveSeconds()), limitSeconds }, { status: 429 });
    }
    // 沒有輸出的 session 不扣額度,但不能無限重複 —— 送靜音撐到 hard cap 再重開,
    // 上游照樣按輸入音訊收費,而本地帳面永遠是 0。
    if (unbilled >= UNBILLED_DAILY_S) {
      return Response.json({ error: "unbilled_quota", unbilledSeconds: Math.round(unbilled) }, { status: 429 });
    }

    const lang = SYS_PROMPTS[url.searchParams.get("lang")] ? url.searchParams.get("lang") : "ja";
    // engine 的鎖原本只在前端(app.js),任何人自己帶 ?engine=fast 就能切到 FAST_MODEL。
    // 要鎖就鎖在這裡;要放開就把 FAST_ENGINE 設成 "on"。
    const engine = this.env.FAST_ENGINE === "on" && url.searchParams.get("engine") === "fast" ? "fast" : "accurate";
    const gender = url.searchParams.get("gender") === "f" ? "f" : "m";
    const glossary = (url.searchParams.get("glossary") || "").slice(0, 500);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    // 從這一刻起算「進行中」。pipe() 設定完就 resolve(session 靠事件推進),
    // 所以正常路徑一律由 finish() 移除;這裡的 catch 只處理設定期就拋錯的情況。
    const entry = { t0: Date.now() };
    this.live.add(entry);
    this.pipe(server, { lang, engine, gender, glossary, entry }).catch((e) => {
      this.live.delete(entry);
      try { server.send(JSON.stringify({ type: "error", message: String(e.message).slice(0, 200) })); server.close(); } catch {}
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async pipe(client, { lang, engine, gender, glossary, entry }) {
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
      this.live.delete(entry);
      // 使用者額度:維持「沒有輸出就不扣」。
      // 全站預算:**一律**累加 —— 上游按輸入音訊計費,不會因為沒有輸出就不收錢。
      // 沒扣額度的秒數另外記進 unbilled,並在進門處設每日上限,免得變成免費迴圈。
      if (gotOutput) this.addUsage(seconds).catch(() => {});
      else this.addUnbilled(seconds).catch(() => {});
      this.bumpGlobal(seconds);
      // DEBUG_ENDPOINT 關掉時,done 訊息也不要夾帶完整 stats(否則那個開關等於只關了查詢入口)
      const payload = { type: "done", reason, seconds: Math.round(seconds), charged: gotOutput };
      if (this.env.DEBUG_ENDPOINT === "on") payload.stats = stats;
      try { client.send(JSON.stringify(payload)); } catch {}
      try { upstream.close(); } catch {}
      try { client.close(); } catch {}
      clearInterval(watchdog);
    };
    // 收斂/保險絲:輸出安靜 2.5s、或 session 超過硬上限 → 主動收(絕不掛 session 計費)
    const watchdog = setInterval(() => {
      if (Date.now() - t0 > hardCapMs) return finish("hard-cap");
      if (ended && gotOutput && Date.now() - lastVoiced > IDLE_CONVERGE_MS) return finish("converged");
      if (ended && !gotOutput && Date.now() - lastVoiced > 8000) return finish("no-output"); // 快回診斷(前端 12s 保險絲之前)
      // 沒送 end、框一直在來、卻始終沒有任何輸出:手機放口袋或腳本送靜音都是這樣。
      // 不提前收的話會一路燒到 hard cap,而上游按輸入音訊計費。
      if (!ended && !gotOutput && stats.framesIn > 0 && Date.now() - t0 > NO_SPEECH_MS) return finish("no-speech");
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
