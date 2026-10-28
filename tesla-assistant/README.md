# 特斯拉助手（Model Y 2025+）

繁體中文、手機優先的 PWA 車主手冊檢索工具，適用於 GitHub Pages。

## 功能
- 匯入車主提供的 Tesla Model Y 2025+ TXT 手冊，全文關鍵字檢索。
- 顯示手冊原文、行號、相鄰內容；可複製段落。
- 手冊保留於使用者瀏覽器 localStorage，不上傳、不內嵌公開儲存庫。
- PWA 離線介面，支援 iPhone Safari「分享 → 加入主畫面」。

## 部署
此專案置於 `/tesla-assistant/`。合併至 main 並確認 GitHub Pages 設為「Deploy from a branch / main / root」後，網址為 https://wangweicg.github.io/Tesla/tesla-assistant/ 。

## 重要限制
這是**原文檢索工具，不是生成式 AI 問答服務**。不會自動回答未出現在手冊的內容。手冊版次、軟體、地區、車輛配置可能不同。充電線路與駕駛安全問題不可只依關鍵字片段判斷，應參考完整官方文件及專業人員。

GitHub Pages 為靜態主機；若日後加入真正 AI 問答，須另建安全後端與檢索服務，不能把 API 金鑰放在前端。
