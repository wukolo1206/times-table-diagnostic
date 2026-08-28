"""deploy_gas.py —— 建立／更新 Apps Script 專案並部署為網路應用程式

    python tools/deploy_gas.py

做四件事：
  1. 取得 Apps Script 授權（token 過期時會開瀏覽器讓使用者授權一次）
  2. 第一次執行：建立綁在試算表上的 Apps Script 專案，記進 gas/.clasp.json
     之後執行：沿用同一個 scriptId
  3. 上傳 Code.gs / FactCore.gs / appsscript.json
  4. 建立新版本並更新既有部署（不新建部署，網址不會變）

上傳前會自動跑 sync-core-to-gas.py --check，不同步就中止——
避免把舊的 FactCore.gs 推上去。
"""
import sys, json, subprocess
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

HERE = Path(__file__).resolve().parent
PROJ = HERE.parent
GAS = PROJ / 'gas'
CLASP = GAS / '.clasp.json'
GW = Path(r'D:\備課ai\google workspace')
TOKEN = GW / 'token_script.json'
CREDS = GW / 'credentials.json'

SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/script.projects',
    'https://www.googleapis.com/auth/script.deployments',
    'https://www.googleapis.com/auth/script.webapp.deploy',
]

SHEET_ID = '1BEf4ZJaA2zNnq73e2prAvNYlsJJ_BttDUNWg4Gg8k3I'
DEPLOY_DESC = 'ttd-webapp'


def creds():
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from google_auth_oauthlib.flow import InstalledAppFlow

    c = None
    if TOKEN.exists():
        try:
            c = Credentials.from_authorized_user_file(str(TOKEN), SCOPES)
        except Exception:
            c = None
    if c and c.valid:
        return c
    if c and c.expired and c.refresh_token:
        try:
            c.refresh(Request())
            TOKEN.write_text(c.to_json(), encoding='utf-8')
            print('token 已重新整理')
            return c
        except Exception as e:
            print('重新整理失敗（%s），改走瀏覽器授權' % str(e)[:60])

    print()
    print('=' * 60)
    print('  需要重新授權：接下來會開啟瀏覽器')
    print('  請用擁有這份試算表的 Google 帳號登入並允許存取')
    print('=' * 60)
    print()
    flow = InstalledAppFlow.from_client_secrets_file(str(CREDS), SCOPES)
    c = flow.run_local_server(port=8080)
    TOKEN.write_text(c.to_json(), encoding='utf-8')
    print('授權完成，token 已存回 %s' % TOKEN.name)
    return c


def check_sync():
    rc = subprocess.run([sys.executable, 'sync-core-to-gas.py', '--check'],
                        cwd=PROJ).returncode
    if rc != 0:
        raise SystemExit('FactCore.gs 與 fact-core.js 不同步，已中止部署')


def read_files():
    files = [
        {'name': 'appsscript', 'type': 'JSON',
         'source': (GAS / 'appsscript.json').read_text(encoding='utf-8')},
        {'name': 'FactCore', 'type': 'SERVER_JS',
         'source': (GAS / 'FactCore.gs').read_text(encoding='utf-8')},
        {'name': 'Code', 'type': 'SERVER_JS',
         'source': (GAS / 'Code.gs').read_text(encoding='utf-8')},
    ]
    return files


def main():
    check_sync()
    from googleapiclient.discovery import build
    svc = build('script', 'v1', credentials=creds())

    # 1. scriptId：沿用或新建
    script_id = None
    if CLASP.exists():
        try:
            script_id = json.loads(CLASP.read_text(encoding='utf-8')).get('scriptId')
        except Exception:
            script_id = None

    if not script_id:
        # 一定要建「獨立」專案，不可加 parentId 綁在試算表上。
        # 綁定式專案部署成網頁應用程式後，連帶授權的請求都會回 400
        # 「很抱歉，目前無法開啟這個檔案」——2026-08-29 實測踩過。
        # 程式碼本來就用 openById 指定試算表，不需要綁定。
        proj = svc.projects().create(
            body={'title': '九九乘法診斷後端'}).execute()
        script_id = proj['scriptId']
        CLASP.write_text(json.dumps({'scriptId': script_id, 'rootDir': '.'},
                                    ensure_ascii=False, indent=2) + '\n',
                         encoding='utf-8')
        print('已建立 Apps Script 專案：' + script_id)
    else:
        print('沿用既有專案：' + script_id)

    # 2. 上傳程式碼
    svc.projects().updateContent(
        scriptId=script_id, body={'files': read_files()}).execute()
    print('程式碼已上傳（3 個檔案）')

    # 3. 建版本
    ver = svc.projects().versions().create(
        scriptId=script_id, body={'description': 'auto deploy'}).execute()
    vnum = ver['versionNumber']
    print('已建立版本 %d' % vnum)

    # 4. 更新既有部署，沒有就新建（更新才不會換網址）
    deps = svc.projects().deployments().list(scriptId=script_id).execute()
    target = None
    for d in deps.get('deployments', []):
        cfg = d.get('deploymentConfig', {})
        if cfg.get('description') == DEPLOY_DESC:
            target = d['deploymentId']
            break

    cfg = {'scriptId': script_id, 'versionNumber': vnum,
           'manifestFileName': 'appsscript', 'description': DEPLOY_DESC}

    if target:
        dep = svc.projects().deployments().update(
            scriptId=script_id, deploymentId=target,
            body={'deploymentConfig': cfg}).execute()
        print('已更新既有部署（網址不變）')
    else:
        dep = svc.projects().deployments().create(
            scriptId=script_id, body=cfg).execute()
        print('已建立新部署')

    url = ''
    for e in dep.get('entryPoints', []):
        if e.get('entryPointType') == 'WEB_APP':
            url = e['webApp']['url']
    if not url:
        url = 'https:/' + '/script.google.com/macros/s/' + dep['deploymentId'] + '/exec'

    print()
    print('=' * 60)
    print('  部署網址：')
    print('  ' + url)
    print('=' * 60)

    # 寫進 config.js，前端才連得上
    cfg_js = PROJ / 'config.js'
    content = (
        "/* config.js — 部署設定\n"
        " *\n"
        " * 由 tools/deploy_gas.py 自動更新。換部署時不要手改這裡。\n"
        " *\n"
        " * 這個檔會進公開 repo，裡面不可放任何個資或密鑰。\n"
        " * GAS 網址本身不是機密（誰都能呼叫），存取控制靠班級代碼與 PIN。\n"
        " */\n"
        "window.TTD_GAS_URL = '" + url + "';\n"
    )
    cfg_js.write_text(content, encoding='utf-8', newline='\n')
    print('已寫入 config.js')
    return 0


if __name__ == '__main__':
    sys.exit(main())
