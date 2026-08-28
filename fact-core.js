/* fact-core.js — 九九乘法熟練度診斷 核心邏輯
 *
 * 網頁與測試共用同一份。不可把這裡的邏輯搬回 HTML 內嵌 —— 那會讓測試變成測複本。
 *
 * 設計依據：docs/superpowers/specs/2026-08-28-times-table-diagnostic-design.md v1.2
 * 純函式，無 DOM 無網路。教學用語一律留在 UI 層，這裡只回傳代碼。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FactCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---- 常數（設計文件 4.1 / 4.2 / 4.4） ---- */

  /** 明細 flags 的位元定義。旋轉不影響有效性，故不在 VALID_MASK 內。 */
  var FLAG = {
    HIDDEN: 1,            // 作答期間切分頁或鎖屏
    FIRSTKEY_CHANGED: 2,  // 首鍵與最終答案首位不符
    SLOW_SUBMIT: 4,       // 送出時間 − 首鍵時間 > 4000ms
    TOO_FAST: 8,          // ms < 250
    ROTATED: 16           // 螢幕旋轉
  };
  var VALID_MASK = FLAG.HIDDEN | FLAG.FIRSTKEY_CHANGED | FLAG.SLOW_SUBMIT | FLAG.TOO_FAST;

  var LEVEL = { UNKNOWN: 'unknown', WEAK: 'weak', SHAKY: 'shaky', FLUENT: 'fluent' };

  var DEFAULT_THRESHOLD_MS = 3000;  // T，可由老師調整
  var DERIVE_LIMIT_MS = 8000;       // L，固定
  var TIMEOUT_MS = 20000;           // 診斷模式每題軟上限
  var MIN_MS = 250;                 // 快於此必為誤觸
  var SLOW_SUBMIT_MS = 4000;        // 首鍵到送出的容許上限
  var WINDOW_BASE = 3;              // 基準組取樣窗（次診斷）
  var WINDOW_ALL = 8;               // 全量組取樣窗（次作答）
  var TENTATIVE_MAX_N = 2;          // n ≤ 2 標記為暫定
  var SPARSE_RATIO = 0.6;           // 班級熱圖有效樣本門檻

  /* ---- 格編號（設計文件 D5：a 為被乘數、b 為乘數，不可互換） ---- */

  function assertOperand(v, name) {
    if (!Number.isInteger(v) || v < 1 || v > 9) {
      throw new RangeError(name + ' 必須是 1–9 的整數：' + v);
    }
  }

  function cellIndex(a, b) {
    assertOperand(a, '被乘數');
    assertOperand(b, '乘數');
    return (a - 1) * 9 + (b - 1);
  }

  function cellOf(i) {
    if (!Number.isInteger(i) || i < 0 || i > 80) {
      throw new RangeError('格索引超出 0–80：' + i);
    }
    return { a: Math.floor(i / 9) + 1, b: (i % 9) + 1 };
  }

  function allCells() {
    var out = [];
    for (var i = 0; i < 81; i++) out.push(cellOf(i));
    return out;
  }

  /** Fisher–Yates。亂數來源注入，測試才能確定性驗證。就地打亂並回傳同一個陣列。 */
  function shuffle(arr, rnd) {
    var r = rnd || Math.random;
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /* ---- 有效性與單題等級（設計文件 4.2 / 4.4） ---- */

  /** 旋轉不影響有效性，故只比對 VALID_MASK。 */
  function isValid(flags) {
    return ((flags || 0) & VALID_MASK) === 0;
  }

  /**
   * 單題等級。答錯與逾時一律 WEAK，不看時間。
   * 「答對但超過 L」等級判 WEAK（那不是提取，是推導），但正確率統計仍算答對——
   * 兩者是不同指標，呼叫端不可用等級去推正確率。
   */
  function gradeAttempt(a, thresholdMs) {
    var T = thresholdMs || DEFAULT_THRESHOLD_MS;
    if (a.ok !== 1) return LEVEL.WEAK;          // 答錯（0）或逾時（null）
    if (a.ms === null || a.ms === undefined) return LEVEL.WEAK;
    if (a.ms > DERIVE_LIMIT_MS) return LEVEL.WEAK;
    if (a.ms < T) return LEVEL.FLUENT;
    return LEVEL.SHAKY;                          // T <= ms <= L
  }

  /* ---- 聚合（設計文件 4.3） ---- */

  function median(nums) {
    if (!nums.length) return null;
    var s = nums.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /**
   * 單格聚合。attempts 須為「已依作答時間排序並取好窗」的陣列。
   * 呼叫端負責決定納入哪些場次與取多少筆（見 buildSnapshot）。
   */
  function aggregateCell(attempts, thresholdMs) {
    var T = thresholdMs || DEFAULT_THRESHOLD_MS;
    var valid = attempts.filter(function (a) { return isValid(a.flags); });
    var n = valid.length;
    if (n === 0) return { n: 0, correct: 0, med: null, lv: LEVEL.UNKNOWN, tent: false };

    var tent = n <= TENTATIVE_MAX_N;
    var bad = valid.filter(function (a) { return a.ok !== 1; }).length;
    var correct = valid.filter(function (a) { return a.ok === 1; }).length;

    // 過半且至少 2 次 → 直接判不會，不看時間
    if (bad >= Math.ceil(n / 2) && bad >= 2) {
      return { n: n, correct: correct, med: null, lv: LEVEL.WEAK, tent: tent };
    }

    var oks = valid.filter(function (a) {
      return a.ok === 1 && a.ms !== null && a.ms !== undefined;
    }).map(function (a) { return a.ms; });

    // 沒有任何可用的答對筆（例：n=1 且答錯）
    if (!oks.length) {
      return { n: n, correct: correct, med: null, lv: LEVEL.WEAK, tent: tent };
    }

    var med = median(oks);
    var lv = gradeAttempt({ ok: 1, ms: med, flags: 0 }, T);
    return { n: n, correct: correct, med: med, lv: lv, tent: tent };
  }

  /* ---- 明細編解碼（設計文件 表 1） ---- */

  function encodeDetail(items) {
    return items.map(function (it) {
      return [it.a, it.b, it.ans, it.ok, it.ms, it.flags];
    });
  }

  function decodeDetail(rows) {
    return rows.map(function (r) {
      return { a: r[0], b: r[1], ans: r[2], ok: r[3], ms: r[4], flags: r[5] };
    });
  }

  /* ---- 快照建構（設計文件 4.3 / D14 / 9.5） ---- */

  /** 基準組的納入條件：課堂 × 診斷。改這裡等於改教學判斷的依據，務必對照 D4。 */
  function isBaseSession(s) {
    return s.mode === 'diagnostic' && s.context === 'class';
  }

  function emptyCells() {
    var out = [];
    for (var i = 0; i < 81; i++) {
      out.push({ n: 0, correct: 0, med: null, lv: LEVEL.UNKNOWN, tent: false });
    }
    return out;
  }

  /**
   * 由場次陣列建出快照。
   * sessions: [{ mode, context, answeredAt, detail }]，detail 為 encodeDetail 的輸出。
   * 排序一律用 answeredAt，與到達順序無關——補送與亂序上傳不得影響結果。
   */
  function buildSnapshot(sessions, thresholdMs) {
    var T = thresholdMs || DEFAULT_THRESHOLD_MS;

    var sorted = sessions.slice().sort(function (x, y) {
      return String(x.answeredAt) < String(y.answeredAt) ? -1
           : String(x.answeredAt) > String(y.answeredAt) ? 1 : 0;
    });

    var bucket = { base: [], all: [] };
    for (var i = 0; i < 81; i++) { bucket.base.push([]); bucket.all.push([]); }

    sorted.forEach(function (s) {
      var inBase = isBaseSession(s);
      decodeDetail(s.detail || []).forEach(function (it) {
        var idx = cellIndex(it.a, it.b);
        bucket.all[idx].push(it);
        if (inBase) bucket.base[idx].push(it);
      });
    });

    // slice(-w) 保留最新的 w 筆
    var out = { base: emptyCells(), all: emptyCells() };
    for (var k = 0; k < 81; k++) {
      out.base[k] = aggregateCell(bucket.base[k].slice(-WINDOW_BASE), T);
      out.all[k] = aggregateCell(bucket.all[k].slice(-WINDOW_ALL), T);
    }
    return out;
  }

  /* ---- 班級熱圖與 Top 10（設計文件 8.2） ---- */

  /**
   * 把全班快照壓成 81 格的班級視圖。
   * snapshots: [{ base:[81], all:[81] }]，group: 'base' | 'all'
   * 未測的學生不列入 covered，也不列入 weakRatio 的分母——否則沒做過診斷的人
   * 會被當成「這格沒問題」，把熱圖洗淡。
   */
  function classHeatmap(snapshots, group) {
    var g = group === 'all' ? 'all' : 'base';
    var total = snapshots.length;
    var out = [];

    for (var i = 0; i < 81; i++) {
      var weak = 0, shaky = 0, fluent = 0, covered = 0, meds = [];
      for (var s = 0; s < total; s++) {
        var c = snapshots[s][g][i];
        if (!c || c.n === 0) continue;
        covered++;
        if (c.lv === LEVEL.WEAK) weak++;
        else if (c.lv === LEVEL.SHAKY) shaky++;
        else if (c.lv === LEVEL.FLUENT) fluent++;
        if (c.med !== null && c.med !== undefined) meds.push(c.med);
      }
      var cc = cellOf(i);
      out.push({
        index: i,
        a: cc.a,
        b: cc.b,
        weak: weak,
        shaky: shaky,
        fluent: fluent,
        covered: covered,
        total: total,
        weakRatio: covered ? (weak + shaky) / covered : 0,
        med: median(meds),
        score: weak * 2 + shaky,
        sparse: total > 0 && covered < total * SPARSE_RATIO
      });
    }
    return out;
  }

  /** 完成診斷的人數（該組中至少有一格有資料）。 */
  function classCoverage(snapshots, group) {
    var g = group === 'all' ? 'all' : 'base';
    var done = snapshots.filter(function (s) {
      return s[g].some(function (c) { return c && c.n > 0; });
    }).length;
    return { done: done, total: snapshots.length };
  }

  /** 明天要補的 Top N。sparse 格不參與排序（樣本太少，排名沒有意義）。 */
  function topWeak(heatmap, n) {
    return heatmap
      .filter(function (h) { return !h.sparse && h.score > 0; })
      .sort(function (x, y) {
        if (y.score !== x.score) return y.score - x.score;
        return (y.med || 0) - (x.med || 0);
      })
      .slice(0, n || 10);
  }

  /* ---- 反應時間與旗標（設計文件 4.4） ---- */

  /**
   * 由一題的事件時間點算出 ms 與 flags。
   *
   * ms 一律回傳算得出來的原始值，即使該題被標為無效（D3：只存原始值，
   * 篩選一律在聚合層做）。呼叫端不可因為 flags 非 0 就把 ms 改成 null。
   *
   * t: { shownAt, firstKeyAt, submitAt, firstKeyDigit, finalAnswer,
   *      hidden, rotated, timedOut }
   */
  function evaluateTiming(t) {
    if (t.timedOut || t.firstKeyAt === null || t.firstKeyAt === undefined) {
      return { ms: null, flags: 0 };
    }

    var ms = t.firstKeyAt - t.shownAt;
    var flags = 0;

    if (t.hidden) flags |= FLAG.HIDDEN;
    if (t.rotated) flags |= FLAG.ROTATED;

    // 先按一個數字再改成別的 → 首鍵時間不代表這個答案的提取時間
    var finalFirst = String(t.finalAnswer || '').charAt(0);
    if (finalFirst && String(t.firstKeyDigit) !== finalFirst) {
      flags |= FLAG.FIRSTKEY_CHANGED;
    }

    // 先亂按一個數字再慢慢想（D12 要偵測的行為）
    if (t.submitAt !== null && t.submitAt !== undefined &&
        (t.submitAt - t.firstKeyAt) > SLOW_SUBMIT_MS) {
      flags |= FLAG.SLOW_SUBMIT;
    }

    if (ms < MIN_MS) flags |= FLAG.TOO_FAST;

    return { ms: ms, flags: flags };
  }

  /* ---- 資料契約（設計文件 6.5） ---- */

  var MODES = { diagnostic: 1, practice: 1, sprint: 1 };
  var CONTEXTS = { class: 1, home: 1 };
  var STATUSES = { complete: 1, partial: 1 };
  var MAX_ITEMS = 200;
  var MAX_BYTES = 100 * 1024;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

  function bad(code, msg) { return { ok: false, code: code, msg: msg }; }

  /**
   * 伺服器與前端共用的 payload 驗證。
   * 伺服器端必須呼叫這個——前端送來的東西一律不可信。
   */
  function validateSession(p) {
    if (!p || typeof p !== 'object') return bad('BAD_PAYLOAD', 'payload 不是物件');

    var size = JSON.stringify(p).length;
    if (size > MAX_BYTES) return bad('TOO_LARGE', 'payload 超過 100KB：' + size);

    if (!p.sessionId || !UUID_RE.test(String(p.sessionId))) {
      return bad('BAD_SESSION_ID', '場次ID 必須是 UUID v4');
    }
    if (!p.classCode || !/^[A-Za-z0-9]{4,12}$/.test(String(p.classCode))) {
      return bad('BAD_CLASS_CODE', '班級代碼格式不符');
    }
    if (!Number.isInteger(p.seat) || p.seat < 1 || p.seat > 99) {
      return bad('BAD_SEAT', '座號必須是 1–99 的整數');
    }
    if (!MODES[p.mode]) return bad('BAD_MODE', '模式不在白名單');
    if (!CONTEXTS[p.context]) return bad('BAD_CONTEXT', '場合不在白名單');
    if (!STATUSES[p.status]) return bad('BAD_STATUS', '完成狀態不在白名單');
    if (!p.answeredAt || !ISO_RE.test(String(p.answeredAt))) {
      return bad('BAD_TIME', '作答時間必須是 ISO 字串');
    }

    if (!Array.isArray(p.detail) || p.detail.length === 0) {
      return bad('BAD_DETAIL', '明細必須是非空陣列');
    }
    if (p.detail.length > MAX_ITEMS) {
      return bad('TOO_MANY', '題數超過 ' + MAX_ITEMS);
    }

    for (var i = 0; i < p.detail.length; i++) {
      var r = p.detail[i];
      if (!Array.isArray(r) || r.length !== 6) {
        return bad('BAD_DETAIL', '第 ' + (i + 1) + ' 題不是六元素陣列');
      }
      if (!Number.isInteger(r[0]) || r[0] < 1 || r[0] > 9 ||
          !Number.isInteger(r[1]) || r[1] < 1 || r[1] > 9) {
        return bad('BAD_DETAIL', '第 ' + (i + 1) + ' 題乘數超出 1–9');
      }
      if (r[3] !== 0 && r[3] !== 1 && r[3] !== null) {
        return bad('BAD_DETAIL', '第 ' + (i + 1) + ' 題 ok 必須是 0/1/null');
      }
      if (r[4] !== null && (!Number.isInteger(r[4]) || r[4] < 0 || r[4] > 120000)) {
        return bad('BAD_DETAIL', '第 ' + (i + 1) + ' 題 ms 超出 0–120000');
      }
      if (!Number.isInteger(r[5]) || r[5] < 0 || r[5] > 31) {
        return bad('BAD_DETAIL', '第 ' + (i + 1) + ' 題 flags 超出範圍');
      }
    }
    return { ok: true };
  }

  /**
   * Sheets 公式注入防護。
   * 首字元為 = + - @ 時，Sheets 會把整格當公式執行；前置單引號強制為文字。
   * 任何寫入 Sheets 的使用者輸入都必須先過這一關。
   */
  function sanitizeCell(v) {
    if (v === null || v === undefined) return '';
    if (typeof v !== 'string') return v;
    return /^[=+\-@]/.test(v) ? "'" + v : v;
  }

  return {
    FLAG: FLAG,
    VALID_MASK: VALID_MASK,
    LEVEL: LEVEL,
    DEFAULT_THRESHOLD_MS: DEFAULT_THRESHOLD_MS,
    DERIVE_LIMIT_MS: DERIVE_LIMIT_MS,
    TIMEOUT_MS: TIMEOUT_MS,
    MIN_MS: MIN_MS,
    SLOW_SUBMIT_MS: SLOW_SUBMIT_MS,
    WINDOW_BASE: WINDOW_BASE,
    WINDOW_ALL: WINDOW_ALL,
    TENTATIVE_MAX_N: TENTATIVE_MAX_N,
    SPARSE_RATIO: SPARSE_RATIO,

    isValid: isValid,
    evaluateTiming: evaluateTiming,
    validateSession: validateSession,
    sanitizeCell: sanitizeCell,
    classHeatmap: classHeatmap,
    classCoverage: classCoverage,
    topWeak: topWeak,
    isBaseSession: isBaseSession,
    buildSnapshot: buildSnapshot,
    median: median,
    aggregateCell: aggregateCell,
    gradeAttempt: gradeAttempt,

    cellIndex: cellIndex,
    cellOf: cellOf,
    allCells: allCells,
    shuffle: shuffle,
    encodeDetail: encodeDetail,
    decodeDetail: decodeDetail
  };
});
