// 部署時執行(wrangler build.command):把 opencc-js 的 UMD bundle 拷進 public/vendor/。
// npm 依賴走 ^ 範圍 → 每次 push 部署自動帶入上游更新(原則:顯示層永不簡中)。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "node_modules/opencc-js/dist/umd/cn2t.js");
const dstDir = path.join(root, "public/vendor");
fs.mkdirSync(dstDir, { recursive: true });
fs.copyFileSync(src, path.join(dstDir, "opencc-cn2t.js"));
const ver = JSON.parse(fs.readFileSync(path.join(root, "node_modules/opencc-js/package.json"), "utf8")).version;
fs.writeFileSync(path.join(dstDir, "VERSION.txt"), `opencc-js ${ver}\n`);
console.log(`vendored opencc-js ${ver} → public/vendor/opencc-cn2t.js`);
