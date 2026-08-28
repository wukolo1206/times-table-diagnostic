"""run-tests.py —— 單一執行入口

    python run-tests.py

會依序跑：
  1. node fact-core.test.js    核心邏輯（等級判定、聚合、快照、熱圖、驗證）
  2. node fact-net.test.js     上傳層（錯開、退避、佇列、去重）
  3. python e2e.spec.py        四頁端到端（自動起 http server 再關掉）

任一失敗即以非 0 結束。
"""
import subprocess, sys, socket, time
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
HERE = Path(__file__).resolve().parent


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_port(port, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(('127.0.0.1', port), 0.4):
                return True
        except OSError:
            time.sleep(0.15)
    return False


def banner(idx, total, name):
    print('=' * 60)
    print('  %d/%d  %s' % (idx, total, name))
    print('=' * 60)
    # 子行程直接寫 stdout，不先 flush 的話標題會印在測試結果後面
    sys.stdout.flush()


def node_test(name, idx, total):
    banner(idx, total, name)
    if not (HERE / name).exists():
        print('  (尚未建立，跳過)')
        return 0
    return subprocess.run(['node', name], cwd=HERE).returncode


def main():
    banner(0, 3, '核心邏輯同步檢查  python sync-core-to-gas.py --check')
    rc = subprocess.run([sys.executable, 'sync-core-to-gas.py', '--check'], cwd=HERE).returncode
    print()

    rc |= node_test('fact-core.test.js', 1, 3)
    print()
    rc |= node_test('fact-net.test.js', 2, 3)
    print()

    banner(3, 3, '端到端  python e2e.spec.py')
    if not (HERE / 'e2e.spec.py').exists():
        print('  (尚未建立，跳過)')
        return rc

    port = free_port()
    srv = subprocess.Popen(
        [sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1'],
        cwd=HERE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_port(port):
            print('  http server 起不來')
            return 1
        rc |= subprocess.run([sys.executable, 'e2e.spec.py', str(port)], cwd=HERE).returncode
    finally:
        srv.terminate()
    return rc


if __name__ == '__main__':
    sys.exit(main())
