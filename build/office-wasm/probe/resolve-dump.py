#!/usr/bin/env python3
"""console.log の `PKC3-STACKDUMP` の行にある `$funcN` を、関数の名前に置き換えて読める形にする。
usage: python3 resolve-dump.py NAMES.tsv CONSOLE.log [SHIFT]
  NAMES.tsv = `番号<TAB>名前` の表(wasm-names.py の出力。README.md の「stack を名前に解く」)
  SHIFT     = dump の番号に足してから表を引く(既定 0)。計装を足した一式は途中の範囲から番号が 1 つずれることがある
"""
import re,sys
if len(sys.argv)<3: sys.exit(__doc__)
shift=int(sys.argv[3]) if len(sys.argv)>3 else 0
names={}
for l in open(sys.argv[1]):
    p=l.rstrip('\n').split('\t',1)
    if len(p)==2: names[p[0]]=p[1]
def short(n):
    n=re.sub(r'\(.*','',n) if len(n)>90 else n
    return n[:110]
for l in open(sys.argv[2]):
    if 'STACKDUMP' not in l: continue
    l=l.rstrip('\n')
    if 'attached ' in l or 'setAutoAttach' in l or 'pause ack' in l: continue
    m=re.search(r'\[STACKDUMP\] (.*)',l); body=m.group(1) if m else l
    body=re.sub(r'\$func(\d+)', lambda mm: '$func'+mm.group(1)+'='+short(names.get(str(int(mm.group(1))+shift),'?')), body)
    t=re.search(r'\[\+(\d+)ms\]',l); print(('[+%s]'%t.group(1) if t else '')+' '+body[:230])
