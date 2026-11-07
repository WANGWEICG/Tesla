# 交車日誌 · Tesla Delivery

私人 Tesla 交車追蹤工具，無社群功能。程式存放 GitHub，網頁適合手機並可加入主畫面。

**不想付 Render 主機費或讓電腦持續開機：請使用 [Cloudflare Workers＋D1 部署教學](./cloudflare/README.md)。** 新版本支援免費額度內的雲端排程與持久儲存，並可在手機完成設定及區域註冊。主機免費額度不代表 Tesla API 必然免費，真實帳號與網域相容性仍需驗證。下方保留原 Node.js／Docker 部署方式。

## 本版已實作

- Tesla 官方 OAuth 授權、有效訂單同步、多筆訂單顯示。
- 持久化排程：預設每 30 分鐘輪詢，服務重新啟動後保留資料與最後查詢時間。
- VIN、狀態、交期與配置的新舊值紀錄（只記錄 API 實際回傳的欄位）。
- 基本 VIN 工廠／年式字碼對照；年式保留 30 年循環歧義，不推測電池、螢幕或馬達。
- 依訂單保存交車檢查、備註與 JSON 匯出（在瀏覽器保存，非跨裝置同步）。
- 網頁開啟期間的瀏覽器變更通知（受瀏覽器支援與權限限制）。
- 私人密碼、HttpOnly Cookie、OAuth state 驗證、同來源 POST 驗證、登入限流。
- AES-256-GCM 加密 Token 與註冊私鑰、單一同步鎖、Refresh Token 輪替先落盤。
- 自動建立公開金鑰端點，提供 Tesla 網域註冊使用。

**目前是待真實帳號驗證的第一版，並非原 App 全功能複製。** 官方訂單文件沒有保證交付欄位的完整結構。本版僅讀取官方 `/api/1/users/orders`；`deliveryWindow`、`deliveryDate` 等對應是待實測的保守映射。若台灣帳號不回傳相關欄位，顯示「未提供」。不會改呼叫未公開的 Tesla App 內部端點，也不會假裝已完成同步。

尚未提供：即時 AIS 船位、運輸船自動配對、生產階段推斷、完整硬體清單、背景 Web Push、庫存提醒、AI 助理、iOS 原生 Widget／Siri。需要對應資料服務或另行整合。有效訂單消失時保留快照並標示「已不在有效清單」，不判定已交車。

## GitHub Pages 與後端的關係

Pages 入口：`https://wangweicg.github.io/Tesla/delivery-tracker/`（PR 合併且 Pages 部署後才會存在）。

Pages 顯示設定入口，輸入已部署的 HTTPS 私人服務網址後，會開啟由後端提供的同一套完整介面。登入 Cookie 與 API 都在私人服務同一網域，避免 iPhone 封鎖第三方 Cookie。**只部署 Pages 無法同步 Tesla。** 正式使用時請將私人服務網址加入 iPhone 主畫面。

## 1. 先在電腦啟動

需求：Node.js 22.13 以上（建議 Node 24 LTS），無 npm 套件依賴。

```sh
cd delivery-tracker
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

將輸出填入 `.env` 的 `DATA_KEY`。另設定一組至少 16 字元的 `APP_PASSWORD`，這不是 Tesla 密碼。兩者請自己妥善保存，不要貼到聊天或提交 Git。

```sh
npm test
npm start
```

開啟 `http://localhost:3000`。未填 Tesla 憑證也能啟動檢查介面，但無法授權或同步。

## 2. 部署私人後端

可使用支援持久化磁碟的 Docker 主機／平台。服務必須長時間運作；會休眠的平台無法保證定時查詢。

- Docker build context 使用儲存庫內的 `delivery-tracker` 目錄。
- 建立 HTTPS 網址；`PUBLIC_URL` 設為該服務的 origin，如 `https://delivery.example.com`（不要子路徑）。
- 設定 `APP_PASSWORD`、`DATA_KEY`；掛載持久化磁碟至 `/data`，確保容器 UID 1000 可寫入。`DATA_DIR=/data`。
- `PORT=3000`，平台反向代理至此連接埠；若平台提供 PORT，依平台值設定。
- 單一執行個體。不要多個容器共用 DB，避免跨實例 Refresh Token 競態。
- 不要將 `/data` 公開或提交到 Git。備份時同時保留資料庫與加密金鑰；遺失 DATA_KEY 無法解密 Token。

```sh
docker build -t tesla-delivery .
docker volume create tesla-delivery-data
docker run --rm -p 3000:3000 --env-file .env -v tesla-delivery-data:/data tesla-delivery
```

容器自行產生並持久保存 EC 金鑰。公開金鑰會出現在：

`https://你的服務網域/.well-known/appspecific/com.tesla.3p.public-key.pem`

私鑰加密保存在資料庫，不會由 HTTP 提供。Docker 執行時可先不填 Tesla 憑證，產生 HTTPS 網址後再設定。`register.mjs` 為電腦端一次性註冊工具，不包含於正式容器。

## 3. 申請與註冊 Tesla Developer 應用

1. 至 [Tesla Developer](https://developer.tesla.com/) 建立應用，依官方要求填寫資料及處理帳務。
2. Allowed origin 設為你的後端 HTTPS origin，redirect URI 設為 `https://你的服務網域/auth/callback`。
3. 請求範圍為 `openid offline_access user_data`；本版不需要車輛控制權限。訂單範圍仍須實際帳號確認，403 時先查官方權限要求。
4. 將 Client ID 與 Secret 放進後端環境變數 `TESLA_CLIENT_ID`、`TESLA_CLIENT_SECRET`，不要放前端、網址、GitHub Pages 或版本庫。
5. 台灣使用 `TESLA_API_BASE=https://fleet-api.prd.na.vn.cloud.tesla.com`。
6. 在電腦的 `.env` 填入相同正式 PUBLIC_URL、ID、Secret 與區域，執行一次性區域註冊：

```sh
node --env-file=.env register.mjs
```

7. 開啟私人服務，輸入 APP_PASSWORD，再至「連線設定」點官方授權。登入與 MFA 均在 Tesla 官方網域完成。
8. 首次同步成功後核對訂單編號與 VIN。若交期未提供，本版不會自行填入預測值。遇到 401 需重新授權；403 檢查區域註冊／scope；402 檢查帳務；429 會延後重試。

不要將 Tesla 密碼、Client Secret、Token 或授權回呼網址貼到 Issue／聊天。程式不輸出 Tesla 的錯誤回應內容以避免洩漏。

## 資料、通知與維運

- SQLite 保存訂單與歷史明文；Token／註冊私鑰加密。應保護資料磁碟及備份，這不是全資料庫加密。
- 登出僅刪除此裝置 session，不停止排程；「中斷背景同步」才刪除本服務 Token。撤銷第三方權限需至 Tesla 帳號管理操作。
- 「中斷」仍保留訂單及歷史。完整刪除時先中斷、停止服務，再刪除專用持久化磁碟；瀏覽器檢查表需另清除此網站資料。
- 程式預設每 30 分鐘同步，可用 `POLL_MINUTES` 設定 5–1440 分鐘。手動同步最短間隔一分鐘，429 時遵守退避。
- 網頁每分鐘讀取自己後端的狀態，不會因此每分鐘呼叫 Tesla；關閉頁面仍有後端排程，但不會收到背景推播。
- 未註冊 Service Worker，避免離線快取私人 API 或 OAuth 回呼。加入主畫面需要線上使用。
- 檢查紀錄匯出含使用者備註；請自行保存。完整歷史保存在後端，介面最多讀取最近 300 筆。
- 不使用第三方前端 CDN、分析器、社群功能，也不公開訂單分享。

## 驗證

`npm test` 使用假的 Tesla HTTP 回應驗證安全邊界、OAuth、Token 輪替、同步差異、限流與中斷，不會連線真實 Tesla。尚需正式 HTTPS、已註冊憑證與本人授權才能完成端到端驗證。瀏覽器通知及 iPhone 加入主畫面亦需實機檢查。

## 官方依據

- [有效訂單端點](https://developer.tesla.com/docs/fleet-api/endpoints/user-endpoints)
- [第三方 OAuth 與 Refresh Token](https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens)
- [區域](https://developer.tesla.com/docs/fleet-api/getting-started/regions-countries)
- [網域公開金鑰與註冊](https://developer.tesla.com/docs/fleet-api/getting-started/what-is-fleet-api)
- [Partner 註冊端點](https://developer.tesla.com/docs/fleet-api/endpoints/partner-endpoints)

非 Tesla 官方產品。不包含原 App 的圖片、圖示、名稱或程式碼。
