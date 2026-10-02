"""**まだ main に入っていない** お知らせの items を差し替える(登記表 + CHANGELOG + KNOWN の digest)。

使い方(repo の根で):
  python3 -B .claude/skills/notice-writing/fix-notice-items.py <id> '<新しい items の JSON 配列>'

⚠ 🔴 既に main に入った id へ使わない(帯には 1 行も出ない ── SKILL の「もう配ったか」)。
⚠ 書く前に notice_check.py で断る(使わない語 / 項目数・字数の上限)。通らなければ 1 file も書かない。
⚠ 題名は変えない(変えるなら登記表・CHANGELOG・system-toc の pin を手で直す)。
"""
import re, json, hashlib, sys, io, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import notice_check
NEW_ID = sys.argv[1]; ITEMS = json.loads(sys.argv[2])
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, s): io.open(p, 'w', encoding='utf-8').write(s)
p = 'src/features/notice/notice-log.ts'; s = rd(p)
m = re.search(r"(  \{\n    id: '%s',\n    title: '([^']*)',\n    items: \[\n)((?:      '[^']*',\n)+)(    \],)" % re.escape(NEW_ID), s)
assert m, 'notice not found'
title = m.group(2); old_items = re.findall(r"      '([^']*)',", m.group(3))
problems = notice_check.check(title, ITEMS)
if problems:
    print('✗ 書く前に止めた(1 file も書いていない):')
    for q in problems:
        print('  - ' + q)
    sys.exit(1)
s = s[:m.start()] + m.group(1) + ''.join("      '%s',\n" % i for i in ITEMS) + m.group(4) + s[m.end():]
wr(p, s)
p = 'CHANGELOG.md'; c = rd(p)
old_block = "### %s\n\n%s" % (title, ''.join("- %s\n" % i for i in old_items))
assert c.count(old_block) == 1, 'changelog block not found'
c = c.replace(old_block, "### %s\n\n%s" % (title, ''.join("- %s\n" % i for i in ITEMS)), 1); wr(p, c)
dig = hashlib.sha256(json.dumps([title, ITEMS], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()[:8]
p = 'tests/adapter/announce.test.ts'; a = rd(p)
a2 = re.sub(r"\['%s', '[0-9a-f]{8}'\]" % re.escape(NEW_ID), "['%s', '%s']" % (NEW_ID, dig), a); assert a2 != a or dig in a
wr(p, a2); print('digest', dig)
