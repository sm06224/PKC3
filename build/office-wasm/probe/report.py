"""run の出力を集計する: 落ちた形の表 / 印の本数 / YIELDWAIT の桁の検算 / waited の分布 / 固まった run の読み。
usage: python3 report.py TEST_PREFIX [CONTROL_PREFIX]
  TEST_PREFIX    = 見たい群の tag の前置き(例 `y9-IDm` → y9-IDm-1, y9-IDm-2 ...)
  CONTROL_PREFIX = 比べる群(対照。省略すると表の対照の列は 0/0)
  run の出力の置き場は PKC3_PROBE_OUT(既定 $PKC3_PROBE_DIR/logs)── go.sh と同じ。"""
import sys,re,os; sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from agg import *
from collections import Counter
MARKY=MARK+['PKC3-YIELDWAIT: enter','PKC3-YIELDWAIT: leave']
def an(t):
    r=analyze(t,'c')
    for m in MARKY[len(MARK):]: r['marks'][m]=sum(1 for l in r['lines'] if m in l)
    return r
if len(sys.argv)<2: sys.exit(__doc__)
H=[an(t) for t in tags(sys.argv[2])] if len(sys.argv)>2 else []
Y=[an(t) for t in tags(sys.argv[1])]
if not Y: sys.exit('%s に %s-* の run が無い'%(L,sys.argv[1]))
print('n h',len(H),'n y',len(Y))
print('\n## 表1 落ちた形 (本数)')
rows=[('memory access out of bounds',lambda r:r['fail']['memory access out of bounds']>0),
('RuntimeError',lambda r:r['fail']['RuntimeError']>0),('Aborted(',lambda r:r['fail']['Aborted(']>0),
('invalid handle',lambda r:r['fail']['invalid handle']>0),('SplitWindow',lambda r:r['fail']['SplitWindow']>0),
('exit!=0 (124=timeout)',lambda r:r['exit']!=0),('exit==124',lambda r:r['exit']==124),
('done 無し',lambda r:not r['done']),('+6s 未到達',lambda r:not r['reached']),('4-after6s shot 無し',lambda r:not r['shot']),
('alive=false',lambda r:r['lastalive'] is False),('json 無し',lambda r:not r['json']),
('faults>0 (json row.faults)',lambda r:bool(r['nfaults'])),
('crashed (上のどれか)',lambda r:r['crashed'])]
for n,f in rows: print('| %s | h %d/%d | y %d/%d |'%(n,sum(map(f,H)),len(H),sum(map(f,Y)),len(Y)))
print('\n## 表2 印 (本数 / 行数)')
for m in MARKY: print('| %s | h %d本/%d行 | y %d本/%d行 |'%(m,sum(1 for r in H if r['marks'].get(m)),sum(r['marks'].get(m,0) for r in H),sum(1 for r in Y if r['marks'].get(m)),sum(r['marks'][m] for r in Y)))
# ---- 3
RE_E=re.compile(r'PKC3-YIELDWAIT: enter #(\d+) t=(\d+) held_by_lo=(\d) wake=(\d) closure=(\d)')
RE_L=re.compile(r'PKC3-YIELDWAIT: leave #(\d+) \(enter #(\d+)\) t=(\d+) waited=(\d+) closure=(\d)')
print('\n## 3 YIELDWAIT の桁の検算')
E={};Lv={}
for r in Y:
    E[r['tag']]=[(int(m.group(1)),int(m.group(2)),m.group(3),m.group(4),m.group(5)) for l in r['lines'] for m in [RE_E.search(l)] if m]
    Lv[r['tag']]=[(int(m.group(1)),int(m.group(2)),int(m.group(3)),int(m.group(4)),m.group(5)) for l in r['lines'] for m in [RE_L.search(l)] if m]
    nraw_e=r['marks']['PKC3-YIELDWAIT: enter']; nraw_l=r['marks']['PKC3-YIELDWAIT: leave']
    if nraw_e!=len(E[r['tag']]) or nraw_l!=len(Lv[r['tag']]): print('!! parse mismatch',r['tag'],nraw_e,len(E[r['tag']]),nraw_l,len(Lv[r['tag']]))
def st(v): return 'min %d / max %d / mean %.1f'%(min(v),max(v),sum(v)/len(v)) if v else 'n/a'
print('enter 行数/run:',st([len(E[t]) for t in E]))
print('leave 行数/run:',st([len(Lv[t]) for t in Lv]))
print('| tag | enter行 | leave行 | max enter #N | max leave #M | N<=3000 の欠け数 | leave M<=3000 の欠け数 | N>3000 で100刻みでない数 | N>3000 の行数 |')
print('|---|---|---|---|---|---|---|---|---|')
totmiss=0;totnon=0;over=0
for t in E:
    ns=[x[0] for x in E[t]]; ms=[x[0] for x in Lv[t]]
    mxn=max(ns) if ns else 0; mxm=max(ms) if ms else 0
    miss=len(set(range(1,min(3000,mxn)+1))-set(ns))
    missm=len(set(range(1,min(3000,mxm)+1))-set(ms))
    hi=[n for n in ns if n>3000]; non=[n for n in hi if n%100!=0]
    totmiss+=miss;totnon+=len(non); over+= (mxn>3000)
    print('| %s | %d | %d | %d | %d | %d | %d | %d | %d |'%(t,len(ns),len(ms),mxn,mxm,miss,missm,len(non),len(hi)))
print('合計: runs with max enter #N > 3000:',over,'/',len(E),'; N<=3000 欠け合計',totmiss,'; 100刻み外合計',totnon)
print('全 run の max enter #N:',max([max([x[0] for x in E[t]] or [0]) for t in E]),' 全 run の max leave #M:',max([max([x[0] for x in Lv[t]] or [0]) for t in Lv]))
# ---- 4
print('\n## 4 waited の分布 (全 run の leave 行合算)')
allw=[]
for t in Lv:
    r0=[r for r in Y if r['tag']==t][0]
    first=None
    for l in r0['lines']:
        m=re.search(r'PKC3-(?:YIELDWAIT|TIMERMUTEX).* t=(\d+)',l)
        if m: first=int(m.group(1)); break
    for (M,N,tt,w,c) in Lv[t]: allw.append((w,t,M,N,tt,(tt-first)/1000 if first else None))
ws=sorted(x[0] for x in allw)
def pct(p): return ws[min(len(ws)-1,int(p*len(ws)))] if ws else None
print('leave 行 n=%d  max=%s p99=%s p50=%s  p90=%s'%(len(ws),ws[-1] if ws else None,pct(.99),pct(.5),pct(.9)))
print('>100ms:',sum(1 for w in ws if w>100),' >1000ms:',sum(1 for w in ws if w>1000),' >5000ms:',sum(1 for w in ws if w>5000))
print('(注) leave は M<=3000 は毎回、それ以降は100回ごと+waited>100 なので、3000超の分布は偏る。M<=3000 のみ:')
w3=sorted(x[0] for x in allw if x[2]<=3000)
if w3: print('  n=%d max=%d p99=%d p50=%d >100:%d >1000:%d'%(len(w3),w3[-1],w3[min(len(w3)-1,int(.99*len(w3)))],w3[len(w3)//2],sum(1 for w in w3 if w>100),sum(1 for w in w3 if w>1000)))
print('| waited(ms) | tag | leave #M | (enter #N) | t= | run内最初のt=からの経過s |')
print('|---|---|---|---|---|---|')
for w,t,M,N,tt,el in sorted(allw,reverse=True)[:10]: print('| %d | %s | %d | %d | %d | %.1f |'%(w,t,M,N,tt,el if el is not None else -1))
# ---- 5
def hung(r): return r['exit']!=0 or not r['reached'] or not r['done']
HG=[r for r in Y if hung(r)]
print('\n## 5 固まった run (exit!=0 / +6s 未到達 / done 無し):',len(HG),'本',[r['tag'] for r in HG])
for r in HG:
    L_=r['lines']
    print('\n###',r['tag'],'exit',r['exit'],'done',r['done'],'reached',r['reached'],'lastlabel(json)',r['lastlabel'])
    print('① console 最後の40行'); print('\n'.join(x[:260] for x in L_[-40:]))
    yl=[l for l in L_ if 'PKC3-YIELDWAIT' in l]
    if yl:
        last=yl[-1]; me=RE_E.search(last)
        if me:
            n=me.group(1); has=any(re.search(r'leave #\d+ \(enter #%s\) '%n,l) for l in L_)
            print('② 最後の YIELDWAIT 行は enter #%s; 同じ N の leave: %s -> main がその wait で止まっている: %s'%(n,'有り' if has else '無し','NO' if has else 'YES'))
        else:
            print('② 最後の YIELDWAIT 行は leave -> NO (最後の wait は抜けている)')
        print('   根拠行:',last[:260])
        # all enters without matching leave among printed
        ens=[int(RE_E.search(l).group(1)) for l in yl if RE_E.search(l)]
        lvN={int(RE_L.search(l).group(2)) for l in yl if RE_L.search(l)}
        un=[n for n in ens if n not in lvN]
        print('   印字された enter のうち対応する leave が無い #N:',un[-10:],'(計',len(un),')  ※N>3000 の leave は100回ごと/waited>100 のみ')
    else: print('② YIELDWAIT 行 0')
    tm=[i for i,l in enumerate(L_) if 'PKC3-TIMERMUTEX' in l]
    if tm:
        i=tm[-1]; after=sum(1 for l in L_[i+1:] if 'YIELDWAIT: enter' in l)
        print('③ 最後の TIMERMUTEX 行:',L_[i][:260]); print('   その後の YIELDWAIT enter:',after,'本; leave:',sum(1 for l in L_[i+1:] if 'YIELDWAIT: leave' in l),'本')
    else: print('③ TIMERMUTEX 行 0')
    steps=[l for l in L_ if '[STEP' in l]
    print('④ 最後の [STEP:',steps[-1][:200] if steps else None,'(step 行数',len(steps),')')
    ts=[(int(m.group(1)),l) for l in L_ for m in [re.search(r'PKC3-(?:YIELDWAIT|TIMERMUTEX).* t=(\d+)',l)] if m]
    sts=[int(re.search(r'@(\d+)',l).group(1)) for l in steps]
    first=ts[0][0] if ts else None
    lastt=ts[-1][0] if ts else None
    print('⑤ 最後の印の t=',lastt,'最初の印の t=',first,'経過 %.1f s'%((lastt-first)/1000) if ts else '', '; 最後の STEP t=',sts[-1] if sts else None,'-> 最後の印から最後の STEP までの差 %.1f s'%((sts[-1]-lastt)/1000) if ts and sts else '')
    m=re.match(r'\[\+(\d+)ms\]',L_[-1]) if L_ else None
    print('   console 最終行の相対 ms:',m.group(1) if m else None,'; 最終印の console 相対 ms:',re.match(r'\[\+(\d+)ms\]',ts[-1][1]).group(1) if ts and re.match(r'\[\+(\d+)ms\]',ts[-1][1]) else None)
# ---- 6
print('\n## 6 正常な run 3 本')
k=0
for r in Y:
    if hung(r) or k>=3: continue
    k+=1; L_=r['lines']
    yl=[l for l in L_ if 'PKC3-YIELDWAIT' in l]
    print('###',r['tag'],'YIELDWAIT 行',len(yl)); print('先頭5:'); print('\n'.join(x[:200] for x in yl[:5])); print('末尾5:'); print('\n'.join(x[:200] for x in yl[-5:]))
    mk=[(i,l) for i,l in enumerate(L_) if ('PKC3-YIELDWAIT' in l or 'PKC3-TIMERMUTEX' in l or ('[STEP' in l and '閉じる' in l))]
    pos=[j for j,(i,l) in enumerate(mk) if '[STEP' in l]
    if pos:
        j=pos[0]; seg=mk[max(0,j-10):j+11]
        print('閉じる step 前後10 (印のみ):'); print('\n'.join(x[1][:200] for x in seg))
    else: print('閉じる step 見つからず')
# ---- 7
print('\n## 7 [STEP の最後のラベル分布 (全 run)')
c=Counter()
for r in Y:
    s=[l for l in r['lines'] if '[STEP' in l]
    c[re.sub(r'^\[STEP @\d+\]\s*','',s[-1]) if s else '(STEP無し)']+=1
for k_,v in c.most_common(): print('|',k_,'|',v,'|')
