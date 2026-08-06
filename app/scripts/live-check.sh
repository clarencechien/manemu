#!/bin/bash
# 正式站煙霧驗證(預覽模式 + 安全防線)
B=https://manemu.ai-apps.work
p(){ printf "%-46s %s\n" "$1" "$2"; }
code(){ curl -s -o /dev/null -w "%{http_code}" "$@"; }

echo "===== 資產與版本 ====="
H=$(curl -s "$B/?nc=$RANDOM")
echo "$H" | grep -q 'id="previewBtn"' && p "登入頁有「看看介面」鍵" "✓" || p "登入頁有「看看介面」鍵" "✗"
echo "$H" | grep -o '看看介面 →' | head -1 | sed 's/^/  文案: /'
echo "$H" | grep -q 'id="previewbar"' && p "預覽橫幅 markup" "✓" || p "預覽橫幅 markup" "✗"
# 版本查詢字串跟著 index 走(寫死會打到舊快取 URL)
VQ=$(echo "$H" | grep -o 'app.js?v=[0-9]*' | head -1)
APPJS=$(curl -s "$B/$VQ")
p "index 引用 app.js" "$VQ"
p "app.js 版本標記" "$(echo "$APPJS" | grep -o 'APP_VER = "[^"]*"' | head -1)"
p "app.js 有 runDemo(離線示範路徑)" "$(echo "$APPJS" | grep -c 'async function runDemo')"
p "app.js 有 preview 防呆" "$(echo "$APPJS" | grep -c 'if (S.preview) return')"

echo; echo "===== 示範素材 ====="
p "/demo/demo.json" "$(code $B/demo/demo.json)"
curl -s "$B/demo/demo.json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);j.forEach((x,i)=>console.log('  '+(i+1)+'.',x.zh,'→',x.tx))})"
for f in d1 d2 d3; do p "/demo/$f.wav" "$(code $B/demo/$f.wav) ($(curl -sI $B/demo/$f.wav | grep -i content-length | tr -d '\r' | cut -d' ' -f2) bytes)"; done

echo; echo "===== 安全防線(未登入不得碰翻譯引擎)====="
p "/ws?lang=ja" "$(code "$B/ws?lang=ja")  ← 需 401"
p "/api/backtranslate (POST)" "$(code -X POST -H 'content-type: application/json' -d '{\"text\":\"test\",\"from\":\"ja\"}' $B/api/backtranslate)  ← 需 401"
p "/api/field-log (POST)" "$(code -X POST -d '{}' $B/api/field-log)  ← 需 401"
p "/api/client-log (POST)" "$(code -X POST -d '{}' $B/api/client-log)  ← 需 401"
p "/api/me" "$(code $B/api/me)  ← 需 401"
p "/api/admin/data" "$(code $B/api/admin/data)  ← 需 401"
p "workers.dev 繞道" "$(code https://manemu.sw-tech.workers.dev/api/me)  ← 需 403"

echo; echo "===== PWA ====="
p "manifest.json" "$(code $B/manifest.json)"
p "icon-192" "$(code $B/icons/icon-192.png)"
p "sw.js" "$(code $B/sw.js)"
echo; echo "===== 安全 headers ====="
curl -sI "$B/" | grep -iE "content-security-policy|x-frame|x-content-type" | cut -c1-110
