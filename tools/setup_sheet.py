"""setup_sheet.py —— 建立九九乘法診斷用的 Google 試算表與四張表

    python tools/setup_sheet.py              建立新試算表（會印出 SHEET_ID）
    python tools/setup_sheet.py <SHEET_ID>   對既有試算表補建缺少的表

用 D:\\備課ai\\google workspace\\token.json（drive scope，Sheets API 也吃這個 scope）。
若報 invalid_grant，依全域 CLAUDE.md 的 google-token-refresh.md 重新授權。

安全性：這支腳本只會「新增」缺少的工作表，不會刪除或覆寫既有資料。
"""
import sys, json
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

GW = Path(r'D:\備課ai\google workspace')
TOKEN = GW / 'token.json'

TITLE = '九九乘法診斷資料'

SHEETS = {
    '作答場次': ['伺服器接收時間', '作答時間', '時間偏移旗標', '場次ID', '班級代碼', '座號',
                 '姓名', '模式', '場合', '完成狀態', '設定', '題數', '正確數', '逾時數',
                 '中位反應ms', 'CPM', '明細JSON'],
    '班級設定': ['班級代碼', '班級名稱', '教師PIN', '純座號模式', '衝刺秒數', 'CPM目標',
                 '熟練門檻ms', '建立日期', '啟用', '保留到期日'],
    '學生名單': ['班級代碼', '座號', '姓名', '暱稱'],
    '熟練度快照': ['班級代碼', '座號', '姓名', '基準組JSON', '全量組JSON', '依據場次數',
                   '最後納入場次時間', '重算版本', 'stale', '更新時間'],
}


def creds():
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    t = json.loads(TOKEN.read_text(encoding='utf-8'))
    c = Credentials.from_authorized_user_file(str(TOKEN), t['scopes'])
    if not c.valid and c.expired and c.refresh_token:
        c.refresh(Request())
    if not c.valid:
        raise SystemExit('token.json 無效，請依 google-token-refresh.md 重新授權')
    return c


def main():
    from googleapiclient.discovery import build
    c = creds()
    svc = build('sheets', 'v4', credentials=c)

    sheet_id = sys.argv[1] if len(sys.argv) > 1 else None

    if not sheet_id:
        body = {'properties': {'title': TITLE, 'locale': 'zh_TW',
                               'timeZone': 'Asia/Taipei'}}
        ss = svc.spreadsheets().create(body=body,
                                       fields='spreadsheetId,spreadsheetUrl').execute()
        sheet_id = ss['spreadsheetId']
        print('已建立試算表：' + ss['spreadsheetUrl'])

    meta = svc.spreadsheets().get(spreadsheetId=sheet_id,
                                  fields='sheets.properties').execute()
    existing = {s['properties']['title']: s['properties']['sheetId']
                for s in meta['sheets']}

    # 新增缺少的工作表（絕不刪除既有的）
    reqs = [{'addSheet': {'properties': {'title': name}}}
            for name in SHEETS if name not in existing]
    if reqs:
        svc.spreadsheets().batchUpdate(spreadsheetId=sheet_id,
                                       body={'requests': reqs}).execute()
        print('新增工作表：' + '、'.join(r['addSheet']['properties']['title'] for r in reqs))

    # 只在該表完全空白時才寫標題列，避免覆寫既有資料
    for name, headers in SHEETS.items():
        got = svc.spreadsheets().values().get(
            spreadsheetId=sheet_id, range="'%s'!A1:A1" % name).execute()
        if got.get('values'):
            print('  %s 已有內容，跳過標題列' % name)
            continue
        svc.spreadsheets().values().update(
            spreadsheetId=sheet_id, range="'%s'!A1" % name,
            valueInputOption='RAW', body={'values': [headers]}).execute()
        print('  %s 標題列已寫入（%d 欄）' % (name, len(headers)))

    # 凍結標題列
    meta = svc.spreadsheets().get(spreadsheetId=sheet_id,
                                  fields='sheets.properties').execute()
    freeze = []
    for s in meta['sheets']:
        p = s['properties']
        if p['title'] in SHEETS and p.get('gridProperties', {}).get('frozenRowCount', 0) == 0:
            freeze.append({'updateSheetProperties': {
                'properties': {'sheetId': p['sheetId'],
                               'gridProperties': {'frozenRowCount': 1}},
                'fields': 'gridProperties.frozenRowCount'}})
    if freeze:
        svc.spreadsheets().batchUpdate(spreadsheetId=sheet_id,
                                       body={'requests': freeze}).execute()

    # 刪掉建立時預設產生的「工作表1」（只在它完全空白時）
    for s in meta['sheets']:
        p = s['properties']
        if p['title'] in ('工作表1', 'Sheet1') and p['title'] not in SHEETS:
            got = svc.spreadsheets().values().get(
                spreadsheetId=sheet_id, range="'%s'!A1:Z10" % p['title']).execute()
            if not got.get('values'):
                svc.spreadsheets().batchUpdate(
                    spreadsheetId=sheet_id,
                    body={'requests': [{'deleteSheet': {'sheetId': p['sheetId']}}]}).execute()
                print('  已刪除空白的預設工作表「%s」' % p['title'])

    print()
    print('SHEET_ID = ' + sheet_id)
    return 0


if __name__ == '__main__':
    sys.exit(main())
