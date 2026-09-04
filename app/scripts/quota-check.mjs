// RelaySession 的配額帳目檢查(此專案沒有測試框架,沿用 scripts/*.mjs 的慣例)。
//   node scripts/quota-check.mjs
//
// ⚠️ 範圍:只驗「帳目」—— usage / addUsage / addUnbilled / liveSeconds 的算術,
// 以及 /backtx 有沒有真的計進配額。**不驗**併發本身:讓「檢查+預扣」變原子的是
// Durable Object 的 input gate(storage await 期間不遞送其他事件),Node 重現不了。
// 這一點在 sukemu 與 bentodrop 的同類修正上也一樣,不要因為腳本綠了就以為競態被測過。
import { RelaySession } from "../src/relay.mjs";

let fail = 0;
const ok = (c, l) => { console.log(`${c ? "  ok  " : " FAIL "} ${l}`); if (!c) fail++; };
const fakeState = () => { const m = new Map(); return { storage: { get: async (k) => m.get(k), put: async (k, v) => void m.set(k, v) } }; };
const envOf = () => ({ GLOBAL_DAILY_SECONDS: "0", RELAY: { idFromName: () => 0, get: () => ({ fetch: async () => new Response("{}") }) } });

{
  const r = new RelaySession(fakeState(), envOf());
  await r.addUsage(30);
  await r.addUnbilled(45);
  const u = await r.usage();
  ok(u.used === 30, "addUsage 記進 used");
  ok(u.unbilled === 45, "addUnbilled 分開記,不混進 used");
  await r.addUsage(10);
  const u2 = await r.usage();
  ok(u2.used === 40 && u2.unbilled === 45, "兩個計數器互不干擾");
}
{
  const r = new RelaySession(fakeState(), envOf());
  ok(r.liveSeconds() === 0, "沒有進行中的 session → 0 秒");
  r.live.add({ t0: Date.now() - 5000 });
  r.live.add({ t0: Date.now() - 3000 });
  const ls = r.liveSeconds();
  ok(ls >= 7.9 && ls <= 8.5, `進行中的兩場都被算進去(約 8 秒,實得 ${ls.toFixed(1)})`);
}
{
  const r = new RelaySession(fakeState(), envOf());
  const res = await r.fetch(new Request("https://do/backtx", { method: "POST" }));
  const j = await res.json();
  ok(j.usedSeconds === 2, "/backtx 折算 2 秒計進配額(原本完全沒有上限)");
}
console.log(fail ? `\n${fail} 項失敗` : "\n全部通過");
process.exit(fail ? 1 : 0);
