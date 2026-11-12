# Auto_Coupon — 熊貓 & Uber Eats 自動領優惠券

台灣 `foodpanda` 與 `Uber Eats` 網頁版優惠券自動批次歸戶工具，支援電腦與行動裝置瀏覽器 Userscript。

> [!WARNING]
> **💻 建議使用電腦網頁版（目前主力開發）**  
> 目前專案全力專注於完善 **電腦網頁版（Chrome / Edge / Brave / Firefox + Tampermonkey / Violentmonkey）**，功能最完整、操作穩定且領券效率最高。  
> **iOS Safari 行動版（Stay / Userscripts）目前相容性較有限（實驗性支援）**：受限於 iOS WebKit 嚴格 CSP 沙盒隔離、行動版虛擬鍵盤彈出遮擋、非主動聚焦限制及 SPA 頁面架構，在部分頁面可能會有反應較慢或手動聚焦提示。若在 iPhone 上遇到問題，**強烈建議改用電腦瀏覽器開啟網頁版批次歸戶**（優惠碼存入帳號後，開啟手機原生 App 點餐即可直接套用）。

## 功能特色

- **手機優先懸浮介面（Shadow DOM 隔離）**：在 `foodpanda.com.tw` 與 `ubereats.com` 顯示可拖曳懸浮球與未嘗試的歸戶型優惠碼數量徽章，點擊展開拇指友善的底部抽屜（Bottom Sheet）。
- **跨頁面自動跳轉續跑**：在首頁或非優惠券頁面點擊「開始批次歸戶」，自動記憶待跑佇列、跳轉至該平台的優惠券頁面並自動接續執行。
- **遠端 `Coupon Feed` 自動同步 + 分類分流**：
  - **歸戶型優惠碼 (`Wallet Coupon`)**：透過真實 DOM 事件模擬與防風控隨機延遲，自動逐一填入並存入帳號優惠券匣（領入帳號後，開啟手機原生 App 點餐即可直接使用）。
  - **結帳/信用卡限定碼 (`Checkout Coupon`)**：自動分流至獨立區塊並提供「一鍵複製」，避免拿結帳限定碼塞優惠券匣失敗。
- **自由文字智慧擷取 (`Candidate Chip`)**：直接貼上 LINE 群組、部落格或新聞懶人包整段文字，自動擷取中英數優惠碼（如 `【天天省天天爽】`、`PANDA888`）並顯示為可勾選/剔除的預覽標籤。
- **本地歷史記憶與防風控保護**：自動記錄已領取與已過期優惠碼（預設略過，可開啟「強制重試」）；若遇登入過期或網站安全驗證（如 PerimeterX / Cloudflare Turnstile）立即自動暫停佇列，待人工完成驗證後可繼續執行。
- **GitHub Actions 每日定時更新**：每日台灣時間 08:00 與 20:00 自動抓取最新台灣外送優惠資訊更新 [`data/coupons.json`](./data/coupons.json)。

## 安裝方式

1. **電腦瀏覽器（強力推薦，最穩定） / Android**：
   - 電腦版 Chrome / Edge / Brave / Firefox 安裝 [**Tampermonkey**](https://www.tampermonkey.net/) 或 [**Violentmonkey**](https://violentmonkey.github.io/) 擴充功能。
   - 點擊安裝 Userscript：[**auto-coupon.user.js**](https://raw.githubusercontent.com/Muranecodes/Auto_Coupon/main/dist/auto-coupon.user.js) 即可一鍵安裝。
2. **iOS (iPhone / iPad)（實驗性支援）**：
   - 於 App Store 安裝免費擴充功能 [**Stay**](https://apps.apple.com/tw/app/stay-for-safari/id1591620171) 或 [**Userscripts**](https://apps.apple.com/tw/app/userscripts/id1463298887)，並在「設定 → Safari → 延伸功能」開啟權限。
   - 點擊安裝腳本原始連結：`https://raw.githubusercontent.com/Muranecodes/Auto_Coupon/main/dist/auto-coupon.user.js`
   - *注意：若 iOS Safari 遇操作不順，建議改用電腦版領取，資料會自動同步至外送帳號。*

## 開發與測試

本專案使用 Node.js 24 原生 TypeScript 支援與內建測試執行器（零外部執行期相依套件）：

```bash
# 執行 Seam 1 (Userscript DOM 整合測試) 與 Seam 2 (爬蟲管線測試)
npm test

# 打包單一檔案 Userscript (產出 dist/auto-coupon.user.js)
npm run build

# 手動執行優惠碼爬蟲更新 data/coupons.json
npm run scrape
```

## 領域模型與架構決策

- [GLOSSARY.md](./GLOSSARY.md) — 專案領域詞彙定義
- [ADR-0001](./docs/adr/0001-mobile-browser-userscript-over-native-app.md) — 為何採用手機瀏覽器 Userscript 而非原生或獨立 WebView App
- [ADR-0002](./docs/adr/0002-wallet-redemption-only-and-dom-simulation.md) — 為何僅於優惠券匣執行真實 DOM 模擬並分離結帳限定碼
