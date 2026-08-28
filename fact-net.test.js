/* fact-net.test.js — 上傳層測試
 *
 * 網路與儲存都用 stub，不碰真實 fetch/localStorage。
 * 執行：node fact-net.test.js
 */
'use strict';
var N = require('./fact-net.js');

var pass = 0, fail = 0;
function group(n) { console.log('\n── ' + n); }
function eq(label, actual, expected) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + '\n        得到 ' + a + '\n        預期 ' + e); }
}
function ok(label, cond) { eq(label, !!cond, true); }

function finish() {
  console.log('\n' + '='.repeat(50));
  console.log('  PASS ' + pass + '   FAIL ' + fail);
  console.log('='.repeat(50));
  process.exit(fail === 0 ? 0 : 1);
}

/* =============================================================
 * 1. 上傳錯開（設計文件 9.1 / D16）
 * =========================================================== */
group('1. 上傳錯開');

eq('座號 1 → 0.7 秒', N.uploadDelayMs(1), 700);
eq('座號 12 → 0 秒（12 mod 12 = 0）', N.uploadDelayMs(12), 0);
eq('座號 13 → 0.7 秒', N.uploadDelayMs(13), 700);
eq('座號 11 → 7.7 秒（最大）', N.uploadDelayMs(11), 7700);
eq('35 人的最大延遲不超過 8 秒', (function () {
  var max = 0;
  for (var s = 1; s <= 35; s++) max = Math.max(max, N.uploadDelayMs(s));
  return max;
})(), 7700);

eq('35 人分散後，同一時槽最多 3 人（D16 的目的）', (function () {
  var slots = {};
  for (var s = 1; s <= 35; s++) {
    var d = N.uploadDelayMs(s);
    slots[d] = (slots[d] || 0) + 1;
  }
  var max = 0;
  Object.keys(slots).forEach(function (k) { max = Math.max(max, slots[k]); });
  return max;
})(), 3);

eq('座號缺失時退回隨機且在 0–8 秒內', (function () {
  var d = N.uploadDelayMs(null, function () { return 0.5; });
  return d >= 0 && d <= 8000;
})(), true);
eq('座號 0 視為缺失', (function () {
  var d = N.uploadDelayMs(0, function () { return 0.99; });
  return d >= 0 && d <= 8000;
})(), true);
eq('座號為字串視為缺失', (function () {
  var d = N.uploadDelayMs('12', function () { return 0.5; });
  return d >= 0 && d <= 8000;
})(), true);

/* =============================================================
 * 2. 退避重試（設計文件 9.1）
 * =========================================================== */
group('2. 退避重試');

eq('第 1 次重試基底 2 秒', N.retryDelayMs(1, function () { return 0; }), 2000);
eq('第 2 次重試基底 4 秒', N.retryDelayMs(2, function () { return 0; }), 4000);
eq('第 3 次重試基底 8 秒', N.retryDelayMs(3, function () { return 0; }), 8000);
eq('抖動上限為基底的 1.5 倍', N.retryDelayMs(1, function () { return 1; }), 3000);
eq('抖動必須存在，否則失敗者會同步再撞一次', (function () {
  var a = N.retryDelayMs(2, function () { return 0; });
  var b = N.retryDelayMs(2, function () { return 1; });
  return b > a;
})(), true);
eq('超過最大次數回傳 null（停止重試）', N.retryDelayMs(4, function () { return 0; }), null);
eq('第 0 次回傳 null', N.retryDelayMs(0, function () { return 0; }), null);
eq('MAX_RETRY 為 3', N.MAX_RETRY, 3);

/* =============================================================
 * 3. 待傳佇列（設計文件 9.2）
 * =========================================================== */
group('3. 待傳佇列');

/** 假的 localStorage。可切換成「不可用」以測降級路徑。 */
function fakeStorage(broken) {
  var mem = {};
  return {
    getItem: function (k) { if (broken) throw new Error('blocked'); return k in mem ? mem[k] : null; },
    setItem: function (k, v) { if (broken) throw new Error('blocked'); mem[k] = String(v); },
    removeItem: function (k) { if (broken) throw new Error('blocked'); delete mem[k]; }
  };
}
// 佇列有 7 天 TTL，測試的時間戳必須用真實時基，否則會全部被判過期
var NOW = Date.now();
var DAY = 24 * 3600 * 1000;

function payload(id, seat, classCode) {
  return {
    sessionId: id, seat: seat || 12, classCode: classCode || 'A7K2Q9',
    mode: 'diagnostic', context: 'class', status: 'complete',
    answeredAt: '2026-09-01T01:00:00.000Z',
    detail: [[7, 8, 56, 1, 2140, 0]]
  };
}

eq('存入後可取出', (function () {
  var q = N.createQueue(fakeStorage());
  q.push(payload('a'), NOW);
  return q.list(NOW).map(function (e) { return e.payload.sessionId; });
})(), ['a']);

eq('同一場次ID 重複 push 不會變成兩筆', (function () {
  var q = N.createQueue(fakeStorage());
  q.push(payload('a'), NOW);
  q.push(payload('a'), NOW + 1);
  return q.list(NOW).length;
})(), 1);

eq('remove 後消失', (function () {
  var q = N.createQueue(fakeStorage());
  q.push(payload('a'), NOW);
  q.push(payload('b'), NOW);
  q.remove('a');
  return q.list(NOW).map(function (e) { return e.payload.sessionId; });
})(), ['b']);

eq('超過 7 天自動清除', (function () {
  var q = N.createQueue(fakeStorage());
  q.push(payload('old'), NOW - 8 * DAY);
  q.push(payload('new'), NOW);
  return q.list(NOW).map(function (e) { return e.payload.sessionId; });
})(), ['new']);

eq('超過 20 筆時拒絕新增並回傳 false', (function () {
  var q = N.createQueue(fakeStorage());
  for (var i = 0; i < 20; i++) q.push(payload('s' + i), NOW);
  return [q.push(payload('overflow'), NOW), q.list(NOW).length];
})(), [false, 20]);

eq('滿了但更新既有項目仍可寫入', (function () {
  var q = N.createQueue(fakeStorage());
  for (var i = 0; i < 20; i++) q.push(payload('s' + i), NOW);
  return [q.push(payload('s0'), NOW + 1), q.list(NOW).length];
})(), [true, 20]);

eq('別人的殘留資料要被找出來（9.2 共用平板）', (function () {
  var q = N.createQueue(fakeStorage());
  q.push(payload('mine', 12, 'A7K2Q9'), NOW);
  q.push(payload('other', 30, 'A7K2Q9'), NOW);
  return q.foreign('A7K2Q9', 12).map(function (e) { return e.payload.sessionId; });
})(), ['other']);

eq('不同班級的殘留也算 foreign', (function () {
  var q = N.createQueue(fakeStorage());
  q.push(payload('otherclass', 12, 'ZZZZZZ'), NOW);
  return q.foreign('A7K2Q9', 12).length;
})(), 1);

eq('foreign 不含自己的資料', (function () {
  var q = N.createQueue(fakeStorage());
  q.push(payload('mine', 12, 'A7K2Q9'), NOW);
  return q.foreign('A7K2Q9', 12).length;
})(), 0);

eq('儲存壞掉時 available 為 false，不拋錯', (function () {
  var q = N.createQueue(fakeStorage(true));
  return [q.available(), q.push(payload('a'), 1000), q.list().length];
})(), [false, false, 0]);

eq('儲存正常時 available 為 true', N.createQueue(fakeStorage()).available(), true);

eq('資料損毀時視為空佇列而非整個壞掉', (function () {
  var st = fakeStorage();
  st.setItem('ttd_pending_v1', '{壞掉的 JSON');
  var q = N.createQueue(st);
  return q.list().length;
})(), 0);

eq('重新建立佇列後資料仍在（真的有落地）', (function () {
  var st = fakeStorage();
  N.createQueue(st).push(payload('a'), NOW);
  return N.createQueue(st).list(NOW).map(function (e) { return e.payload.sessionId; });
})(), ['a']);

eq('markTried 累加次數', (function () {
  var st = fakeStorage();
  var q = N.createQueue(st);
  q.push(payload('a'), NOW);
  q.markTried('a'); q.markTried('a');
  return q.list(NOW)[0].tries;
})(), 2);

/* =============================================================
 * 4. 送出與補送（設計文件 5.2 / 9.1 / 9.3）
 * =========================================================== */
group('4. 送出與補送');

/** 假的 fetch。responses 為依序回傳的結果，'throw' 表示丟出網路錯誤。 */
function fakeFetch(responses) {
  var calls = [];
  var i = 0;
  var f = function (url, opt) {
    calls.push({ url: url, opt: opt });
    var r = responses[Math.min(i++, responses.length - 1)];
    if (r === 'throw') return Promise.reject(new Error('network down'));
    return Promise.resolve({
      ok: true,
      text: function () { return Promise.resolve(JSON.stringify(r)); }
    });
  };
  f.calls = calls;
  return f;
}
var GAS = 'https://script.google.com/macros/s/XXX/exec';
function nosleep() { return Promise.resolve(); }

(async function () {
  var f1 = fakeFetch([{ ok: true }]);
  var up1 = N.createUploader({ url: GAS, fetchFn: f1, storage: fakeStorage(), sleep: nosleep });
  var r1 = await up1.send(payload('a'));
  eq('送出成功回 sent', r1.status, 'sent');
  eq('Content-Type 必須是 text/plain（5.2，用 json 會被 preflight 擋死）',
     f1.calls[0].opt.headers['Content-Type'], 'text/plain;charset=utf-8');
  eq('不可帶任何自訂 header（5.2）',
     Object.keys(f1.calls[0].opt.headers), ['Content-Type']);
  eq('必須 follow redirect（GAS 會 302 到 googleusercontent）',
     f1.calls[0].opt.redirect, 'follow');
  eq('body 為 JSON 字串', JSON.parse(f1.calls[0].opt.body).sessionId, 'a');
  eq('method 為 POST', f1.calls[0].opt.method, 'POST');
  ok('不可帶 credentials', f1.calls[0].opt.credentials === undefined ||
     f1.calls[0].opt.credentials === 'omit');

  var f2 = fakeFetch([{ ok: true, dup: true }]);
  var up2 = N.createUploader({ url: GAS, fetchFn: f2, storage: fakeStorage(), sleep: nosleep });
  var r2 = await up2.send(payload('b'));
  eq('伺服器回 dup 視為成功（9.3）', r2.status, 'sent');
  eq('dup 有被標示出來', r2.dup, true);

  var f3 = fakeFetch(['throw', 'throw', { ok: true }]);
  var up3 = N.createUploader({ url: GAS, fetchFn: f3, storage: fakeStorage(), sleep: nosleep });
  var r3 = await up3.send(payload('c'));
  eq('前兩次失敗第三次成功', r3.status, 'sent');
  eq('總共呼叫 3 次', f3.calls.length, 3);

  var st4 = fakeStorage();
  var f4 = fakeFetch(['throw']);
  var up4 = N.createUploader({ url: GAS, fetchFn: f4, storage: st4, sleep: nosleep });
  var r4 = await up4.send(payload('d'));
  eq('重試用盡回 queued', r4.status, 'queued');
  eq('重試用盡後共呼叫 4 次（1 次原始 + 3 次重試）', f4.calls.length, 4);
  eq('資料留在佇列等下次補送', N.createQueue(st4).list().length, 1);

  var st5 = fakeStorage();
  var f5 = fakeFetch([{ ok: true }]);
  var up5 = N.createUploader({ url: GAS, fetchFn: f5, storage: st5, sleep: nosleep });
  await up5.send(payload('e'));
  eq('送出成功後佇列清空', N.createQueue(st5).list().length, 0);

  var f6 = fakeFetch([{ ok: false, code: 'BAD_SEAT' }]);
  var up6 = N.createUploader({ url: GAS, fetchFn: f6, storage: fakeStorage(), sleep: nosleep });
  var r6 = await up6.send(payload('f'));
  eq('驗證錯誤回 rejected，不重試', r6.status, 'rejected');
  eq('驗證錯誤只呼叫 1 次', f6.calls.length, 1);
  eq('錯誤碼有帶回來', r6.code, 'BAD_SEAT');

  var st7 = fakeStorage();
  var q7 = N.createQueue(st7);
  q7.push(payload('x'), NOW);
  q7.push(payload('y'), NOW);
  var f7 = fakeFetch([{ ok: true }]);
  var up7 = N.createUploader({ url: GAS, fetchFn: f7, storage: st7, sleep: nosleep });
  var r7 = await up7.flush();
  eq('flush 補送兩筆', r7.sent, 2);
  eq('flush 後佇列清空', N.createQueue(st7).list().length, 0);

  var st8 = fakeStorage();
  var q8 = N.createQueue(st8);
  q8.push(payload('bad'), NOW);
  q8.push(payload('good'), NOW);
  var f8 = fakeFetch([{ ok: false, code: 'BAD_SEAT' }, { ok: true }]);
  var up8 = N.createUploader({ url: GAS, fetchFn: f8, storage: st8, sleep: nosleep });
  var r8 = await up8.flush();
  eq('壞資料被丟棄，好資料仍送出', [r8.sent, r8.rejected], [1, 1]);
  eq('flush 後佇列清空（壞的也要移除，否則永遠卡著）',
     N.createQueue(st8).list().length, 0);

  var f9 = fakeFetch([{ ok: true }]);
  var up9 = N.createUploader({ url: GAS, fetchFn: f9, storage: fakeStorage(), sleep: nosleep });
  var r9 = await up9.flush();
  eq('空佇列 flush 不呼叫網路', [r9.sent, f9.calls.length], [0, 0]);

  finish();
})();

