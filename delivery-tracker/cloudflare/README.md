# Cloudflare 免費雲端版本

以 Workers 執行 HTTP／排程、D1 保存資料。不需要 Render、付費磁碟或持續開機的電腦。這是原 Node 版本的另一個部署目標，沒有社群功能。

**「免費」指在 Cloudflare Workers Free／D1 免費額度內使用，不保證 Tesla Fleet API 免費，也不保證 Tesla 接受 `workers.dev` 應用網域。** 尚未以使用者真實帳號、Cloudflare 免費方案的實際 CPU 限制或 Tesla 網域註冊完成端到端驗證。若 Tesla 要求付款設定或不接受免費子網域，請先停止，確認後再決定；本程式不會替使用者加購網域、調高消費額度或升級方案。

## 手機操作：從 GitHub 部署

先合併此版本 PR，再操作 Cloudflare 控制台：

1. 在目前畫面按 **Create app**。
2. 選 **Continue with GitHub／Import a repository**（匯入 GitHub 專案），授權存取 `WANGWEICG/Tesla`。不要選靜態檔案拖放上傳或 Docker。
3. 選 `WANGWEICG/Tesla`，使用 `main` 分支，依下表填寫。

| 欄位 | 值 |
| --- | --- |
| Worker／Project name | `tesla-delivery` |
| Root directory | `delivery-tracker/cloudflare` |
| Build command（可留空；Wrangler 會執行內建 build） | `node build.mjs` |
| Deploy command | `npx --yes wrangler@4.158.0 deploy` |
| Branch | `main` |
| 方案 | Workers Free |

Worker 名稱必須與 `wrangler.jsonc` 的 `name` 相同。若名字被使用，先回到 GitHub 改設定中的 `name`，再用相同名稱建立；不要在控制台單獨改名。

4. 保留 Free 方案，執行部署。Wrangler 自動建立並綁定 D1，無須手動複製 Database ID。此設定只宣告 Workers、D1 與 Cron，不包含付費 Containers 或 R2。
5. 成功後開啟 `https://tesla-delivery.你的帳戶子網域.workers.dev`。如果第一次要求建立 Workers 子網域，使用 Cloudflare 提供的免費 `workers.dev` 子網域。
6. 尚未設定環境變數時，首頁會顯示設定說明。點 **產生密碼與金鑰**（或開啟同網址的 `/setup`）。點 **產生一組新值**，複製 APP_PASSWORD 與 DATA_KEY 並自行保存，別貼到聊天或 GitHub。
7. 到此 Worker → **Settings → Variables and Secrets** 新增下列**執行期設定**（不是 Build variables）：

| 名稱 | 類型 | 值 |
| --- | --- | --- |
| `APP_PASSWORD` | Secret | 設定頁產生的私人存取密碼 |
| `DATA_KEY` | Secret | 設定頁產生的 64 位十六進位金鑰 |
| `PUBLIC_URL` | Text | 你的完整 `https://…workers.dev` origin，不加其他路徑 |

8. 儲存並部署變更，再打開首頁，用 APP_PASSWORD 登入。此時可使用檢查表，Tesla 帳號尚未連接。

設定頁只在瀏覽器用 Web Crypto 產生亂數，不把產生值送至伺服器、不存在 localStorage。離開頁面會遺失未保存的值。不要在已設定完成後重新產生並覆蓋 DATA_KEY，否則已保存授權無法解密。

## Tesla 授權設定：可以全程用手機

### 若已填到「組建變數」，不必搬移或重打密碼

可選用專門的部署指令，將組建環境中原本的 APP_PASSWORD、DATA_KEY、PUBLIC_URL 作為同一 Worker 的執行時 Secrets 一起部署：

```sh
node delivery-tracker/cloudflare/deploy.mjs
```

以上指令以儲存庫根目錄為基準，適用沒有另外設定 Root directory 的 Cloudflare Builds。若 Root directory 已設成 `delivery-tracker/cloudflare`，則填 `node deploy.mjs`。組建命令維持原設定即可。

此流程使用 Wrangler 官方的 `deploy --secrets-file`；只複製三項指定值，未列出的既有 Secrets 由 Wrangler 保留。PUBLIC_URL 在此路徑也作為 Secret 保存，程式讀取方式相同。腳本不產生新金鑰、不顯示值、不將值提交到 GitHub，而是使用權限 0600 的組建暫存檔，部署結束後清除。執行前會驗證格式，缺值就停止。請維持三項組建值與目前實際使用值相同；未來修改它們後重新部署，也會更新相應執行時設定。

此流程需要 Cloudflare Builds 的部署 API 權杖允許上傳 Worker 與 Secrets；若平台拒絕，保留錯誤碼協助判斷，不要貼出 API Token。此腳本不會替使用者變更權限。

1. 在 [Tesla Developer](https://developer.tesla.com/) 建立應用，依官方要求填寫資料。
2. Allowed origin：你的 `PUBLIC_URL`。Redirect URI：`PUBLIC_URL/auth/callback`。選取 `openid offline_access user_data`，不需要控制車輛權限。
3. 在 Cloudflare 的 **Variables and Secrets** 新增 `TESLA_CLIENT_ID`（Text 或 Secret）與 `TESLA_CLIENT_SECRET`（Secret），儲存並部署。
4. 先在瀏覽器開啟 `PUBLIC_URL/.well-known/appspecific/com.tesla.3p.public-key.pem`，確認看到公開金鑰。這會使用 Web Crypto 建立 P-256 金鑰並持久化至 D1，私鑰以 DATA_KEY 加密。
5. 返回工作台 → 連線設定 → **註冊 Tesla 應用網域**。這會在後端取得 Partner Token 並呼叫區域註冊端點，不需在手機執行終端指令，也不向前端提供 Token。
6. 註冊成功後按 **前往 Tesla 官方授權**。登入與 MFA 均在 Tesla 官方網站完成。
7. 首次成功同步後核對訂單編號與 VIN。若缺少交期、船名或配置欄位，仍顯示「未提供」。

網域註冊是否接受 `workers.dev`、訂單權限與欄位是否完整，仍須真實帳號驗證。若官方回傳 400／403，先核對 origin、回呼、區域與應用資格；不要視為必須花錢就能解決。若 402，先確認 Tesla 帳務，本程式不會自動開通付費。

## 排程與免費額度

- `wrangler.jsonc` 內有 `*/30 * * * *`，每 30 分鐘觸發（以 UTC 排程，台灣同樣每半小時）。新增／修改 Cron 可能需約 15 分鐘傳播。
- 訂單未連接時不呼叫 Tesla。連接後預設每日最多約 48 次排程查詢，另加手動同步、初次連接及必要 Token 更新。
- 若自訂 `POLL_MINUTES`（Text），可設 30–1440。Cron 仍每半小時觸發，實際查詢依間隔跳過；例如 60 表示每小時查詢。手動同步至少間隔一分鐘。
- 401 會清除本服務授權，需本人重新連接；429 會將退避時間保存到 D1，重建執行個體不會繞過退避。
- Cloudflare 免費額度是帳號所有應用共用。超出額度可能停止服務；請保留 Free 方案，不需為本程式主動升級。
- Free Worker 有 CPU 時間限制。測試涵蓋程式邏輯與 Wrangler 打包，實際免費方案的 CPU、網域及上游可用性仍需部署後驗證。單次最多支援 10 筆有效訂單，超過時保留既有資料並顯示錯誤，不會靜默截斷。
- Cron 成功與否可在控制台的 Cron 事件及私人頁面的最後成功時間核對。日誌預設停用，以減少 OAuth 回呼網址被記錄；如自行啟用日誌，不要公開包含授權參數的紀錄。

## 安全與資料

使用原版前端與資料模型；Token／註冊私鑰 AES-GCM 加密，訂單／歷史明文保存在私人 D1。Worker 不提供 D1 資料的公開分享。

Token 更新、授權交換與註冊使用 D1 的原子租約鎖，支援不同 Workers 執行個體。所有寫入帶 owner fence；「中斷背景同步」在同一批次刪除憑證及鎖，因此已在途中的舊 Token 更新不能重新連接帳號。登入限流也保存在 D1。

只允許 PUBLIC_URL 正式網址存取 API，POST 驗證 Origin，Cookie 使用 Secure／HttpOnly／SameSite=Lax。OAuth state 是一次性且綁定登入 session，回呼參數不會送到前端工作台。不要把 Client Secret 放進 Wrangler 公開設定或 GitHub。

與原版相同：無即時 AIS 船位、無背景 Web Push；網頁開啟時可嘗試瀏覽器通知。關閉網頁仍保存歷史，下次開啟可查看。檢查表與備註只保存在該瀏覽器，可匯出。

Cloudflare 與 Node 版本不會自動共用或搬移資料；舊版未部署過則無資料需要搬移。若已使用 Node 版本，先匯出／備份，不要直接刪除。

要停用：在私人工作台按「中斷背景同步」，並到 Tesla 帳號管理撤銷應用權限；要完整刪除資料時，另外刪除此 Worker 專用 D1，及清除瀏覽器網站資料。

## 本機驗證（選用）

部署後不需要讓電腦持續開機。本機指令只是開發測試選項。

```sh
cd delivery-tracker/cloudflare
npm test
npx --yes wrangler@4.158.0 deploy --dry-run
```

`npm test` 以 SQLite 模擬 D1 API 驗證 SQL、OAuth、租約、斷線競態與排程，使用假的 Tesla 回應，不會連線真實帳號。Cloudflare 真實 D1／CPU 與 Tesla 授權尚需部署後驗證。

## 官方文件

- [Workers 免費額度](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1 免費額度](https://developers.cloudflare.com/d1/platform/pricing/)
- [GitHub 建置設定](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [自動建立 D1 綁定](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/)
- [Cron 排程](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Tesla 帳務與限額](https://developer.tesla.com/docs/fleet-api/billing-and-limits)
