/* fact-net.js — 九九乘法熟練度診斷 上傳層
 *
 * 責任：決定何時送、怎麼重試、送不出去時存哪裡。
 * 網路與儲存皆由外部注入（見 createUploader），測試不碰真實 fetch/localStorage。
 *
 * 設計依據：docs/superpowers/specs/2026-08-28-times-table-diagnostic-design.md v1.2 第 9 節
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FactNet = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SLOTS = 12;            // 座號取模的槽數
  var SLOT_GAP_MS = 700;     // 每槽間隔
  var MAX_RETRY = 3;
  var RETRY_BASE_MS = [2000, 4000, 8000];

  /**
   * 上傳延遲：由座號決定，非隨機（D16）。
   * 隨機只是機率分散，35 台仍可能撞在同一秒；取模可確定性地把同槽人數壓到 3 以內。
   * 座號缺失或為 0 時才退回隨機，並由呼叫端記錄告警。
   */
  function uploadDelayMs(seat, rnd) {
    if (!Number.isInteger(seat) || seat < 1) {
      return Math.floor((rnd || Math.random)() * 8000);
    }
    return (seat % SLOTS) * SLOT_GAP_MS;
  }

  /**
   * 退避重試的等待時間。attempt 從 1 起算。
   * 必須加隨機抖動——否則第一批失敗的裝置會在 2 秒後再次同步撞擊伺服器。
   */
  function retryDelayMs(attempt, rnd) {
    if (attempt < 1 || attempt > MAX_RETRY) return null;
    var base = RETRY_BASE_MS[attempt - 1];
    return Math.round(base * (1 + (rnd || Math.random)() * 0.5));
  }

  /* ---- 待傳佇列（設計文件 9.2） ---- */

  var QUEUE_KEY = 'ttd_pending_v1';
  var QUEUE_MAX = 20;
  var QUEUE_TTL_MS = 7 * 24 * 3600 * 1000;

  /**
   * 以場次ID 為鍵的待傳佇列。
   * storage 需具備 getItem / setItem / removeItem（注入以便測試）。
   * 任何一個操作都不可拋錯——儲存不可用時整個佇列降級為「不可用」，
   * 由呼叫端改走每 10 題上傳一次的路徑（9.2 的唯一 D9 例外）。
   */
  function createQueue(storage) {
    var broken = false;

    function readAll() {
      if (broken) return {};
      try {
        var raw = storage.getItem(QUEUE_KEY);
        if (!raw) return {};
        var o = JSON.parse(raw);
        return (o && typeof o === 'object') ? o : {};
      } catch (e) {
        // 資料損毀不該讓整個作答流程掛掉，視為空佇列
        return {};
      }
    }

    function writeAll(o) {
      if (broken) return false;
      try { storage.setItem(QUEUE_KEY, JSON.stringify(o)); return true; }
      catch (e) { broken = true; return false; }
    }

    function available() {
      if (broken) return false;
      try { storage.getItem(QUEUE_KEY); return true; }
      catch (e) { broken = true; return false; }
    }

    /** 取出未過期的項目。now 可注入以測 TTL。 */
    function list(now) {
      var t = now === undefined ? Date.now() : now;
      var all = readAll(), out = [], changed = false;
      Object.keys(all).forEach(function (id) {
        var e = all[id];
        if (t - e.at > QUEUE_TTL_MS) { delete all[id]; changed = true; return; }
        out.push(e);
      });
      if (changed) writeAll(all);
      return out;
    }

    /** 回傳是否成功放入。滿了就拒絕，不丟棄任何既有資料。 */
    function push(p, now) {
      if (!available()) return false;
      var t = now === undefined ? Date.now() : now;
      var all = readAll();
      if (!all[p.sessionId] && Object.keys(all).length >= QUEUE_MAX) return false;
      all[p.sessionId] = { payload: p, at: t, tries: 0 };
      return writeAll(all);
    }

    function remove(sessionId) {
      var all = readAll();
      delete all[sessionId];
      return writeAll(all);
    }

    function markTried(sessionId) {
      var all = readAll();
      if (all[sessionId]) { all[sessionId].tries++; writeAll(all); }
    }

    /**
     * 屬於別人的殘留（共用平板）。
     * 這些資料必須先補送再清除，絕不可直接覆寫——那是另一位學生的作答紀錄。
     */
    function foreign(classCode, seat) {
      return list().filter(function (e) {
        return e.payload.classCode !== classCode || e.payload.seat !== seat;
      });
    }

    return {
      available: available,
      list: list,
      push: push,
      remove: remove,
      markTried: markTried,
      foreign: foreign
    };
  }

  /* ---- 送出（設計文件 5.2 / 9.1 / 9.3） ---- */

  function defaultSleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /**
   * 上傳器。fetchFn / storage / sleep 皆可注入，測試不碰真實環境。
   *
   * CORS 關鍵（5.2）：Content-Type 必須是 text/plain 且不可加任何自訂 header。
   * 用 application/json 或 X- 開頭的 header 會觸發 preflight，
   * 而 GAS Web App 不回應 OPTIONS，請求會在到達 doPost 之前就失敗——
   * 且在桌機 Chrome 上不一定重現，很容易到實機測試才爆。
   */
  function createUploader(opt) {
    var url = opt.url;
    var fetchFn = opt.fetchFn;
    var sleep = opt.sleep || defaultSleep;
    var queue = createQueue(opt.storage);

    function postOnce(p) {
      return fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(p),
        redirect: 'follow'
      }).then(function (res) {
        return res.text();
      }).then(function (txt) {
        return JSON.parse(txt);
      });
    }

    /**
     * 送一筆。回傳 { status: 'sent' | 'queued' | 'rejected' }。
     * 資料先進佇列再送——送出過程中裝置沒電也不會掉。
     */
    function send(p) {
      queue.push(p);

      function attempt(tryNo) {
        return postOnce(p).then(function (body) {
          if (body && body.ok) {
            queue.remove(p.sessionId);
            return { status: 'sent', dup: !!body.dup };
          }
          // 伺服器明確拒絕（資料不合契約）——重試也不會變好，直接丟棄
          queue.remove(p.sessionId);
          return { status: 'rejected', code: body && body.code };
        }).catch(function () {
          queue.markTried(p.sessionId);
          var wait = retryDelayMs(tryNo, Math.random);
          if (wait === null) return { status: 'queued' };
          return sleep(wait).then(function () { return attempt(tryNo + 1); });
        });
      }

      return attempt(1);
    }

    /** 補送佇列裡的全部項目。逐筆處理，一筆壞掉不可卡住其他筆。 */
    function flush() {
      var items = queue.list();
      var sent = 0, rejected = 0, stillQueued = 0;

      return items.reduce(function (chain, e) {
        return chain.then(function () {
          return send(e.payload).then(function (r) {
            if (r.status === 'sent') sent++;
            else if (r.status === 'rejected') rejected++;
            else stillQueued++;
          });
        });
      }, Promise.resolve()).then(function () {
        return { sent: sent, rejected: rejected, queued: stillQueued };
      });
    }

    return { send: send, flush: flush, queue: queue };
  }

  return {
    createUploader: createUploader,
    QUEUE_KEY: QUEUE_KEY,
    QUEUE_MAX: QUEUE_MAX,
    QUEUE_TTL_MS: QUEUE_TTL_MS,
    createQueue: createQueue,
    SLOTS: SLOTS,
    SLOT_GAP_MS: SLOT_GAP_MS,
    MAX_RETRY: MAX_RETRY,
    uploadDelayMs: uploadDelayMs,
    retryDelayMs: retryDelayMs
  };
});
