/* manemu 前端:真實 PTT 音訊管線(mockup UI 平移,模擬層換成 relay WS)。 */
"use strict";
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============ 語言/場景(同 mockup) ============ */
const LANGS = {
  ja: { label: "日本語", btn: "対 日本語", pttThem: "押して話す", pttThemSub: "→ 中文", holdStatus: "押しながら話してください", divider: "⇅ 面對面・上側は相手用", who: "(日本語)", youWord: "あなた", themWord: "相手(中国語)" },
  en: { label: "English", btn: "to English", pttThem: "Hold to speak", pttThemSub: "→ Chinese", holdStatus: "Hold the button and speak", divider: "⇅ Face to face · top side is for them", who: "(English)", youWord: "You", themWord: "Them (Chinese)" },
  ko: { label: "한국어", btn: "한국어로", pttThem: "누르고 말하기", pttThemSub: "→ 中文", holdStatus: "버튼을 누른 채 말해 주세요", divider: "⇅ 面對面・위쪽은 상대방용", who: "(한국어)", youWord: "나", themWord: "상대(중국어)" },
  vi: { label: "Tiếng Việt", btn: "sang tiếng Việt", pttThem: "Nhấn giữ để nói", pttThemSub: "→ Tiếng Trung", holdStatus: "Nhấn giữ nút và nói", divider: "⇅ 面對面・Phía trên dành cho đối phương", who: "(Tiếng Việt)", youWord: "Bạn", themWord: "Đối phương (tiếng Trung)" },
  th: { label: "ไทย", btn: "เป็นภาษาไทย", pttThem: "กดค้างเพื่อพูด", pttThemSub: "→ ภาษาจีน", holdStatus: "กดปุ่มค้างไว้แล้วพูด", divider: "⇅ 面對面・ด้านบนสำหรับคู่สนทนา", who: "(ภาษาไทย)", youWord: "คุณ", themWord: "อีกฝ่าย (ภาษาจีน)" },
};
const LANG_ORDER = ["ja", "en", "ko", "vi", "th"];
const SCENES = {
  general: { label: "🧭 旅遊・通用", ghostTitle: "把「人・事・時・地」說清楚,翻譯會更準。試著說:", ghosts: ["「我要一份〇〇,〇〇不要加。」", "「請問〇〇在哪裡?怎麼走?」", "「我〇點有預約,名字是〇〇。」"] },
  emergency: { label: "🆘 旅遊・緊急", ghostTitle: "求助時照這個句型,一次講完整:", ghosts: ["「我在(地點),我的同伴(發生什麼),請幫我(需要的協助)。」", "例:「我在車站東口,朋友昏倒了,請叫救護車。」", "例:「我的護照不見了,請問要去哪裡報案?」"] },
};
const SCENE_ORDER = ["general", "emergency"];
const TEST_LINES = [
  { id: "T001", zh: "請問車站在哪裡?怎麼走比較快?" }, { id: "T007", zh: "我要兩張到京都的車票,大人一張、小孩一張。" },
  { id: "T014", zh: "這個不要辣,我不太能吃辣。" }, { id: "T016", zh: "我對蝦子過敏,餐點裡請不要放任何海鮮。" },
  { id: "T022", zh: "太貴了,算我三千塊可以嗎?" }, { id: "T030", zh: "請問退房時間是早上十點還是十一點?" },
  { id: "T037", zh: "我的房間號碼是七〇二,我朋友昏倒了。" }, { id: "T044", zh: "我們會晚三十分鐘到,位子可以保留嗎?" },
];

const S = { lang: LANGS[localStorage.getItem("mn_lang")] ? localStorage.getItem("mn_lang") : "ja",
            scene: "general", fast: false, test: false, testIdx: 0, busy: false, msgCount: 0,
            email: null, tier: null, usedSeconds: 0, limitSeconds: 0 };
// 泰語句尾禮貌詞由說話者性別決定(ครับ 男/ค่ะ 女);模型無記憶會每 session 亂跳,必須鎖進 prompt
const thGender = () => localStorage.getItem("mn_th_gender") || "m";
const quotaLeft = () => (S.limitSeconds > 0 ? S.limitSeconds - S.usedSeconds : Infinity);

/* ============ 版本標記與診斷(真機回報用) ============ */
const APP_VER = "v16-history-textonly";
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS 偽裝桌面
const withTimeout = (p, ms, tag) => Promise.race([p, sleep(ms).then(() => { throw new Error(tag); })]);
// 麵包屑:每個階段留腳印,卡死時知道卡在哪(強制解鎖時上報 + 進 console)
const crumbs = [];
const crumb = (s) => { crumbs.push(`${(performance.now() / 1000).toFixed(1)} ${s}`); if (crumbs.length > 60) crumbs.shift(); };
async function reportClientLog(kind) {
  try {
    await fetch("/api/client-log", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, ver: APP_VER, ua: navigator.userAgent, ios: IS_IOS, ts: new Date().toISOString(), crumbs: crumbs.slice(-40) }) });
  } catch {}
}

/* ============ 翻譯紀錄(IndexedDB,只存在此裝置、絕不上傳) ============ */
// 伺服器端對話零留存是隱私原則(app/README);紀錄留在使用者自己的裝置上,兩者互補。
// 一律純文字;音檔(譯音 WAV)只在 🧪 測試模式下附帶——輸入音檔任何情況都不存。
// Blob 存不進去自動降級純文字;IDB 全部失敗就當沒有這功能,絕不影響翻譯主流程。
const HIST_MAX = 400; // 句數上限,超過刪最舊
let histDbP = null;
function histDb() {
  histDbP ??= new Promise((res) => {
    try {
      const rq = indexedDB.open("manemu-history", 1);
      rq.onupgradeneeded = () => {
        const st = rq.result.createObjectStore("utt", { keyPath: "id", autoIncrement: true });
        st.createIndex("ts", "ts"); st.createIndex("conv", "conv");
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res(null);
      rq.onblocked = () => res(null);
    } catch { res(null); }
  });
  return histDbP;
}
const idbDone = (tx) => new Promise((res) => { tx.oncomplete = res; tx.onerror = res; tx.onabort = res; });
async function histAdd(rec) {
  const db = await histDb(); if (!db) return;
  const put = async (r) => { const tx = db.transaction("utt", "readwrite"); tx.objectStore("utt").add(r); await idbDone(tx); };
  try { await put(rec); } catch { try { await put({ ...rec, audio: null }); } catch {} } // Blob 存不了 → 純文字
  try { // 修剪最舊
    const tx = db.transaction("utt", "readwrite"); const st = tx.objectStore("utt");
    const count = await new Promise((r2) => { const c = st.count(); c.onsuccess = () => r2(c.result); c.onerror = () => r2(0); });
    let toDel = count - HIST_MAX;
    if (toDel > 0) await new Promise((r2) => {
      const cur = st.index("ts").openCursor();
      cur.onsuccess = () => { const c = cur.result; if (c && toDel-- > 0) { c.delete(); c.continue(); } else r2(); };
      cur.onerror = () => r2();
    });
    await idbDone(tx);
  } catch {}
}
async function histAll() {
  const db = await histDb(); if (!db) return [];
  try {
    return await new Promise((res) => {
      const rq = db.transaction("utt").objectStore("utt").getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
    });
  } catch { return []; }
}
async function histDelConv(conv) {
  const db = await histDb(); if (!db) return;
  try {
    const tx = db.transaction("utt", "readwrite");
    await new Promise((res) => {
      const cur = tx.objectStore("utt").index("conv").openCursor(IDBKeyRange.only(conv));
      cur.onsuccess = () => { const c = cur.result; if (c) { c.delete(); c.continue(); } else res(); };
      cur.onerror = () => res();
    });
    await idbDone(tx);
  } catch {}
}
async function histClear() {
  const db = await histDb(); if (!db) return;
  try { const tx = db.transaction("utt", "readwrite"); tx.objectStore("utt").clear(); await idbDone(tx); } catch {}
}

/* ============ 音訊:擷取(worklet)與播放(24k) ============ */
let audioCtx = null, mediaStream = null, workletNode = null, srcNode = null;
let ctxGen = 0, micCtxGen = -1; // Safari bug:MediaStream 跨(重建的)AudioContext 重用會靜默無聲 → 世代對不上就換新 mic
async function ensureAudio() {
  // iOS Safari:mic track 停止後 ctx 會被系統打斷(suspended/interrupted),
  // 且在被打斷的 ctx 上 resume() 可能「永不 resolve」→ 一律 race timeout,救不回就重建。
  // 本函式只在 pointerdown 手勢內被呼叫,重建/resume 都合法。
  if (audioCtx && audioCtx.state !== "running") {
    await Promise.race([audioCtx.resume().catch(() => {}), sleep(800)]);
    if (audioCtx.state !== "running") {
      console.warn(`[audio] ctx 救不回(state=${audioCtx.state})→ 重建`);
      try { audioCtx.close(); } catch {}
      audioCtx = null; playQ.scheduled = 0; playQ.playing = false;
    }
  }
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    ctxGen++;
    await withTimeout(audioCtx.audioWorklet.addModule("/pcm-worklet.js"), 5000, "worklet-timeout");
    if (audioCtx.state !== "running") await Promise.race([audioCtx.resume().catch(() => {}), sleep(800)]);
  }
}
// 僅供本地測試裝置模擬 iOS 凍結(Playwright 從外部拿不到閉包內的 ctx)
window.__audioDebug = { get ctx() { return audioCtx; } };
async function startCapture(onFrame) {
  pauseCapture(); // 清掉可能殘留的舊節點(重建/競態後的孤兒 worklet)
  crumb("ensureAudio");
  await ensureAudio();
  // iOS 關鍵:mic stream 儘量保留(track.stop 會讓系統收回 audio session)。
  // 但三種情況必須換新的,否則收不到任何音框(真機第二句卡死的根因群):
  //  ① track 已死 ② track 被靜音(iOS 在 <audio> 播放後常把錄音端 mute)
  //  ③ ctx 重建過(Safari:MediaStream 跨 AudioContext 重用 → 靜默無聲)
  const tracks = mediaStream?.getTracks() ?? [];
  const micDead = !tracks.length
    || !tracks.some((t) => t.readyState === "live")
    || tracks.some((t) => t.muted)
    || (micCtxGen !== -1 && micCtxGen !== ctxGen); // -1 = 預熱取得、尚未綁定任何 ctx(可直接用)
  if (micDead) {
    if (mediaStream) crumb(`mic-dead(live:${tracks.some((t) => t.readyState === "live")} muted:${tracks.some((t) => t.muted)} gen:${micCtxGen}/${ctxGen})`);
    releaseMic();
    crumb("getUserMedia");
    mediaStream = await withTimeout(
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }),
      8000, "mic-timeout");
  }
  micCtxGen = ctxGen; // 綁定到目前 ctx(Safari:stream 不能跨重建的 ctx 重用)
  crumb(`mic-live g${ctxGen}`);
  srcNode = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, "pcm-downsampler");
  workletNode.port.onmessage = (e) => onFrame(e.data);
  srcNode.connect(workletNode); // 不接到 destination:只擷取不外放
}
function pauseCapture() { // 句間:停止取音但保留 mic(半雙工由此保證,mic 指示燈會亮著)
  try { srcNode?.disconnect(); workletNode?.disconnect(); } catch {}
  srcNode = workletNode = null;
}
function releaseMic() { // 收起頁面/卡死自救:真正放掉裝置
  pauseCapture();
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  micCtxGen = -1;
}
// 登入後立刻預熱:權限提示在「按 PTT 之前」出現並只出現一次,
// 第一句不會再被權限框打斷(按住中跳提示 → 鬆手去按允許 → 句子斷掉)
async function prewarmMic(announce = false) {
  if (mediaStream?.getTracks().some((t) => t.readyState === "live")) return;
  if (announce) $("status").textContent = "請先允許使用麥克風(只需要一次)";
  try {
    crumb("prewarm-mic");
    mediaStream = await withTimeout(
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }),
      20000, "mic-timeout");
    micCtxGen = -1; // 尚未綁定 ctx,第一次 startCapture 時綁
    if (announce) $("status").textContent = "按住說話";
  } catch (e) {
    crumb("prewarm-fail:" + (e?.message ?? e));
    if (announce) $("status").textContent = "按住說話"; // 失敗照舊:第一次 PTT 時再要權限
  }
}
document.addEventListener("visibilitychange", () => {
  if (S.busy) return;
  if (document.visibilityState === "hidden") releaseMic();       // 收起頁面:放掉裝置(指示燈熄)
  else if (document.visibilityState === "visible") prewarmMic(); // 回來:靜默預熱(權限已給過)
});
// 24kHz PCM16 佇列播放(300ms 起播 buffer,burst 到達也順)
const playQ = { scheduled: 0, playing: false };
function enqueuePcm(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const n = Math.floor(bytes.length / 2);
  if (!n) return;
  const f32 = new Float32Array(n);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < n; i++) f32[i] = dv.getInt16(i * 2, true) / 32768;
  const buf = audioCtx.createBuffer(1, n, 24000);
  buf.getChannelData(0).set(f32);
  const src = audioCtx.createBufferSource();
  src.buffer = buf; src.connect(audioCtx.destination);
  const startAt = Math.max(audioCtx.currentTime + (playQ.playing ? 0 : 0.3), playQ.scheduled);
  src.start(startAt);
  playQ.scheduled = startAt + buf.duration;
  playQ.playing = true;
}
const playbackRemaining = () => Math.max(0, (playQ.scheduled - (audioCtx?.currentTime ?? 0)) * 1000);

// iOS 自動播放限制:程式化 <audio>.play() 只允許發生在「被手勢開光過」的元素上
// → pointerdown 時用 20ms 無聲 WAV 開光一顆,之後 fallback 播放共用它
const SILENT_WAV = "data:audio/wav;base64,UklGRmQBAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YUABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
let speakEl = null;
function unlockSpeaker() {
  if (speakEl) return;
  speakEl = new Audio(SILENT_WAV);
  speakEl.playsInline = true;
  speakEl.play().then(() => speakEl.pause()).catch(() => {});
}

// <audio>+WAV 播放(重播同路徑;在 iOS 真機上唯一確認會出聲的路)
async function playWavChunks(b64chunks) {
  if (!b64chunks?.length) return;
  const url = pcmToWavUrl(b64chunks, 24000);
  try {
    const a = speakEl ?? new Audio();
    a.src = url;
    await withTimeout(a.play(), 3000, "play-timeout");
    await new Promise((res) => {
      a.addEventListener("ended", res, { once: true });
      a.addEventListener("error", res, { once: true });
      setTimeout(res, 30000); // 保險絲
    });
  } catch (e) { console.warn("[audio] wav 播放失敗", e); crumb("wavfail:" + e.message); }
  finally { URL.revokeObjectURL(url); }
}
// 等譯音播完。iOS:WebAudio 串流播放不可靠(audio session 被收回時「時鐘照走、輸出無聲」,
// 偵測不到)→ 一律走 <audio>+WAV;其他平台維持串流 + 凍結偵測 fallback。
async function drainPlayback(b64chunks) {
  try {
    if (IS_IOS) { crumb("drain-ios-wav"); await playWavChunks(b64chunks); return; }
    if (!audioCtx || playbackRemaining() <= 0) return;
    const mark = audioCtx.currentTime;
    await sleep(300);
    if (audioCtx.currentTime > mark) { crumb("drain-stream"); await sleep(playbackRemaining() + 100); return; }
    console.warn(`[audio] ctx 凍結(state=${audioCtx.state})→ <audio> WAV 相容播放`);
    crumb("drain-frozen");
    try { audioCtx.close(); } catch {}   // 已排程的無聲來源一起清掉,下一句在手勢內重建
    audioCtx = null; playQ.scheduled = 0;
    await playWavChunks(b64chunks);
    reportClientLog("frozen-fallback");
  } finally { playQ.playing = false; }
}

/* ============ 一輪 PTT(核心:真 relay) ============ */
async function runUtterance({ side, ui }) {
  S.busy = true; S.releasedAt = null; S.lastMsgAt = 0; S.doneSeen = false;
  let settled = false;
  const inner = runUtteranceInner({ side, ui })
    .catch((e) => { console.warn("utterance failed", e); crumb("err:" + (e?.message ?? e)); ui.status("⚠ 出了點問題,再試一次", false); })
    .finally(() => { settled = true; });
  // 保險絲:放開按鈕後任何掛死都要能自救,絕不讓使用者只能重整。
  // relay 死寂(放開後 12s 沒任何訊息)提早放行;done 之後交給播放自己的保險絲,45s 絕對上限。
  const fuse = (async () => {
    while (!settled) {
      await sleep(1000);
      if (settled || !S.releasedAt) continue;
      const now = performance.now();
      if (!S.doneSeen && now - Math.max(S.releasedAt, S.lastMsgAt) > 12000) return "stuck";
      if (now - S.releasedAt > 45000) return "stuck";
    }
    return "ok";
  })();
  if (await Promise.race([inner.then(() => "ok"), fuse]) === "stuck") {
    console.warn("[fuse] 卡死強制解鎖:", crumbs.join(" | "));
    reportClientLog("stuck");
    ui.status("⚠ 這句卡住了,已自動解鎖,直接講下一句就好", false);
    try { audioCtx?.close(); } catch {}
    audioCtx = null; playQ.scheduled = 0; playQ.playing = false;
    releaseMic(); // 連 mic 一起放掉重來,下一句全部重建
  }
  S.busy = false; try { pauseCapture(); } catch {} window.__pttRelease = null;
}
async function runUtteranceInner({ side, ui }) {
  // 額度預檢:用完就別開麥克風/連線,直接給明確文案
  if (quotaLeft() <= 0) {
    ui.status(`今天的翻譯額度用完了(${Math.round(S.limitSeconds / 60)} 分鐘),明天 UTC 00:00 重置`, false);
    return;
  }
  const t0 = performance.now();
  ui.status("連線中…", true);
  const lang = side === "me" ? S.lang : "zh";
  const engine = S.fast && side === "me" ? "fast" : "accurate";
  const ws = new WebSocket(`/ws?lang=${lang}&engine=${engine}&gender=${thGender()}&glossary=${encodeURIComponent(localStorage.getItem("mn_glossary") || "")}`);
  ws.binaryType = "arraybuffer";

  let ready = false, ended = false, endSent = false;
  const preReady = [];
  const micFrames = [];   // 測試模式要上傳
  const el = ui.begin({ side });
  let inTx = "", outTx = "", tFirstAudio = null;

  let doneStats = null, relayError = null;
  const audioB64 = []; // 供重播
  const finishPromise = new Promise((resolve) => {
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      S.lastMsgAt = performance.now(); // 保險絲用:relay 還活著的證據
      console.log("[relay]", m.type, m.text ?? m.reason ?? "");   // 手機可接 USB/遠端主控台看
      if (m.type === "ready") {
        crumb("ws-ready"); ready = true;
        for (const f of preReady) ws.send(f); preReady.length = 0;
        // 手快的句子:放開時 ws 還沒 ready,end 得補送,否則 relay 空等(clientlog 實錄)
        if (ended && !endSent && ws.readyState === 1) { ws.send(JSON.stringify({ type: "end" })); endSent = true; crumb("end-flushed"); }
      }
      // zh 文字顯示前過簡→正轉換(me 側的 STT、them 側的譯文);外語原樣
      if (m.type === "inTx") { if (!inTx) crumb("inTx1"); inTx += m.text; el.srcEl.textContent = side === "me" ? toTrad(inTx) : inTx; }
      if (m.type === "outTx") { if (!outTx) crumb("outTx1"); outTx += m.text; el.txEl.textContent = side === "me" ? outTx : toTrad(outTx); el.host?.scrollIntoView({ block: "end" }); }
      if (m.type === "audio") {
        if (tFirstAudio === null) { tFirstAudio = performance.now(); crumb("audio1"); }
        audioB64.push(m.data);
        if (!IS_IOS) enqueuePcm(m.data); // iOS 不走 WebAudio 串流(無聲風險),收齊後 WAV 一次播
      }
      if (m.type === "error") { relayError = m.message || "relay error"; crumb("relay-err"); resolve("error"); }
      if (m.type === "done") { crumb("done:" + (m.reason ?? "")); S.doneSeen = true; doneStats = m.stats ?? null; resolve(m.reason); }
    });
    ws.addEventListener("close", () => resolve("closed"));
    ws.addEventListener("error", () => resolve("ws-error"));
  });

  let firstFrameLogged = false;
  const onFrame = (frameBuf) => {
    if (ended) return;
    if (!firstFrameLogged) { firstFrameLogged = true; crumb("frame1"); console.log("[mic] first frame bytes:", frameBuf?.byteLength); }
    if (!frameBuf?.byteLength) return; // 空框不送
    micFrames.push(new Uint8Array(frameBuf.slice(0)));
    if (ready && ws.readyState === 1) ws.send(frameBuf); else preReady.push(frameBuf);
  };
  // 開錄後 2s 一個音框都沒有 = mic 靜默死(iOS 的 mute 不一定反映在 track 屬性上)
  // → ctx+mic 整組砍掉重建一次(權限已給過,Safari 不會再跳提示)。
  // 注意:計時必須從 startCapture「完成後」起算——v9 從按下起算,把慢路徑(getUserMedia 1.5s+)
  // 誤判成無音框,還跟進行中的 startCapture 打架(clientlog 的 capfail:No ScriptProcessor)。
  let frameFuse = null;
  const armFrameFuse = () => {
    frameFuse = setTimeout(async () => {
      if (firstFrameLogged || ended) return;
      crumb("no-frames→rebuild");
      try {
        pauseCapture();
        try { audioCtx?.close(); } catch {}
        audioCtx = null; playQ.scheduled = 0; playQ.playing = false;
        releaseMic();
        await startCapture(onFrame);
        crumb("rebuild-ok");
      } catch (e2) { crumb("rebuild-fail:" + (e2?.message ?? e2)); reportClientLog("mic-rebuild-fail"); }
    }, 2000);
  };
  try {
    await startCapture(onFrame);
    if (!ended) armFrameFuse();
  } catch (e) {
    clearTimeout(frameFuse);
    crumb("capfail:" + (e?.message ?? e));
    ui.status(e?.message === "mic-timeout" ? "⚠ 麥克風沒有回應(可能被其他 app 占用),再按一次試試" : "需要麥克風權限", false);
    try { ws.close(); } catch {}
    if (e?.message === "mic-timeout") { releaseMic(); reportClientLog("mic-timeout"); }
    S.busy = false; return;
  }
  ui.status("聆聽中 <span class='wave'><i></i><i></i><i></i><i></i></span>", true);

  // 等放開(呼叫端在 pointerup 時呼叫 window.__pttRelease)
  await new Promise((r) => { window.__pttRelease = r; });
  ended = true;
  clearTimeout(frameFuse);
  const tReleased = performance.now();
  S.releasedAt = tReleased; // 保險絲從這一刻起算
  crumb(`released(${S.relSrc ?? "?"})${firstFrameLogged ? "" : "-noframes"}`);
  pauseCapture(); // 只斷 worklet,mic 保留(iOS audio session 不能斷)
  // 零音框或 <300ms 瞬放 = 這句沒有內容:立刻乾淨中止,不等 relay(13s 假卡死的來源)。
  // mic 預熱後首框 ~100ms 就到,「瞬放」不再保證零音框,所以按住時長要獨立判斷。
  const heldMs = tReleased - t0;
  if (!firstFrameLogged || heldMs < 300) {
    try { ws.close(); } catch {}
    el.host?.remove(); el.txEl?.closest(".fmsg")?.remove(); // 收掉空氣泡
    if (S.msgCount > 0) S.msgCount--;
    if (S.msgCount === 0) renderEmpty();
    if (!firstFrameLogged && heldMs >= 500) {
      // 按夠久卻零音框 = mic 真的靜默死 → 整組重置,下一句全新重建
      try { audioCtx?.close(); } catch {}
      audioCtx = null; playQ.scheduled = 0; playQ.playing = false;
      releaseMic();
      reportClientLog("no-frames");
      ui.status("⚠ 麥克風沒收到聲音,已重置,請再說一次", false);
    } else {
      ui.status("要按住說話,說完再放開", false); // 瞬放(手滑或 iOS 假 cancel)
    }
    return;
  }
  if (ws.readyState === 1) { ws.send(JSON.stringify({ type: "end" })); endSent = true; }
  ui.status("翻譯中…", true);

  await finishPromise;
  const deadAir = tFirstAudio !== null ? Math.round(tFirstAudio - tReleased) : null;

  // 空結果 = 鏈路斷了:把斷點直接寫在氣泡上,不假裝成功
  if (!outTx) {
    await refreshUsage();                                   // 可能是額度剛用完
    if (quotaLeft() <= 0) {
      el.txEl.innerHTML = `<span style="color:var(--warn)">今天的翻譯額度用完了</span>`;
      const d = document.createElement("div");
      d.className = "backtx"; d.style.borderColor = "var(--warn)";
      d.textContent = `上限 ${Math.round(S.limitSeconds / 60)} 分鐘/日,UTC 00:00 重置。這次沒有成功所以不計費。`;
      el.host?.querySelector(".bubble")?.appendChild(d);
      ui.done({ side, inTx, outTx, deadAir: null, completionMs: 0, lagS: "0.0" }, el);
      return;
    }
    const s = doneStats;
    const diag = relayError ? `relay 錯誤:${relayError}`
      : s ? `斷點診斷:上游${s.upstreamOpened ? "已連" : "未連(status=" + s.upstreamStatus + ", key=" + s.hasKey + ")"}`
          + `,setup ${s.setupComplete ? "✓" : "✗"},收到你的音框 ${s.framesIn} 個,`
          + `辨識 ${s.inTxChars} 字/譯文 ${s.outTxChars} 字,關閉原因 ${s.upstreamCloseCode ?? "-"} ${s.upstreamCloseReason ?? ""}`
      : "沒有診斷資料(relay 版本較舊?)";
    el.txEl.innerHTML = `<span style="color:var(--warn)">⚠ 沒有收到譯文</span>`;
    const d = document.createElement("div");
    d.className = "backtx"; d.style.borderColor = "var(--warn)";
    d.textContent = diag + " — 完整資料開 /api/debug";
    el.host?.querySelector(".bubble")?.appendChild(d);
  }

  // 等譯音播完再解鎖(半雙工)
  ui.status("🔊 播放譯音(此時麥克風關閉)", true);
  el.host?.classList.add("speaking");
  await drainPlayback(audioB64);
  el.host?.classList.remove("speaking");

  // 端到端計時:speech=按住講話長度、deadAir=放開→首音、completion=放開→譯音播完、total=按下→播完
  const speechMs = Math.round(tReleased - t0);
  const completionMs = Math.round(performance.now() - tReleased);
  ui.done({ side, inTx, outTx, deadAir, speechMs, completionMs,
    lagS: ((performance.now() - t0) / 1000).toFixed(1), reason: doneStats?.finishReason }, el);
  if (outTx && audioB64.length) ui.replay?.(el, audioB64);

  // 本地翻譯紀錄(此裝置限定,見 histAdd):純文字。
  // 音檔原則:輸入音檔永不存;譯音也不存——只有 🧪 測試模式(明示記錄)例外。
  if (outTx) histAdd({
    conv: S.conv, ts: Date.now(), side, lang: side === "me" ? S.lang : "zh", uiLang: S.lang,
    src: side === "me" ? toTrad(inTx) : inTx,
    tx: side === "me" ? outTx : toTrad(outTx),
    audio: S.test && audioB64.length ? new Blob([pcmToWavBytes(audioB64, 24000)], { type: "audio/wav" }) : null,
  });

  // 回譯確認(me 側、非測試模式;面對面 UI 沒有 badge 位就不打——別白花回譯錢)
  if (side === "me" && !S.test && outTx && ui.supportsBadge) {
    try {
      const r = await fetch("/api/backtranslate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: outTx, from: S.lang }) });
      const d = await r.json();
      if (d.zh) ui.badge(el, toTrad(d.zh));
    } catch {}
  }
  // 測試模式記錄(R1 收集管道)——沒有譯文就不算完成,提示重念
  if (S.test && side === "me" && !outTx) {
    ui.status("這句沒有成功,請再念一次(不會跳下一句)", false);
    S.busy = false; refreshUsage(); return;
  }
  if (S.test && side === "me") {
    const line = TEST_LINES[S.testIdx];
    const pcm = concatBytes(micFrames);
    fetch("/api/field-log", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: line?.id, expectedZh: line?.zh, lang: S.lang, engine, stt: inTx, tx: outTx,
        deadAirMs: deadAir, speechMs, completionMs, ts: new Date().toISOString(), audioB64: b64enc(pcm), sampleRate: 16000 }) }).catch(() => {});
    S.testIdx++;
    updateTestbar();
  }
  crumb("utter-end");
  S.busy = false;
  ui.status("按住說話", false);
  refreshUsage();
}
// PCM16 chunks(base64)→ WAV bytes / Blob URL(重播與本地紀錄共用;<audio> 在行動瀏覽器最穩)
function pcmToWavBytes(b64chunks, sampleRate) {
  const bufs = b64chunks.map((a) => Uint8Array.from(atob(a), (c) => c.charCodeAt(0)));
  const total = bufs.reduce((s, b) => s + b.length, 0);
  const wav = new Uint8Array(44 + total);
  const dv = new DataView(wav.buffer);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) wav[o + i] = s.charCodeAt(i); };
  wstr(0, "RIFF"); dv.setUint32(4, 36 + total, true); wstr(8, "WAVE");
  wstr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wstr(36, "data"); dv.setUint32(40, total, true);
  let o = 44; for (const b of bufs) { wav.set(b, o); o += b.length; }
  return wav;
}
function pcmToWavUrl(b64chunks, sampleRate) {
  return URL.createObjectURL(new Blob([pcmToWavBytes(b64chunks, sampleRate)], { type: "audio/wav" }));
}

function concatBytes(arrs) {
  const total = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function b64enc(bytes) {
  let s = ""; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}

/* ============ PTT 鎖定(全 UI 共用;之前漏移植導致 ReferenceError 卡死) ============ */
function setPtt(disabled) {
  // 正在被按住的那顆絕不 disable:iOS 對「互動中途被 disable 的元素」會在 ~100ms 後
  // 補發 cancel/leave → 快路徑(mic 已就緒)的句子被瞬間放開(clientlog 交替卡死的根因)
  const set = (id, v) => { const b = $(id); if (b) b.disabled = v && id !== S.holdBtnId; };
  set("pttMe", disabled);
  set("pttThem", disabled || S.test);
  set("fpttMine", disabled);
  set("fpttOther", disabled || S.test);
}

/* ============ 對談 UI ============ */
const chatUI = {
  begin({ side }) {
    if (S.msgCount === 0) $("stream").innerHTML = "";
    S.msgCount++;
    const el = document.createElement("div");
    el.className = "msg " + side;
    el.innerHTML = `<span class="who">${side === "me" ? "我(中文)" : "對方" + LANGS[S.lang].who}</span>
      <div class="bubble"><div class="src"></div><div class="tx"></div></div><div class="rowmeta"></div>`;
    $("stream").appendChild(el);
    el.scrollIntoView({ block: "end" });
    return { host: el, srcEl: el.querySelector(".src"), txEl: el.querySelector(".tx") };
  },
  done({ outTx, deadAir, completionMs }, el) {
    // 口語化小資訊列(讓 user 有感知速度,不丟技術名詞)
    const bits = [];
    if (outTx && deadAir !== null) {
      bits.push(deadAir <= 100 ? "⚡ 秒接話" : `⚡ ${(deadAir / 1000).toFixed(1)} 秒接話`);
    }
    if (outTx && completionMs) bits.push(`🗣 ${(completionMs / 1000).toFixed(1)} 秒說完`);
    if (S.test && outTx) bits.push("✓ 已記錄");
    el.host.querySelector(".rowmeta").innerHTML = bits.map((t) => `<span class="lat">${t}</span>`).join("");
    el.host.scrollIntoView({ block: "end" });
  },
  replay(el, audioB64) {
    // 走 <audio> + WAV Blob:繞開 WebAudio(audioCtx.resume() 在部分 Android 會永不 resolve)
    const b = document.createElement("button");
    b.className = "badge ok"; b.textContent = "🔊 重播";
    let wavUrl = null, playing = false;
    b.addEventListener("click", async () => {
      if (playing || S.busy) return;
      playing = true; S.busy = true; setPtt(true);
      $("status").textContent = "🔊 重播中";
      try {
        if (!wavUrl) wavUrl = pcmToWavUrl(audioB64, 24000);
        const a = new Audio(wavUrl);
        await a.play();
        await new Promise((res) => {
          a.addEventListener("ended", res, { once: true });
          a.addEventListener("error", res, { once: true });
          setTimeout(res, 30000); // 保險絲:無論如何 30s 內解鎖
        });
      } catch (e) { console.warn("replay failed", e); }
      finally {
        playing = false; S.busy = false; setPtt(false);
        $("status").textContent = "按住說話";
      }
    });
    el.host.querySelector(".rowmeta").prepend(b);
  },
  badge(el, backZh) {
    const b = document.createElement("button");
    b.className = "badge ok"; b.textContent = "🔍 核對意思";
    b.addEventListener("click", () => {
      if (el.host.querySelector(".backtx")) return;
      const d = document.createElement("div");
      d.className = "backtx ok"; d.textContent = `對方聽到的意思:「${backZh}」`;
      el.host.querySelector(".bubble").appendChild(d);
    });
    el.host.querySelector(".rowmeta").appendChild(b);
    if (S.fast) b.click(); // 快速模式強制展開
  },
  status(html, busy) { $("status").innerHTML = html; setPtt(busy); },
  hint(text) { $("status").textContent = text; }, // 只給文字回饋,不動按鈕鎖定
  supportsBadge: true,
};

/* ============ 面對面 UI(同級字、氣泡配色) ============ */
function faceUI(half) {
  const st = half === "mine" ? $("stMine") : $("stOther");
  return {
    begin({ side }) {
      const own = half === "mine" ? $("feedMine") : $("feedOther");
      const opp = half === "mine" ? $("feedOther") : $("feedMine");
      if (S.msgCount === 0) { own.innerHTML = ""; opp.innerHTML = ""; }
      S.msgCount++;
      const d = document.createElement("div");
      d.className = "fmsg me";
      d.innerHTML = `<span class="fsrc"></span><small>${half === "mine" ? "你說的" : LANGS[S.lang].youWord}</small>`;
      own.appendChild(d);
      const od = document.createElement("div");
      od.className = "fmsg them";
      od.innerHTML = `<span class="ftx"></span><small>${half === "mine" ? LANGS[S.lang].themWord : "對方"}</small>`;
      opp.appendChild(od);
      return { host: d, srcEl: d.querySelector(".fsrc"), txEl: od.querySelector(".ftx") };
    },
    done() {},
    badge() {},
    // 一定要走 setPtt:它會跳過「按住中的那顆」——之前這裡自己 disable,
    // iOS 的假 cancel bug 在面對面模式原樣重演(對話模式修了、這裡漏了)
    status(html, busy) { st.innerHTML = html; setPtt(busy); },
    hint(text) { st.textContent = text; }, // 面對面的忙碌回饋要寫在自己這半邊,#status 在此模式看不到
  };
}

/* ============ PTT 綁定(pointerdown 開始、pointerup 結束) ============ */
function bindPtt(btn, side, ui) {
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (S.busy) { ui.hint("稍等一下,上一句還在處理"); return; } // 不再靜默(寫進該模式自己的狀態列)
    unlockSpeaker(); // iOS:趁手勢開光 <audio>,fallback 播放才被允許
    S.holdBtnId = btn.id; // 按住中:這顆不受 setPtt disable(見 setPtt 註解)
    btn.classList.add("holding");
    try { btn.setPointerCapture?.(e.pointerId); } catch { /* 快速點放時 pointer 可能已失效,不阻斷整句 */ }
    runUtterance({ side, ui }).finally(() => btn.classList.remove("holding"));
  });
  const release = (src) => () => { S.relSrc = src; S.holdBtnId = null; window.__pttRelease?.(); };
  btn.addEventListener("pointerup", release("up"));
  btn.addEventListener("pointercancel", release("cancel"));
  btn.addEventListener("pointerleave", release("leave"));
}

/* ============ 頂列/雜項 ============ */
function renderEmpty() {
  if (S.msgCount > 0 || S.test) return;
  const sc = SCENES[S.scene];
  $("stream").innerHTML = `<div class="ghost"><b>${sc.ghostTitle}</b>${sc.ghosts.map((g) => `<span class="gx">${g}</span>`).join("")}</div>`;
  $("feedMine").innerHTML = `<div class="fghost"><b>${sc.ghostTitle}</b><br>${sc.ghosts.join("<br>")}</div>`;
  $("feedOther").innerHTML = "";
}
function applyLang() {
  const L = LANGS[S.lang];
  $("langBtn").value = S.lang;
  localStorage.setItem("mn_lang", S.lang);
  // 泰語專用:句尾禮貌詞 chip(其他語言隱藏)
  const g = $("thGender");
  g.classList.toggle("hidden", S.lang !== "th");
  if (S.lang === "th") g.textContent = thGender() === "f" ? "尾詞 ค่ะ(女)" : "尾詞 ครับ(男)";
  $("pttMeSub").textContent = `→ ${L.label}`;
  $("pttThemBig").textContent = L.pttThem;
  $("pttThemSub").textContent = L.pttThemSub;
  $("fpttOther").textContent = `${L.pttThem}(${L.label} → 中文)`;
  $("stOther").textContent = L.holdStatus;
  $("faceDivider").textContent = L.divider;
}
function updateTestbar() {
  const t = TEST_LINES[S.testIdx];
  $("testbar").innerHTML = !t
    ? `✓ 測試完成:${TEST_LINES.length} 句已記錄,感謝!`
    : `<span class="rec"></span><b>測試模式 ${S.testIdx + 1}/${TEST_LINES.length}</b> 請照念:「${t.zh}」<br><small>(${t.id}・你的錄音與翻譯結果會被記錄)</small>`;
}
function resetConversation() {
  S.msgCount = 0; S.testIdx = 0; S.busy = false;
  S.conv = Date.now(); // 新的對話組(本地紀錄以此分組)
  renderEmpty();
  $("status").textContent = "按住說話";
}

/* ============ 翻譯紀錄面板 ============ */
const LANG_SHORT = { ja: "日", en: "英", ko: "韓", vi: "越", th: "泰", zh: "中" };
async function renderHistory() {
  const box = $("histList"); box.textContent = "";
  const recs = await histAll();
  $("histCount").textContent = `${recs.length} 句・只存在此裝置`;
  if (!recs.length) {
    const p = document.createElement("div"); p.className = "histEmpty";
    p.textContent = "還沒有紀錄。翻譯過的句子會自動存在這台裝置上,不會上傳到任何伺服器。";
    box.appendChild(p); return;
  }
  const groups = new Map(); // 依對話組;新的在前、組內照時間
  recs.sort((a, b) => b.conv - a.conv || a.ts - b.ts);
  for (const r of recs) { if (!groups.has(r.conv)) groups.set(r.conv, []); groups.get(r.conv).push(r); }
  for (const [conv, list] of groups) {
    const g = document.createElement("div"); g.className = "hconv";
    const head = document.createElement("div"); head.className = "hconvHead";
    const when = new Date(list[0].ts).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
    const langs = [...new Set(list.map((r) => LANG_SHORT[r.uiLang] ?? r.uiLang))].join("/");
    const span = document.createElement("span"); span.textContent = `${when}・中⇄${langs}・${list.length} 句`;
    const del = document.createElement("button"); del.className = "del"; del.textContent = "刪除";
    del.addEventListener("click", async () => { await histDelConv(conv); renderHistory(); });
    head.append(span, del); g.appendChild(head);
    for (const r of list) {
      const row = document.createElement("div"); row.className = "hrow";
      const src = document.createElement("div"); src.className = "hsrc"; src.textContent = (r.side === "me" ? "我:" : "對方:") + (r.src || "(沒聽清)");
      const tx = document.createElement("div"); tx.className = "htx " + r.side; tx.textContent = r.tx || "";
      row.append(src, tx);
      if (r.audio) {
        const b = document.createElement("button"); b.className = "hplay"; b.textContent = "🔊 重播";
        b.addEventListener("click", () => {
          if (S.busy) return;
          const url = URL.createObjectURL(r.audio);
          const a = new Audio(url);
          a.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
          a.play().catch(() => URL.revokeObjectURL(url));
        });
        row.appendChild(b);
      }
      g.appendChild(row);
    }
    box.appendChild(g);
  }
}
async function refreshUsage() {
  try {
    const d = await (await fetch("/api/me")).json();
    if (d.usedSeconds === undefined) return;
    S.usedSeconds = d.usedSeconds; S.limitSeconds = d.limitSeconds; S.tier = d.tier;
    $("usage").textContent = d.limitSeconds > 0
      ? `今日 ${Math.round(d.usedSeconds / 60)}/${Math.round(d.limitSeconds / 60)} 分`
      : `今日 ${Math.round(d.usedSeconds / 60)} 分・無上限`;
  } catch {}
}

/* ============ Turnstile(登入頁擋 bot;未設 site key 則不出現) ============ */
async function mountTurnstile() {
  let siteKey = null;
  try { siteKey = (await (await fetch("/api/config")).json()).turnstileSiteKey; } catch {}
  if (!siteKey) return;                       // 未啟用:表單直接 POST(Worker 端也不驗)
  const btn = $("ssoBtn");
  btn.disabled = true;
  btn.textContent = "請先完成人機驗證";
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true; s.defer = true;
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  }).catch(() => {});
  if (!window.turnstile) { btn.disabled = false; btn.textContent = "使用 Google 登入"; return; }
  window.turnstile.render("#tsWidget", {
    sitekey: siteKey,
    callback: () => { btn.disabled = false; btn.textContent = "使用 Google 登入"; },
    "expired-callback": () => { btn.disabled = true; btn.textContent = "驗證過期,請重試"; },
    "error-callback": () => { btn.disabled = false; btn.textContent = "使用 Google 登入"; },
  });
}

/* ============ boot:登入判斷 ============ */
/* ============ PWA:安裝資格與提示 ============ */
// SW 零快取(見 sw.js 註解),存在只為安裝資格;失敗無妨,app 照常
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
let deferredInstall = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // Chrome 的 mini-infobar 換成我們自己的按鈕
  deferredInstall = e;
  const b = $("installBtn");
  if (b && !isStandalone()) b.hidden = false;
});
document.addEventListener("click", (e) => {
  if (e.target?.id !== "installBtn" || !deferredInstall) return;
  deferredInstall.prompt();
  deferredInstall.userChoice.finally(() => { deferredInstall = null; $("installBtn").hidden = true; });
});

(async function boot() {
  console.log("[manemu]", APP_VER, IS_IOS ? "(iOS 模式:WAV 播放)" : "");
  const verEl = $("appver"); if (verEl) verEl.textContent = APP_VER; // 真機確認跑的是哪版
  // iOS 沒有 beforeinstallprompt:登入頁給文字指引(裝了還能記住 mic 權限)
  if (IS_IOS && !isStandalone()) {
    const f = $("loginFine");
    if (f) f.textContent += "  iPhone:Safari 分享 → 加入主畫面,可全螢幕使用並記住麥克風權限。";
  }
  // 顯示層原則:永不簡中。OpenCC(cn→twp,含台灣化詞彙)為主,s2t.js 字表為載入失敗的後備。
  if (window.OpenCC) {
    try {
      const cc = window.OpenCC.Converter({ from: "cn", to: "twp" });
      window.toTrad = (s) => (s ? cc(s) : s);
    } catch (e) { console.warn("OpenCC init failed, using fallback s2t", e); }
  }
  const q = new URLSearchParams(location.search);
  if (q.get("waitlist")) {
    $("waitNotice").classList.remove("hidden");
    const em = q.get("email");
    if (em) {
      // textContent 組裝(不走 innerHTML)→ email 純當文字,無注入面
      const body = $("waitNoticeBody");
      body.textContent = "";
      const s = document.createElement("span"); s.className = "em"; s.textContent = em;
      body.append(s, " 還不在受邀名單內,已自動幫你登記。", document.createElement("br"),
                  "開通後,用同一個帳號再登入一次就能使用。");
    }
    $("ssoBtn").textContent = "換一個 Google 帳號登入";
  }
  let me = null;
  try { const r = await fetch("/api/me"); if (r.ok) me = await r.json(); } catch {}
  if (!me) {
    $("loginScreen").classList.remove("hidden");
    await mountTurnstile();
    return;
  }
  S.email = me.email; S.tier = me.tier;
  S.usedSeconds = me.usedSeconds; S.limitSeconds = me.limitSeconds;
  $("appScreen").classList.remove("hidden");
  $("usage").textContent = me.limitSeconds > 0
    ? `今日 ${Math.round(me.usedSeconds / 60)}/${Math.round(me.limitSeconds / 60)} 分`
    : `今日 ${Math.round(me.usedSeconds / 60)} 分・無上限`;
  applyLang(); renderEmpty();
  prewarmMic(true); // 不 await:權限框跳出時 UI 照常可用,拿到後 status 恢復「按住說話」

  bindPtt($("pttMe"), "me", chatUI);
  bindPtt($("pttThem"), "them", chatUI);
  bindPtt($("fpttMine"), "me", faceUI("mine"));
  bindPtt($("fpttOther"), "them", faceUI("other"));

  $("sceneBtn").addEventListener("click", () => {
    S.scene = SCENE_ORDER[(SCENE_ORDER.indexOf(S.scene) + 1) % SCENE_ORDER.length];
    $("sceneBtn").textContent = SCENES[S.scene].label;
    resetConversation();
  });
  // 語言下拉:選項文字用該語言自己的「翻成〇〇」連接詞(対 日本語 / to English / …)
  $("langBtn").innerHTML = LANG_ORDER.map((k) => `<option value="${k}">${LANGS[k].btn}</option>`).join("");
  $("langBtn").value = S.lang;
  $("langBtn").addEventListener("change", (e) => {
    S.lang = e.target.value;
    applyLang(); resetConversation();
    if (S.lang === "th" && !localStorage.getItem("mn_th_gender")) {
      $("status").textContent = "泰語句尾禮貌詞:點上方「尾詞」切換 ครับ(男)/ ค่ะ(女)";
    }
  });
  $("thGender").addEventListener("click", () => {
    localStorage.setItem("mn_th_gender", thGender() === "f" ? "m" : "f");
    applyLang();
  });
  $("mChat").addEventListener("click", () => switchMode(false));
  $("mFace").addEventListener("click", () => switchMode(true));
  function switchMode(face) {
    $("mChat").setAttribute("aria-pressed", String(!face));
    $("mFace").setAttribute("aria-pressed", String(face));
    $("chatMode").classList.toggle("hidden", face);
    $("faceMode").classList.toggle("hidden", !face);
  }
  // 快速模式 UI 已下架(S.fast 恆 false → engine 一律 accurate);relay 端仍支援,驗完再放回
  $("testChip").addEventListener("click", () => {
    S.test = !S.test;
    $("testChip").dataset.on = String(S.test);
    $("testbar").classList.toggle("hidden", !S.test);
    resetConversation();
    if (S.test) updateTestbar();
  });
  $("glossaryBtn").addEventListener("click", () => {
    const cur = localStorage.getItem("mn_glossary") || "";
    const v = prompt("行程術語表(地名/店名/航班,逗號分隔;會提供給口譯引擎):", cur);
    if (v !== null) localStorage.setItem("mn_glossary", v.slice(0, 500));
  });
  S.conv = Date.now(); // 首個對話組
  $("histBtn").addEventListener("click", () => { $("histPanel").classList.remove("hidden"); renderHistory(); });
  $("histClose").addEventListener("click", () => $("histPanel").classList.add("hidden"));
  $("histClear").addEventListener("click", async () => {
    if (!confirm("清空這台裝置上的全部翻譯紀錄?(不影響任何伺服器資料,因為本來就沒有)")) return;
    await histClear(); renderHistory();
  });
})();
