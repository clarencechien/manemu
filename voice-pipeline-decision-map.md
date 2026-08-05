# 語音 / 字幕 / 翻譯管線 — 決策地圖

收斂 2026-08-05 討論。涵蓋 manemu、kvsplayer、廠區三條線的選型判準、路線圖與市場選項。

---

## 一句話結論

**預設全部用 Gemini 一體式;只有在「時間戳必須從音訊推導且要求秒級以下精度」「需可重現稽核」「需地端或資料落地」三者之一成立時,才引入專用 STT。**

成本不是理由——Gemini Flash 批次轉錄約 $0.0027/分,比 Cloud STT 即時檔位便宜五六倍,跟最便宜的批次檔位打平。理由永遠是**結構性能力**,不是單價。

---

## 判準

三個問題,依序問:

**Q1:時間戳需要從音訊推導嗎?**
- 已有 CC 軌 / 只要摘要與決議 → **不需要**,Gemini 一路到底
- 需要產字幕且無現成軌 → 進 Q2

**Q2:對嘴誤差容忍度是多少?**
- 觀眾在「讀」字幕(綜藝、教學、多數 YouTube)→ ±1 秒可接受,**Gemini 分段直讀即可**
- 觀眾在「對嘴」或需逐字對照(演講、法庭、法遵)→ 進 Q3

**Q3:需要可重現、可稽核、或地端嗎?**
- 是 → **專用 STT**,而且多半是 Speechmatics(唯一同時強在語碼轉換與地端)
- 否 → **Gemini 產內容 + 廉價 STT 做 forced alignment**(見下)

### 反直覺的兩點

1. **拆成 cascaded 會丟掉跨模態關聯。** STT 看不見畫面字卡,看不見講者指著哪張投影片。一旦音訊轉成文字,「這句話在回應畫面上那張卡」這個關係就永久消失,後面補再多 context 也回不來。
2. **對齊用的 STT 不需要準。** forced alignment 已知說了什麼,只需決定落在音軌何處,搜尋空間小一個數量級。Groq Whisper($0.0006/分)或本地 Whisper 就夠,完全不需要 phrase set 或高階模型。

---

## 三條線的定位

| | manemu | kvsplayer | 廠區(未動工) |
|---|---|---|---|
| 場景 | 旅途即時口譯 | 韓綜字幕站 | 稽核 / 參訪 / 事故檢討 |
| 第一優先 | 延遲(0.4s) | 字卡理解 + 譯文品質 | 術語零錯 + 可稽核 |
| 引擎 | Gemini Live 一體式 | Gemini 分段看片 | **Speechmatics** cascaded |
| 時間容忍 | 不適用 | ±1 秒 | 秒級以下 |
| 為何不換 | 拆開就失去語氣模仿 | 拆開就失去字卡 | 拆開才拿得到偏置與地端 |

**這三條線不該共用引擎,但該共用兩樣東西:glossary 與評測 harness。**

---

## 路線圖

### 現在就能做(無前置條件)

**A. 晶晶體評測(半天,約 $5)**
用現有 harness 跑 100 句真實會議語料,四組對照:
- Gemini 3.5 Flash 裸跑
- Gemini + 術語表塞 prompt
- **Speechmatics Ursa 1**(宣稱語碼轉換勝過次名 35%)
- Cloud STT Chirp 3 + phrase set

這份結果直接決定廠區那條線的引擎。在此之前不要寫任何生產程式碼。

**B. kvsplayer 兩趟制分離**
第一趟看片產 cue(吃影片 token),第二趟只餵 cue JSON 產摘要註解(純文字,約為第一趟的 3%)。
- 第二趟便宜到可以**換用 Pro 級模型**——最需要理解力的一步用最好的模型,最花錢的一步用最省的
- 失敗重試只重付 3%
- `♻ 免費重建` 已是這個骨架,差在讓它能指定不同 `GEMINI_MODEL`

**C. 可變 fps**
`videoMetadata` 支援自訂影格速率(`generateContent` 有,Interactions API 尚無)。
- 音訊固定 32 tok/秒,幀隨 fps 縮放
- 1 fps + MEDIUM ≈ 290 tok/秒;0.2 fps + LOW ≈ 45 tok/秒
- **對白段降 fps 省錢;字卡密集段升 fps 救召回率**——漏抓閃現字卡是 1 fps 的物理限制,調解析度救不了
- 細掃階梯因此多一種手段:同區間、高 fps 重掃

**D. manemu 回音場景實測**
未驗清單裡風險最高的一項。譯音外放會回灌麥克風,而旅途場景幾乎不可能戴耳機。優先序應在 iOS 複驗之前。

### 需要前置條件

**E. 時間戳校正(前置:住宅 IP 抓取節點)**
Gemini 產內容 → 廉價 STT 做 forced alignment → 時間戳貼齊音軌。
- 對齊鑰匙已經在你的 pipeline 裡:speech cue 的 `ko` 欄位
- **限制:`kind="card"` 對不了**,字卡無對應音訊,只能靠幀差偵測(需影片 bytes,同樣綁在此前置條件上)
- **別因此讓 Gemini 停止聽**——音訊只佔 token 一成,省不到錢,反而失去聽看互相佐證
- 住宅 IP 節點的價值因此比原估更高:它解鎖的不只是字幕軌,是整條校正路線

**F. 廠區線(前置:A 的評測結果 + 客戶資安窗口確認相機政策)**
先做離線會後逐字稿,不碰即時:
- 繞開 gRPC 在 Cloudflare Workers 上跑不起來的問題
- 批次成本只有即時的五分之一
- diarization 本來就只在批次支援

**G. 廠區即時字幕(前置:F 驗證通過 + CF 路由實測)**
HiNet 光世代因 CF 免費方案路由到 colo=SIN 會拉到 ~2 秒。旅途場景可接受,**廠內固網不可接受**——那正是會踩到的環境,且對延遲容忍度更低。這條線啟動前必須先實測付費方案的路由差異。

### 不做

- 遠端會議即時翻譯 —— 叫召集人開一個 Teams Premium 就解決了
- 自建全雙工 transport 層 —— OpenAI、Google、ByteDance、NVIDIA 都在推,一年內是商品
- 把產品定位押在「對話更自然」 —— 那是模型商的戰場,會被每季一次的版本更新輾過
- Interactions API 遷移 —— 會失去 Batch 與明確快取,而 Live 能力還沒併過來

---

## 市場選項(2026-08 現況)

### STT

| 服務 | 價格 | 特點 |
|---|---|---|
| **Speechmatics Ursa 1** | 批次約 $0.80/小時 | **語碼轉換勝次名 35%**;完整地端與私有雲部署。晶晶體 + 廠區的雙重命中 |
| Groq Whisper-Large-V3-Turbo | ~$0.0006/分 | 最便宜。forced alignment 可用(不需要準,只要時間) |
| **xAI Grok STT** | **$0.10/小時批次 / $0.20/小時串流**($0.0017 / $0.0033 每分) | **詞級時間戳 + diarization + 多聲道內建**;Inverse Text Normalization(口說數字→電話/金額/日期);25 語言(**需確認中韓**);WebSocket 串流。**forced alignment 的最佳選擇** |
| AssemblyAI Universal-2 | $0.0025/分 | 幻覺比 Whisper 少約三成;transcript intelligence 最完整 |
| Deepgram Nova-3 | $0.0043 批次 / $0.0077 串流 | 延遲與成本效率領先;Flux 專為語音代理 |
| ElevenLabs Scribe v2 | $0.004/分 | **diarization 內含不加價**;99 語言;Realtime 版 150ms / 30 語言 |
| OpenAI gpt-4o-mini-transcribe | $0.003/分 | 最便宜的量產級;gpt-4o-transcribe $0.006/分 |
| Google Cloud STT V2 (Chirp 3) | $0.016/分即時;**Dynamic Batch ~$0.003**(24 小時內回) | phrase set 偏置、資料落地(含新加坡)、CMEK、On-Prem 版 |
| Azure AI Speech | $0.017/分即時 | Custom Speech;HIPAA |
| AWS Transcribe | $0.024/分,500 萬分鐘以上降至 $0.0078 | Call Analytics |
| **Gemini 3.5 Flash(批次)** | **~$0.0027/分** | 同時聽 + 看 + 譯;無詞級時間戳 |

**計費陷阱**:Cloud STT 每個請求進位到 2 秒——PTT 逐句送的短請求受害最重;多聲道乘聲道數;重試與重疊音訊照算。

### TTS

| 服務 | 價格 | 特點 |
|---|---|---|
| Cartesia Sonic-3 / 4 | $0.011 / 1K 字元 | **最快**,TTFA 約 40–90ms;SSM 架構,P99 尾延遲穩;15+ 語言 |
| Speechmatics | $0.011 / 1K 字元 | 同價位,測試時聽到的聲音就是上線的聲音 |
| Google Standard / WaveNet | $4 / 1M 字元 | 最便宜;Chirp 3 HD $30/1M;自訂發音、語速停頓控制 |
| Amazon Polly Standard | $4 / 1M 字元 | AWS 整合 |
| Deepgram Aura-2 | $30 / 1M 字元 | 90ms;STT+TTS 同一家降低整合複雜度 |
| ElevenLabs | Flash/Turbo $60/1M;Multilingual v2/v3 $120/1M | 品質與情感表現最強;**貴 11–27 倍**;Flash v2.5 約 75ms |
| Google Instant Custom Voice | $60 / 1M 字元 | 聲音複製,支援跨語系轉移 |
| xAI Grok TTS | $4.20 / 1M 字元 | 5 種聲音、20 語言;行內表情標籤([laugh]、[sigh]、耳語);單次上限 15,000 字元 |

### 即時翻譯 / 全雙工

| 服務 | 狀態 | 備註 |
|---|---|---|
| **Gemini Live**(`gemini-3.1-flash-live-preview`) | **有 API** | manemu 現用。原生 audio-to-audio、WebSocket 全雙工、輸入輸出皆有轉錄稿 |
| Gemini 3.5 Live Translate | 有 API,preview | 語音語言對數說法互相矛盾,採用前必查官方語言表 |
| OpenAI GPT-Live-1 | **無 API**(2026/07/08 上線,僅 ChatGPT 消費端) | 排除 Business/Enterprise/Edu workspace。可當驗證工具,不能當產品 |
| gpt-realtime-translate | 有 API,$0.034/分 | manemu 評測中表現最差(災難率 22%) |
| xAI Grok Voice Think Fast 2.0 | 有 API,**$0.08/分** | speech-to-speech;WebSocket/WebRTC、伺服器端 turn detection、自訂聲音、Grok 原生工具。Artificial Analysis 語音對語音指數 82.9%,落後 Qwen Audio 3.0 Realtime Plus 的 84.1%。**無視訊輸入**。同一套技術驅動 Tesla 車內與 Starlink 客服 |
| ByteDance Seeduplex | 豆包內建 | 中文全雙工,誤回應與誤打斷率比自家上一代降約五成 |
| Teams Premium / Copilot | 授權制 | 翻譯字幕 31 語言,**召集人一人有授權全體可用**;Interpreter agent 需人人授權 |
| Google Meet | Workspace + Gemini 附加元件 | 字幕 69 語言;語音翻譯僅 5 個語言對,**不含中日** |

### 你自己的評測數據(勿忘)

三引擎 × 五語全量評測結論:

| | 通用 Live + 口譯 prompt | translate 專用模式 | gpt-realtime-translate |
|---|---|---|---|
| adequacy | **4.85–4.88** | 4.55–4.61 | 3.84–4.02 |
| 災難率 | **0.7–2%** | 8% | 22% |
| 問句保留 | **98.6–99.3%** | 91% | 83% |

**通用模型 + prompt 勝過專用翻譯模式。** 這個結論可能可以外推到其他選型:專用模式是黑盒,通用模型才塞得進你的術語與語域約束。

---

## 五條帶得走的原則

1. **重試成本是非線性的。** LLM 重試等於重付整段媒體 ingest,ASR 重試幾乎免費。你那 NTD 200 的學費就是這個。退避階梯與收尾訊號不是防呆,是成本控制的核心。

2. **窮舉性是永久的稅。** ASR 單調掃過不會漏;LLM 會跳段,而且跳得自然到不對照看不出來。全用 Gemini 不是省掉工程,是把工程從**編排**移到**驗證**。

3. **真正的資產是評測 harness,不是任何一條管線。** 當架構收斂成「一次呼叫做完所有事」,就沒有中間層可以除錯了,唯一能守住品質的是快速量測的能力。

4. **glossary 的累積單位決定它值不值錢。** 工廠(同一批料號、同樣那些人)與單一頻道會複利;跨領域內容不會。per-channel 是對的切法,別為了「支援更多影片」改成全域詞表。

5. **護城河是「聽辨領域詞」與「說得像台灣人」,不是翻譯品質本身。** 你自己的數據已經證明:24 筆災難有 23 筆來自聽,不是譯。而三大會議平台都不給自訂術語表——那是它們不打算補的洞。
