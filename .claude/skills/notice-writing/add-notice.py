"""お知らせを 1 件足す(登記表 / CHANGELOG / 決まりの test の 4 か所 + smoke の 1 か所を同時に書く)。

使い方(repo の根で。⚠ `-B` で __pycache__ を作らせない):
  python3 -B .claude/skills/notice-writing/add-notice.py <id> <題名> '<items の JSON 配列>' <issue 番号> [<落とす id>]
  python3 -B .claude/skills/notice-writing/add-notice.py --check <id> <題名> '<items の JSON 配列>' <issue 番号>   # 検査だけ

  <id>        YYYY-MM-DD-slug(先頭 10 字が日付として CHANGELOG の節になる)
  <落とす id> 登記表が枠(`NOTICE_KEEP_MAX`)に達しているときだけ。いちばん古い 1 件の id。無ければ落とさない

やること(全部この順):
  0. 🔴 書く前に断る(notice_check.py) ── 使わない語(ui-terms.ts の BANNED_TERMS)/ 項目数・字数の上限 /
     TS の文字列を壊す字。⚠ 通らなければ **1 file も書かずに止まる**
  1. src/features/notice/notice-log.ts の NOTICES 先頭に足す(落とす id が在れば、そこへ「落とした」注釈を残す)
  2. CHANGELOG.md に足す(同じ日の節が在ればその先頭、無ければ新しい節)
  3. tests/docs-parity.test.ts の DROPPED(落とすときだけ)
  4. tests/adapter/announce.test.ts の KNOWN(digest を計算して足し、落とした行を消す)
  5. 🔴 tests/smoke/system-toc.smoke.spec.ts の「最新のお知らせの題名」pin を張り替える
     (2026-09-26 から古いままで、以後のお知らせ全部で落ちていた。CI は smoke を回さないので鳴らない)

⚠ 足し終えたら `npx vitest run tests/adapter/announce.test.ts tests/adapter/help-pane.test.ts
  tests/docs-parity.test.ts tests/features/ui-terms.test.ts tests/features/manual-refs.test.ts` を回す
  (manual-refs はマニュアルを触ったときの必須)。⚠ 既に main に入った id へ足さない(SKILL の「もう配ったか」)。
"""
import re, json, hashlib, sys, io, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import notice_check

argv = [a for a in sys.argv[1:] if a != '--check']
CHECK_ONLY = len(argv) != len(sys.argv) - 1
NEW_ID = argv[0]; TITLE = argv[1]; ITEMS = json.loads(argv[2]); ISSUE = argv[3]
DROP_ID = argv[4] if len(argv) > 4 else ''  # oldest entry id to drop ('' = 枠に達していない; no drop)
DATE = NEW_ID[:10]

# 0. 書く前に断る(⚠ ここを通らなければ何も書かない)
assert re.match(r'\d{4}-\d{2}-\d{2}-[a-z0-9-]+$', NEW_ID), 'id は YYYY-MM-DD-slug'
problems = notice_check.check(TITLE, ITEMS)
if problems:
    print('✗ 書く前に止めた(1 file も書いていない):')
    for q in problems:
        print('  - ' + q)
    sys.exit(1)
print('✓ 文面の検査を通った')
if CHECK_ONLY:
    sys.exit(0)

def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, s): io.open(p, 'w', encoding='utf-8').write(s)
# 1. notice-log.ts
p = 'src/features/notice/notice-log.ts'; s = rd(p)
# 0b. 枠(NOTICE_SHOW_MAX)を超えるなら、書く前に止める ── 2026-10-02 に 51 件目を書いてしまい、
#     announce / help-pane の 4 件が落ちて初めて気づいた(「dropped title None」は合図にならない)。
cap = int(re.search(r'export const NOTICE_SHOW_MAX = (\d+);', s).group(1))
ids = re.findall(r"^    id: '([^']+)',$", s, re.M)
if not DROP_ID and len(ids) + 1 > cap:
    print('✗ 登記表が %d 件で枠(%d)に達している(1 file も書いていない)。' % (len(ids), cap))
    print('  いちばん古い entry を 5 番目の引数で落とす: %s' % ids[-1])
    sys.exit(1)
entry = "  {\n    id: '%s',\n    title: '%s',\n    items: [\n%s    ],\n  },\n" % (NEW_ID, TITLE, ''.join("      '%s',\n" % i for i in ITEMS))
head = 'export const NOTICES: readonly Notice[] = [\n'
assert s.count(head) == 1
s = s.replace(head, head + entry, 1)
# drop oldest: find "  {\n    id: 'DROP_ID'" ... up to the matching "  },\n"
dtitle = None
if DROP_ID:
    m = re.search(r"\n  \{\n    id: '%s',.*?\n  \},\n" % re.escape(DROP_ID), s, re.S)
    assert m, 'drop target not found'
    dropped = m.group(0)
    dtitle = re.search(r"title: '([^']*)'", dropped).group(1)
    note = "\n  // ⚠ %s(%s): 枠を超えたので\n  //    `%s` を登記表から落とした ──\n  //    **原本は CHANGELOG.md に在る**(%s の節)\n" % (DATE, ISSUE, DROP_ID, DROP_ID[:10])
    s = s[:m.start()] + note + s[m.end():]
wr(p, s)
# 2. CHANGELOG.md
p = 'CHANGELOG.md'; c = rd(p)
sec = "## %s\n\n### %s\n\n%s\n" % (DATE, TITLE, ''.join("- %s\n" % i for i in ITEMS))
if ("## %s\n" % DATE) in c:
    c = c.replace("## %s\n\n" % DATE, "## %s\n\n### %s\n\n%s\n" % (DATE, TITLE, ''.join("- %s\n" % i for i in ITEMS)), 1)
else:
    i = c.index('\n## 20'); c = c[:i+1] + sec + c[i+1:]
wr(p, c)
# 3. docs-parity DROPPED
p = 'tests/docs-parity.test.ts'; t = rd(p)
anchor = "  const DROPPED: readonly string[] = [\n"
assert t.count(anchor) == 1
if DROP_ID: t = t.replace(anchor, anchor + "    /**\n     * ⚠ **%s(%s)に、いちばん古い 1 件が枠から出た**。\n     * 🔑 配布済み:CHANGELOG.md の %s の節に原本\n     */\n    '%s',\n" % (DATE, ISSUE, DROP_ID[:10], dtitle), 1)
wr(p, t)
# 4. announce KNOWN
p = 'tests/adapter/announce.test.ts'; a = rd(p)
dig = hashlib.sha256(json.dumps([TITLE, ITEMS], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()[:8]
anchor = "  const KNOWN: readonly [id: string, digest: string][] = [\n"
assert a.count(anchor) == 1
cmt = ("    /** ⚠ **#%s で足した**(%s)。枠が満杯だったので、いちばん古い 1 件(`%s`)を落とした ── 原本は `CHANGELOG.md`(%s の節)。 */\n" % (ISSUE, DATE, DROP_ID, DROP_ID[:10])) if DROP_ID else ("    /** ⚠ **#%s で足した**(%s)。 */\n" % (ISSUE, DATE))
a = a.replace(anchor, anchor + cmt + "    ['%s', '%s'],\n" % (NEW_ID, dig), 1)
if DROP_ID:
    m2 = re.search(r"\n(    /\*\*(?:(?!\*/).)*?\*/\n)?    \['%s', '[0-9a-f]{8}'\],\n" % re.escape(DROP_ID), a, re.S)
    assert m2, 'KNOWN row not found'
    a = a[:m2.start()] + "\n" + a[m2.end():]
wr(p, a)
print('digest', dig); print('dropped title', dtitle)
# 5. system-toc smoke pins the newest notice title (notice-writing SKILL: 足す前に前の題名を grep)
p = 'tests/smoke/system-toc.smoke.spec.ts'; t = rd(p)
m3 = re.search(r"\n   \*/\n  \)\.toContain\('([^']*)'\);\n", t)
assert m3, 'system-toc pin not found'
old_title = m3.group(1)
t = t[:m3.start()] + "\n   * ⚠ %s(#%s)に `%s` を先頭へ足したので、ここも 1 段新しい題名へ直した。\n   */\n  ).toContain('%s');\n" % (DATE, ISSUE, NEW_ID, TITLE) + t[m3.end():]
wr(p, t)
print('system-toc pin', old_title, '->', TITLE)
