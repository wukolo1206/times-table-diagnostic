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


def ck(cond, name):
    print(('  PASS ' if cond else '  FAIL ') + name)
    if not cond:
        failed.append(name)


def empty_cells():
    return [{"n": 0, "correct": 0, "med": None, "lv": "unknown", "tent": False}
            for _ in range(81)]


def cell(lv, med=2000, n=3):
    return {"n": n, "correct": n, "med": med, "lv": lv, "tent": n <= 2}


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
                "base": cells, "all": cells,
                "diagnostics": [
                    {"answeredAt": "2026-09-01T01:00:00Z", "total": 81,
                     "correct": 60, "timeouts": 2, "med": 2100},
                    {"answeredAt": "2026-09-15T01:00:00Z", "total": 81,
                     "correct": 71, "timeouts": 0, "med": 1800}]}
    elif 'action=dashboard' in url:
        if 'pin=1234' not in url:
            body = {"ok": False, "code": "BAD_PIN", "left": 4}
        else:
            weak_cells = empty_cells()
            weak_cells[C78] = cell("weak", 9000)
            weak_cells[C69] = cell("shaky", 5000)
            good_cells = empty_cells()
            good_cells[C78] = cell("shaky", 4000)
            good_cells[C69] = cell("fluent", 1000)
            body = {"ok": True, "className": "測試班", "thresholdMs": 3000,
                    "seatOnly": False, "anomalies": [],
                    "students": [
                        {"seat": 1, "name": "小明", "base": weak_cells,
                         "all": weak_cells, "sessions": 1, "stale": False},
                        {"seat": 2, "name": "小華", "base": good_cells,
                         "all": good_cells, "sessions": 1, "stale": False}]}
    else:
        body = {"ok": True}
    route.fulfill(status=200, content_type='application/json', body=json.dumps(body))


def test_index(pg):
    print('== index.html')
    pg.goto(BASE + 'index.html?cls=TEST01')
    pg.wait_for_selector('.seat-btn')
    seats = pg.eval_on_selector_all('.seat-btn', 'e=>e.map(x=>x.textContent)')
    ck(seats == ['1 小明', '2 小華'], '名單由 GAS 帶入，座號與姓名都顯示')
    ck(pg.is_hidden('#rangeCard'), '未選座號時不顯示範圍選擇')
    pg.click('.seat-btn')
    ck(pg.is_visible('#rangeCard'), '選了座號後出現範圍選擇')
    ck(pg.inner_text('#count') == '共 81 題', '預設全選 81 題')
    ck(pg.eval_on_selector('#start', 'e=>e.disabled') is False, '選了座號後可以開始')

    pg.click('[data-preset="hard"]')
    ck(pg.inner_text('#count') == '共 36 題', '只測 6～9 是 36 題')
    ck(pg.eval_on_selector_all('.row-btn.on', 'e=>e.length') == 4, '亮起 4 列')
    pg.click('[data-preset="none"]')
    ck(pg.eval_on_selector('#start', 'e=>e.disabled') is True, '一列都沒選時不能開始')
    ck('還沒選' in pg.inner_text('#count'), '沒選時提示要選')
    pg.click('.row-btn')
    ck(pg.inner_text('#count') == '共 9 題', '點一列是 9 題')
    pg.click('[data-preset="all"]')
    ck(pg.inner_text('#count') == '共 81 題', '按全部回到 81 題')


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

    # 第 1 題故意答錯（99 一定錯，兩位數自動送出）
    q = pg.inner_text('#q')
    a, b = [int(x) for x in q.replace('×', ' ').split()]
    ck(a == 7, '題目確實只出 7 的乘法')
    pg.click('.pad button:text-is("9")')
    ck(pg.eval_on_selector('.pad button:text-is("送出")', 'e=>e.classList.contains("go")') is True,
       '輸入一位數後送出鍵會亮起（提示要按這裡）')
    pg.click('.pad button:text-is("9")')
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
    pg.on('dialog', lambda d: d.accept())
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
            pg.click('.pad button:text-is("%s")' % d)
        if len(ans) == 1:
            pg.click('.pad button:text-is("送出")')

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
        if len(ans) == 1:
            pg.click('.pad button:text-is("送出")')

    pg.wait_for_function('document.getElementById("prog").textContent === "3 / 9"', timeout=6000)
    pg.once('dialog', lambda d: d.accept())
    pg.click('#stopEarly')
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
    ck(pg.is_visible('#cmpCard'), '有兩次診斷時顯示進步比較')
    ck('+11' in pg.eval_on_selector('#cmp', 'e=>e.textContent'), '進步題數算對（71-60）')
    ck(pg.is_visible('#weakCard'), '顯示還要多練的清單')


def test_teacher(pg):
    print('== teacher.html')
    pg.goto(BASE + 'teacher.html?cls=TEST01')
    pg.fill('#pin', '0000')
    pg.click('#login')
    pg.wait_for_selector('.msg.err')
    ck('PIN 不對' in pg.eval_on_selector('#loginMsg', 'e=>e.textContent'), '錯誤 PIN 被擋')

    pg.fill('#pin', '1234')
    pg.click('#login')
    pg.wait_for_selector('#board:not([hidden])')
    ck(pg.eval_on_selector_all('table.heat td', 'e=>e.length') == 81, '班級熱圖 81 格')

    tops = pg.eval_on_selector_all('#top li', 'e=>e.map(x=>x.textContent)')
    ck(len(tops) >= 1 and tops[0].startswith('7 × 8'), 'Top 10 第一名為 7×8（score 最高）')
    ck(len(tops) >= 2 and tops[1].startswith('6 × 9'), 'Top 10 第二名為 6×9')

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
            test_partial(pg)
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
