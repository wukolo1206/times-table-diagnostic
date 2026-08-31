"""e2e.spec.py —— 四頁端到端測試

執行：python run-tests.py        （會自動起 http server）
或：  python -m http.server 8899 --bind 127.0.0.1
      python e2e.spec.py 8899

不能用 file:// 開 —— 頁面用 <script src> 載入 fact-core.js 等檔案。

GAS 一律用 route 攔截，不打真實伺服器（會弄髒正式資料，也讓測試依賴網路）。
config.js 也一併攔截並換成假網址，這樣不必為了測試去改正式程式碼。
"""
import sys, json
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')

PORT = sys.argv[1] if len(sys.argv) > 1 else '8899'
BASE = 'http://127.0.0.1:%s/' % PORT
FAKE_GAS = 'https://script.google.com/macros/s/FAKE/exec'

# 索引與 fact-core.js 的 cellIndex 一致：(a-1)*9 + (b-1)
C78 = (7 - 1) * 9 + (8 - 1)
C69 = (6 - 1) * 9 + (9 - 1)
C23 = (2 - 1) * 9 + (3 - 1)

failed = []
posted = []
deleted = []


def ck(cond, name):
    print(('  PASS ' if cond else '  FAIL ') + name)
    if not cond:
        failed.append(name)


def empty_cells():
    return [{"n": 0, "correct": 0, "med": None, "lv": "unknown", "tent": False,
             "wrong": []} for _ in range(81)]


def cell(lv, med=2000, n=3, wrong=None):
    return {"n": n, "correct": n, "med": med, "lv": lv, "tent": n <= 2,
            "wrong": wrong or []}


def route_config(route, request):
    """把 config.js 換成指向假 GAS，正式程式碼不必為測試改動。"""
    route.fulfill(status=200, content_type='application/javascript',
                  body="window.TTD_GAS_URL = '%s';" % FAKE_GAS)


def contract_errors(p):
    """比照 fact-core.js 的 validateSession 檢查關鍵欄位。
    之前這裡直接回 ok:true，等於沒驗證，所以「小數毫秒被伺服器退件」漏掉了。"""
    e = []
    if not isinstance(p.get('detail'), list) or not p['detail']:
        e.append('detail 不是非空陣列'); return e
    for i, r in enumerate(p['detail']):
        if not isinstance(r, list) or len(r) != 6:
            e.append('第 %d 題不是六元素' % (i+1)); continue
        a, b, ans, ok, ms, flags = r
        if not (isinstance(a, int) and 1 <= a <= 9): e.append('第 %d 題 a 不合法' % (i+1))
        if not (isinstance(b, int) and 1 <= b <= 9): e.append('第 %d 題 b 不合法' % (i+1))
        if ok not in (0, 1, None): e.append('第 %d 題 ok 不合法' % (i+1))
        if ms is not None and not (isinstance(ms, int) and 0 <= ms <= 120000):
            e.append('第 %d 題 ms 不是 0-120000 的整數（得到 %r）' % (i+1, ms))
        if not (isinstance(flags, int) and 0 <= flags <= 31):
            e.append('第 %d 題 flags 不合法' % (i+1))
    if p.get('mode') not in ('diagnostic', 'practice', 'sprint'): e.append('mode 不合法')
    if p.get('context') not in ('class', 'home'): e.append('context 不合法')
    if p.get('status') not in ('complete', 'partial'): e.append('status 不合法')
    if not isinstance(p.get('seat'), int) or p['seat'] < 1: e.append('seat 不合法')
    return e


NLC = chr(10)


def route_gas(route, request):
    if request.method == 'POST':
        posted.append(json.loads(request.post_data))
        route.fulfill(status=200, content_type='application/json',
                      body=json.dumps({"ok": True}))
        return

    url = request.url
    if 'action=students' in url:
        body = {"ok": True, "className": "測試班", "seatOnly": False,
                "students": [{"seat": 1, "name": "小明"}, {"seat": 2, "name": "小華"}]}
    elif 'action=myrecord' in url:
        cells = empty_cells()
        cells[C78] = cell("weak", 9000, 1)
        cells[C23] = cell("fluent", 900)
        body = {"ok": True, "name": "小明", "thresholdMs": 3000,
                "sprintSec": 10, "cpmGoal": 30,
                "sprints": [
                    {"answeredAt": "2026-09-01T01:00:00Z", "total": 12,
                     "correct": 8, "cpm": 24, "rows": "7", "limitSec": 10},
                    {"answeredAt": "2026-09-01T02:00:00Z", "total": 40,
                     "correct": 33, "cpm": 11, "rows": "7", "limitSec": 180}],
                "base": cells, "all": cells,
                "diagnostics": [
                    {"answeredAt": "2026-09-01T01:00:00Z", "total": 81,
                     "correct": 60, "timeouts": 2, "med": 2100},
                    {"answeredAt": "2026-09-15T01:00:00Z", "total": 81,
                     "correct": 71, "timeouts": 0, "med": 1800}]}
    elif 'action=delsession' in url:
        deleted.append(('session', url))
        body = {"ok": True, "seat": 1}
    elif 'action=delgroup' in url:
        deleted.append(('group', url))
        body = {"ok": True, "deleted": 2, "seats": 2}
    elif 'action=classgroups' in url:
        body = {"ok": True, "groups": [
            {"key": "k1", "day": "2026-09-02", "mode": "sprint", "rows": "7", "people": 2,
             "limitSec": 180, "avgCorrect": 30.0, "avgTotal": 33.0, "avgCpm": 20},
            {"key": "k0", "day": "2026-09-03", "mode": "sprint", "rows": "7", "people": 2,
             "limitSec": 180, "avgCorrect": 36.0, "avgTotal": 38.0, "avgCpm": 26},
            {"key": "k2", "day": "2026-09-01", "mode": "diagnostic", "rows": "7", "people": 3,
             "limitSec": None, "avgCorrect": 7.0, "avgTotal": 9.0, "avgCpm": None}]}
    elif 'action=classreport' in url:
        body = {"ok": True, "day": "2026-09-02", "mode": "sprint", "rows": "7",
                "students": [
                    {"seat": 1, "name": "小明", "total": 9, "correct": 7, "timeouts": 0,
                     "med": 4200, "cpm": None, "status": "complete", "thinkMs": 31000},
                    {"seat": 2, "name": "小華", "total": 9, "correct": 9, "timeouts": 0,
                     "med": 1100, "cpm": None, "status": "complete", "thinkMs": 9900}],
                "missing": [{"seat": 3, "name": "小美"}],
                "cells": [
                    {"a": 7, "b": 8, "ok": 1, "no": 1, "to": 0, "avgMs": 5200, "n": 2},
                    {"a": 7, "b": 2, "ok": 2, "no": 0, "to": 0, "avgMs": 900, "n": 2},
                    {"a": 7, "b": 6, "ok": 2, "no": 0, "to": 0, "avgMs": 4800, "n": 2}],
                "errors": [
                    {"a": 7, "b": 8, "ans": 54, "n": 8, "type": "other_fact"},
                    {"a": 7, "b": 6, "ans": 13, "n": 2, "type": "added"}]}
    elif 'action=sessions' in url:
        body = {"ok": True, "sessions": [
            {"id": "s1", "answeredAt": "2026-09-01T01:24:00Z", "mode": "diagnostic",
             "context": "class", "status": "complete", "rows": "7", "limitSec": None,
             "total": 9, "correct": 7, "timeouts": 0, "med": 2100, "cpm": None,
             "thinkMs": 18500},
            {"id": "s2", "answeredAt": "2026-09-02T09:30:00Z", "mode": "sprint",
             "context": "class", "status": "complete", "rows": "7", "limitSec": 60,
             "total": 20, "correct": 18, "timeouts": 0, "med": 1500, "cpm": 18,
             "thinkMs": 30200}]}
    elif 'action=session' in url:
        body = {"ok": True, "id": "s1", "seat": 1, "answeredAt": "2026-09-01T09:30:00Z",
                "mode": "diagnostic", "context": "class", "status": "complete",
                "config": {"rows": "7"}, "total": 3, "correct": 2, "timeouts": 0,
                "med": 2100, "cpm": None,
                "detail": [[7, 8, 56, 1, 2100, 0], [7, 9, 49, 0, 4300, 0],
                           [7, 6, None, None, None, 0]]}
    elif 'action=progress' in url:
        # [ms, ok, flags, 日期]；小明的 7×8 練三次仍慢＝卡住，小華由慢變快＝練起來了
        body = {"ok": True, "className": "測試班", "seatOnly": False,
                "students": [
                    {"seat": 1, "name": "小明", "cells": {
                        str(C78): [[9000, 0, 0, "2026-09-01"],
                                   [7000, 1, 0, "2026-09-02"],
                                   [6400, 1, 0, "2026-09-03"]],
                        str(C69): [[5000, 1, 0, "2026-09-01"],
                                   [2400, 1, 0, "2026-09-03"]]}},
                    {"seat": 2, "name": "小華", "cells": {
                        str(C78): [[5200, 1, 0, "2026-09-01"],
                                   [2100, 1, 0, "2026-09-03"]]}},
                    {"seat": 3, "name": "小美", "cells": {}}]}
    elif 'action=dashboard' in url:
        if 'pin=1234' not in url:
            body = {"ok": False, "code": "BAD_PIN", "left": 4}
        else:
            weak_cells = empty_cells()
            weak_cells[C78] = cell("weak", None, 3, [[49, "neighbor"], [15, "added"]])
            weak_cells[C69] = cell("shaky", 5000)
            good_cells = empty_cells()
            good_cells[C78] = cell("shaky", 4000)
            good_cells[C69] = cell("fluent", 1000)
            body = {"ok": True, "className": "測試班", "thresholdMs": 3000,
                    "seatOnly": False, "anomalies": [],
                    "students": [
                        {"seat": 1, "name": "小明", "base": weak_cells,
                         "all": weak_cells, "sessions": 1, "stale": False,
                         "counts": {"diag": 1, "sprint": 0, "practice": 0},
                         "lastAt": "2026-09-01T01:00:00Z"},
                        {"seat": 2, "name": "小華", "base": good_cells,
                         "all": good_cells, "sessions": 1, "stale": False,
                         "counts": {"diag": 1, "sprint": 0, "practice": 0},
                         "lastAt": "2026-09-01T01:00:00Z"},
                        {"seat": 3, "name": "小美", "base": empty_cells(),
                         "all": empty_cells(), "sessions": 0, "stale": False,
                         "counts": {"diag": 0, "sprint": 0, "practice": 0},
                         "lastAt": ""},
                        {"seat": 4, "name": "阿凱", "base": empty_cells(),
                         "all": good_cells, "sessions": 3, "stale": False,
                         "counts": {"diag": 0, "sprint": 3, "practice": 0},
                         "lastAt": "2026-09-02T01:00:00Z"},
                        {"seat": 5, "name": "小雨", "base": good_cells,
                         "all": good_cells, "sessions": 1, "stale": False,
                         "counts": {"diag": 1, "sprint": 0, "practice": 0},
                         "lastAt": "2026-09-01T01:00:00Z"}]}
    else:
        body = {"ok": True}
    route.fulfill(status=200, content_type='application/json', body=json.dumps(body))


def auto_accept(d):
    """診斷流程的續作詢問一律確定。教師頁要測「按取消」，用前必須先移除。"""
    d.accept()


def wrong_answer(a, b):
    """位數要跟正解一樣，否則會提早自動送出、打到下一題去。"""
    exp = str(a * b)
    w = '9' * len(exp)
    return '8' * len(exp) if w == exp else w


def test_index(pg):
    print('== index.html')
    pg.goto(BASE + 'index.html?cls=TEST01')
    pg.wait_for_selector('.seat-btn')
    seats = pg.eval_on_selector_all('.seat-btn', 'e=>e.map(x=>x.textContent)')
    ck(seats == ['1 小明', '2 小華'], '名單由 GAS 帶入，座號與姓名都顯示')
    ck(pg.is_hidden('#rangeCard'), '未選座號時不顯示範圍選擇')
    pg.click('.seat-btn')
    ck(pg.is_visible('#rangeCard'), '選了座號後出現範圍選擇')
    ck('請點選' in pg.inner_text('#count'), '預設一個都沒選，要自己點')
    ck(pg.eval_on_selector('#modeDiag', 'e=>e.disabled') is True, '沒點數字時不能開始')
    ck(pg.eval_on_selector_all('.row-btn', 'e=>e.map(x=>x.textContent)') ==
       ['1','2','3','4','5','6','7','8','9'], '按鈕只顯示數字')

    pg.click('.row-btn')
    ck(pg.inner_text('#count') == '共 9 題', '點一個數字是 9 題')
    ck(pg.eval_on_selector('#modeDiag', 'e=>e.disabled') is False, '點了就能開始')
    pg.click('.row-btn')
    ck('請點選' in pg.inner_text('#count'), '再點一次會取消選取')

    pg.click('[data-preset="hard"]')
    ck(pg.inner_text('#count') == '共 36 題', '6～9 是 36 題')
    ck(pg.eval_on_selector_all('.row-btn.on', 'e=>e.length') == 4, '亮起 4 個')
    pg.click('[data-preset="none"]')
    ck(pg.eval_on_selector('#modeDiag', 'e=>e.disabled') is True, '清除後不能開始')
    pg.click('[data-preset="all"]')
    ck(pg.inner_text('#count') == '共 81 題', '全選是 81 題')
    ck(pg.eval_on_selector('#modeDiag', 'e=>e.disabled') is False, '可以選診斷')
    ck(pg.eval_on_selector('#modeSprint', 'e=>e.disabled') is False, '可以選精熟練習')
    pg.click('[data-preset="none"]')
    ck(pg.eval_on_selector('#modeSprint', 'e=>e.disabled') is True, '沒選數字時兩個模式都不能按')

    # 老師不用記第二個網址
    ck(pg.is_visible('#toTeacher'), '學生頁有「老師管理」入口')
    pg.click('#toTeacher')
    pg.wait_for_url('**/teacher.html*', timeout=10000)
    ck('cls=TEST01' in pg.url, '帶著班級代碼進教師頁：' + pg.url.split('?')[-1])
    ck(pg.is_visible('#loginCard'), '仍然要輸入 PIN 才進得去')


def test_diagnose(pg):
    print('== diagnose.html（只測 7 的乘法，9 題，跑完整場）')
    posted.clear()
    pg.goto(BASE + 'diagnose.html?cls=TEST01&seat=1&r=7')
    pg.evaluate('localStorage.clear()')
    pg.reload()
    pg.wait_for_selector('#toBaseline')
    ck(pg.is_visible('#introStage'), '先出現說明頁')
    ck(pg.inner_text('#introTotal') == '9', '說明頁題數跟著範圍走')
    ck('7 的乘法' in pg.inner_text('#introRows'), '說明頁寫出測哪幾的乘法')

    pg.click('#toBaseline')
    pg.wait_for_selector('#baselineStage:not([hidden])')
    for i in range(5):
        pg.wait_for_selector('.dot.go', timeout=8000)
        pg.click('#dot')
        if i < 4:
            pg.wait_for_selector('.dot:not(.go)', timeout=3000)
    pg.wait_for_selector('#quizStage:not([hidden])', timeout=8000)

    ck(pg.inner_text('#prog') == '1 / 9', '進度顯示 1 / 9')
    ck(pg.eval_on_selector_all('.pad button', 'e=>e.length') == 12, '數字鍵盤有 12 顆鍵')
    ck('倒數' not in pg.content(), '診斷模式不顯示倒數（8.1）')
    ck(pg.eval_on_selector('.pad button:text-is("送出")', 'e=>e.disabled') is True,
       '還沒輸入時送出鍵是停用的')

    # 第 1 題故意答錯（99 一定錯；7 的乘法答案都兩位，打滿兩位自動送出）
    q = pg.inner_text('#q')
    a, b = [int(x) for x in q.replace('×', ' ').split()]
    ck(a == 7, '題目確實只出 7 的乘法')
    w = wrong_answer(a, b)
    pg.click('.pad button:text-is("%s")' % w[0])
    if len(w) > 1:
        ck(pg.eval_on_selector('.pad button:text-is("送出")', 'e=>e.classList.contains("go")') is True,
           '兩位數答案打了一位時，送出鍵會亮（想只填一位可以按）')
        pg.click('.pad button:text-is("%s")' % w[1])
    pg.wait_for_selector('.fb.no', timeout=3000)
    ck(pg.inner_text('#fb') == '✗', '答錯只顯示叉，不顯示正確答案（8.1）')
    pg.wait_for_function('document.getElementById("prog").textContent === "2 / 9"', timeout=3000)

    prog = pg.evaluate('JSON.parse(localStorage.getItem("ttd_progress_v1"))')
    ck(prog['idx'] == 1, '每題答完就存進度（8.1 中斷續作）')
    ck(prog['baselineMs'] is not None, '手速基準有存進場次（4.5）')
    ck(len(prog['cells']) == 9, '題目清單只有 9 題')
    ck(all(isinstance(r['ms'], int) for r in prog['results'] if r['ms'] is not None),
       '反應毫秒是整數（小數會讓整份上傳被退回）')

    # 續作
    pg.on('dialog', auto_accept)
    pg.reload()
    pg.wait_for_selector('#quizStage:not([hidden])', timeout=5000)
    ck(pg.inner_text('#prog') == '2 / 9', '重新載入後從第 2 題續作')

    # 剩下的照實答完，第 2 題用一位數答案測送出鍵
    for n in range(1, 9):
        pg.wait_for_function('document.getElementById("prog").textContent === "%d / 9"' % (n + 1),
                             timeout=6000)
        a, b = [int(x) for x in pg.inner_text('#q').replace('×', ' ').split()]
        ans = str(a * b)
        for d in ans:
            pg.click('.pad button:text-is("%s")' % d)   # 打滿答案位數就自動送出

    pg.wait_for_selector('#doneStage:not([hidden])', timeout=15000)
    ck('共 9 題' in pg.inner_text('#doneSummary'), '完成畫面題數正確')

    pg.wait_for_function('document.getElementById("upMsg").textContent.indexOf("上傳中") === -1',
                         timeout=20000)
    ck(pg.inner_text('#upMsg') == '成績已上傳。', '上傳成功訊息')

    # 上傳內容必須通過資料契約——這一關是為了擋「伺服器退件」那類問題
    ck(len(posted) == 1, '整場只送一次（D9），實際 %d 次' % len(posted))
    if posted:
        pl = posted[0]
        errs = contract_errors(pl)
        ck(not errs, '上傳內容符合資料契約：' + ('; '.join(errs[:3]) if errs else 'OK'))
        ck(len(pl['detail']) == 9, '上傳 9 題')
        ck(pl['status'] == 'complete', '狀態為 complete')
        ck(pl['config'].get('rows') == '7', '設定裡記錄了測驗範圍')
        ck(all(r[0] == 7 for r in pl['detail']), '上傳的題目都是 7 的乘法')


def test_autosubmit(pg):
    """答案是一位數時，按一個數字就自動送出。"""
    print('== 一位數自動送出（只測 1 的乘法）')
    pg.goto(BASE + 'diagnose.html?cls=TEST01&seat=1&r=1')
    pg.evaluate('localStorage.clear()')
    pg.reload()
    pg.click('#toBaseline')
    for i in range(5):
        pg.wait_for_selector('.dot.go', timeout=8000)
        pg.click('#dot')
        if i < 4:
            pg.wait_for_selector('.dot:not(.go)', timeout=3000)
    pg.wait_for_selector('#quizStage:not([hidden])', timeout=8000)

    # 找一題答案是一位數的（1 的乘法：1×1~1×9，前九題有八題是一位數）
    for _ in range(9):
        a, b = [int(x) for x in pg.inner_text('#q').replace('×', ' ').split()]
        if a * b < 10:
            break
        for d in wrong_answer(a, b):
            pg.click('.pad button:text-is("%s")' % d)
        pg.wait_for_timeout(600)

    before = pg.inner_text('#prog')
    pg.click('.pad button:text-is("%d")' % (a * b))
    pg.wait_for_function('document.getElementById("prog").textContent !== "%s"' % before,
                         timeout=4000)
    ck(True, '一位數答案按一下就送出，不用再按送出鍵（%s → %s）'
       % (before, pg.inner_text('#prog')))


def test_partial(pg):
    """沒做完就結束，已作答的部分也要送出（設計文件 8.1 的 partial）。
    原本沒實作也沒測，學生中途停下時作答會留在平板永遠進不了資料庫。"""
    print('== 提早結束（partial）')
    posted.clear()
    pg.goto(BASE + 'diagnose.html?cls=TEST01&seat=1&r=9')
    pg.evaluate('localStorage.clear()')
    pg.reload()
    pg.click('#toBaseline')
    for i in range(5):
        pg.wait_for_selector('.dot.go', timeout=8000)
        pg.click('#dot')
        if i < 4:
            pg.wait_for_selector('.dot:not(.go)', timeout=3000)
    pg.wait_for_selector('#quizStage:not([hidden])', timeout=8000)

    ck(pg.is_visible('#stopEarly'), '作答畫面有「先做到這裡」')
    # 答兩題就停
    for n in range(2):
        pg.wait_for_function('document.getElementById("prog").textContent === "%d / 9"' % (n + 1),
                             timeout=6000)
        a, b = [int(x) for x in pg.inner_text('#q').replace('×', ' ').split()]
        ans = str(a * b)
        for d in ans:
            pg.click('.pad button:text-is("%s")' % d)

    pg.wait_for_function('document.getElementById("prog").textContent === "3 / 9"', timeout=6000)
    pg.click('#stopEarly')   # dialog 由 test_diagnose 裝的常駐 handler 接受
    pg.wait_for_selector('#doneStage:not([hidden])', timeout=10000)
    pg.wait_for_function('document.getElementById("upMsg").textContent.indexOf("上傳中") === -1',
                         timeout=20000)

    ck(len(posted) == 1, '提早結束也會上傳，實際 %d 次' % len(posted))
    if posted:
        pl = posted[0]
        ck(pl['status'] == 'partial', '狀態標為 partial')
        ck(len(pl['detail']) == 2, '只送已作答的 2 題')
        errs = contract_errors(pl)
        ck(not errs, '提早結束的資料也符合契約：' + ('; '.join(errs[:2]) if errs else 'OK'))
    ck(pg.evaluate('localStorage.getItem("ttd_progress_v1")') is None, '送出後清掉進度')


def test_sprint(pg):
    """精熟練習：限時、計分、答錯鎖定、三顆星。"""
    print('== sprint.html（精熟練習，10 秒）')
    posted.clear()
    pg.goto(BASE + 'sprint.html?cls=TEST01&seat=1&r=7')
    pg.evaluate('localStorage.clear()')
    pg.reload()
    pg.wait_for_function('!document.getElementById("go").disabled', timeout=30000)

    intro = pg.inner_text('#introText')
    ck('10 秒' in intro, '說明頁顯示班級設定的秒數')
    ck('不要亂按' in intro, '說明頁提醒答錯會停一下')
    ck('上次最好答對 8 題' in intro, '顯示同範圍同長度的上次最佳成績')

    # 時間可選，且「上次最佳」只跟同樣長度比
    ck(pg.is_visible('#timePick'), '有時間選擇')
    labels = pg.eval_on_selector_all('.time-btn', 'e=>e.map(x=>x.textContent)')
    ck('3 分' in labels, '有 3 分鐘可選：' + '、'.join(labels))
    ck(pg.eval_on_selector('.time-btn.on', 'e=>e.textContent') == '10 秒',
       '預設選中班級設定的長度')
    pg.click('.time-btn:text-is("3 分")')
    pg.wait_for_timeout(200)
    intro3 = pg.inner_text('#introText')
    ck('3 分鐘' in intro3, '換成 3 分鐘後說明跟著改')
    ck('上次最好答對 33 題' in intro3,
       '3 分鐘的紀錄跟 3 分鐘比，不會拿 10 秒的來比')
    pg.click('.time-btn:text-is("10 秒")')
    pg.wait_for_timeout(200)
    ck('上次最好答對 8 題' in pg.inner_text('#introText'), '切回去也正確')

    pg.click('#go')
    pg.wait_for_selector('#playStage:not([hidden])', timeout=5000)
    ck(pg.inner_text('#score') == '0 分', '分數從 0 開始')

    a, b = [int(x) for x in pg.inner_text('#q').replace('×', ' ').split()]
    ck(a == 7, '只出選定範圍的題目')

    # 答對一題 → 加分
    ans = str(a * b)
    for d in ans:
        pg.click('.pad button:text-is("%s")' % d)
    pg.wait_for_function('document.getElementById("score").textContent === "10 分"',
                         timeout=4000)
    ck(True, '答對加 10 分')

    # 答錯 → 不扣分但鍵盤鎖住
    pg.wait_for_timeout(400)
    a2, b2 = [int(x) for x in pg.inner_text('#q').replace('×', ' ').split()]
    for d in wrong_answer(a2, b2):
        pg.click('.pad button:text-is("%s")' % d)
    pg.wait_for_selector('.fb.no', timeout=4000)
    ck(pg.inner_text('#score') == '10 分', '答錯不扣分（分數只往上）')
    ck(pg.eval_on_selector('#pad', 'e=>e.classList.contains("locked")') is True,
       '答錯後鍵盤鎖住 1.5 秒')

    # 等時間到
    pg.wait_for_selector('#doneStage:not([hidden])', timeout=20000)
    ck('分' in pg.inner_text('#finalScore'), '結束顯示分數')
    ck('每分鐘' in pg.inner_text('#finalDetail'), '結束顯示每分鐘題數')
    stars = pg.inner_text('#stars')
    ck(len(stars) == 3, '三顆星位置都在')
    detail = pg.inner_text('#starDetail')
    ck('比上次的 8 題進步' in detail, '第一顆星說明跟上次比')
    ck('每分鐘達到 30 題' in detail, '第二顆星說明 CPM 目標')
    ck('全部都很熟' in detail, '第三顆星說明範圍全綠')
    ck(pg.is_visible('#goalBox'), '結束畫面顯示還差幾格')
    ck('7 的乘法' in pg.inner_text('#goalBox'), '進度框寫出是哪個數字')
    ck('點亮徽章' in pg.inner_text('#goalBox'), '單一數字說「點亮徽章」')

    pg.wait_for_function('document.getElementById("upMsg").textContent.indexOf("上傳中") === -1',
                         timeout=20000)
    ck(len(posted) == 1, '整場只送一次，實際 %d 次' % len(posted))
    if posted:
        pl = posted[0]
        ck(pl['mode'] == 'sprint', '模式標為 sprint')
        ck(pl['config']['limitSec'] == 10, '設定記錄實際使用的秒數')
        ck(pl['config']['rows'] == '7', '設定記錄範圍')
        errs = contract_errors(pl)
        ck(not errs, '精熟練習的資料也符合契約：' + ('; '.join(errs[:2]) if errs else 'OK'))


def test_me(pg):
    print('== me.html')
    pg.goto(BASE + 'me.html?cls=TEST01&seat=1')
    pg.wait_for_selector('table.heat td')
    ck(pg.eval_on_selector_all('table.heat td', 'e=>e.length') == 81, '個人熱圖 81 格')
    ck(pg.eval_on_selector_all('td.weak', 'e=>e.length') == 1, '一格為紅（還要多練）')
    ck(pg.eval_on_selector_all('td.tent', 'e=>e.length') == 1, 'n=1 的格帶斜紋（D13）')
    # 只看畫面上真正顯示的文字，不看原始碼——程式註解裡提到「不會」不算
    visible = pg.inner_text('body')
    ck('不會' not in visible, '學生端畫面不出現「不會」字樣（Q5）')
    ck(pg.eval_on_selector_all('.badge', 'e=>e.length') == 9, '徽章有九枚')
    ck('已收集' in pg.inner_text('#badgeCount'), '顯示收集進度')
    ck(pg.is_visible('#bestCard'), '有練習紀錄時顯示最佳紀錄')
    ck('330 分' in pg.inner_text('#best'), '最高分取所有場次的最佳（33 題×10）')
    ck('3 分鐘' in pg.inner_text('#best'), '標明最高分是幾分鐘拿的，避免不同長度混淆')
    ck(pg.is_visible('#trend'), '兩次以上練習會畫出個人趨勢')
    ck(pg.eval_on_selector_all('#trend svg circle', 'e=>e.length') == 2, '兩個點')
    ck(pg.is_visible('#cmpCard'), '有兩次診斷時顯示進步比較')
    ck('+11' in pg.eval_on_selector('#cmp', 'e=>e.textContent'), '進步題數算對（71-60）')
    ck(pg.is_visible('#weakCard'), '顯示還要多練的清單')
    # 這一頁原本是死路：看完弱項卻沒辦法直接去練
    ck(pg.is_visible('#practice'), '有「練我的弱項」按鈕')
    ck('7' in pg.inner_text('#actionHint'), '提示裡帶出要練的數字')
    pg.click('#practice')
    pg.wait_for_url('**/sprint.html*', timeout=10000)
    ck('r=7' in pg.url, '按下去會帶著弱項數字進練習頁：' + pg.url.split('?')[-1])


def test_teacher(pg):
    print('== teacher.html')
    # 移除診斷流程裝的「一律確定」，否則測不到「按取消不會刪」
    try:
        pg.remove_listener('dialog', auto_accept)
    except Exception:
        pass
    pg.goto(BASE + 'teacher.html?cls=TEST01')
    pg.fill('#pin', '0000')
    pg.click('#login')
    pg.wait_for_selector('.msg.err')
    ck('PIN 不對' in pg.eval_on_selector('#loginMsg', 'e=>e.textContent'), '錯誤 PIN 被擋')

    pg.fill('#pin', '1234')
    pg.click('#login')
    pg.wait_for_selector('#board:not([hidden])')

    # 分頁：進來預設停在熱圖，其他頁籤的內容先收起來
    tabs = pg.eval_on_selector_all('#tabBar button', 'e=>e.map(x=>x.textContent)')
    ck(len(tabs) == 4, '四個上層頁籤，實際 %d：%s' % (len(tabs), '／'.join(tabs)))
    ck(pg.is_visible('#cardHeat'), '預設停在熱圖總覽')
    ck(pg.is_hidden('#cardOne'), '其他頁籤的內容先收起來')

    ck(pg.eval_on_selector_all('table.heat td', 'e=>e.length') == 81, '班級熱圖 81 格')
    ck('?cls=TEST01' in pg.eval_on_selector('#stuLink', 'e=>e.textContent'),
       '顯示可直接發給學生的連結')
    ck('teacher.html' not in pg.eval_on_selector('#stuLink', 'e=>e.textContent'),
       '學生連結不會指到教師頁')
    ck(pg.eval_on_selector('#codeShow', 'e=>e.textContent') == 'TEST01',
       '同時附上班級代碼備用')
    # 沒做過的學生也要算進分母，否則「樣本不足」的保護會失效
    ck('5 人中 3 人有資料' in pg.inner_text('#coverage'),
       '涵蓋率把沒做過的人算進分母：' + pg.inner_text('#coverage').strip())
    ck(pg.eval_on_selector_all('td.sparse', 'e=>e.length') > 0,
       '只有 2/3 做過，格子要標斜紋提醒別當結論')

    tops = pg.eval_on_selector_all('#top li', 'e=>e.map(x=>x.textContent)')
    ck(len(tops) >= 1 and tops[0].startswith('7 × 8'), 'Top 10 第一名為 7×8（score 最高）')
    ck(len(tops) >= 2 and tops[1].startswith('6 × 9'), 'Top 10 第二名為 6×9')
    # 排名編號若緊貼算式，「1. 5 × 2」會被讀成小數 1.5
    ck(not tops[0][0].isdigit() or ' × ' in tops[0][:6],
       '排名編號不會和算式黏成小數')

    before = pg.eval_on_selector_all('td.weak', 'e=>e.length')
    pg.select_option('#thr', '2000')
    pg.wait_for_timeout(200)
    after = pg.eval_on_selector_all('td.weak', 'e=>e.length')
    ck(after >= before, '門檻調嚴後紅格不會變少')
    pg.select_option('#thr', '3000')
    pg.wait_for_timeout(200)
    back = pg.eval_on_selector_all('td.weak', 'e=>e.length')
    ck(back == before, '門檻調回來顏色完全復原（D3：只在呈現層套用）')

    # 第 8 列（a=7）第 9 欄（b=8）——第一列是表頭，第一欄是列標
    pg.click('table.heat tr:nth-child(8) td:nth-child(9)')
    pg.wait_for_selector('#detailCard:not([hidden])')
    ck('7 × 8' in pg.eval_on_selector('#detailTitle', 'e=>e.textContent'), '點格子展開該格名單')
    ck('小明' in pg.eval_on_selector('#detailBody', 'e=>e.textContent'), '名單裡有該生')

    pg.select_option('#grp', 'all')
    pg.wait_for_timeout(200)
    ck(pg.eval_on_selector_all('table.heat td', 'e=>e.length') == 81, '切到全量組仍正常')
    pg.select_option('#grp', 'base')
    pg.wait_for_timeout(200)


    # 進步視圖：練過多次才看得出價值
    print('== 進步視圖')
    pg.select_option('#view', 'prog')
    pg.wait_for_selector('#cardStuck:not([hidden])', timeout=10000)
    pg.wait_for_timeout(400)
    ck(pg.is_hidden('#cardTop'), '進步視圖不顯示「明天要補的」（那是現況榜）')
    ck('第一次' in pg.inner_text('#heatNote') and '最近一次' in pg.inner_text('#heatNote'),
       '說明寫出比的是第一次與最近一次')

    td78 = 'table.heat tr:nth-child(8) td:nth-child(9)'
    ck('weak' in pg.eval_on_selector(td78, 'e=>e.className'),
       '7×8 有人練三次還是沒熟練 → 紅')
    ck('1' in pg.eval_on_selector(td78, 'e=>e.textContent'), '格內寫出人數')
    td69 = 'table.heat tr:nth-child(7) td:nth-child(10)'
    ck('fluent' in pg.eval_on_selector(td69, 'e=>e.className'),
       '6×9 練起來了 → 綠')
    td11 = 'table.heat tr:nth-child(2) td:nth-child(2)'
    ck('unknown' in pg.eval_on_selector(td11, 'e=>e.className'),
       '沒人重複練過的格子 → 灰，不假裝有結論')

    stuck = pg.inner_text('#stuckList')
    ck('7 × 8' in stuck, '頑固格清單列出 7×8')
    ck('小明' in stuck, '頑固格指名是誰卡住')
    ck('6 × 9' not in stuck, '練起來的格子不會出現在頑固格清單')

    # 點格子看歷次秒數
    pg.click(td78)
    pg.wait_for_selector('#detailCard:not([hidden])')
    det = pg.inner_text('#detailBody')
    ck('歷次表現' in det, '點格子看得到歷次表現')
    ck('7.0 → 6.4' in det, '列出每一次的秒數：' + det.split('歷次表現')[-1][:40].replace(NLC, ' '))
    ck('卡住' in det, '標出誰卡住了')
    ck('2.1' in det and '練起來了' in det, '標出誰練起來了')

    # 門檻是呈現層的東西，進步視圖也要跟著重算（D3）
    pg.select_option('#thr', '2000')
    pg.wait_for_timeout(300)
    ck('shaky' in pg.eval_on_selector(td69, 'e=>e.className'),
       '門檻改成 2 秒後，6×9 的 2.4 秒不再算「練起來了」')
    pg.select_option('#thr', '3000')
    pg.wait_for_timeout(300)
    ck('fluent' in pg.eval_on_selector(td69, 'e=>e.className'), '門檻改回來完全復原')

    pg.select_option('#view', 'now')
    pg.wait_for_timeout(300)
    ck(pg.is_hidden('#cardStuck'), '切回現況視圖，頑固格清單收起來')
    ck(pg.is_visible('#cardTop'), '切回現況視圖，「明天要補的」回來')
    ck('不會＋不熟' in pg.inner_text('#heatNote'), '說明也切回現況版')

    print('== 單一學生檢視與家長訊息')
    pg.click('#tabBar button:text-is("看單一學生")')
    pg.wait_for_timeout(300)
    ck(pg.is_visible('#onePanel'), '切到頁籤後顯示單一學生檢視')
    pg.select_option('#oneSeat', '1')
    pg.wait_for_timeout(200)
    ck('小明' in pg.inner_text('#oneSummary'), '顯示學生姓名')
    ck('2026-09-01' in pg.inner_text('#oneSummary'), '顯示最近測驗日期')
    ck('課堂診斷 1 次' in pg.inner_text('#oneSummary'), '分開顯示診斷與練習次數')
    ck(pg.is_hidden('#oneNotice'), '做過診斷的學生不顯示提醒')
    ck('要加強的數字' in pg.inner_text('#oneRows'), '列出要加強的數字')
    ck('7' in pg.inner_text('#oneRows') and '6' in pg.inner_text('#oneRows'),
       '要加強的數字含 7 與 6')

    items = pg.eval_on_selector_all('#oneList li', 'e=>e.map(x=>x.textContent)')
    ck(len(items) == 2, '要練的算式列出 2 題')
    ck(items[0].startswith('7 × 8 ＝ 56'), '不會的排最前面')
    ck('寫成 49' in items[0] and '記混' in items[0], '寫出他填錯的數字與原因')

    msg = pg.inner_text('#onePreview')
    ck('【九九乘法診斷結果】小明' in msg, '家長訊息有標題與姓名')
    ck('7 × 8 ＝ 56' in msg, '家長訊息列出要練的題目')
    ck('寫成 49' in msg, '家長訊息說明錯在哪')
    ck('念出聲音' in msg, '家長訊息附上具體做法')
    ck('不會' not in msg, '家長訊息不出現「不會」字樣')

    # 小華只有「答對但慢」，沒有答錯——訊息應該講時間，不該講寫錯什麼
    pg.select_option('#oneSeat', '2')
    pg.wait_for_timeout(200)
    msg2 = pg.inner_text('#onePreview')
    ck('小華' in msg2, '換人後訊息跟著換')
    ck('寫成' not in msg2, '沒答錯的學生不會出現「寫成」')
    ck('答案是對的' in msg2 and '秒' in msg2, '只有慢的學生，訊息說明是速度問題')

    # 只做過練習沒做診斷的學生，預設視角全空白——必須解釋，否則看起來像資料掉了
    pg.select_option('#oneSeat', '4')
    pg.wait_for_timeout(200)
    ck(pg.is_visible('#oneNotice'), '只做過練習的學生會出現說明')
    ck('還沒做過課堂診斷' in pg.inner_text('#oneNotice'), '說明寫出原因')
    ck('練習 3 次' in pg.inner_text('#oneSummary'), '顯示練習次數')
    pg.click('#switchAll')
    pg.wait_for_timeout(300)
    ck(pg.eval_on_selector('#grp', 'e=>e.value') == 'all', '一鍵切到含練習的資料')
    ck(pg.is_hidden('#oneNotice'), '切過去後提醒消失')
    pg.select_option('#grp', 'base')
    pg.select_option('#oneSeat', '1')
    pg.wait_for_timeout(200)

    print('== 切到單場報表')
    pg.click('#tabBar button:text-is("單場報表")')
    pg.wait_for_timeout(300)
    ck(pg.is_hidden('#cardHeat'), '切走後熱圖收起來')
    ck(pg.is_visible('#cardReport'), '單場報表顯示出來')

    # 全班某一次施測
    print('== 全班報表')
    pg.wait_for_selector('#reportBox:not([hidden])', timeout=15000)
    opts = pg.eval_on_selector_all('#groupSel option', 'e=>e.map(x=>x.textContent)')
    ck(len(opts) == 3, '列出三場施測，實際 %d' % len(opts))

    # 全班趨勢圖
    ck(pg.is_visible('#trendBox'), '兩場以上練習會畫出全班趨勢')
    ck(pg.eval_on_selector_all('#trendBox svg circle', 'e=>e.length') == 2,
       '只畫練習場次（診斷不入圖）')
    ck('每分鐘' in pg.inner_text('#trendBox'), '說明用每分鐘題數而非分數')
    ck('快了 6 題' in pg.inner_text('#trendBox'), '算出跟第一次的差距')
    ck('精熟練習' in opts[0] and '7 的乘法' in opts[0], '選項寫出日期、模式、範圍')

    ck(pg.eval_on_selector_all('#repTabs button', 'e=>e.length') == 3, 'A／B／C 三個小頁籤')
    ck(pg.is_visible('#secA'), '預設顯示 A')
    ck(pg.is_hidden('#secB'), 'B 先收起來')

    rep = pg.inner_text('#secA')
    ck('這一次誰做了' in rep, 'A 區塊：誰做了')
    ck('還沒做（1 人）' in rep and '小美' in rep, 'A 區塊列出沒做的人')
    ck('70' in rep, 'A 區塊算出分數（7 對 × 10）')
    ck('4.2 秒' in rep, 'A 區塊顯示中位思考時間')

    pg.click('#repTabs button:has-text("每題表現")')
    pg.wait_for_timeout(200)
    ck(pg.is_visible('#secB') and pg.is_hidden('#secA'), '切到 B，A 收起來')
    repB = pg.inner_text('#secB')
    ck('每一題全班的表現' in repB, 'B 區塊：每題統計')
    ck('5.2 秒' in repB and '偏慢' in repB, 'B 區塊標出答對但慢的題目')

    # B 表排序
    def b_first():
        return pg.eval_on_selector(
            '#tblB tr:nth-child(2) td', 'e=>e.textContent')
    ck('7 × 8' in b_first(), 'B 表預設錯最多的排最前：' + b_first().strip())
    pg.click('#reportBox th[data-kb="avgMs"]')
    pg.wait_for_timeout(200)
    ck('7 × 8' in b_first(), '依秒數排序，最慢的排最前：' + b_first().strip())
    pg.click('#reportBox th[data-kb="avgMs"]')
    pg.wait_for_timeout(200)
    ck('7 × 2' in b_first(), '再點一次改成最快的排最前：' + b_first().strip())
    pg.click('#reportBox th[data-kb="cell"]')
    pg.wait_for_timeout(200)
    ck('7 × 2' in b_first(), '依題目排序：' + b_first().strip())
    pg.click('#reportBox th[data-kb="no"]')
    pg.wait_for_timeout(200)
    ck('7 × 8' in b_first(), '依錯的人數排序回到 7×8：' + b_first().strip())

    pg.click('#repTabs button:has-text("常犯的錯")')
    pg.wait_for_timeout(200)
    repC = pg.inner_text('#secC')
    ck('全班常犯的錯' in repC, 'C 區塊：常見錯誤')
    ck('和別句口訣記混了' in repC, 'C 區塊寫出錯誤原因')
    ck('把乘法當成加法算' in repC, 'C 區塊分辨不同錯誤型態')
    pg.click('#repTabs button:has-text("誰做了")')
    pg.wait_for_timeout(200)

    # 排序
    slow_first = pg.eval_on_selector_all('#tblA th[data-k]', 'e=>e.map(x=>x.textContent)')
    ck(len(slow_first) >= 4, 'A 區塊的欄位可點擊排序')
    pg.click('#tblA th[data-k="med"]')
    pg.wait_for_timeout(200)
    # 第一欄現在是勾選框，座號在第二欄
    first = pg.eval_on_selector('#tblA tr:nth-child(2) td:nth-child(2)',
                                'e=>e.textContent')
    ck('2' in first, '依中位思考排序後最快的排最前（小華）：' + first)

    # 每一次測驗的明細
    print('== 單場測驗明細')
    pg.click('#tabBar button:text-is("看單一學生")')
    pg.wait_for_timeout(300)
    ck(pg.is_visible('#loadSessions'), '有「看每一次測驗的明細」按鈕')
    pg.click('#loadSessions')
    pg.wait_for_selector('table.sess tr.pick', timeout=10000)
    sess = pg.eval_on_selector_all('table.sess tr.pick', 'e=>e.map(x=>x.innerText)')
    ck(len(sess) == 2, '列出 2 場，實際 %d 場' % len(sess))
    ck('課堂診斷' in sess[0], '寫出測驗種類')
    # 存的是 UTC，畫面要顯示當地時間（台北 = UTC+8，01:24Z → 09:24）
    ck('09:24' in sess[0], '時間轉成當地時間顯示')
    ck('01:24' not in sess[0], '不會直接把 UTC 秀出來')
    ck('70' in sess[0], '顯示分數（7 對 × 10）')
    ck('18.5 秒' in sess[0], '顯示思考總秒數')
    pg.click('table.sess tr.pick')
    pg.wait_for_selector('table.qs', timeout=10000)
    qs_txt = pg.inner_text('#qsBox')
    ck('7 × 8' in qs_txt, '逐題列出題目')
    ck('2.1 秒' in qs_txt, '逐題列出秒數')
    ck('沒作答' in qs_txt, '逾時的題目標示出來')
    ck('4.3 秒' in qs_txt, '答錯的題目也有秒數')

    # 刪除單場
    deleted.clear()
    ck(pg.eval_on_selector_all('.del-sess', 'e=>e.length') == 2, '每一場都有刪除按鈕')
    pg.once('dialog', lambda d: d.dismiss())
    pg.click('.del-sess')
    pg.wait_for_timeout(400)
    ck(len(deleted) == 0, '按取消不會刪')
    pg.once('dialog', lambda d: d.accept())
    pg.click('.del-sess')
    pg.wait_for_timeout(1200)
    ck(len(deleted) == 1 and deleted[0][0] == 'session', '確認後才真的刪')
    ck('id=s1' in deleted[0][1], '刪的是被點的那一場')

    # 勾選刪除（回到單場報表的 A 表）
    pg.click('#tabBar button:text-is("單場報表")')
    pg.click('#repTabs button:has-text("誰做了")')
    pg.wait_for_selector('#delPicked', timeout=15000)
    deleted.clear()
    ck(pg.eval_on_selector('#delPicked', 'e=>e.disabled') is True, '沒勾人時不能刪')
    ck(pg.eval_on_selector_all('.pick-seat', 'e=>e.length') == 2, '每位學生一個勾選框')

    pg.check('.pick-seat')
    ck(pg.eval_on_selector('#delPicked', 'e=>e.disabled') is False, '勾了就能刪')
    ck('1 人' in pg.inner_text('#delPicked'), '按鈕寫出勾了幾人：' + pg.inner_text('#delPicked'))
    ck(pg.eval_on_selector('#pickAll', 'e=>e.indeterminate') is True, '只勾部分時全選框呈半選')

    pg.check('#pickAll')
    ck(pg.eval_on_selector_all('.pick-seat:checked', 'e=>e.length') == 2, '全選會勾起全部')
    ck('整場' in pg.inner_text('#delPicked'), '全選時按鈕改說「刪掉整場」')

    pg.uncheck('#pickAll')
    ck(pg.eval_on_selector('#delPicked', 'e=>e.disabled') is True, '取消全選後不能刪')

    # 只刪一位
    pg.check('.pick-seat')
    pg.once('dialog', lambda d: d.dismiss())
    pg.click('#delPicked')
    pg.wait_for_timeout(400)
    ck(len(deleted) == 0, '按取消不會刪')

    pg.once('dialog', lambda d: d.accept())
    pg.click('#delPicked')
    pg.wait_for_timeout(1200)
    ck(len(deleted) == 1 and deleted[0][0] == 'group', '確認後才刪')
    ck('seats=1' in deleted[0][1], '只送出被勾的座號，不是整場：' + deleted[0][1].split('&seats=')[-1][:12])

    pg.click('#tabBar button:text-is("看單一學生")')
    pg.wait_for_timeout(300)
    pg.click('#printAll')
    pg.wait_for_timeout(300)
    sheets = pg.eval_on_selector_all('#printArea .sheet', 'e=>e.length')
    ck(sheets == 4, '列印全班只印有資料的人（4 位），實際 %d 張' % sheets)


def main():
    with sync_playwright() as p:
        br = p.chromium.launch()
        ctx = br.new_context()
        ctx.route('**/config.js', route_config)
        ctx.route('https://script.google.com/**', route_gas)
        pg = ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        try:
            test_index(pg)
            test_diagnose(pg)
            test_autosubmit(pg)
            test_partial(pg)
            test_sprint(pg)
            test_me(pg)
            test_teacher(pg)
        finally:
            br.close()
        ck(not errs, '四頁都沒有 JS 錯誤：' + '; '.join(errs[:3]))

    print()
    if failed:
        print('FAIL %d 項：' % len(failed))
        for f in failed:
            print('  - ' + f)
        return 1
    print('端到端全部通過')
    return 0


if __name__ == '__main__':
    sys.exit(main())
