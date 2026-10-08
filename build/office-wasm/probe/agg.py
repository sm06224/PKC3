import sys,os,re,json,glob
# 集計の共通部(report.py が読む)。run の出力(TAG.json / TAG.log / TAG.console.log / shots/)の置き場は go.sh と同じ env で決まる
OUT=os.path.abspath(os.environ.get('PKC3_PROBE_OUT') or os.path.join(os.environ.get('PKC3_PROBE_DIR') or os.getcwd(),'logs'))
L=OUT+'/'
MARK=['PKC3-TIMERMUTEX: skipped','PKC3-TIMERMUTEX: ran under mutex','PKC3-TASKGONE','PKC3-LAYOUTGUARD','PKC3-TOOLTIPGUARD','PKC3-VIEWDATAGONE','PKC3-GRIPGUARD']
FAIL=['memory access out of bounds','RuntimeError','Aborted(','invalid handle','SplitWindow']
def read(p):
    try: return open(p,errors='replace').read()
    except: return ''
def tags(prefix): 
    return sorted({re.sub(r'\.(console\.)?log$|\.json$','',os.path.basename(p)) for p in glob.glob(L+prefix+'-*') if re.search(r'-\d+\.(console\.log|log|json)$',p)}, key=lambda t:int(t.rsplit('-',1)[1]))
def analyze(tag,kind):
    con=read(L+tag+'.console.log'); lg=read(L+tag+'.log')
    r={'tag':tag,'marks':{},'fail':{},'lines':con.splitlines(),'log':lg}
    for m in MARK: r['marks'][m]=sum(1 for l in con.splitlines() if m in l)
    for f in FAIL: r['fail'][f]=sum(1 for l in (con+'\n'+lg).splitlines() if f in l)
    ex=re.findall(r'exit=(\d+)',lg); r['exit']=int(ex[-1]) if ex else None
    r['done']=bool(re.search(r'^done$',lg,re.M))
    js=None
    try: js=json.load(open(L+tag+'.json'))
    except: pass
    r['json']=js is not None
    labels=[o['label'] for o in js['obs']] if js else []
    last=js['obs'][-1] if js and js['obs'] else None
    r['lastlabel']=labels[-1] if labels else None
    r['lastalive']=last['alive'] if last else None
    r['nsteps']=len(labels)
    want='+6s' if kind=='c' else '+25s idle'
    r['reached']=want in labels
    if kind=='c': r['shot']=os.path.exists(OUT+'/shots/'+tag+'-4-after6s.png')
    r['skipmax']=max([int(x) for x in re.findall(r'skipped #(\d+)',con)] or [0])
    r['ranmax']=max([int(x) for x in re.findall(r'skipped so far (\d+)',con)] or [0])
    r['nfaults']=len(js['row']['faults']) if js else None
    r['faults']=[f['text'][:100] for f in js['row']['faults']] if js else []
    failany=any(v for v in r['fail'].values())
    r['crashed']= failany or r['exit']!=0 or not r['done'] or not r['reached'] or (kind=='c' and not r['shot']) or r['lastalive'] is False
    return r
if __name__=='__main__':
    pass
