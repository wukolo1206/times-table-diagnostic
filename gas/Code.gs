/* Code.gs —— 九九乘法熟練度診斷 後端
 *
 * 設計依據：docs/superpowers/specs/2026-08-28-times-table-diagnostic-design.md v1.2
 *
 * GAS 慣例（違反會出事，不要改）：
 *   - 不可用 template literal（反引號字串）
 *   - URL 中的 // 要拆成 'https:/' + '/...'
 *   - 不可用 hash 路由，一律查詢參數
 *   - doGet 內不可呼叫會觸發 OAuth 的函式
 *
 * 驗證與聚合邏輯一律呼叫 FactCore（由 sync-core-to-gas.py 產生），
 * 不可在這裡另寫一份——兩份一定會分岔。
 */

var SHEET_ID = '1BEf4ZJaA2zNnq73e2prAvNYlsJJ_BttDUNWg4Gg8k3I';

var T_SESSION = '作答場次';
var T_CLASS = '班級設定';
var T_STUDENT = '學生名單';
var T_SNAPSHOT = '熟練度快照';

var DEDUP_CACHE_SEC = 21600;   // 6 小時，覆蓋絕大多數重試情境
var DEDUP_SCAN_ROWS = 5000;    // 掃描窗，涵蓋約 7 班 × 7 天（設計文件 9.3）
var LOCK_WAIT_MS = 30000;

var PIN_MAX_FAIL = 5;
var PIN_WINDOW_SEC = 600;      // 10 分鐘內失敗 5 次
var PIN_LOCK_SEC = 1800;       // 鎖 30 分鐘

/* ============================================================
 * 表結構
 * ========================================================== */

function sessionHeaders() {
  return ['伺服器接收時間', '作答時間', '時間偏移旗標', '場次ID', '班級代碼', '座號', '姓名',
          '模式', '場合', '完成狀態', '設定', '題數', '正確數', '逾時數', '中位反應ms',
          'CPM', '明細JSON'];
}

function classHeaders() {
  return ['班級代碼', '班級名稱', '教師PIN', '純座號模式', '衝刺秒數', 'CPM目標',
          '熟練門檻ms', '建立日期', '啟用', '保留到期日'];
}

function studentHeaders() {
  return ['班級代碼', '座號', '姓名', '暱稱'];
}

function snapshotHeaders() {
  return ['班級代碼', '座號', '姓名', '基準組JSON', '全量組JSON', '依據場次數',
          '最後納入場次時間', '重算版本', 'stale', '更新時間'];
}

function ss_() {
  return SpreadsheetApp.openById(SHEET_ID);
}

function sheet_(name, headers) {
  var s = ss_().getSheetByName(name);
  if (!s) {
    s = ss_().insertSheet(name);
    s.appendRow(headers);
    s.setFrozenRows(1);
  }
  return s;
}

/** 手動執行一次即可建好四張表。表已由 tools/setup_sheet.py 建立，這裡是備援。 */
function setupSheets() {
  sheet_(T_SESSION, sessionHeaders());
  sheet_(T_CLASS, classHeaders());
  sheet_(T_STUDENT, studentHeaders());
  sheet_(T_SNAPSHOT, snapshotHeaders());
  Logger.log('四張表已就緒');
}

/** 建一個示範班級，方便開發期使用。正式班級由老師手動填（Phase 1）。 */
function seedDemoClass() {
  var cs = sheet_(T_CLASS, classHeaders());
  if (getClass_('DEMO01')) { Logger.log('DEMO01 已存在'); return; }
  cs.appendRow(['DEMO01', '示範班', '1234', false, 60, 30, 3000, new Date(), true,
                new Date(Date.now() + 400 * 24 * 3600 * 1000)]);
  var st = sheet_(T_STUDENT, studentHeaders());
  for (var i = 1; i <= 3; i++) {
    st.appendRow(['DEMO01', i, '測試' + i, '小test' + i]);
  }
  Logger.log('示範班已建立：代碼 DEMO01、PIN 1234');
}

/* ============================================================
 * 共用查詢
 * ========================================================== */

function jsonOut_(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 查班級設定，回傳物件或 null。 */
function getClass_(code) {
  var rows = sheet_(T_CLASS, classHeaders()).getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(code)) {
      return {
        code: rows[i][0], name: rows[i][1], pin: String(rows[i][2]),
        seatOnly: rows[i][3] === true, sprintSec: rows[i][4], cpmGoal: rows[i][5],
        thresholdMs: Number(rows[i][6]) || 3000, enabled: rows[i][8] === true,
        row: i + 1
      };
    }
  }
  return null;
}

/** 查學生，回傳物件或 null。姓名一律以名單為準，不採信前端。 */
function getStudent_(code, seat) {
  var rows = sheet_(T_STUDENT, studentHeaders()).getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(code) && Number(rows[i][1]) === Number(seat)) {
      return { seat: rows[i][1], name: rows[i][2], nick: rows[i][3] };
    }
  }
  return null;
}

function listClasses_() {
  var rows = sheet_(T_CLASS, classHeaders()).getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) out.push({ code: rows[i][0] });
  return out;
}

function listSeats_(classCode) {
  var rows = sheet_(T_STUDENT, studentHeaders()).getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(classCode)) out.push(Number(rows[i][1]));
  }
  return out;
}

/* ============================================================
 * 上傳（設計文件 6.5 / 9.3 / 9.4）
 * ========================================================== */

function doPost(e) {
  try {
    var p = JSON.parse(e.postData.contents);
    return jsonOut_(writeSession(p));
  } catch (err) {
    return jsonOut_({ ok: false, code: 'SERVER_ERROR', msg: String(err) });
  }
}

/** 場次ID 是否已存在。先查快取，再掃有界範圍（9.3）。 */
function seenSession_(sessionId) {
  var cache = CacheService.getScriptCache();
  if (cache.get('dedup_' + sessionId)) return true;

  var s = sheet_(T_SESSION, sessionHeaders());
  var last = s.getLastRow();
  if (last < 2) return false;

  var start = Math.max(2, last - DEDUP_SCAN_ROWS + 1);
  var rng = s.getRange(start, 4, last - start + 1, 1);   // 第 4 欄 = 場次ID
  var found = rng.createTextFinder(sessionId).matchEntireCell(true).findNext();
  return !!found;
}

function markSeen_(sessionId) {
  CacheService.getScriptCache().put('dedup_' + sessionId, '1', DEDUP_CACHE_SEC);
}

function writeSession(p) {
  // 1. 契約驗證（與前端同一份規則）
  var v = FactCore.validateSession(p);
  if (!v.ok) return v;

  // 2. 班級與學生必須真的存在（設計文件 6.5）
  var cls = getClass_(p.classCode);
  if (!cls || !cls.enabled) return { ok: false, code: 'CLASS_NOT_FOUND' };
  var stu = getStudent_(p.classCode, p.seat);
  if (!stu) return { ok: false, code: 'STUDENT_NOT_FOUND' };

  // 3. 統計由伺服器算，不採信前端送來的數字
  var items = FactCore.decodeDetail(p.detail);
  var correct = 0, timeouts = 0, msList = [];
  items.forEach(function (it) {
    if (it.ok === 1) correct++;
    if (it.ok === null) timeouts++;
    if (it.ok === 1 && it.ms !== null && FactCore.isValid(it.flags)) msList.push(it.ms);
  });
  var med = FactCore.median(msList);

  // 4. 時間偏移偵測（表 1）
  var now = new Date();
  var answered = new Date(p.answeredAt);
  var skewed = Math.abs(now.getTime() - answered.getTime()) > 24 * 3600 * 1000;

  // 5. 去重 + 寫入，只有這一段需要鎖（9.4）
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    return { ok: false, code: 'BUSY', retry: true };
  }
  try {
    if (seenSession_(p.sessionId)) {
      return { ok: true, dup: true };
    }
    sheet_(T_SESSION, sessionHeaders()).appendRow([
      now,
      p.answeredAt,
      skewed,
      p.sessionId,
      FactCore.sanitizeCell(p.classCode),
      p.seat,
      FactCore.sanitizeCell(stu.name),
      p.mode,
      p.context,
      p.status,
      JSON.stringify(p.config || {}),
      items.length,
      correct,
      timeouts,
      med === null ? '' : med,
      '',                               // CPM：Phase 2 才有
      JSON.stringify(p.detail)
    ]);
    markSeen_(p.sessionId);
  } finally {
    lock.releaseLock();
  }

  // 6. 快照更新在鎖外，盡力而為。失敗不影響回傳（9.5、D11）
  try {
    updateSnapshot_(p.classCode, p.seat, cls.thresholdMs);
  } catch (err) {
    markSnapshotStale_(p.classCode, p.seat);
  }

  return { ok: true };
}

/* ============================================================
 * 快照（設計文件 9.5 / D11 / D14）
 * ========================================================== */

/** 讀某班（或某生）全部場次，回傳 buildSnapshot 需要的格式。 */
function readSessions_(classCode, seat) {
  var rows = sheet_(T_SESSION, sessionHeaders()).getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][4]) !== String(classCode)) continue;
    if (seat !== null && seat !== undefined && Number(rows[i][5]) !== Number(seat)) continue;
    var detail;
    try { detail = JSON.parse(rows[i][16]); } catch (e) { continue; }
    if (!detail) continue;
    out.push({
      mode: rows[i][7],
      context: rows[i][8],
      // 時間偏移的那幾筆改用伺服器接收時間排序（表 1）
      answeredAt: rows[i][2] === true ? new Date(rows[i][0]).toISOString() : String(rows[i][1]),
      detail: detail
    });
  }
  return out;
}

function findSnapshotRow_(classCode, seat) {
  var rows = sheet_(T_SNAPSHOT, snapshotHeaders()).getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(classCode) && Number(rows[i][1]) === Number(seat)) {
      return i + 1;
    }
  }
  return 0;
}

function markSnapshotStale_(classCode, seat) {
  var row = findSnapshotRow_(classCode, seat);
  if (row) sheet_(T_SNAPSHOT, snapshotHeaders()).getRange(row, 9).setValue(true);
}

/** 重算單一學生的快照。冪等——重跑幾次結果都一樣。 */
function updateSnapshot_(classCode, seat, thresholdMs) {
  var sessions = readSessions_(classCode, seat);
  var snap = FactCore.buildSnapshot(sessions, thresholdMs);
  var stu = getStudent_(classCode, seat);
  var s = sheet_(T_SNAPSHOT, snapshotHeaders());
  var row = findSnapshotRow_(classCode, seat);

  var last = '';
  sessions.forEach(function (x) { if (String(x.answeredAt) > last) last = String(x.answeredAt); });

  var values = [
    FactCore.sanitizeCell(classCode),
    seat,
    FactCore.sanitizeCell(stu ? stu.name : ''),
    JSON.stringify(snap.base),
    JSON.stringify(snap.all),
    sessions.length,
    last,
    0,
    false,
    new Date()
  ];

  if (row) {
    var prevVer = Number(s.getRange(row, 8).getValue()) || 0;
    values[7] = prevVer + 1;
    s.getRange(row, 1, 1, values.length).setValues([values]);
  } else {
    values[7] = 1;
    s.appendRow(values);
  }
}

/**
 * 全班全量重算。冪等，且結果永遠是正確值——
 * 因此「夜間重算覆寫剛剛的增量更新」是預期行為，不是問題（9.5）。
 */
function rebuildSnapshots(classCode) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return;
  try {
    var classes = classCode ? [{ code: classCode }] : listClasses_();
    classes.forEach(function (c) {
      var cls = getClass_(c.code);
      if (!cls || !cls.enabled) return;
      listSeats_(c.code).forEach(function (seat) {
        updateSnapshot_(c.code, seat, cls.thresholdMs);
      });
    });
  } finally {
    lock.releaseLock();
  }
}

/** 每晚跑一次的安全網。安裝：手動執行一次 installNightlyTrigger()。 */
function nightlyRebuild() {
  rebuildSnapshots(null);
}

function installNightlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'nightlyRebuild') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('nightlyRebuild').timeBased().atHour(2).everyDays(1).create();
  Logger.log('夜間重算 trigger 已安裝（每日 02:00）');
}

/* ============================================================
 * 讀取端點（設計文件 6.6）
 * ========================================================== */

function doGet(e) {
  var action = e.parameter.action || '';
  // 參數名不可用 c —— GAS 保留該名稱，帶 c= 的請求會在進入 doGet 前就被回 400
  var code = e.parameter.cls || '';

  try {
    if (action === 'students') return jsonOut_(apiStudents(code));
    if (action === 'config') return jsonOut_(apiConfig(code));
    if (action === 'myrecord') return jsonOut_(apiMyRecord(code, Number(e.parameter.seat)));
    if (action === 'dashboard') return jsonOut_(apiDashboard(code, e.parameter.pin));
    if (action === 'deleteclass') {
      return jsonOut_(apiDeleteClass(code, e.parameter.pin, e.parameter.confirm));
    }
    return jsonOut_({ ok: false, code: 'UNKNOWN_ACTION' });
  } catch (err) {
    return jsonOut_({ ok: false, code: 'SERVER_ERROR', msg: String(err) });
  }
}

/** 學生名單。純座號模式時不回傳姓名。 */
function apiStudents(code) {
  var cls = getClass_(code);
  if (!cls || !cls.enabled) return { ok: false, code: 'CLASS_NOT_FOUND' };
  var rows = sheet_(T_STUDENT, studentHeaders()).getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== String(code)) continue;
    out.push({ seat: Number(rows[i][1]), name: cls.seatOnly ? '' : rows[i][2] });
  }
  out.sort(function (x, y) { return x.seat - y.seat; });
  return { ok: true, className: cls.name, seatOnly: cls.seatOnly, students: out };
}

/** 班級設定中學生端需要的部分。不含 PIN。 */
function apiConfig(code) {
  var cls = getClass_(code);
  if (!cls || !cls.enabled) return { ok: false, code: 'CLASS_NOT_FOUND' };
  return { ok: true, className: cls.name, thresholdMs: cls.thresholdMs,
           seatOnly: cls.seatOnly };
}

/** 單一學生的快照與診斷場次摘要。 */
function apiMyRecord(code, seat) {
  var cls = getClass_(code);
  if (!cls || !cls.enabled) return { ok: false, code: 'CLASS_NOT_FOUND' };
  var stu = getStudent_(code, seat);
  if (!stu) return { ok: false, code: 'STUDENT_NOT_FOUND' };

  var s = sheet_(T_SNAPSHOT, snapshotHeaders());
  var row = findSnapshotRow_(code, seat);
  if (!row) {
    updateSnapshot_(code, seat, cls.thresholdMs);
    row = findSnapshotRow_(code, seat);
  }
  var v = s.getRange(row, 1, 1, snapshotHeaders().length).getValues()[0];

  // stale 就即時重建（9.5）
  if (v[8] === true) {
    updateSnapshot_(code, seat, cls.thresholdMs);
    v = s.getRange(row, 1, 1, snapshotHeaders().length).getValues()[0];
  }

  return {
    ok: true,
    name: cls.seatOnly ? '' : stu.name,
    thresholdMs: cls.thresholdMs,
    base: JSON.parse(v[3]),
    all: JSON.parse(v[4]),
    diagnostics: diagnosticSummaries_(code, seat)
  };
}

/** 診斷場次的簡要清單，供個人頁做兩次比較。 */
function diagnosticSummaries_(code, seat) {
  var rows = sheet_(T_SESSION, sessionHeaders()).getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][4]) !== String(code)) continue;
    if (Number(rows[i][5]) !== Number(seat)) continue;
    if (rows[i][7] !== 'diagnostic') continue;
    out.push({
      answeredAt: String(rows[i][1]), total: rows[i][11],
      correct: rows[i][12], timeouts: rows[i][13], med: rows[i][14]
    });
  }
  out.sort(function (x, y) { return x.answeredAt < y.answeredAt ? -1 : 1; });
  return out;
}

/** PIN 節流。4 碼只有 10000 組，沒有節流等於沒有保護（6.6）。 */
function checkPin_(code, pin) {
  var cache = CacheService.getScriptCache();
  var lockKey = 'pinlock_' + code;
  if (cache.get(lockKey)) return { ok: false, code: 'PIN_LOCKED' };

  var cls = getClass_(code);
  if (!cls || !cls.enabled) return { ok: false, code: 'CLASS_NOT_FOUND' };

  if (String(pin) === cls.pin) {
    cache.remove('pinfail_' + code);
    return { ok: true, cls: cls };
  }

  var failKey = 'pinfail_' + code;
  var n = Number(cache.get(failKey) || 0) + 1;
  cache.put(failKey, String(n), PIN_WINDOW_SEC);
  if (n >= PIN_MAX_FAIL) {
    cache.put(lockKey, '1', PIN_LOCK_SEC);
    return { ok: false, code: 'PIN_LOCKED' };
  }
  return { ok: false, code: 'BAD_PIN', left: PIN_MAX_FAIL - n };
}

/** 教師 Dashboard 資料。只回傳這一班，絕不跨班。 */
function apiDashboard(code, pin) {
  var chk = checkPin_(code, pin);
  if (!chk.ok) return chk;
  var cls = chk.cls;

  var rows = sheet_(T_SNAPSHOT, snapshotHeaders()).getDataRange().getValues();
  var students = [];
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== String(code)) continue;
    students.push({
      seat: Number(rows[i][1]),
      name: cls.seatOnly ? '' : rows[i][2],
      base: JSON.parse(rows[i][3]),
      all: JSON.parse(rows[i][4]),
      sessions: rows[i][5],
      lastAt: String(rows[i][6] || ''),   // 家長通知要寫測驗日期
      stale: rows[i][8] === true
    });
  }
  students.sort(function (x, y) { return x.seat - y.seat; });

  return {
    ok: true,
    className: cls.name,
    thresholdMs: cls.thresholdMs,
    seatOnly: cls.seatOnly,
    students: students,
    anomalies: findAnomalies_(code)
  };
}

/** 異常標記供老師判斷（6.6）。不做任何自動處置。 */
function findAnomalies_(code) {
  var rows = sheet_(T_SESSION, sessionHeaders()).getDataRange().getValues();
  var bySeat = {}, out = [];
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][4]) !== String(code)) continue;
    var seat = Number(rows[i][5]);
    if (!bySeat[seat]) bySeat[seat] = [];
    bySeat[seat].push(new Date(rows[i][0]).getTime());
  }
  Object.keys(bySeat).forEach(function (seat) {
    var ts = bySeat[seat].sort(function (a, b) { return a - b; });
    for (var k = 2; k < ts.length; k++) {
      if (ts[k] - ts[k - 2] < 5 * 60 * 1000) {
        out.push({ seat: Number(seat), type: 'BURST', msg: '5 分鐘內 3 場以上' });
        break;
      }
    }
  });
  return out;
}

/* ============================================================
 * 資料保留與刪除（設計文件 6.7）
 * ========================================================== */

/**
 * 每月檢查一次。到期班級的明細清空、姓名清空，但保留統計摘要
 * （老師可能還想看歷年的整體正確率，那不含個資）。
 */
function monthlyRetentionSweep() {
  var cs = sheet_(T_CLASS, classHeaders());
  var rows = cs.getDataRange().getValues();
  var now = new Date();

  for (var i = 1; i < rows.length; i++) {
    var due = rows[i][9];
    if (!due || new Date(due) > now) continue;
    var code = String(rows[i][0]);
    purgeClassPersonalData_(code);
    cs.getRange(i + 1, 9).setValue(false);   // 順便停用
    Logger.log('已清理到期班級：' + code);
  }
}

/** 清掉個資，保留統計。 */
function purgeClassPersonalData_(code) {
  var s = sheet_(T_SESSION, sessionHeaders());
  var rows = s.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][4]) !== String(code)) continue;
    s.getRange(i + 1, 7).setValue('');    // 姓名
    s.getRange(i + 1, 17).setValue('');   // 明細JSON
  }
  clearRowsOf_(sheet_(T_STUDENT, studentHeaders()), 1, code);
  clearRowsOf_(sheet_(T_SNAPSHOT, snapshotHeaders()), 1, code);
}

/** 刪除某班在某張表的全部列（由後往前刪，否則索引會位移）。 */
function clearRowsOf_(sheet, codeCol, code) {
  var rows = sheet.getDataRange().getValues();
  for (var i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][codeCol - 1]) === String(code)) sheet.deleteRow(i + 1);
  }
}

/** 老師主動刪除本班全部資料。需要 PIN 與輸入班級代碼確認。 */
function apiDeleteClass(code, pin, confirmText) {
  var chk = checkPin_(code, pin);
  if (!chk.ok) return chk;
  if (confirmText !== code) return { ok: false, code: 'CONFIRM_MISMATCH' };

  clearRowsOf_(sheet_(T_SESSION, sessionHeaders()), 5, code);
  clearRowsOf_(sheet_(T_SNAPSHOT, snapshotHeaders()), 1, code);
  clearRowsOf_(sheet_(T_STUDENT, studentHeaders()), 1, code);
  return { ok: true };
}

function installMonthlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'monthlyRetentionSweep') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('monthlyRetentionSweep').timeBased().onMonthDay(1).atHour(3).create();
  Logger.log('每月保留檢查 trigger 已安裝');
}
