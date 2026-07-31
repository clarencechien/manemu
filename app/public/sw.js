// manemu service worker——只為 PWA 安裝資格存在,刻意「零快取」:
// 部署即生效的原則優先(iOS Safari 舊快取的教訓,見 app/README);
// 離線本來就不可用(翻譯需要連線),快取殼只會製造版本不一致。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => { /* 不攔截:全部走網路 */ });
