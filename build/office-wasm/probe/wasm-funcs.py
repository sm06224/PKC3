#!/usr/bin/env python3
"""wasm の file 内バイト位置(CDP の Debugger.paused の callFrames[].location.columnNumber)を
関数の番号(wasm-function[N] の N)に直す。code section の各 body の [start, end) を表にする。
usage: python3 -I wasm-funcs.py --wasm soffice.wasm OFFSET...   (OFFSET は 10 進)
       python3 -I wasm-funcs.py --wasm soffice.wasm --dump table.json"""
import argparse, bisect, json, sys

def uleb(buf, pos):
    v = 0; sh = 0
    while True:
        b = buf[pos]; pos += 1
        v |= (b & 0x7F) << sh
        if b & 0x80 == 0: return v, pos
        sh += 7

def parse(path):
    buf = open(path, 'rb').read()
    assert buf[:4] == b'\x00asm', 'not wasm'
    pos = 8; n_import_funcs = 0; bodies = None
    while pos < len(buf):
        sid = buf[pos]; pos += 1
        size, pos = uleb(buf, pos)
        start = pos; end = pos + size
        if sid == 2:  # import
            cnt, p = uleb(buf, start)
            for _ in range(cnt):
                l, p = uleb(buf, p); p += l
                l, p = uleb(buf, p); p += l
                kind = buf[p]; p += 1
                if kind == 0: _, p = uleb(buf, p); n_import_funcs += 1
                elif kind == 1: p += 1; fl = buf[p]; p += 1; _, p = uleb(buf, p); (fl & 1) and (lambda: None)() ; p = p if not (fl & 1) else uleb(buf, p)[1]
                elif kind == 2: fl = buf[p]; p += 1; _, p = uleb(buf, p); p = p if not (fl & 1) else uleb(buf, p)[1]
                elif kind == 3: p += 2
                elif kind == 4: _, p = uleb(buf, p)
                else: raise SystemExit(f'unknown import kind {kind}')
        elif sid == 10:  # code
            cnt, p = uleb(buf, start); bodies = []
            for i in range(cnt):
                bsize, p = uleb(buf, p)
                bodies.append((p, p + bsize)); p += bsize
        pos = end
    assert bodies is not None, 'no code section'
    return n_import_funcs, bodies

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--wasm', required=True); ap.add_argument('--dump'); ap.add_argument('offsets', nargs='*', type=int)
    a = ap.parse_args()
    nimp, bodies = parse(a.wasm)
    starts = [b[0] for b in bodies]
    print(f'imports={nimp} defined={len(bodies)} code=[{bodies[0][0]},{bodies[-1][1]})', file=sys.stderr)
    if a.dump: json.dump({'imports': nimp, 'bodies': bodies}, open(a.dump, 'w'))
    for off in a.offsets:
        i = bisect.bisect_right(starts, off) - 1
        if i < 0 or off >= bodies[i][1]: print(f'{off}\t(not in a function body)')
        else: print(f'{off}\twasm-function[{nimp + i}]\tbody_off=+{off - bodies[i][0]}')
main()
