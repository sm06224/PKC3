/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-layout-guard.py` を検める(#1393 の**直し(入口の門)**)。
 *
 * 🔴 **直す物**: Impress で枠を Tab → Enter → Esc で操作してから「ファイル → 閉じる」を押すと、
 * 「Office が停止しました」(`table index is out of bounds`)になることがある。
 * `InterimItemWindow::dispose()` は `m_xContainer.reset()` の後で `m_aLayoutIdle.Stop()` を呼ぶ。
 * JSPI の Qt backend では、その間にレイアウトの Idle が main スレッドから割り込み、
 * 窓の状態を 1 つも検めない `Layout()` が空になった子窓へ触る。直しは `Layout()` の
 * `m_aLayoutIdle.Stop();` の直後で、`m_xContainer` が無ければ(= dispose 中)返す。
 *
 * ⚠ 見るのは 5 つ:
 *   ① **錨が原文に当たる**(上流 `7f96a38cf750` の file そのまま ── 合成した物ではない)/ 1 つ外しても落ちる /
 *      二重当ては落ちて不変
 *   ② **直しの中身を、描いた結果で見る**: `Stop()` の**後**に門が在り、門の中で返り、
 *      `Stop()` / `GetWindow(FirstChild)` / `setLayoutAllocation` は原文のまま残る(順序で見る)
 *   ③ **足した行は全部印を含み、原文の行は 1 行も書き換えない**(印の行を除くと原文と一致する)
 *   ④ **`<cstdio>`** が足されている(`std::fputs` の宣言)
 *   ⑤ 他の LO patch と当て先が重ならない / workflow の本数の主張がこの 1 本を数えている
 *
 * 🔴 **言えないこと**: 当てた後の C++ が本物の LO の header でコンパイルできること /
 * 本物の JSPI で閉じる操作が止まらなくなること。どちらも**焼いて、Impress の閉じる probe で
 * `PKC3-LAYOUTGUARD:` の行が出て fault が消える**まで確かめられない。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-layout-guard.py';
const REL = 'vcl/source/control/InterimItemWindow.cxx';
const MARK = 'PKC3-LAYOUTGUARD';
const EXCERPT = readFileSync('tests/fixtures/office-lo/InterimItemWindow.excerpt.cxx', 'utf-8');

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
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-layoutguard-'));
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

describe('#1393 の直し(layout-guard)── 当て方', () => {
  it('🔑 空振り防止: 錨を拾えている(0 件でも「全部当たった」は真になる)', () => {
    expect(FIX_ANCHORS.length, '直しの錨を拾えていない').toBe(2);
    expect(new Set(FIX_ANCHORS).size, '同じ錨が 2 つ在る').toBe(FIX_ANCHORS.length);
    expect(EXCERPT, '抜粋が空').toContain('void InterimItemWindow::Layout()');
  });

  it('🔴 錨は、上流の原文に**ちょうど 1 件**ずつ当たる(`Stop();` は dispose にも在るので、関数の頭ごと)', () => {
    for (const a of FIX_ANCHORS) {
      expect(count(EXCERPT, a), `錨が 1 件でない:\n${a}`).toBe(1);
    }
    // ⚠ 対照群: 4 字下げの `m_aLayoutIdle.Stop();` だけなら原文に 2 件在る(dispose と Layout)(= 行だけを錨にすると曖昧になる)
    expect(count(EXCERPT, '\n    m_aLayoutIdle.Stop();\n')).toBe(2);
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

  it('🔴 錨が 1 つでも無ければ落ちる。何も書かない', () => {
    for (let i = 0; i < FIX_ANCHORS.length; i++) {
      const broken = EXCERPT.replace(FIX_ANCHORS[i]!, '// 上流が形を変えた\n');
      expect(broken, `錨 ${i} を外せていない`).not.toBe(EXCERPT);
      const t = tree(broken);
      try {
        const r = run(SCRIPT, t.dir);
        expect(r.code, `錨 ${i} を外しても落ちない:\n${r.out}`).toBe(1);
        expect(r.out, `錨 ${i} の落ち方が「錨の欠落」でない`).toContain('錨が 0 件');
        expect(t.read(), '落ちたのに書き換えている').toBe(broken);
      } finally {
        t.cleanup();
      }
    }
  });

  it('🔴 錨が 1 字違っても落ちる(`Stop();` の前の字下げが変わった上流を、黙って通さない)', () => {
    const broken = EXCERPT.replace('void InterimItemWindow::Layout()\n{\n    m_aLayoutIdle.Stop();\n', 'void InterimItemWindow::Layout()\n{\n  m_aLayoutIdle.Stop();\n');
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
    const doubled = `${EXCERPT}\n${FIX_ANCHORS[1]}`;
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

describe('#1393 の直し(layout-guard)── 当てた結果(描いた C++ で見る)', () => {
  it('🔴 `Stop()` の後に門が在り、門の中で返り、残りの Layout は原文のまま後ろに続く(順序で見る)', () => {
    const after = patched();
    // 注釈を落としてから探す(注釈にも `Layout` の語は出る)
    const code = after
      .split('\n')
      .filter((l) => !/^\s*\/\/ /.test(l))
      .join('\n');
    const at = (needle: string): number => {
      expect(count(code, needle), `「${needle.trim()}」が 1 件でない`).toBe(1);
      return code.indexOf(needle);
    };
    const layoutAt = at('void InterimItemWindow::Layout()\n');
    const stopAt = code.indexOf('m_aLayoutIdle.Stop();', layoutAt);
    const guardAt = at('if (!m_xContainer) // PKC3-LAYOUTGUARD');
    const putsAt = at('std::fputs("PKC3-LAYOUTGUARD: Layout skipped (window not ready or disposing)\\n", stderr); // PKC3-LAYOUTGUARD');
    const retAt = at('return; // PKC3-LAYOUTGUARD');
    const childAt = at('vcl::Window* pChild = GetWindow(GetWindowType::FirstChild);\n    assert(pChild);\n    VclContainer::setLayoutAllocation');
    expect(stopAt, 'Layout の Stop が見つからない').toBeGreaterThan(layoutAt);
    // 順序: 関数の頭 → Stop → 門 → 印 → return → 残り(子窓へ触る所)
    expect(stopAt).toBeLessThan(guardAt);
    expect(guardAt).toBeLessThan(putsAt);
    expect(putsAt).toBeLessThan(retAt);
    expect(retAt).toBeLessThan(childAt);
    // 🔴 Stop が門より**前**(止めてから返る = 再予約を残さない)
    expect(code.slice(layoutAt, guardAt)).toContain('m_aLayoutIdle.Stop();');
  });

  it('🔴 原文の他の所は動かない: dispose の reset 3 つと Stop、StartIdleLayout、Resize の呼び出しが 1 件ずつ', () => {
    const after = patched();
    expect(after).toContain('    m_xContainer.reset();\n    m_xBuilder.reset();\n    m_xVclContentArea.disposeAndClear();\n\n    m_aLayoutIdle.Stop();\n');
    expect(after).toContain('void InterimItemWindow::Resize() { Layout(); }');
    expect(after).toContain('IMPL_LINK_NOARG(InterimItemWindow, DoLayout, Timer*, void) { Layout(); }');
    // Stop は元のまま 3 件(足したのは門であって Stop ではない)
    expect(count(EXCERPT, 'm_aLayoutIdle.Stop();'), '抜粋の前提').toBe(3);
    expect(count(after, 'm_aLayoutIdle.Stop();')).toBe(3);
  });

  it('🔴 `#include <cstdio>` が `<window.h>` の直後に足されている(`std::fputs` の宣言)', () => {
    const after = patched();
    expect(count(EXCERPT, '#include <cstdio>'), '抜粋の前提(元には無い)').toBe(0);
    expect(after).toContain(`#include <window.h>\n#include <cstdio> // ${MARK}\n`);
    // include は file の頭(関数の外)に在り、fputs を使う所より前
    expect(after.indexOf('#include <cstdio>')).toBeLessThan(after.indexOf('std::fputs'));
  });

  it('🔴 足した行は全部印を含み、原文の行は 1 行も書き換えない(印の行を除くと原文と一致)', () => {
    const after = patched();
    // ⚠ 対照群: 当たった後が原文と違うこと(違わなければ、何も足していない)
    expect(after).not.toBe(EXCERPT);
    expect(restore(after)).toBe(EXCERPT);
    // 足した行は 9 行(include 1 + 注釈 3 + 本体 5)
    const added = after.split('\n').filter((l) => l.includes(MARK));
    expect(added.length).toBe(9);
    // 🔴 印の無い足し行が無い: 原文の行集合に無い行は、全部印を含む(grep で数える形)
    const origLines = new Set(EXCERPT.split('\n'));
    const bare = after.split('\n').filter((l) => !origLines.has(l) && !l.includes(MARK));
    expect(bare, '印の無い足し行').toEqual([]);
    // 🔴 中身まで見る(⚠ 期待値は patch から取らず**手で書く** ── 同じ盲点を共有しない)。
    //    注釈を落とした実行行だけで比べる
    const code = added.filter((l) => !/^\s*\/\/ /.test(l)).map((l) => l.trim());
    expect(code).toEqual([
      `#include <cstdio> // ${MARK}`,
      `if (!m_xContainer) // ${MARK}`,
      `{ // ${MARK}`,
      `std::fputs("${MARK}: Layout skipped (window not ready or disposing)\\n", stderr); // ${MARK}`,
      `return; // ${MARK}`,
      `} // ${MARK}`,
    ]);
    for (const l of added) {
      expect(l, '行末の \\ は次の行をコメントへ連結する').not.toMatch(/\\\s*$/);
      expect(l, 'ブロックコメントは使わない').not.toMatch(/\/\*|\*\//);
    }
    // 注釈は 3 行で、全部 `//` 始まり(実行文を注釈の顔で足していない)
    expect(added.filter((l) => /^\s*\/\/ /.test(l)).length).toBe(3);
    // 括弧は釣り合っている
    const braces = code.join('\n').replace(/"[^"]*"/g, '');
    expect(count(braces, '{')).toBe(count(braces, '}'));
  });
});

describe('#1393 の直し(layout-guard)── 他の検査との関係', () => {
  it('🔑 当て先が、他の LO patch と重ならない(同じ file を 2 本が触ると当てる順で結果が変わる)', () => {
    const owners = readdirSync('build/office-wasm')
      .filter((f) => /^patch-.*\.py$/.test(f))
      .filter((f) => readFileSync(join('build/office-wasm', f), 'utf-8').includes(`"${REL}"`));
    expect(owners).toEqual(['patch-lo-layout-guard.py']);
  });

  it('🔑 check-patches-on-ref.sh が拾える形(`SRC = "…"`)で当て先を宣言している', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/^SRC\s*=\s*"vcl\/source\/control\/InterimItemWindow\.cxx"/m);
  });

  it('🔑 workflow の本数の主張が、この 1 本を数えている(24 → 25)', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(yml).toMatch(/24 → 25\(2026-10-07\)/);
    expect(yml).toContain('patch-lo-layout-guard.py');
    // 3 本(layout-guard / hscroll-hdl / viewdata-gone)と tooltip-guard / grip-guard の 2 本を足して 24 → 29、timer-mutex で 30、yield-wait(#1408 の印)で 31
    expect(yml).toContain('test "$n" -eq 34');
  });
});
