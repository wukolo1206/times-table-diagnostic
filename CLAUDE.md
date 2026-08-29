---
project: 九九乘法熟練度診斷
category: 康軒數學
status: 已上線，待實機平板驗證
version: 0.5.0
url: https://wukolo1206.github.io/times-table-diagnostic/
next_action: 用實機平板＋校內網路完成一次真實作答上傳（CORS 桌機測過不算數），再安排一個班試教
updated: 2026-08-29
---

# CLAUDE.md — 九九乘法熟練度診斷

四年級九九乘法提取速度的線上診斷工具。核心指標是**提取速度**不是正確率——
四年級學生多半「答得出來」，問題在於是靠連加推導而非直接提取，只看對錯的熱圖會幾乎全綠。

- **設計文件：** `../docs/superpowers/specs/2026-08-28-times-table-diagnostic-design.md` v1.2
- **實作計畫：** `../docs/superpowers/plans/2026-08-28-times-table-diagnostic-phase1.md`
- **試算表：** https://docs.google.com/spreadsheets/d/1BEf4ZJaA2zNnq73e2prAvNYlsJJ_BttDUNWg4Gg8k3I/edit
- **Apps Script 專案：** `13tSg_CWU3i9ohKepVSEJjDPUrg5kYmmvW2Px7NlWrKxbqg8QuwnDotfN`
- **後端網址：** 見 `config.js`（由 `tools/deploy_gas.py` 自動維護，勿手改）
- **示範班：** 代碼 `DEMO01`、教師 PIN `1234`

## 架構

- 前端：純 HTML + CSS + 原生 JS，無框架無 build，GitHub Pages
- 後端：GAS Web App + Google Sheets 四張表
- 核心邏輯 `fact-core.js` 由 `sync-core-to-gas.py` 同步為 `gas/FactCore.gs`，**不可手動編輯後者**

| 檔案 | 責任 |
|---|---|
| `fact-core.js` | 純函式：等級判定、聚合、快照、熱圖、Top 10、反應時間、資料契約 |
| `fact-net.js` | 上傳層：座號錯開、退避重試、localStorage 佇列、`text/plain` POST |
| `fact-quiz.js` | 作答介面：雙 rAF 計時、數字鍵盤、20 秒軟上限、進度暫存 |
| `gas/Code.gs` | 後端：`doGet`／`doPost`、快照增量與全量重算、保留政策 |

## 頁面

| 檔案 | 用途 |
|---|---|
| `index.html` | 入口：班級代碼 → 選座號 |
| `diagnose.html` | 診斷作答（範圍可選、手速校準、中斷續作、提早結束、錯開上傳） |
| `sprint.html` | 精熟練習：限時搶答、答錯鎖 1.5 秒、三顆星、弱項加權抽題 |
| `me.html` | 學生個人頁：9×9 熱圖、九枚徽章、最佳紀錄、弱項清單、進步比較 |
| `teacher.html` | 教師 Dashboard：兩層熱圖、Top 10、單一學生檢視、錯誤型態、家長訊息（複製／列印）、門檻調整、CSV、代作答、刪除 |

## 測試

    python run-tests.py

四關：核心邏輯同步檢查 → `fact-core.test.js`（148）→ `fact-net.test.js`（54）→ `e2e.spec.py`（39）

部署後另外跑：

    python tools/loadtest.py <GAS_URL> LOAD01 33

## 工具

| 腳本 | 用途 |
|---|---|
| `tools/setup_sheet.py` | 建立／補建試算表四張表（只新增，不覆寫既有資料） |
| `tools/deploy_gas.py` | 建立 Apps Script 專案、上傳程式碼、更新部署，並回寫 `config.js` |
| `tools/loadtest.py` | 33 筆併發上傳與去重驗證 |
| `sync-core-to-gas.py` | 由 `fact-core.js` 產生 `gas/FactCore.gs` |

## 不能動的地方

- **`Content-Type` 必須是 `text/plain`**：改成 `application/json` 會觸發 CORS preflight，
  GAS 不回應 `OPTIONS`，上傳會全面失敗。且桌機 Chrome 上不一定重現
- **反應時間存原始毫秒**：熟練門檻只在呈現層套用。改成存「是否超時」的布林值，
  門檻一改歷史資料就作廢
- **`gas/FactCore.gs`**：由腳本產生，手改會與 `fact-core.js` 分岔
- **查詢參數不可叫 `c`**：GAS 保留該名稱，帶 `c=` 的請求進不到 `doGet` 就被回 400，
  錯誤訊息卻長得像部署失敗。班級代碼一律用 `cls`（詳見 PITFALLS）
- **7×8 與 8×7 是不同的格**：不可為了省題數合併——學生只背了一個方向的口訣
- **repo 內不得有任何學生個資**：GitHub Pages 是公開的，名單只存在 Sheets

## Phase 2 待做

~~限時衝刺、CPM、弱項練習~~（v0.4.0 已實作為 `sprint.html`）。
剩：三榜排行、全班同步衝刺、班級自助建立頁（`admin.html`）、
設計文件 7.2 的遺忘因子（需快照存每格上次作答日期）。

**精熟練習模式的設計已與使用者討論定案，見 `DECISIONS.md` 的 Phase 2 章節**
（分數當過關標準而非診斷指標、三顆星個人化門檻、答錯懲罰的兩種取捨、先驗證熱圖再做練習）。

`fact-core.js` 的快照結構已預留全量組等級供抽題使用，第二版不需改資料格式。
