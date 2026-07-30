# Infra 選型:relay 住在哪(Cloudflare vs GCP vs AWS vs VPS)

依公開資料 + 本專案實測(colo 路由、死氣)做的預測性比較,2026-07-30。
結論先講:**留在 Cloudflare Workers。** 唯一會改變答案的情境寫在 §5。

## 1. 這個工作負載長什麼樣(選型的前提)

- 長連線 WebSocket 中繼(客戶端 WS ↔ Gemini WS),單 session 10–120s
- CPU 幾乎為零(轉發音框),記憶體極小;延遲敏感(死氣 = 使用者→relay→Google 的往返疊加)
- 量小而突發;需要:金鑰隔離、SSO+配額、儲存(R2)、WAF/bot 防護
- **成本結構的關鍵**:relay 基礎設施在所有選項下都是零頭——Gemini 音訊費(~$0.023/分)
  比任何一家的運算費大 2–3 個數量級。所以這題比的是**延遲、維運、安全**,不是價格。

## 2. 實測基準(比較的錨點)

| 網路 | colo | 死氣 |
| --- | --- | --- |
| 台灣 5G(行動) | TPE | **0.4s(產品代表值)** |
| HiNet 光世代 | SIN(免費方案路由) | 2.0s |

變異全在「使用者→relay」這一段;「relay→Google」不論哪家雲都走機房骨幹,都快。

## 3. 逐選項預測

| | 使用者→relay | HiNet 問題 | 旅途(日韓/港卡) | 維運/安全 | 月固定成本 |
| --- | --- | --- | --- | --- | --- |
| **CF Workers+DO(現況)** | anycast 就近進 colo | **有**(免費 zone 被導 SIN) | 就近 colo,全好 | 全託管:WAF/Turnstile/R2/金鑰隔離/push 即部署 | $5 |
| **GCP Cloud Run(asia-east1=台灣)** | 就近 Google POP→骨幹 | **無**(HiNet↔Google 直連好) | 全部繞回台灣,+30–50ms | 要自建配額/名單(Firestore)、Cloud Armor 另計 | ~$10–15(min-instance=1 防冷啟) |
| **AWS Fargate(東京)** | 直連東京 | 無(台日 ~40ms RTT) | 日本好,其他繞東京 | 全自建,最重 | ~$15+ |
| **AWS API GW WS + Lambda** | — | — | — | **架構不成立**:Lambda 無法跨 invocation 持有對 Google 的上游 WS;每音框一次 invoke 的延遲抖動也不可接受 | — |
| **VPS(東京/台北)** | 直連 | 無 | 同 Fargate | TLS/更新/擴縮/金鑰全自己;要 WAF 就得再套 CF(路由樂透回歸) | $5–10 |

**預測死氣(依公開 RTT 資料推)**

| 網路情境 | CF(現況) | Cloud Run 台灣 | Fargate/VPS 東京 |
| --- | --- | --- | --- |
| 台灣行動 | **0.4s**(實測) | ~0.4s | ~0.5–0.6s |
| HiNet 家用 | 2.0s(實測) | **~0.4–0.5s** | ~0.5–0.6s |
| 日韓當地 eSIM | ~0.4–0.6s | ~0.5–0.7s | 日 ~0.4s / 韓 ~0.5s |
| 中華漫遊(回台出口) | ~0.5–0.7s | ~0.5–0.7s | ~0.6–0.8s |

## 4. 幾個容易誤判的點

- **「香港能用」不是 CF 獨有**:server-side relay(Google 只看到伺服器出口)在四個選項都成立。
- **Lambda 系列直接出局**不是因為貴,是因為模式不合:API GW WebSocket 的「每訊息喚一次函式」
  拿不住對 Gemini 的長連線;真要在 AWS 做就是 Fargate/EC2,那就是 VPS 命題。
- **DO 的計費恐懼不成立**:outbound WS 讓 DO 無法休眠,但 128MB × 120s 硬上限 ≈ 15 GB-s
  ≈ $0.0002/session,對定價毫無影響。
- **VPS 的隱藏成本是安全面**:金鑰住在要自己巡邏的 VM 上;為了 WAF 把 CF 套回前面,
  HiNet 路由樂透就回來了(除非 DNS-only 裸奔)。
- **Cloud Run 的真實代價**是把 Workers 送的東西一件件買回來/重寫:名單熱更新(R2)、
  per-user 序列化(DO)、Turnstile、config-as-code 部署——程式碼要動的是整個 auth/quota 層。

## 5. 什麼情況下改答案

- **「台灣家用固網」變成真實客群**(例如遠距教學/視訊口譯場景):HiNet 的 2s 不能再「接受」。
  屆時兩條路:zone 升級/Argo(付 Cloudflare 錢)或把 `/ws` 單獨搬去 Cloud Run asia-east1
  (混合架構:CF 留著做站台+auth,relay 換 GCP;程式碼只有 DO 那層要移植)。
- **Gemini 換成 Vertex AI 版**(企業合規需求):Cloud Run 同雲內呼叫會有小優勢,一併重評。
- 在那之前,旅途場景(產品主場)CF 全贏或打平,而且維運成本是零——不動。
