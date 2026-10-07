/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-hscroll-hdl.py` を検める(#1393 の**直し(落ちた先)**)。
 *
 * 🔴 **直す物**: Impress の文書を閉じると「Office が停止しました」(`table index is out of bounds`)に
 * なることがある。`SalInstanceScrolledWindow` の ctor は縦・横の**両方**の `ScrollHdl` を自分の物へ差し替えて
 * 元の Link を退避するのに、dtor は**縦だけ**戻す(上流の戻し忘れ)。wrapper が破棄された後、横の
 * スクロールバーの Link は解放済みの wrapper を指したままで、`doSetAllocation` 末尾の `Scroll()` がそこへ飛ぶ。
 * 直しは dtor で横も戻す 2 行。
 *
 * ⚠ 見るのは 5 つ:
 *   ① **錨が原文に当たる**(上流の抜粋 ── 合成した物ではない)/ 1 つ外しても落ちる / 二重当ては落ちて不変
 *   ② **直しの中身を、描いた結果で見る**: dtor の中で、縦の戻しの**後**に横の戻しが在る /
 *      **ctor の側は 1 行も動かない**(`getVertScrollBar()` の字は ctor にも在る ── 錨が ctor へ漏れない)
 *   ③ **足した行は全部印を含み、原文の行は 1 行も書き換えない**
 *   ④ 他の LO patch と当て先が重ならない
 *   ⑤ workflow の本数の主張がこの 1 本を数えている
 *
 * 🔴 **言えないこと**: 当てた後の C++ が本物の LO の header でコンパイルできること /
 * 本物の JSPI で停止が消えること(焼いて、Impress の閉じる probe で確かめる)。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-hscroll-hdl.py';
const REL = 'vcl/source/app/salvtables.cxx';
const MARK = 'PKC3-HSCROLLHDL';
const EXCERPT = readFileSync('tests/fixtures/office-lo/salvtables.excerpt.cxx', 'utf-8');

/** python の module から値を取り出す(⚠ 錨の字をここへ書き写さない)。 */
function pyJson(script: string, expr: string): unknown {
  const code = [
    'import importlib.util,sys,json',
    'sys.dont_write_bytecode=True',
    `sp=importlib.util.spec_from_file_location("p","${script}")`,
    'm=importlib.util.module_from_spec(sp); sp.loader.exec_module(m)',
    `print(json.dumps(${expr}))`,
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf-8', stdio: 'pipe' }));
}

const FIX_ANCHORS = pyJson(SCRIPT, '[a for a,_ in m.PARTS]') as string[];

interface Tree {
  dir: string;
  read: () => string;
  cleanup: () => void;
}

function tree(body: string = EXCERPT): Tree {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-hscrollhdl-'));
  mkdirSync(dirname(join(dir, REL)), { recursive: true });
  writeFileSync(join(dir, REL), body, 'utf-8');
  return {
    dir,
    read: () => readFileSync(join(dir, REL), 'utf-8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function run(script: string, dir: string): { code: number; out: string } {
  const r = spawnSync('python3', [script, dir], { encoding: 'utf-8', stdio: 'pipe' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** 数える(部分文字列の出現数)。 */
const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** 足した行(印を含む行)を取り除く。この直しは**原文の行を 1 行も書き換えない**(足すだけ)。 */
function restore(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.includes(MARK))
    .join('\n');
}

function patched(): string {
  const t = tree();
  try {
    expect(run(SCRIPT, t.dir).code).toBe(0);
    return t.read();
  } finally {
    t.cleanup();
  }
}

describe('#1393 の直し(hscroll-hdl)── 当て方', () => {
  it('🔑 空振り防止: 錨を拾えている(0 件でも「全部当たった」は真になる)', () => {
    expect(FIX_ANCHORS.length, '直しの錨を拾えていない').toBe(1);
    expect(EXCERPT, '抜粋が空').toContain('SalInstanceScrolledWindow::~SalInstanceScrolledWindow()');
  });

  it('🔴 錨は、上流の原文の抜粋に**ちょうど 1 件**当たる(⚠ 行だけなら ctor にも在る)', () => {
    expect(count(EXCERPT, FIX_ANCHORS[0]!), '錨が 1 件でない').toBe(1);
    // ⚠ 対照群: 縦のスクロールバーの取得は ctor と dtor の 2 か所に在る(行だけを錨にすると曖昧になる)
    expect(count(EXCERPT, '    ScrollBar& rVertScrollBar = m_xScrolledWindow->getVertScrollBar();\n')).toBe(2);
  });

  it('🔴 毎回当たる(入力で gate しない)。当てると印が入り、file が変わる', () => {
    const t = tree();
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(0);
      expect(t.read()).not.toBe(EXCERPT);
      expect(t.read()).toContain(MARK);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 二重当ては落ち(exit 1)、file は 1 バイトも変わらない', () => {
    const t = tree();
    try {
      expect(run(SCRIPT, t.dir).code).toBe(0);
      const once = t.read();
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('二重当て');
      expect(t.read()).toBe(once);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 錨が無ければ落ちる。何も書かない', () => {
    const broken = EXCERPT.replace(FIX_ANCHORS[0]!, '// 上流が形を変えた\n');
    expect(broken, '錨を外せていない').not.toBe(EXCERPT);
    const t = tree(broken);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(1);
      expect(r.out, '落ち方が「錨の欠落」でない').toContain('錨が 0 件');
      expect(t.read(), '落ちたのに書き換えている').toBe(broken);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 錨が 1 字違っても落ちる(上流が縦の戻しの変数名を変えたら、黙って通さない)', () => {
    const broken = EXCERPT.replace('rVertScrollBar.SetScrollHdl(m_aOrigVScrollHdl);\n}', 'rVertScrollBar.SetScrollHdl(m_aOrigVScrollHdl2);\n}');
    expect(broken).not.toBe(EXCERPT);
    const t = tree(broken);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(1);
      expect(t.read()).toBe(broken);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 錨が 2 件になっても落ちる(同じ形が上流に増えたら、どちらかを選ばない)', () => {
    const doubled = `${EXCERPT}\n${FIX_ANCHORS[0]}`;
    const t = tree(doubled);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('錨が 2 件');
      expect(t.read()).toBe(doubled);
    } finally {
      t.cleanup();
    }
  });

  it('当て先の file が無ければ落ちる', () => {
    const t = tree();
    try {
      const r = run(SCRIPT, `${t.dir}/no-such-root`);
      expect(r.code).toBe(1);
      expect(r.out).toContain(REL);
    } finally {
      t.cleanup();
    }
  });
});

describe('#1393 の直し(hscroll-hdl)── 当てた結果(描いた C++ で見る)', () => {
  it('🔴 dtor の中で、縦の戻しの**後**に横の戻しが在り、dtor の閉じ括弧より前', () => {
    const after = patched();
    const dtorAt = after.indexOf('SalInstanceScrolledWindow::~SalInstanceScrolledWindow()\n');
    expect(dtorAt).toBeGreaterThan(-1);
    const dtorEnd = after.indexOf('\n}\n', dtorAt);
    const dtor = after.slice(dtorAt, dtorEnd);
    const vert = dtor.indexOf('rVertScrollBar.SetScrollHdl(m_aOrigVScrollHdl);');
    const horzDecl = dtor.indexOf('ScrollBar& rHorzScrollBar = m_xScrolledWindow->getHorzScrollBar(); // PKC3-HSCROLLHDL');
    const horz = dtor.indexOf('rHorzScrollBar.SetScrollHdl(m_aOrigHScrollHdl); // PKC3-HSCROLLHDL');
    expect(vert).toBeGreaterThan(-1);
    expect(horzDecl).toBeGreaterThan(vert);
    expect(horz).toBeGreaterThan(horzDecl);
    // 🔴 横の戻しは dtor の**中**に 1 件だけ(他の所へ漏れていない)
    expect(count(after, 'rHorzScrollBar.SetScrollHdl(m_aOrigHScrollHdl); // PKC3-HSCROLLHDL')).toBe(1);
    expect(count(dtor, 'm_aOrigHScrollHdl')).toBe(1);
  });

  it('🔴 ctor の側は 1 行も動かない(横の差し替え + 退避は元のまま 1 件ずつ)', () => {
    const after = patched();
    expect(count(after, 'm_aOrigHScrollHdl = rHorzScrollBar.GetScrollHdl();')).toBe(1);
    expect(count(after, 'rHorzScrollBar.SetScrollHdl(LINK(this, SalInstanceScrolledWindow, HscrollHdl));')).toBe(1);
    expect(count(after, 'rVertScrollBar.SetScrollHdl(LINK(this, SalInstanceScrolledWindow, VscrollHdl));')).toBe(1);
    // 縦の戻しは元のまま 1 件(足したのは横だけ)
    expect(count(after, 'rVertScrollBar.SetScrollHdl(m_aOrigVScrollHdl);')).toBe(1);
    // HscrollHdl の本体も元のまま
    expect(after).toContain('        m_aOrigHScrollHdl.Call(&m_xScrolledWindow->getHorzScrollBar());\n');
  });

  it('🔴 足した行は全部印を含み、原文の行は 1 行も書き換えない(印の行を除くと原文と一致)', () => {
    const after = patched();
    expect(after).not.toBe(EXCERPT);
    expect(restore(after)).toBe(EXCERPT);
    const added = after.split('\n').filter((l) => l.includes(MARK));
    expect(added.length).toBe(2);
    // 🔴 印の無い足し行が無い(原文の行集合に無い行は、全部印を含む)
    const origLines = new Set(EXCERPT.split('\n'));
    const bare = after.split('\n').filter((l) => !origLines.has(l) && !l.includes(MARK));
    expect(bare, '印の無い足し行').toEqual([]);
    // ⚠ 期待値は patch から取らず**手で書く**
    expect(added.map((l) => l.trim())).toEqual([
      `ScrollBar& rHorzScrollBar = m_xScrolledWindow->getHorzScrollBar(); // ${MARK}`,
      `rHorzScrollBar.SetScrollHdl(m_aOrigHScrollHdl); // ${MARK}`,
    ]);
    // include は足さない(`std::fputs` を使わない直し)
    expect(after).not.toContain('#include <cstdio>');
  });
});

describe('#1393 の直し(hscroll-hdl)── 他の検査との関係', () => {
  it('🔑 当て先が、他の LO patch と重ならない(同じ file を 2 本が触ると当てる順で結果が変わる)', () => {
    const owners = readdirSync('build/office-wasm')
      .filter((f) => /^patch-.*\.py$/.test(f))
      .filter((f) => readFileSync(join('build/office-wasm', f), 'utf-8').includes(`"${REL}"`));
    expect(owners).toEqual(['patch-lo-hscroll-hdl.py']);
  });

  it('🔑 check-patches-on-ref.sh が拾える形(`SRC = "…"`)で当て先を宣言している', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/^SRC\s*=\s*"vcl\/source\/app\/salvtables\.cxx"/m);
  });

  it('🔑 workflow の本数の主張が、この 1 本を数えている(25 → 26)', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(yml).toMatch(/25 → 26\(2026-10-07\)/);
    expect(yml).toContain('patch-lo-hscroll-hdl.py');
    expect(yml).toContain('test "$n" -eq 34');
  });
});
