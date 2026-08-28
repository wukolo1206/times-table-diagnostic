"""sync-core-to-gas.py —— 把 fact-core.js 轉成 GAS 可用的 FactCore.gs

GAS 沒有 require，但伺服器端必須用同一份驗證與聚合邏輯。
手動複製兩份一定會分岔，所以改用腳本產生，並由 run-tests.py 檢查是否同步。

    python sync-core-to-gas.py           產生／更新 gas/FactCore.gs
    python sync-core-to-gas.py --check   只檢查是否同步（不同步則以 1 結束）
"""
import sys, hashlib
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
HERE = Path(__file__).resolve().parent
SRC = HERE / 'fact-core.js'
DST = HERE / 'gas' / 'FactCore.gs'

MARKER = "function () {\n  'use strict';"

HEADER = """/* FactCore.gs —— 由 sync-core-to-gas.py 從 fact-core.js 自動產生
 *
 * 不要手動編輯這個檔案。改 fact-core.js 之後執行：
 *     python sync-core-to-gas.py
 *
 * 來源雜湊：%s
 */
"""


def build():
    src = SRC.read_text(encoding='utf-8')
    digest = hashlib.sha256(src.encode('utf-8')).hexdigest()[:16]

    if MARKER not in src:
        raise SystemExit('fact-core.js 的 UMD 包裝格式改了，sync 腳本需要一起改')

    # 去掉 UMD 包裝的頭尾，改成 GAS 的全域指派
    body = src[src.index(MARKER):]
    body = body[:body.rindex('});')]
    gas = HEADER % digest + 'var FactCore = (' + body + '})();\n'
    return gas, digest


def main():
    gas, digest = build()
    DST.parent.mkdir(parents=True, exist_ok=True)

    if '--check' in sys.argv:
        if not DST.exists():
            print('  FAIL  gas/FactCore.gs 不存在，請執行 python sync-core-to-gas.py')
            return 1
        if DST.read_text(encoding='utf-8') != gas:
            print('  FAIL  gas/FactCore.gs 與 fact-core.js 不同步')
            print('        請執行 python sync-core-to-gas.py 後重新 commit')
            return 1
        print('  PASS  gas/FactCore.gs 與 fact-core.js 同步（%s）' % digest)
        return 0

    DST.write_text(gas, encoding='utf-8', newline='\n')
    print('已產生 %s（來源雜湊 %s）' % (DST, digest))
    return 0


if __name__ == '__main__':
    sys.exit(main())
