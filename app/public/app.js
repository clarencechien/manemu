/* manemu 前端:真實 PTT 音訊管線(mockup UI 平移,模擬層換成 relay WS)。 */
"use strict";
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============ 語言/場景(同 mockup) ============ */
const LANGS = {
  ja: { label: "日本語", btn: "対 日本語", pttThem: "押して話す", pttThemSub: "→ 中文", holdStatus: "押しながら話してください", divider: "⇅ 面對面・上側は相手用", who: "(日本語)", youWord: "あなた", themWord: "相手(中国語)" },
  en: { label: "English", btn: "to English", pttThem: "Hold to speak", pttThemSub: "→ Chinese", holdStatus: "Hold the button and speak", divider: "⇅ Face to face · top side is for them", who: "(English)", youWord: "You", themWord: "Them (Chinese)" },
  ko: { label: "한국어", btn: "한국어로", pttThem: "누르고 말하기", pttThemSub: "→ 中文", holdStatus: "버튼을 누른 채 말해 주세요", divider: "⇅ 面對面・위쪽은 상대방용", who: "(한국어)", youWord: "나", themWord: "상대(중국어)" },
};
const LANG_ORDER = ["ja", "en", "ko"];
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

const S = { lang: "ja", scene: "general", fast: false, test: false, testIdx: 0, busy: false, msgCount: 0,
            email: null, tier: null, usedSeconds: 0, limitSeconds: 0 };
const quotaLeft = () => (S.limitSeconds > 0 ? S.limitSeconds - S.usedSeconds : Infinity);

/* ============ 音訊:擷取(worklet)與播放(24k) ============ */
let audioCtx = null, mediaStream = null, workletNode = null, srcNode = null;
async function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.audioWorklet.addModule("/pcm-worklet.js");
  }
  if (audioCtx.state === "suspended") await audioCtx.resume();
}
async function startCapture(onFrame) {
  await ensureAudio();
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  srcNode = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, "pcm-downsampler");
  workletNode.port.onmessage = (e) => onFrame(e.data);
  srcNode.connect(workletNode); // 不接到 destination:只擷取不外放
}
function stopCapture() {
  try { srcNode?.disconnect(); workletNode?.disconnect(); } catch {}
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = srcNode = workletNode = null;
}
// 24kHz PCM16 佇列播放(300ms 起播 buffer,burst 到達也順)
const playQ = { chunks: [], scheduled: 0, playing: false };
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

/* ============ 一輪 PTT(核心:真 relay) ============ */
async function runUtterance({ side, ui }) {
  S.busy = true;
  try { await runUtteranceInner({ side, ui }); }
  catch (e) { console.warn("utterance failed", e); ui.status("⚠ 出了點問題,再試一次", false); }
  finally { S.busy = false; try { stopCapture(); } catch {} window.__pttRelease = null; }
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
  const ws = new WebSocket(`/ws?lang=${lang}&engine=${engine}&glossary=${encodeURIComponent(localStorage.getItem("mn_glossary") || "")}`);
  ws.binaryType = "arraybuffer";

  let ready = false, ended = false;
  const preReady = [];
  const micFrames = [];   // 測試模式要上傳
  const el = ui.begin({ side });
  let inTx = "", outTx = "", tFirstAudio = null;

  let doneStats = null, relayError = null;
  const audioB64 = []; // 供重播
  const finishPromise = new Promise((resolve) => {
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      console.log("[relay]", m.type, m.text ?? m.reason ?? "");   // 手機可接 USB/遠端主控台看
      if (m.type === "ready") { ready = true; for (const f of preReady) ws.send(f); preReady.length = 0; }
      // zh 文字顯示前過簡→正轉換(me 側的 STT、them 側的譯文);外語原樣
      if (m.type === "inTx") { inTx += m.text; el.srcEl.textContent = side === "me" ? toTrad(inTx) : inTx; }
      if (m.type === "outTx") { outTx += m.text; el.txEl.textContent = side === "me" ? outTx : toTrad(outTx); el.host?.scrollIntoView({ block: "end" }); }
      if (m.type === "audio") { if (tFirstAudio === null) tFirstAudio = performance.now(); audioB64.push(m.data); enqueuePcm(m.data); }
      if (m.type === "error") { relayError = m.message || "relay error"; resolve("error"); }
      if (m.type === "done") { doneStats = m.stats ?? null; resolve(m.reason); }
    });
    ws.addEventListener("close", () => resolve("closed"));
    ws.addEventListener("error", () => resolve("ws-error"));
  });

  let firstFrameLogged = false;
  try {
    await startCapture((frameBuf) => {
      if (ended) return;
      if (!firstFrameLogged) { firstFrameLogged = true; console.log("[mic] first frame bytes:", frameBuf?.byteLength); }
      if (!frameBuf?.byteLength) return; // 空框不送
      micFrames.push(new Uint8Array(frameBuf.slice(0)));
      if (ready && ws.readyState === 1) ws.send(frameBuf); else preReady.push(frameBuf);
    });
  } catch {
    ui.status("需要麥克風權限", false); try { ws.close(); } catch {}
    S.busy = false; return;
  }
  ui.status("聆聽中 <span class='wave'><i></i><i></i><i></i><i></i></span>", true);

  // 等放開(呼叫端在 pointerup 時呼叫 window.__pttRelease)
  await new Promise((r) => { window.__pttRelease = r; });
  ended = true;
  const tReleased = performance.now();
  stopCapture();
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "end" }));
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
  await sleep(playbackRemaining() + 100);
  el.host?.classList.remove("speaking");
  playQ.playing = false;

  // 端到端計時:speech=按住講話長度、deadAir=放開→首音、completion=放開→譯音播完、total=按下→播完
  const speechMs = Math.round(tReleased - t0);
  const completionMs = Math.round(performance.now() - tReleased);
  ui.done({ side, inTx, outTx, deadAir, speechMs, completionMs,
    lagS: ((performance.now() - t0) / 1000).toFixed(1), reason: doneStats?.finishReason }, el);
  if (outTx && audioB64.length) ui.replay?.(el, audioB64);

  // 回譯確認(me 側、非測試模式)
  if (side === "me" && !S.test && outTx) {
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
  S.busy = false;
  ui.status("按住說話", false);
  refreshUsage();
}
// PCM16 chunks(base64)→ WAV Blob URL(重播用;<audio> 在行動瀏覽器最穩)
function pcmToWavUrl(b64chunks, sampleRate) {
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
  return URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
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
  const set = (id, v) => { const b = $(id); if (b) b.disabled = v; };
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
    b.className = "badge ok"; b.textContent = "↩ 確認";
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
    status(html, busy) { st.innerHTML = html; $("fpttMine").disabled = busy; $("fpttOther").disabled = busy || S.test; },
  };
}

/* ============ PTT 綁定(pointerdown 開始、pointerup 結束) ============ */
function bindPtt(btn, side, ui) {
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (S.busy) { $("status").textContent = "稍等一下,上一句還在處理"; return; } // 不再靜默
    btn.classList.add("holding");
    try { btn.setPointerCapture?.(e.pointerId); } catch { /* 快速點放時 pointer 可能已失效,不阻斷整句 */ }
    runUtterance({ side, ui }).finally(() => btn.classList.remove("holding"));
  });
  const release = () => window.__pttRelease?.();
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("pointerleave", release);
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
  $("langBtn").textContent = `${L.btn} ▾`;
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
  renderEmpty();
  $("status").textContent = "按住說話";
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
(async function boot() {
  // 顯示層原則:永不簡中。OpenCC(cn→twp,含台灣化詞彙)為主,s2t.js 字表為載入失敗的後備。
  if (window.OpenCC) {
    try {
      const cc = window.OpenCC.Converter({ from: "cn", to: "twp" });
      window.toTrad = (s) => (s ? cc(s) : s);
    } catch (e) { console.warn("OpenCC init failed, using fallback s2t", e); }
  }
  if (new URLSearchParams(location.search).get("waitlist")) {
    $("loginFine").textContent = "這個 Google 帳號還不在受邀名單內——已幫你排上等候名單,開通後通知你。";
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

  bindPtt($("pttMe"), "me", chatUI);
  bindPtt($("pttThem"), "them", chatUI);
  bindPtt($("fpttMine"), "me", faceUI("mine"));
  bindPtt($("fpttOther"), "them", faceUI("other"));

  $("sceneBtn").addEventListener("click", () => {
    S.scene = SCENE_ORDER[(SCENE_ORDER.indexOf(S.scene) + 1) % SCENE_ORDER.length];
    $("sceneBtn").textContent = SCENES[S.scene].label;
    resetConversation();
  });
  $("langBtn").addEventListener("click", () => {
    S.lang = LANG_ORDER[(LANG_ORDER.indexOf(S.lang) + 1) % LANG_ORDER.length];
    applyLang(); resetConversation();
  });
  $("mChat").addEventListener("click", () => switchMode(false));
  $("mFace").addEventListener("click", () => switchMode(true));
  function switchMode(face) {
    $("mChat").setAttribute("aria-pressed", String(!face));
    $("mFace").setAttribute("aria-pressed", String(face));
    $("chatMode").classList.toggle("hidden", face);
    $("faceMode").classList.toggle("hidden", !face);
  }
  $("mEngine").addEventListener("click", () => {
    S.fast = !S.fast;
    $("mEngine").dataset.fast = String(S.fast);
    $("mEngine").textContent = S.fast ? "快速" : "精準";
    $("status").textContent = S.fast ? "快速模式:邊講邊翻,請盯著確認文字" : "精準模式:講完約 1 秒出譯音";
  });
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
})();
