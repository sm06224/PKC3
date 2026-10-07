/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-tooltip-guard.py` を検める(#1393 形 B の**門と印**)。
 *
 * 🔴 **直す物**: Impress の文書を「ファイル → 閉じる」で閉じる最中に、まれに(30 回に 1 回)
 * 「Office が停止しました」(`memory access out of bounds`)になる。Qt6 wasm(JSPI)では
 * `ToolTip::maShowTimer` が SolarMutex なしで main スレッドに発火し、閉じる側がスライド一覧を dispose している最中に
 * `ToolTip::DoShow()` が走る。`DoShow()` は `!pWindow` しか検めず、`GetPageObjectLayouter()` を
 * null 検査なしで使う。直しは `!pWindow` の検査の直後に、5 つの状態(窓の破棄 / 非表示 / 記述・ページ・配置器が空)を
 * 見て、当たれば**そのツールチップ 1 回だけ出さずに**返す門(印は 20 回まで ── 上限は印だけで、return は毎回)。
 *
 * ⚠ 見るのは 5 つ:
 *   ① **錨が原文に当たる**(上流 `d6226c1a` の抜粋 ── 合成した物ではない)/ 1 つ外しても落ちる(file は不変)/
 *      当て済みは **SKIP(exit 0)で file は 1 バイトも変わらない**
 *   ② **門の中身を、描いた結果で見る**: `!pWindow` の検査 → 門 → 原文の本体(`GetBoundingBox`)の順。
 *      上限の `if` は fprintf だけを包み、`return` は包まない(包むと 21 回目以降は素通りして落ちる)
 *   ③ **足した行は全部印を含み、原文の行は 1 行も書き換えない**
 *   ④ **`<cstdio>`** と印の上限(20)のカウンタが足されている / 他の LO patch と当て先が重ならない
 *   ⑤ workflow の本数の主張がこの 1 本を数えている / 上流の実 file(在れば)へ本当に当たる
 *
 * 🔴 **言えないこと**: 当てた後の C++ が本物の LO の header でコンパイルできること /
 * 本物で停止が消えること。🔴 **この門は、ぶら下がった pointer(解放済みの `SdPage` / `PageObjectLayouter`)を
 * 捕まえられない** ── 焼いて、閉じる probe で `PKC3-TOOLTIPGUARD: … why=` の回数を読むまで言えない
 * (`why=` が 0 回のまま落ちるなら、この門は原因に届いていない)。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-tooltip-guard.py';
const REL = 'sd/source/ui/slidesorter/view/SlsToolTip.cxx';
const MARK = 'PKC3-TOOLTIPGUARD';
const EXCERPT = readFileSync('tests/fixtures/office-lo/SlsToolTip.excerpt.cxx', 'utf-8');
/** 上流(`d6226c1a`)を展開した作業 dir。在るときだけ実 file へ当てる(CI には無い)。 */
/** 上流の実 file(在る箱でだけ回す。CI には無いので skip ── 実物の錨は焼く前の `check-patches-on-ref.sh` が見る)。 */
const UPSTREAM = process.env['PKC3_LO_UP'] ?? '';

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
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-tooltipguard-'));
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

describe('#1393 形 B(tooltip-guard)── 当て方', () => {
  it('🔑 空振り防止: 錨を拾えている(0 件でも「全部当たった」は真になる)', () => {
    expect(FIX_ANCHORS.length, '錨を拾えていない').toBe(2);
    expect(new Set(FIX_ANCHORS).size, '同じ錨が 2 つ在る').toBe(FIX_ANCHORS.length);
    expect(EXCERPT, '抜粋が空').toContain('void ToolTip::DoShow()');
  });

  it('🔴 錨は、上流の原文の抜粋に**ちょうど 1 件**ずつ当たる', () => {
    for (const a of FIX_ANCHORS) {
      expect(count(EXCERPT, a), `錨が 1 件でない:\n${a}`).toBe(1);
    }
  });

  it('🔴 毎回当たる(入力で gate しない)。当てると印が入り、file が変わる', () => {
    const t = tree();
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('patched:');
      expect(t.read()).not.toBe(EXCERPT);
      expect(t.read()).toContain(MARK);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 冪等: 当て済みは SKIP(exit 0)で、file は 1 バイトも変わらない', () => {
    const t = tree();
    try {
      expect(run(SCRIPT, t.dir).code).toBe(0);
      const once = t.read();
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('SKIP');
      expect(t.read()).toBe(once);
      // 印の行が 2 組に増えていない
      expect(count(t.read(), 'if (g_nPkc3TipSaid < 20)')).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 印が在るのに門が欠けている file(部分適用 / 手編集)は SKIP しない ── exit 1 で file は不変', () => {
    // 印を 1 行だけ持つ file(include の行だけ当たっていて、門が無い形)
    const partial = EXCERPT.replace(FIX_ANCHORS[0]!, FIX_ANCHORS[0]! + '// PKC3-TOOLTIPGUARD (only the include line)\n');
    expect(partial, '部分適用の形を作れていない').not.toBe(EXCERPT);
    const t = tree(partial);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(1);
      expect(r.out).not.toContain('SKIP');
      expect(r.out).toContain('部分適用');
      expect(t.read(), '部分適用の file を書き換えた').toBe(partial);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 錨が 1 つでも無ければ落ちる(exit 1)。何も書かない', () => {
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

  it('🔴 錨が 1 字違っても落ちる(上流が `pWindow` の取り方を変えたら、黙って通さない)', () => {
    const broken = EXCERPT.replace('if (msCurrentHelpText.isEmpty() || !pWindow)', 'if (msCurrentHelpText.isEmpty() ||  !pWindow)');
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

  it('🔴 錨が 2 件になっても落ちる(同じ形が増えたら、どちらかを選ばない)', () => {
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

describe('#1393 形 B(tooltip-guard)── 当てた結果(描いた C++ で見る)', () => {
  it('🔴 順序: `!pWindow` の検査 → 門 → 原文の本体(`GetBoundingBox`)(注釈を落として見る)', () => {
    const after = patched();
    const code = after
      .split('\n')
      .filter((l) => !/^\s*\/\/ /.test(l))
      .join('\n');
    const fnAt = code.indexOf('void ToolTip::DoShow()');
    expect(fnAt).toBeGreaterThan(-1);
    const fn = code.slice(fnAt);
    const at = (needle: string): number => {
      expect(count(fn, needle), `「${needle.trim()}」が 1 件でない`).toBe(1);
      return fn.indexOf(needle);
    };
    const guardAt = at('if (msCurrentHelpText.isEmpty() || !pWindow)');
    const whyAt = at('int nPkc3Why = 0;');
    const bodyAt = at('mrSlideSorter.GetView().GetLayouter().GetPageObjectLayouter()->GetBoundingBox(');
    expect(guardAt).toBeLessThan(whyAt);
    expect(whyAt).toBeLessThan(bodyAt);
    // 5 つの検査が、原文の検査(`!pWindow`)の後・本体の前に、この順で在る
    const order = [
      'pWindow->isDisposed()',
      '!pWindow->IsReallyVisible()',
      '!mpDescriptor)',
      '!mpDescriptor->GetPage()',
      '!mrSlideSorter.GetView().GetLayouter().GetPageObjectLayouter()',
    ].map((n) => fn.indexOf(n));
    for (const p of order) expect(p).toBeGreaterThan(whyAt);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]!);
    expect(order[order.length - 1]).toBeLessThan(bodyAt);
  });

  it('🔴 門: why は 1〜5 の 5 通り、上限は fprintf だけを包み `return` は毎回(包むと 21 回目以降は素通りして落ちる)', () => {
    const after = patched();
    const gateAt = after.indexOf('    int nPkc3Why = 0;');
    const bodyAt = after.indexOf('    ::tools::Rectangle aBox (');
    expect(gateAt).toBeGreaterThan(-1);
    expect(bodyAt).toBeGreaterThan(gateAt);
    // 🔑 期待値は patch から取らず**手で書く**
    expect(after.slice(gateAt, bodyAt)).toBe(
      [
        `    int nPkc3Why = 0; // ${MARK}`,
        `    if (pWindow->isDisposed()) nPkc3Why = 1; // ${MARK}`,
        `    else if (!pWindow->IsReallyVisible()) nPkc3Why = 2; // ${MARK}`,
        `    else if (!mpDescriptor) nPkc3Why = 3; // ${MARK}`,
        `    else if (!mpDescriptor->GetPage()) nPkc3Why = 4; // ${MARK}`,
        `    else if (!mrSlideSorter.GetView().GetLayouter().GetPageObjectLayouter()) nPkc3Why = 5; // ${MARK}`,
        `    if (nPkc3Why != 0) // ${MARK}`,
        `    { // ${MARK}`,
        `        if (g_nPkc3TipSaid < 20) // ${MARK}`,
        `        { // ${MARK}`,
        `            ++g_nPkc3TipSaid; // ${MARK}`,
        `            std::fprintf(stderr, "${MARK}: DoShow skipped why=%d\\n", nPkc3Why); // ${MARK}`,
        `        } // ${MARK}`,
        `        return; // ${MARK}`,
        `    } // ${MARK}`,
        ``,
        ``,
      ].join('\n'),
    );
  });

  it('🔴 印の上限: `< 20` と `++` と fprintf が在り、カウンタは file scope(関数より前)に 1 つ', () => {
    const after = patched();
    const counter = `namespace { int g_nPkc3TipSaid = 0; } // ${MARK}`;
    expect(count(after, counter), 'カウンタの宣言が 1 件でない').toBe(1);
    expect(after.indexOf(counter), 'カウンタが関数より後ろ(file scope でない)').toBeLessThan(
      after.indexOf('void ToolTip::DoShow()'),
    );
    expect(count(after, 'g_nPkc3TipSaid < 20'), '上限の `< 20` が 1 件でない').toBe(1);
    expect(count(after, '++g_nPkc3TipSaid;'), '`++` が 1 件でない').toBe(1);
    expect(count(after, 'std::fprintf(stderr, "PKC3-TOOLTIPGUARD: DoShow skipped why=%d\\n", nPkc3Why);')).toBe(1);
    const capAt = after.indexOf('g_nPkc3TipSaid < 20');
    const incAt = after.indexOf('++g_nPkc3TipSaid;');
    const putsAt = after.indexOf('std::fprintf(');
    expect(capAt).toBeLessThan(incAt);
    expect(incAt).toBeLessThan(putsAt);
  });

  it('🔴 `#include <cstdio>` が `<vcl/help.hxx>` の直後に足されている(`std::fprintf` の宣言)', () => {
    const after = patched();
    expect(count(EXCERPT, '#include <cstdio>'), '抜粋の前提(元には無い)').toBe(0);
    expect(after).toContain(`#include <vcl/help.hxx>\n#include <cstdio> // ${MARK}\n`);
    expect(after.indexOf('#include <cstdio>')).toBeLessThan(after.indexOf('std::fprintf'));
  });

  it('🔴 足した行は全部 mark で終わる(注釈の 1 行を除く)。原文の行は 1 行も書き換えない', () => {
    const after = patched();
    expect(after).not.toBe(EXCERPT);
    expect(restore(after)).toBe(EXCERPT);
    // 足した行は 18 行(include 1 + カウンタ 1 + 注釈 1 + 門 15)
    const added = after.split('\n').filter((l) => l.includes(MARK));
    expect(added.length).toBe(18);
    // 🔴 印の無い足し行が無い(原文の行集合に無い行は、全部印を含む)
    const origLines = new Set(EXCERPT.split('\n'));
    const bare = after.split('\n').filter((l) => !origLines.has(l) && !l.includes(MARK));
    expect(bare, '印の無い足し行').toEqual([]);
    // 実行行は全部、行末が `// PKC3-TOOLTIPGUARD`(注釈の行だけが先頭に `// PKC3-TOOLTIPGUARD(` を持つ)
    const comments = added.filter((l) => /^\s*\/\/ /.test(l));
    expect(comments.length).toBe(1);
    for (const l of added.filter((x) => !comments.includes(x))) {
      expect(l.endsWith(` // ${MARK}`), `行末が印でない: ${l}`).toBe(true);
    }
    for (const l of added) {
      expect(l, '行末の \\ は次の行をコメントへ連結する').not.toMatch(/\\\s*$/);
      expect(l, 'ブロックコメントは使わない').not.toMatch(/\/\*|\*\//);
    }
    // 括弧は釣り合っている(文字列を除いて `{` と `}` の数が同じ)
    const braces = added
      .filter((l) => !comments.includes(l))
      .join('\n')
      .replace(/"[^"]*"/g, '');
    expect(count(braces, '{')).toBe(count(braces, '}'));
  });

  it('🔴 原文の他の所は動かない: `GetBoundingBox` の呼び出し・`ShowPopover` が元のまま 1 件', () => {
    const after = patched();
    expect(count(after, 'mrSlideSorter.GetView().GetLayouter().GetPageObjectLayouter()->GetBoundingBox(')).toBe(1);
    expect(count(after, 'Help::ShowPopover(')).toBe(1);
    expect(count(after, '    if (maShowTimer.IsActive())\n')).toBe(1);
  });
});

describe('#1393 形 B(tooltip-guard)── 上流の実 file へ', () => {
  const real = UPSTREAM ? join(UPSTREAM, REL) : '';
  it.skipIf(!real || !existsSync(real))('🔴 実 file へ当たる(exit 0)。足した行は 18・消した行は 0。2 度目は SKIP で不変', () => {
    const orig = readFileSync(real, 'utf-8');
    const t = tree(orig);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(0);
      const after = t.read();
      const o = orig.split('\n');
      const a = after.split('\n');
      expect(a.length - o.length).toBe(18);
      expect(restore(after)).toBe(orig);
      const r2 = run(SCRIPT, t.dir);
      expect(r2.code, r2.out).toBe(0);
      expect(r2.out).toContain('SKIP');
      expect(t.read()).toBe(after);
    } finally {
      t.cleanup();
    }
  });
});

describe('#1393 形 B(tooltip-guard)── 他の検査との関係', () => {
  it('🔑 当て先が、他の LO patch と重ならない(同じ file を 2 本が触ると当てる順で結果が変わる)', () => {
    const owners = readdirSync('build/office-wasm')
      .filter((f) => /^patch-.*\.py$/.test(f))
      .filter((f) => readFileSync(join('build/office-wasm', f), 'utf-8').includes(`"${REL}"`));
    expect(owners).toEqual(['patch-lo-tooltip-guard.py']);
  });

  it('🔑 check-patches-on-ref.sh が拾える形(`SRC = "…"`)で当て先を宣言している', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/^SRC\s*=\s*"sd\/source\/ui\/slidesorter\/view\/SlsToolTip\.cxx"/m);
  });

  it('🔑 workflow の本数の主張が、この 1 本を数えている(27 → 28。いまの `-eq` は 29)', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(yml).toMatch(/27 → 28\(2026-10-07\)/);
    expect(yml).toContain('patch-lo-tooltip-guard.py');
    expect(yml).toContain('test "$n" -eq 29');
  });
});
