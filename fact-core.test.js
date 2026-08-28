/* fact-core.test.js — 核心邏輯回歸測試
 *
 * 期望值一律取自設計文件 v1.2 的明文規則，每組標明對應章節。
 * 執行：node fact-core.test.js
 */
'use strict';
var C = require('./fact-core.js');

var pass = 0, fail = 0;
function group(n) { console.log('\n── ' + n); }
function eq(label, actual, expected) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + '\n        得到 ' + a + '\n        預期 ' + e); }
}
function throws(label, fn) {
  try { fn(); fail++; console.log('  FAIL  ' + label + '\n        預期拋錯但沒有'); }
  catch (e) { pass++; console.log('  PASS  ' + label); }
}

/* =============================================================
 * 0. 常數（設計文件 4.1 / 4.2 / 4.4）
 * =========================================================== */
group('0. 常數');
eq('VALID_MASK 不含旋轉位元', (C.VALID_MASK & C.FLAG.ROTATED) === 0, true);
eq('VALID_MASK = 1|2|4|8', C.VALID_MASK, 15);
eq('推導上限固定 8000', C.DERIVE_LIMIT_MS, 8000);
eq('預設門檻 3000', C.DEFAULT_THRESHOLD_MS, 3000);
eq('基準組窗 3', C.WINDOW_BASE, 3);
eq('全量組窗 8', C.WINDOW_ALL, 8);


/* =============================================================
 * 1. 格編號與明細編解碼（設計文件 D5 / 表 1）
 * =========================================================== */
group('1. 格編號與明細編解碼');

eq('1×1 為索引 0', C.cellIndex(1, 1), 0);
eq('1×9 為索引 8', C.cellIndex(1, 9), 8);
eq('2×1 為索引 9', C.cellIndex(2, 1), 9);
eq('9×9 為索引 80', C.cellIndex(9, 9), 80);
eq('7×8 與 8×7 不同格（D5）', C.cellIndex(7, 8) === C.cellIndex(8, 7), false);
eq('索引 55 還原為 7×2', C.cellOf(55), { a: 7, b: 2 });
eq('81 格逐一往返一致', (function () {
  for (var i = 0; i < 81; i++) {
    var c = C.cellOf(i);
    if (C.cellIndex(c.a, c.b) !== i) return i;
  }
  return true;
})(), true);
throws('乘數 0 應拋錯', function () { C.cellIndex(0, 5); });
throws('乘數 10 應拋錯', function () { C.cellIndex(10, 5); });
throws('索引 81 應拋錯', function () { C.cellOf(81); });

eq('allCells 回傳 81 格', C.allCells().length, 81);
eq('allCells 無重複', (function () {
  var seen = {}, cs = C.allCells();
  for (var i = 0; i < cs.length; i++) {
    var k = C.cellIndex(cs[i].a, cs[i].b);
    if (seen[k]) return false;
    seen[k] = 1;
  }
  return true;
})(), true);

eq('shuffle 為排列，不增不減', (function () {
  var arr = [1, 2, 3, 4, 5];
  var seq = [0.9, 0.1, 0.8, 0.2, 0.5], i = 0;
  var out = C.shuffle(arr.slice(), function () { return seq[i++ % seq.length]; });
  return out.slice().sort().join(',');
})(), '1,2,3,4,5');
eq('shuffle 不改動原陣列', (function () {
  var arr = [1, 2, 3];
  C.shuffle(arr.slice(), Math.random);
  return arr.join(',');
})(), '1,2,3');

eq('encodeDetail 產生六元素陣列', C.encodeDetail([
  { a: 7, b: 8, ans: 56, ok: 1, ms: 2140, flags: 0 }
]), [[7, 8, 56, 1, 2140, 0]]);
eq('encodeDetail 逾時題 ans 與 ms 為 null', C.encodeDetail([
  { a: 6, b: 9, ans: null, ok: null, ms: null, flags: 0 }
]), [[6, 9, null, null, null, 0]]);
eq('decodeDetail 為 encodeDetail 的反函式', (function () {
  var items = [
    { a: 7, b: 8, ans: 56, ok: 1, ms: 2140, flags: 0 },
    { a: 6, b: 9, ans: null, ok: null, ms: null, flags: 0 },
    { a: 3, b: 4, ans: 11, ok: 0, ms: 900, flags: C.FLAG.TOO_FAST }
  ];
  return JSON.stringify(C.decodeDetail(C.encodeDetail(items))) === JSON.stringify(items);
})(), true);

/* =============================================================
 * 2. 有效性與單題等級（設計文件 4.2 / 4.4）
 * =========================================================== */
group('2. 有效性與單題等級');

eq('flags 0 為有效', C.isValid(0), true);
eq('切分頁為無效', C.isValid(C.FLAG.HIDDEN), false);
eq('首鍵改動為無效', C.isValid(C.FLAG.FIRSTKEY_CHANGED), false);
eq('送出過久為無效', C.isValid(C.FLAG.SLOW_SUBMIT), false);
eq('過快為無效', C.isValid(C.FLAG.TOO_FAST), false);
eq('僅旋轉仍為有效', C.isValid(C.FLAG.ROTATED), true);
eq('旋轉＋切分頁為無效', C.isValid(C.FLAG.ROTATED | C.FLAG.HIDDEN), false);
eq('undefined flags 視為有效', C.isValid(undefined), true);

var T = C.DEFAULT_THRESHOLD_MS;
function att(ok, ms, flags) { return { ok: ok, ms: ms, flags: flags || 0 }; }

eq('2999ms 答對 → 熟練', C.gradeAttempt(att(1, 2999), T), C.LEVEL.FLUENT);
eq('3000ms 答對 → 不熟（左閉）', C.gradeAttempt(att(1, 3000), T), C.LEVEL.SHAKY);
eq('7999ms 答對 → 不熟', C.gradeAttempt(att(1, 7999), T), C.LEVEL.SHAKY);
eq('8000ms 答對 → 不熟（右閉）', C.gradeAttempt(att(1, 8000), T), C.LEVEL.SHAKY);
eq('8001ms 答對 → 不會', C.gradeAttempt(att(1, 8001), T), C.LEVEL.WEAK);
eq('答錯 → 不會（不看時間）', C.gradeAttempt(att(0, 500), T), C.LEVEL.WEAK);
eq('逾時未答 → 不會', C.gradeAttempt(att(null, null), T), C.LEVEL.WEAK);
eq('答對但 ms 為 null → 不會', C.gradeAttempt(att(1, null), T), C.LEVEL.WEAK);

eq('門檻改 2000 後 2500ms 由熟練變不熟', C.gradeAttempt(att(1, 2500), 2000), C.LEVEL.SHAKY);
eq('門檻改 4000 後 3500ms 由不熟變熟練', C.gradeAttempt(att(1, 3500), 4000), C.LEVEL.FLUENT);
eq('未給門檻時用預設值', C.gradeAttempt(att(1, 2999)), C.LEVEL.FLUENT);

/* =============================================================
 * 3. 單格多筆聚合（設計文件 4.3）
 * =========================================================== */
group('3. 單格多筆聚合');

eq('median 奇數筆', C.median([5, 1, 3]), 3);
eq('median 偶數筆取平均', C.median([1, 2, 3, 4]), 2.5);
eq('median 單筆', C.median([7]), 7);
eq('median 空陣列為 null', C.median([]), null);
eq('median 不改動原陣列', (function () {
  var a = [3, 1, 2]; C.median(a); return a.join(',');
})(), '3,1,2');

eq('無資料 → 未測', C.aggregateCell([], T),
   { n: 0, correct: 0, med: null, lv: C.LEVEL.UNKNOWN, tent: false });

eq('n=1 答對快 → 熟練且標暫定（D13）', C.aggregateCell([att(1, 1200)], T),
   { n: 1, correct: 1, med: 1200, lv: C.LEVEL.FLUENT, tent: true });

eq('n=1 答錯 → 不會且標暫定', C.aggregateCell([att(0, 3000)], T),
   { n: 1, correct: 0, med: null, lv: C.LEVEL.WEAK, tent: true });

eq('n=2 → 仍標暫定', C.aggregateCell([att(1, 1000), att(1, 1400)], T).tent, true);
eq('n=3 → 不標暫定', C.aggregateCell([att(1, 1000), att(1, 1400), att(1, 1200)], T).tent, false);

eq('n=3 錯 2 → 不會（過半且≥2）', C.aggregateCell(
  [att(0, 500), att(0, 600), att(1, 1000)], T).lv, C.LEVEL.WEAK);
eq('n=8 錯 2 → 不判不會（未過半）', C.aggregateCell(
  [att(0, 500), att(0, 600), att(1, 1000), att(1, 1100),
   att(1, 1200), att(1, 1300), att(1, 1400), att(1, 1500)], T).lv, C.LEVEL.FLUENT);
eq('n=4 錯 2 → 不會（恰好過半 ceil(4/2)=2）', C.aggregateCell(
  [att(0, 500), att(0, 600), att(1, 1000), att(1, 1100)], T).lv, C.LEVEL.WEAK);
eq('n=2 錯 1 → 不判不會（未達 2 次）', C.aggregateCell(
  [att(0, 500), att(1, 1000)], T).lv, C.LEVEL.FLUENT);

eq('逾時計入錯誤筆數', C.aggregateCell(
  [att(null, null), att(null, null), att(1, 1000)], T).lv, C.LEVEL.WEAK);

eq('中位數用答對筆，極端值不拉歪（4.3）', C.aggregateCell(
  [att(1, 1000), att(1, 1100), att(1, 15000)], T).med, 1100);
eq('中位數 1100 → 熟練，若取平均 5700 會誤判為不會', C.aggregateCell(
  [att(1, 1000), att(1, 1100), att(1, 15000)], T).lv, C.LEVEL.FLUENT);

eq('無效筆被排除，不計入 n', C.aggregateCell(
  [att(1, 100, C.FLAG.TOO_FAST), att(1, 2000)], T).n, 1);
eq('全部無效 → 未測', C.aggregateCell(
  [att(1, 100, C.FLAG.TOO_FAST)], T).lv, C.LEVEL.UNKNOWN);
eq('旋轉筆仍計入', C.aggregateCell([att(1, 2000, C.FLAG.ROTATED)], T).n, 1);

eq('correct 只數答對，逾時不計入', C.aggregateCell(
  [att(1, 1000), att(0, 500), att(null, null)], T).correct, 1);

eq('答對但全都超過 8 秒 → 不會', C.aggregateCell(
  [att(1, 9000), att(1, 9500), att(1, 9200)], T).lv, C.LEVEL.WEAK);

/* =============================================================
 * 4. 快照建構（設計文件 4.3 / D14 / 9.5）
 * =========================================================== */
group('4. 快照建構');

function sess(mode, context, answeredAt, items) {
  return { mode: mode, context: context, answeredAt: answeredAt, detail: C.encodeDetail(items) };
}
function one(a, b, ok, ms, flags) {
  return [{ a: a, b: b, ans: ok === 1 ? a * b : 0, ok: ok, ms: ms, flags: flags || 0 }];
}
var i78 = C.cellIndex(7, 8);

eq('快照有 base 與 all 兩組，各 81 格', (function () {
  var s = C.buildSnapshot([], T);
  return [Object.keys(s).sort().join(','), s.base.length, s.all.length];
})(), ['all,base', 81, 81]);

eq('無資料時每格皆為未測', C.buildSnapshot([], T).base[i78].lv, C.LEVEL.UNKNOWN);

eq('課堂診斷進基準組', C.buildSnapshot(
  [sess('diagnostic', 'class', '2026-09-01T01:00:00Z', one(7, 8, 1, 1200))], T).base[i78].lv,
  C.LEVEL.FLUENT);

eq('回家診斷不進基準組（D4）', C.buildSnapshot(
  [sess('diagnostic', 'home', '2026-09-01T01:00:00Z', one(7, 8, 1, 1200))], T).base[i78].lv,
  C.LEVEL.UNKNOWN);

eq('課堂練習不進基準組（D4）', C.buildSnapshot(
  [sess('practice', 'class', '2026-09-01T01:00:00Z', one(7, 8, 1, 1200))], T).base[i78].lv,
  C.LEVEL.UNKNOWN);

eq('回家練習仍進全量組', C.buildSnapshot(
  [sess('practice', 'home', '2026-09-01T01:00:00Z', one(7, 8, 1, 1200))], T).all[i78].lv,
  C.LEVEL.FLUENT);

eq('練習資料不得改變基準組的 n（A5）', (function () {
  var diag = sess('diagnostic', 'class', '2026-09-01T01:00:00Z', one(7, 8, 1, 5000));
  var many = [];
  for (var k = 0; k < 5; k++) {
    many.push(sess('practice', 'home', '2026-09-0' + (k + 2) + 'T01:00:00Z', one(7, 8, 1, 800)));
  }
  var s = C.buildSnapshot([diag].concat(many), T);
  return [s.base[i78].n, s.base[i78].lv, s.all[i78].n];
})(), [1, C.LEVEL.SHAKY, 6]);

eq('基準組窗為 3，只取最近三次診斷', (function () {
  var ss = [];
  [9000, 9000, 800, 800, 800].forEach(function (ms, k) {
    ss.push(sess('diagnostic', 'class', '2026-09-0' + (k + 1) + 'T01:00:00Z', one(7, 8, 1, ms)));
  });
  var c = C.buildSnapshot(ss, T).base[i78];
  return [c.n, c.lv];
})(), [3, C.LEVEL.FLUENT]);

eq('全量組窗為 8', (function () {
  var ss = [];
  for (var k = 0; k < 12; k++) {
    ss.push(sess('practice', 'home', '2026-09-' + (10 + k) + 'T01:00:00Z', one(7, 8, 1, 900)));
  }
  return C.buildSnapshot(ss, T).all[i78].n;
})(), 8);

eq('亂序輸入不影響結果（9.5）', (function () {
  var early = sess('diagnostic', 'class', '2026-09-01T01:00:00Z', one(7, 8, 1, 9000));
  var late = sess('diagnostic', 'class', '2026-09-20T01:00:00Z', one(7, 8, 1, 800));
  var mid = sess('diagnostic', 'class', '2026-09-10T01:00:00Z', one(7, 8, 1, 5000));
  var forward = C.buildSnapshot([early, mid, late], T).base[i78];
  var backward = C.buildSnapshot([late, mid, early], T).base[i78];
  return JSON.stringify(forward) === JSON.stringify(backward);
})(), true);

eq('窗滿時丟棄的是最舊的一筆，不是最新的', (function () {
  var ss = [];
  [9000, 9000, 9000, 800].forEach(function (ms, k) {
    ss.push(sess('diagnostic', 'class', '2026-09-0' + (k + 1) + 'T01:00:00Z', one(7, 8, 1, ms)));
  });
  return C.buildSnapshot(ss, T).base[i78].lv;
})(), C.LEVEL.WEAK);

eq('未涉及的格仍為未測', C.buildSnapshot(
  [sess('diagnostic', 'class', '2026-09-01T01:00:00Z', one(7, 8, 1, 1200))], T)
  .base[C.cellIndex(2, 3)].lv, C.LEVEL.UNKNOWN);

eq('partial 場次照常納入（表 1 完成狀態）', C.buildSnapshot(
  [sess('diagnostic', 'class', '2026-09-01T01:00:00Z', one(7, 8, 0, 4000))], T).base[i78].lv,
  C.LEVEL.WEAK);

eq('detail 缺漏時不炸掉', C.buildSnapshot(
  [{ mode: 'diagnostic', context: 'class', answeredAt: '2026-09-01T01:00:00Z' }], T)
  .base[i78].lv, C.LEVEL.UNKNOWN);

/* =============================================================
 * 5. 班級熱圖與 Top 10（設計文件 8.2）
 * =========================================================== */
group('5. 班級熱圖與 Top 10');

function makeSpec(idx, v) { var o = {}; o[idx] = v; return o; }
function snapOf(spec) {
  var cells = [];
  for (var i = 0; i < 81; i++) {
    cells.push({ n: 0, correct: 0, med: null, lv: C.LEVEL.UNKNOWN, tent: false });
  }
  Object.keys(spec).forEach(function (k) { cells[k] = spec[k]; });
  return { base: cells, all: cells };
}
function cell(lv, med) { return { n: 3, correct: 3, med: med === undefined ? 2000 : med, lv: lv, tent: false }; }

var i69 = C.cellIndex(6, 9), i23 = C.cellIndex(2, 3);

eq('熱圖長度 81', C.classHeatmap([snapOf({})], 'base').length, 81);

eq('數出不會與不熟人數', (function () {
  var studs = [
    snapOf(makeSpec(i78, cell(C.LEVEL.WEAK))),
    snapOf(makeSpec(i78, cell(C.LEVEL.WEAK))),
    snapOf(makeSpec(i78, cell(C.LEVEL.SHAKY))),
    snapOf(makeSpec(i78, cell(C.LEVEL.FLUENT)))
  ];
  var h = C.classHeatmap(studs, 'base')[i78];
  return [h.weak, h.shaky, h.fluent, h.covered, h.total];
})(), [2, 1, 1, 4, 4]);

eq('熱圖帶回 a 與 b 方便呈現', (function () {
  var h = C.classHeatmap([snapOf({})], 'base')[i78];
  return [h.a, h.b, h.index];
})(), [7, 8, i78]);

eq('未測學生不列入 covered', (function () {
  var studs = [snapOf(makeSpec(i78, cell(C.LEVEL.WEAK))), snapOf({})];
  var h = C.classHeatmap(studs, 'base')[i78];
  return [h.covered, h.total];
})(), [1, 2]);

eq('covered 未達 60% 標為 sparse', (function () {
  var studs = [snapOf(makeSpec(i78, cell(C.LEVEL.WEAK))), snapOf({}), snapOf({})];
  return C.classHeatmap(studs, 'base')[i78].sparse;
})(), true);

eq('covered 恰好 60% 不標 sparse', (function () {
  var studs = [
    snapOf(makeSpec(i78, cell(C.LEVEL.WEAK))),
    snapOf(makeSpec(i78, cell(C.LEVEL.WEAK))),
    snapOf(makeSpec(i78, cell(C.LEVEL.WEAK))),
    snapOf({}), snapOf({})
  ];
  return C.classHeatmap(studs, 'base')[i78].sparse;
})(), false);

eq('weakRatio 為 (不會+不熟)/covered，不含未測', (function () {
  var studs = [
    snapOf(makeSpec(i78, cell(C.LEVEL.WEAK))),
    snapOf(makeSpec(i78, cell(C.LEVEL.SHAKY))),
    snapOf(makeSpec(i78, cell(C.LEVEL.FLUENT))),
    snapOf(makeSpec(i78, cell(C.LEVEL.FLUENT)))
  ];
  return C.classHeatmap(studs, 'base')[i78].weakRatio;
})(), 0.5);

eq('沒人做過的格 weakRatio 為 0 而非除以零', (function () {
  var h = C.classHeatmap([snapOf({})], 'base')[i78];
  return [h.weakRatio, h.med];
})(), [0, null]);

eq('score = 不會×2 + 不熟', (function () {
  var studs = [
    snapOf(makeSpec(i78, cell(C.LEVEL.WEAK))),
    snapOf(makeSpec(i78, cell(C.LEVEL.WEAK))),
    snapOf(makeSpec(i78, cell(C.LEVEL.SHAKY)))
  ];
  return C.classHeatmap(studs, 'base')[i78].score;
})(), 5);

eq('Top 10 依 score 降序', (function () {
  var studs = [];
  for (var k = 0; k < 5; k++) {
    var spec = {};
    spec[i78] = cell(C.LEVEL.WEAK);
    spec[i69] = cell(C.LEVEL.SHAKY);
    spec[i23] = cell(C.LEVEL.FLUENT);
    studs.push(snapOf(spec));
  }
  return C.topWeak(C.classHeatmap(studs, 'base'), 2).map(function (x) { return x.index; });
})(), [i78, i69]);

eq('sparse 格不進 Top 10', (function () {
  var studs = [];
  for (var k = 0; k < 5; k++) {
    var spec = {};
    if (k === 0) spec[i78] = cell(C.LEVEL.WEAK);
    spec[i69] = cell(C.LEVEL.SHAKY);
    studs.push(snapOf(spec));
  }
  return C.topWeak(C.classHeatmap(studs, 'base'), 5).map(function (x) { return x.index; });
})(), [i69]);

eq('score 同分時中位時間大者優先', (function () {
  var studs = [];
  for (var k = 0; k < 3; k++) {
    var spec = {};
    spec[i78] = cell(C.LEVEL.SHAKY, 4000);
    spec[i69] = cell(C.LEVEL.SHAKY, 7000);
    studs.push(snapOf(spec));
  }
  return C.topWeak(C.classHeatmap(studs, 'base'), 2).map(function (x) { return x.index; });
})(), [i69, i78]);

eq('全班全綠時 Top 10 為空', (function () {
  var studs = [];
  for (var k = 0; k < 3; k++) studs.push(snapOf(makeSpec(i78, cell(C.LEVEL.FLUENT))));
  return C.topWeak(C.classHeatmap(studs, 'base'), 10).length;
})(), 0);

eq('可切換到全量組', (function () {
  var s = snapOf(makeSpec(i78, cell(C.LEVEL.WEAK)));
  return C.classHeatmap([s], 'all')[i78].weak;
})(), 1);

eq('coverage 為完成診斷的人數比例', (function () {
  var studs = [snapOf(makeSpec(i78, cell(C.LEVEL.WEAK))), snapOf({}), snapOf({}), snapOf({})];
  return C.classCoverage(studs, 'base');
})(), { done: 1, total: 4 });

eq('空班級不炸掉', (function () {
  return [C.classHeatmap([], 'base').length, C.classCoverage([], 'base').total,
          C.topWeak(C.classHeatmap([], 'base'), 10).length];
})(), [81, 0, 0]);

/* =============================================================
 * 6. 資料契約與公式注入防護（設計文件 6.5）
 * =========================================================== */
group('6. 資料契約與公式注入防護');

function goodPayload(over) {
  var p = {
    sessionId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    classCode: 'A7K2Q9',
    seat: 12,
    name: '王小明',
    mode: 'diagnostic',
    context: 'class',
    status: 'complete',
    answeredAt: '2026-09-01T01:23:45.000Z',
    config: { sv: 1, thresholdMs: 3000, limitSec: null, baselineMs: 312 },
    detail: [[7, 8, 56, 1, 2140, 0]]
  };
  Object.keys(over || {}).forEach(function (k) { p[k] = over[k]; });
  return p;
}

eq('合法 payload 通過', C.validateSession(goodPayload()).ok, true);
eq('非物件被拒', C.validateSession(null).code, 'BAD_PAYLOAD');

eq('場次ID 非 UUID 被拒', C.validateSession(goodPayload({ sessionId: 'abc' })).code, 'BAD_SESSION_ID');
eq('缺場次ID 被拒', C.validateSession(goodPayload({ sessionId: undefined })).code, 'BAD_SESSION_ID');
eq('班級代碼空白被拒', C.validateSession(goodPayload({ classCode: '' })).code, 'BAD_CLASS_CODE');
eq('班級代碼含符號被拒', C.validateSession(goodPayload({ classCode: 'A-B!' })).code, 'BAD_CLASS_CODE');
eq('座號非整數被拒', C.validateSession(goodPayload({ seat: '十二' })).code, 'BAD_SEAT');
eq('座號 0 被拒', C.validateSession(goodPayload({ seat: 0 })).code, 'BAD_SEAT');
eq('座號 100 被拒', C.validateSession(goodPayload({ seat: 100 })).code, 'BAD_SEAT');
eq('模式不在白名單被拒', C.validateSession(goodPayload({ mode: 'hack' })).code, 'BAD_MODE');
eq('場合不在白名單被拒', C.validateSession(goodPayload({ context: 'cafe' })).code, 'BAD_CONTEXT');
eq('狀態不在白名單被拒', C.validateSession(goodPayload({ status: 'weird' })).code, 'BAD_STATUS');
eq('作答時間非 ISO 被拒', C.validateSession(goodPayload({ answeredAt: '昨天' })).code, 'BAD_TIME');
eq('partial 狀態合法', C.validateSession(goodPayload({ status: 'partial' })).ok, true);

eq('明細非陣列被拒', C.validateSession(goodPayload({ detail: 'x' })).code, 'BAD_DETAIL');
eq('明細空陣列被拒', C.validateSession(goodPayload({ detail: [] })).code, 'BAD_DETAIL');
eq('明細元素不足 6 個被拒', C.validateSession(goodPayload({ detail: [[7, 8, 56, 1, 2140]] })).code, 'BAD_DETAIL');
eq('乘數 0 被拒', C.validateSession(goodPayload({ detail: [[0, 8, 0, 1, 100, 0]] })).code, 'BAD_DETAIL');
eq('乘數 10 被拒', C.validateSession(goodPayload({ detail: [[10, 8, 80, 1, 100, 0]] })).code, 'BAD_DETAIL');
eq('ms 為負被拒', C.validateSession(goodPayload({ detail: [[7, 8, 56, 1, -5, 0]] })).code, 'BAD_DETAIL');
eq('ms 超過 120000 被拒', C.validateSession(goodPayload({ detail: [[7, 8, 56, 1, 120001, 0]] })).code, 'BAD_DETAIL');
eq('ms 為 null 合法（逾時）', C.validateSession(goodPayload({ detail: [[7, 8, null, null, null, 0]] })).ok, true);
eq('ok 非 0/1/null 被拒', C.validateSession(goodPayload({ detail: [[7, 8, 56, 2, 100, 0]] })).code, 'BAD_DETAIL');
eq('flags 超出 0-31 被拒', C.validateSession(goodPayload({ detail: [[7, 8, 56, 1, 100, 99]] })).code, 'BAD_DETAIL');
eq('題數超過 200 被拒', (function () {
  var d = [];
  for (var i = 0; i < 201; i++) d.push([7, 8, 56, 1, 100, 0]);
  return C.validateSession(goodPayload({ detail: d })).code;
})(), 'TOO_MANY');
eq('81 題合法', (function () {
  var d = [];
  for (var i = 0; i < 81; i++) { var c = C.cellOf(i); d.push([c.a, c.b, c.a * c.b, 1, 1500, 0]); }
  return C.validateSession(goodPayload({ detail: d })).ok;
})(), true);

eq('payload 超過 100KB 被拒', (function () {
  var big = new Array(120000).join('x');
  return C.validateSession(goodPayload({ name: big })).code;
})(), 'TOO_LARGE');

eq('等號開頭前置單引號', C.sanitizeCell('=1+1'), "'=1+1");
eq('加號開頭前置單引號', C.sanitizeCell('+A1'), "'+A1");
eq('減號開頭前置單引號', C.sanitizeCell('-2+3'), "'-2+3");
eq('at 開頭前置單引號', C.sanitizeCell('@SUM'), "'@SUM");
eq('正常姓名不動', C.sanitizeCell('王小明'), '王小明');
eq('數字不動', C.sanitizeCell(12), 12);
eq('null 轉空字串', C.sanitizeCell(null), '');
eq('undefined 轉空字串', C.sanitizeCell(undefined), '');
eq('中間有等號不動', C.sanitizeCell('a=b'), 'a=b');

/* =============================================================
 * 7. 反應時間與旗標（設計文件 4.4）
 * =========================================================== */
group('7. 反應時間與旗標');

function timing(over) {
  var t = {
    shownAt: 1000, firstKeyAt: 3200, submitAt: 4000,
    firstKeyDigit: '5', finalAnswer: '56',
    hidden: false, rotated: false, timedOut: false
  };
  Object.keys(over || {}).forEach(function (k) { t[k] = over[k]; });
  return t;
}

eq('ms 為首鍵減去顯示時間，不含輸入時間（D7）', C.evaluateTiming(timing()).ms, 2200);
eq('正常作答 flags 為 0', C.evaluateTiming(timing()).flags, 0);

eq('切分頁標 HIDDEN', C.evaluateTiming(timing({ hidden: true })).flags, C.FLAG.HIDDEN);
eq('旋轉標 ROTATED 但仍有效', (function () {
  var r = C.evaluateTiming(timing({ rotated: true }));
  return [r.flags, C.isValid(r.flags)];
})(), [C.FLAG.ROTATED, true]);

eq('首鍵與答案首位不符標 FIRSTKEY_CHANGED',
   C.evaluateTiming(timing({ firstKeyDigit: '4', finalAnswer: '56' })).flags,
   C.FLAG.FIRSTKEY_CHANGED);
eq('首鍵與答案首位相符不標',
   C.evaluateTiming(timing({ firstKeyDigit: '5', finalAnswer: '56' })).flags, 0);

eq('送出比首鍵晚超過 4 秒標 SLOW_SUBMIT（先亂按再想）',
   C.evaluateTiming(timing({ firstKeyAt: 3200, submitAt: 7300 })).flags, C.FLAG.SLOW_SUBMIT);
eq('恰好 4000ms 不標（邊界）',
   C.evaluateTiming(timing({ firstKeyAt: 3200, submitAt: 7200 })).flags, 0);
eq('4001ms 標記（邊界）',
   C.evaluateTiming(timing({ firstKeyAt: 3200, submitAt: 7201 })).flags, C.FLAG.SLOW_SUBMIT);

eq('反應快於 250ms 標 TOO_FAST',
   C.evaluateTiming(timing({ shownAt: 1000, firstKeyAt: 1200 })).flags, C.FLAG.TOO_FAST);
eq('恰好 250ms 不標（邊界）',
   C.evaluateTiming(timing({ shownAt: 1000, firstKeyAt: 1250 })).flags, 0);

eq('多個問題同時發生時旗標疊加',
   C.evaluateTiming(timing({ hidden: true, rotated: true, firstKeyDigit: '4' })).flags,
   C.FLAG.HIDDEN | C.FLAG.ROTATED | C.FLAG.FIRSTKEY_CHANGED);

eq('逾時題 ms 為 null',
   C.evaluateTiming(timing({ timedOut: true, firstKeyAt: null, submitAt: null })).ms, null);
eq('逾時題 flags 為 0（逾時本身不是無效，是有效證據）',
   C.evaluateTiming(timing({ timedOut: true, firstKeyAt: null, submitAt: null })).flags, 0);
eq('沒按過任何鍵視同逾時',
   C.evaluateTiming(timing({ firstKeyAt: null })).ms, null);

eq('無效作答的 ms 仍要算出來並保留（D3：只存原始值）',
   C.evaluateTiming(timing({ hidden: true })).ms, 2200);

eq('一位數答案不比對首位以外的字元',
   C.evaluateTiming(timing({ firstKeyDigit: '8', finalAnswer: '8' })).flags, 0);

eq('答案為空字串時不誤判首鍵改動',
   C.evaluateTiming(timing({ finalAnswer: '' })).flags, 0);

// performance.now() 回傳小數；ms 必須是整數，否則上傳會被 BAD_DETAIL 退回
eq('小數時間戳產生整數 ms',
   C.evaluateTiming(timing({ shownAt: 1000.7, firstKeyAt: 3200.4 })).ms, 2200);
eq('ms 一律為整數（四捨五入）',
   Number.isInteger(C.evaluateTiming(timing({ shownAt: 0.123, firstKeyAt: 1999.876 })).ms), true);
eq('小數也能正確觸發過快判定',
   C.evaluateTiming(timing({ shownAt: 1000.0, firstKeyAt: 1249.4 })).flags, C.FLAG.TOO_FAST);


/* =============================================================
 * 8. 自選測驗範圍
 * =========================================================== */
group('8. 自選測驗範圍');

eq('全選 1-9 就是 81 格', C.cellsForRows([1,2,3,4,5,6,7,8,9]).length, 81);
eq('只選 6-9 是 36 題', C.cellsForRows([6,7,8,9]).length, 36);
eq('只選一列是 9 題', C.cellsForRows([7]).length, 9);
eq('選 7 出的都是 7 開頭', (function () {
  return C.cellsForRows([7]).every(function (c) { return c.a === 7; });
})(), true);
eq('每列都配 1-9', (function () {
  return C.cellsForRows([7]).map(function (c) { return c.b; }).sort(function(x,y){return x-y;}).join(',');
})(), '1,2,3,4,5,6,7,8,9');
eq('順序照列排，不打亂（打亂交給 shuffle）', (function () {
  var cs = C.cellsForRows([9, 6]);
  return [cs[0].a, cs[9].a];
})(), [6, 9]);
eq('重複的列只算一次', C.cellsForRows([7, 7, 8]).length, 18);
eq('空陣列回傳空', C.cellsForRows([]).length, 0);
throws('列超出 1-9 應拋錯', function () { C.cellsForRows([0]); });
throws('非整數應拋錯', function () { C.cellsForRows([1.5]); });

eq('parseRows 解析網址字串', C.parseRows('6789'), [6, 7, 8, 9]);
eq('parseRows 去重並排序', C.parseRows('9876'), [6, 7, 8, 9]);
eq('parseRows 忽略非數字與 0', C.parseRows('6a7,0'), [6, 7]);
eq('parseRows 空字串視為全選', C.parseRows(''), [1,2,3,4,5,6,7,8,9]);
eq('parseRows undefined 視為全選', C.parseRows(undefined), [1,2,3,4,5,6,7,8,9]);
eq('formatRows 產生網址字串', C.formatRows([9, 6, 7]), '679');

/* ===== 結果 ===== */
console.log('\n' + '='.repeat(50));
console.log('  PASS ' + pass + '   FAIL ' + fail);
console.log('='.repeat(50));
process.exit(fail === 0 ? 0 : 1);
