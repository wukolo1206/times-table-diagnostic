/* fact-quiz.js — 作答介面元件
 *
 * 只做 DOM 接線與事件蒐集，所有判斷呼叫 FactCore。
 * 需要真實 DOM，因此由 e2e.spec.py 測，不進 node 測試。
 *
 * 設計依據：docs/superpowers/specs/2026-08-28-times-table-diagnostic-design.md v1.2 第 8.1 節
 */
(function (root) {
  'use strict';
  var C = root.FactCore;

  /**
   * 雙 rAF：第一次 callback 在重繪前，第二次才接近實際上屏（4.5）。
   * 單次 rAF 會把畫面尚未顯示的那一幀也算進反應時間。
   */
  function afterPaint(fn) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { fn(performance.now()); });
    });
  }

  /**
   * 建立一題的作答控制器。
   *
   * opt: {
   *   cell: {a, b},
   *   timeoutMs,               預設 FactCore.TIMEOUT_MS
   *   onFinish(result)         result = {a, b, ans, ok, ms, flags}
   * }
   */
  function createQuestion(opt) {
    var cell = opt.cell;
    var timeoutMs = opt.timeoutMs || C.TIMEOUT_MS;

    var shownAt = null;
    var firstKeyAt = null;
    var firstKeyDigit = null;
    var buffer = '';
    var hidden = false;
    var rotated = false;
    var done = false;
    var timer = null;

    function onVisibility() { if (document.hidden) hidden = true; }
    function onBlur() { hidden = true; }
    function onOrient() { rotated = true; }

    function attach() {
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('blur', onBlur);
      window.addEventListener('orientationchange', onOrient);
    }

    function detach() {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('orientationchange', onOrient);
      if (timer) { clearTimeout(timer); timer = null; }
    }

    function finish(timedOut) {
      if (done) return;
      done = true;
      detach();

      var ans = buffer === '' ? null : Number(buffer);
      var t = C.evaluateTiming({
        shownAt: shownAt,
        firstKeyAt: firstKeyAt,
        submitAt: performance.now(),
        firstKeyDigit: firstKeyDigit,
        finalAnswer: buffer,
        hidden: hidden,
        rotated: rotated,
        timedOut: timedOut
      });

      opt.onFinish({
        a: cell.a, b: cell.b,
        ans: ans,
        ok: timedOut ? null : (ans === cell.a * cell.b ? 1 : 0),
        ms: t.ms,
        flags: t.flags
      });
    }

    /** 題目已上屏，開始計時。 */
    function start() {
      attach();
      afterPaint(function (t) {
        shownAt = t;
        timer = setTimeout(function () { finish(true); }, timeoutMs);
      });
    }

    /** 按下 0–9。只有數字鍵會設定 firstKeyAt（4.4）。 */
    function pressDigit(d) {
      if (done || shownAt === null) return buffer;
      if (buffer.length >= 2) return buffer;      // 九九乘法答案最多兩位
      if (firstKeyAt === null) {
        firstKeyAt = performance.now();
        firstKeyDigit = String(d);
      }
      buffer += String(d);
      var out = buffer;
      if (buffer.length === 2) finish(false);     // 兩位數輸入滿即自動送出
      return out;
    }

    /** 清除。不影響 firstKeyAt——首鍵時間是既成事實，清掉不能重來。 */
    function clear() {
      if (done) return buffer;
      buffer = '';
      return buffer;
    }

    /** 送出（一位數答案用）。無輸入時不動作。 */
    function submit() {
      if (done || buffer === '') return;
      finish(false);
    }

    return {
      start: start,
      pressDigit: pressDigit,
      clear: clear,
      submit: submit,
      value: function () { return buffer; },
      isDone: function () { return done; }
    };
  }

  /* ---- 裝置反應基準（設計文件 4.5） ---- */

  /**
   * 5 次「畫面變色就按」。回傳中位數。
   * 這個值只存進場次 metadata、只在呈現層使用，
   * 絕不修改任何一題的原始 ms（D3）。
   */
  function createBaseline(opt) {
    var trials = opt.trials || 5;
    var results = [];
    var shownAt = null;
    var waiting = false;

    function next() {
      if (results.length >= trials) {
        opt.onFinish(C.median(results));
        return;
      }
      waiting = true;
      opt.onWait();
      // 隨機延遲後才變色，避免學生抓節奏預先按
      setTimeout(function () {
        if (!waiting) return;
        opt.onGo();
        afterPaint(function (t) { shownAt = t; });
      }, 700 + Math.random() * 1300);
    }

    function press() {
      if (!waiting) return;
      if (shownAt === null) {         // 還沒變色就按 → 這次不算
        opt.onTooEarly();
        waiting = false;
        setTimeout(next, 600);
        return;
      }
      results.push(performance.now() - shownAt);
      shownAt = null;
      waiting = false;
      opt.onHit(results.length, trials);
      setTimeout(next, 500);
    }

    return { start: next, press: press };
  }

  /* ---- 進度暫存與續作（設計文件 8.1） ---- */

  var PROGRESS_KEY = 'ttd_progress_v1';

  function saveProgress(state) {
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(state)); return true; }
    catch (e) { return false; }
  }

  function loadProgress() {
    try {
      var raw = localStorage.getItem(PROGRESS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function clearProgress() {
    try { localStorage.removeItem(PROGRESS_KEY); } catch (e) { /* 忽略 */ }
  }

  root.FactQuiz = {
    afterPaint: afterPaint,
    createQuestion: createQuestion,
    createBaseline: createBaseline,
    saveProgress: saveProgress,
    loadProgress: loadProgress,
    clearProgress: clearProgress,
    PROGRESS_KEY: PROGRESS_KEY
  };
})(typeof self !== 'undefined' ? self : this);
