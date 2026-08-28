"""loadtest.py —— 併發上傳測試

模擬全班同時交卷。設計文件 C5 的驗收替代方案：
35 台實機同時可用的時機在校園中極難安排，改用 2 台實機 + 33 個並發請求。
這支腳本負責那 33 個。

    python tools/loadtest.py <GAS_URL> <班級代碼> [並發數]

會做三件事：
  1. 併發送出 N 筆場次，確認全部成功且無遺失
  2. 重送同樣的場次ID，確認伺服器回 dup 而非重複寫入
  3. 回報耗時分布，供判斷 waitLock 是否逾時

注意：這會在指定班級寫入 N 筆假資料。請用專門的壓測班（例如 LOAD01），
不要對正式班級跑。
"""
import sys, json, uuid, time, random
from concurrent.futures import ThreadPoolExecutor
from urllib import request as urlrequest

sys.stdout.reconfigure(encoding='utf-8')


def make_payload(seat, session_id=None):
    detail = []
    for a in range(1, 10):
        for b in range(1, 10):
            ok = 1 if random.random() > 0.15 else 0
            detail.append([a, b, a * b if ok else a * b + 1, ok,
                           random.randint(600, 6000), 0])
    return {
        "sessionId": session_id or str(uuid.uuid4()),
        "classCode": CLASS,
        "seat": seat,
        "name": "",
        "mode": "diagnostic",
        "context": "class",
        "status": "complete",
        "answeredAt": time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime()),
        "config": {"sv": 1, "thresholdMs": 3000, "limitSec": None, "baselineMs": 300},
        "detail": detail
    }


def post(payload):
    """一律用 text/plain —— 與前端相同，避免觸發 preflight（設計文件 5.2）。"""
    body = json.dumps(payload).encode('utf-8')
    req = urlrequest.Request(URL, data=body,
                             headers={'Content-Type': 'text/plain;charset=utf-8'})
    t0 = time.time()
    try:
        with urlrequest.urlopen(req, timeout=120) as r:
            out = json.loads(r.read().decode('utf-8'))
        return {'ok': out.get('ok'), 'dup': out.get('dup'), 'code': out.get('code'),
                'sec': time.time() - t0}
    except Exception as e:
        return {'ok': False, 'code': 'EXC:' + str(e)[:80], 'sec': time.time() - t0}


def report(title, results):
    okn = sum(1 for r in results if r['ok'])
    dup = sum(1 for r in results if r.get('dup'))
    secs = sorted(r['sec'] for r in results)
    print()
    print('== ' + title)
    print('  成功 %d / %d（其中 dup %d）' % (okn, len(results), dup))
    print('  耗時 最快 %.1fs　中位 %.1fs　最慢 %.1fs'
          % (secs[0], secs[len(secs) // 2], secs[-1]))
    bad = [r for r in results if not r['ok']]
    if bad:
        print('  失敗代碼：')
        for r in bad[:10]:
            print('    - ' + str(r['code']))
    return okn, dup


def main():
    payloads = [make_payload(i + 1) for i in range(N)]

    with ThreadPoolExecutor(max_workers=N) as ex:
        first = list(ex.map(post, payloads))
    okn, _ = report('第 1 輪：%d 筆併發上傳' % N, first)

    # 同樣的場次ID 再送一次，應全部回 dup
    with ThreadPoolExecutor(max_workers=N) as ex:
        second = list(ex.map(post, payloads))
    okn2, dup2 = report('第 2 輪：同場次ID 重送（應全部 dup）', second)

    print()
    print('=' * 50)
    problems = []
    if okn != N:
        problems.append('第 1 輪有 %d 筆失敗' % (N - okn))
    if dup2 != N:
        problems.append('第 2 輪只有 %d 筆被判為 dup，去重有漏' % dup2)
    slow = [r for r in first if r['sec'] > 60]
    if slow:
        problems.append('%d 筆超過 60 秒，waitLock 可能逾時' % len(slow))

    if problems:
        print('  有問題：')
        for p in problems:
            print('    - ' + p)
        print('=' * 50)
        return 1

    print('  通過。請到試算表確認「作答場次」剛好增加 %d 列（不是 %d 列）。' % (N, N * 2))
    print('=' * 50)
    return 0


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    URL = sys.argv[1]
    CLASS = sys.argv[2]
    N = int(sys.argv[3]) if len(sys.argv) > 3 else 33
    sys.exit(main())
