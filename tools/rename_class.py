"""rename_class.py —— 更改班級代碼

    python tools/rename_class.py <舊代碼> <新代碼>

班級代碼同時出現在四張表，手動改一定會漏；漏掉的那張表會讓資料變成孤兒
（例如作答場次還掛在舊代碼下，Dashboard 就看不到那些成績）。

新代碼規則（與 fact-core 的資料契約一致）：4–12 個英數字。

安全性：純座號模式的班級（不存姓名）用好記的代碼沒問題，代碼被猜到也只看得到座號。
會存姓名的班級請保留不可猜的隨機代碼。
"""
import sys, json
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
GW = Path(r'D:\備課ai\google workspace')
SHEET_ID = '1BEf4ZJaA2zNnq73e2prAvNYlsJJ_BttDUNWg4Gg8k3I'

# 每張表的「班級代碼」在第幾欄（1 起算）
TABLES = {
    '班級設定': 1,
    '學生名單': 1,
    '熟練度快照': 1,
    '作答場次': 5,
}


def creds():
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    t = json.loads((GW / 'token.json').read_text(encoding='utf-8'))
    c = Credentials.from_authorized_user_file(str(GW / 'token.json'), t['scopes'])
    if not c.valid and c.expired and c.refresh_token:
        c.refresh(Request())
    if not c.valid:
        raise SystemExit('token.json 無效，請依 google-token-refresh.md 重新授權')
    return c


def col_letter(n):
    s = ''
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def main(old, new):
    import re
    if not re.match(r'^[A-Za-z0-9]{4,12}$', new):
        raise SystemExit('新代碼必須是 4–12 個英數字：' + new)

    from googleapiclient.discovery import build
    svc = build('sheets', 'v4', credentials=creds())

    # 先確認新代碼沒被別班用走
    got = svc.spreadsheets().values().get(
        spreadsheetId=SHEET_ID, range="'班級設定'!A:A").execute().get('values', [])
    codes = [r[0] for r in got[1:] if r]
    if new in codes:
        raise SystemExit('新代碼已經有別的班級在用：' + new)
    if old not in codes:
        raise SystemExit('找不到舊代碼：' + old)

    total = 0
    for table, col in TABLES.items():
        letter = col_letter(col)
        rng = "'%s'!%s:%s" % (table, letter, letter)
        vals = svc.spreadsheets().values().get(
            spreadsheetId=SHEET_ID, range=rng).execute().get('values', [])
        updates, hits = [], 0
        for i, row in enumerate(vals):
            if i == 0:
                continue                     # 標題列
            if row and str(row[0]) == old:
                updates.append({'range': "'%s'!%s%d" % (table, letter, i + 1),
                                'values': [[new]]})
                hits += 1
        if updates:
            svc.spreadsheets().values().batchUpdate(
                spreadsheetId=SHEET_ID,
                body={'valueInputOption': 'RAW', 'data': updates}).execute()
        print('  %-12s 改了 %d 列' % (table, hits))
        total += hits

    print()
    print('完成：%s → %s（共 %d 列）' % (old, new, total))
    print('提醒：舊網址 ?cls=%s 會失效，記得把新連結發給學生。' % old)
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
