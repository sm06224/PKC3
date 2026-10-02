"""お知らせの文面を、書く前に断る検査(add-notice.py / fix-notice-items.py が読み込む)。

🔑 書いた後に `ui-terms` / `help-pane` の門で落ちる往復を無くすための物(2026-10-02、1 日に 3 回踏んだ)。
正本は TS 側の定数で、ここは**それを読む**(値を写さない ── 写すと片方だけ腐る):
  - `src/features/ui-terms.ts` の BANNED_TERMS(使わない語と、その除外の複合語)
  - `src/features/notice/notice-log.ts` の NOTICE_ITEMS_MAX / NOTICE_ITEM_CHARS_MAX / NOTICE_ITEM_CHARS_MIN
"""
import io
import re


def _rd(p):
    return io.open(p, encoding='utf-8').read()


def load_limits():
    s = _rd('src/features/notice/notice-log.ts')
    out = {}
    for name in ('NOTICE_ITEMS_MAX', 'NOTICE_ITEM_CHARS_MAX', 'NOTICE_ITEM_CHARS_MIN'):
        m = re.search(r'export const %s = (\d+);' % name, s)
        assert m, '%s が notice-log.ts に見つからない(読み方が古い)' % name
        out[name] = int(m.group(1))
    return out


def load_banned():
    """[(語, [除外の複合語...])]。`banned('面', '...', '...', ['画面', '紙面'])` の形を読む。"""
    s = _rd('src/features/ui-terms.ts')
    body = s[s.index('export const BANNED_TERMS'):]
    rows = re.findall(r"\n  banned\('([^']+)',\s*'[^']*',\s*'[^']*'(?:,\s*\[([^\]]*)\])?\),", body)
    assert len(rows) >= 10, 'BANNED_TERMS を読めていない(%d 件)' % len(rows)
    return [(w, re.findall(r"'([^']+)'", ex or '')) for w, ex in rows]


def _hits(text, word, excludes):
    """`word` の出現のうち、除外の複合語の一部になっていない物の数(ui-terms.ts の bannedPattern と同じ読み)。"""
    n = 0
    for m in re.finditer(re.escape(word), text):
        i = m.start()
        covered = False
        for ex in excludes:
            for k in (j.start() for j in re.finditer(re.escape(word), ex)):
                if i - k >= 0 and text[i - k:i - k + len(ex)] == ex:
                    covered = True
        if not covered:
            n += 1
    return n


def check(title, items):
    """問題の一覧を返す(空なら通す)。"""
    lim = load_limits()
    banned = load_banned()
    problems = []
    if not (1 <= len(items) <= lim['NOTICE_ITEMS_MAX']):
        problems.append('項目数 %d(1〜%d)' % (len(items), lim['NOTICE_ITEMS_MAX']))
    for label, text in [('題名', title)] + [('項目%d' % (i + 1), t) for i, t in enumerate(items)]:
        if label != '題名' and not (lim['NOTICE_ITEM_CHARS_MIN'] <= len(text) <= lim['NOTICE_ITEM_CHARS_MAX']):
            problems.append('%s は %d 字(%d〜%d)「%s」' % (label, len(text), lim['NOTICE_ITEM_CHARS_MIN'], lim['NOTICE_ITEM_CHARS_MAX'], text[:30]))
        for ch in ("'", '\\', '`'):
            if ch in text:
                problems.append('%s に %r が在る(TS の文字列にそのまま入れると壊れる。「」で書く)' % (label, ch))
        for w, ex in banned:
            c = _hits(text, w, ex)
            if c:
                problems.append('%s に使わない語「%s」が %d 件' % (label, w, c))
    return problems
