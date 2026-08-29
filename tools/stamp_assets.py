"""stamp_assets.py —— 在 HTML 的 js/css 參照後面蓋上版本戳記

    python tools/stamp_assets.py

為什麼需要：GitHub Pages 與瀏覽器都會快取 .js／.css。
改完程式推上去後，學生的平板可能還在跑舊版——而且不會有任何錯誤訊息，
只會出現「功能怎麼不見了」或更糟的「行為跟預期不一樣」。
實測就發生過兩次：一次是新功能看不到，一次是抓到舊的 fact-core.js 導致參數失效。

做法：把 `src="fact-core.js"` 改寫成 `src="fact-core.js?v=<時間戳>"`，
換了網址，快取就失效。HTML 本身 GitHub Pages 只快取很短時間，所以會拿到新的參照。

每次改動前端後、commit 之前執行一次。
"""
import re, sys, time
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
HERE = Path(__file__).resolve().parent
PROJ = HERE.parent

# 只蓋自己的檔案，不動外部資源
LOCAL = re.compile(
    r'(<(?:script|link)[^>]*?(?:src|href)=")([A-Za-z0-9_\-./]+\.(?:js|css))(\?v=[0-9]+)?(")')


def main():
    stamp = time.strftime('%Y%m%d%H%M')
    changed = 0
    for f in sorted(PROJ.glob('*.html')):
        s = f.read_text(encoding='utf-8')
        new = LOCAL.sub(lambda m: m.group(1) + m.group(2) + '?v=' + stamp + m.group(4), s)
        if new != s:
            f.write_text(new, encoding='utf-8', newline='\n')
            n = len(LOCAL.findall(new))
            print('  %-16s %d 個參照 → v=%s' % (f.name, n, stamp))
            changed += 1
    print('已蓋版本戳記的檔案：%d' % changed)
    return 0


if __name__ == '__main__':
    sys.exit(main())
