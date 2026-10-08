/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-viewdata-gone.py` を検める(#1396 の**直し**)。
 *
 * 🔴 **直す物**: Impress(`.odp`)を開いた直後に、何もしていないのに「Office が停止しました」
 * (`memory access out of bounds`)になることがある。stack は `SvTreeListBox::getPreferredDimensions` ←
 * `IconView::GetOptimalSize`。`getPreferredDimensions` は model の全 entry の `GetWidth()` を引くが、
 * それは view data(`m_DataTable`)を引く。model に入った後・view data を作る前(`Insert` の Broadcast の前)や、
 * view data を消した後・entry を消す前(`Clear`)に、レイアウトの Idle が割り込むと null 起点の添字で落ちる。
 * 直しは門 1 つ: view data の無い entry は飛ばして次へ進む(印は 20 回まで ── 上限は印だけで、skip は毎回)。
 * ⚠ `m_pModel` の null 門は足さない(`SvTreeListBox::First()` が `treelistbox.hxx:446` で null 安全なので、
 * 足しても挙動が変わらない ── レビューで外した)。
 *
 * ⚠ 見るのは 5 つ:
 *   ① **錨が原文に当たる**(上流の抜粋 ── 合成した物ではない)/ 1 つ外しても落ちる / 二重当ては落ちて不変
 *   ② **直しの中身を、描いた結果で見る**: `rWidths.clear()` → `First()` → `while` →
 *      view data の門(飛ばすときは `Next` へ進む = 無限ループにならない。上限は印だけ)→ 原文の本体、の順
 *   ③ **足した行は全部印を含み、原文の行は 1 行も書き換えない**
 *   ④ **`<cstdio>`** と印の上限のカウンタが足されている / 他の LO patch と当て先が重ならない
 *   ⑤ workflow の本数の主張がこの 1 本を数えている
 *
 * 🔴 **言えないこと**: 当てた後の C++ が本物の LO の header でコンパイルできること
 * (`m_DataTable` / `Next()` が const の member から使えることは `treelistbox.hxx:208` / `:447` の
 * 原文で確かめたが、コンパイルはしていない)/ 本物で停止が消えること。**焼いて、Impress を開く probe で
 * `PKC3-VIEWDATAGONE:` が出て停止が消える(または 0 回のまま落ちて「view data ではない」と分かる)**まで
 * 確かめられない。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-viewdata-gone.py';
const REL = 'vcl/source/treelist/treelistbox.cxx';
const MARK = 'PKC3-VIEWDATAGONE';
const EXCERPT = readFileSync('tests/fixtures/office-lo/treelistbox.excerpt.cxx', 'utf-8');

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
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-viewdatagone-'));
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

describe('#1396 の直し(viewdata-gone)── 当て方', () => {
  it('🔑 空振り防止: 錨を拾えている(0 件でも「全部当たった」は真になる)', () => {
    expect(FIX_ANCHORS.length, '直しの錨を拾えていない').toBe(2);
    expect(new Set(FIX_ANCHORS).size, '同じ錨が 2 つ在る').toBe(FIX_ANCHORS.length);
    expect(EXCERPT, '抜粋が空').toContain('tools::Long SvTreeListBox::getPreferredDimensions(');
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

  it('🔴 錨が 1 字違っても落ちる(上流が `First()` の呼び方を変えたら、黙って通さない)', () => {
    const broken = EXCERPT.replace('SvTreeListEntry* pEntry = First();\n    while (pEntry)', 'SvTreeListEntry* pEntry = First(); \n    while (pEntry)');
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

describe('#1396 の直し(viewdata-gone)── 当てた結果(描いた C++ で見る)', () => {
  it('🔴 順序: clear → First → while → view data の門 → 原文の本体(注釈を落として見る)', () => {
    const after = patched();
    // 注釈を落としてから探す(注釈にも `First` の語は出うる)
    const code = after
      .split('\n')
      .filter((l) => !/^\s*\/\/ /.test(l))
      .join('\n');
    const fnAt = code.indexOf('tools::Long SvTreeListBox::getPreferredDimensions(');
    expect(fnAt).toBeGreaterThan(-1);
    const fn = code.slice(fnAt, code.indexOf('\nSize SvTreeListBox::GetOptimalSize', fnAt));
    const at = (needle: string): number => {
      expect(count(fn, needle), `「${needle.trim()}」が 1 件でない`).toBe(1);
      return fn.indexOf(needle);
    };
    const clearAt = at('rWidths.clear();');
    const firstAt = at('SvTreeListEntry* pEntry = First();');
    const whileAt = at('while (pEntry)');
    const gateAt = at('if (m_DataTable.find(pEntry) == m_DataTable.end())');
    const bodyAt = at('sal_uInt16 nCount = pEntry->ItemCount();');
    expect(clearAt).toBeLessThan(firstAt);
    // 🔴 `m_pModel` の null 門は無い(`First()` は null 安全 ── 足しても挙動が変わらない)
    expect(count(after, '!m_pModel')).toBe(0);
    expect(firstAt).toBeLessThan(whileAt);
    expect(whileAt).toBeLessThan(gateAt);
    expect(gateAt).toBeLessThan(bodyAt);
    // 🔴 view data の門は `while (pEntry)` の**直後**の `{` の次(= 全 entry が通る所)
    expect(fn).toContain('    while (pEntry)\n    {\n        if (m_DataTable.find(pEntry)');
  });

  it('🔴 飛ばす枝は `Next(pEntry)` で進んでから `continue`(進まずに continue すると無限ループ)。上限は印だけ', () => {
    const after = patched();
    const gateAt = after.indexOf('if (m_DataTable.find(pEntry) == m_DataTable.end())');
    const bodyAt = after.indexOf('sal_uInt16 nCount = pEntry->ItemCount();');
    expect(gateAt).toBeGreaterThan(-1);
    expect(bodyAt).toBeGreaterThan(gateAt);
    // 🔑 期待値は patch から取らず**手で書く**。上限の if は fputs だけを包み、`Next` / `continue` は包まない
    //    (`Next` が上限の中に入ると、21 回目以降は進まずに continue して**無限ループ**になる)
    const gate = after.slice(gateAt, bodyAt);
    expect(gate).toBe(
      [
        `if (m_DataTable.find(pEntry) == m_DataTable.end()) // ${MARK}`,
        `        { // ${MARK}`,
        `            if (g_nPkc3ViewDataGoneSaid < 20) // ${MARK}`,
        `            { // ${MARK}`,
        `                ++g_nPkc3ViewDataGoneSaid; // ${MARK}`,
        `                std::fputs("${MARK}: entry without view data skipped\\n", stderr); // ${MARK}`,
        `            } // ${MARK}`,
        `            pEntry = Next(pEntry); // ${MARK}`,
        `            continue; // ${MARK}`,
        `        } // ${MARK}`,
        `        `,
      ].join('\n'),
    );
    // 原文の進め方(末尾の `pEntry = Next( pEntry );` と `nHeight += …`)は元のまま 1 件
    expect(count(after, '        pEntry = Next( pEntry );\n        nHeight += GetEntryHeight();\n')).toBe(1);
    // 🔴 `return nHeight;` は元のまま(本体の戻りは触らない)
    expect(count(after, '    return nHeight;\n')).toBe(1);
  });

  it('🔴 印の上限: `< 20` と `++` が在り、カウンタは file scope(関数より前)に 1 つ。`fputs` は上限の内側', () => {
    const after = patched();
    const counter = `namespace { int g_nPkc3ViewDataGoneSaid = 0; } // ${MARK}`;
    expect(count(after, counter), 'カウンタの宣言が 1 件でない').toBe(1);
    expect(after.indexOf(counter), 'カウンタが関数より後ろ(file scope でない)').toBeLessThan(
      after.indexOf('tools::Long SvTreeListBox::getPreferredDimensions('),
    );
    expect(count(after, 'g_nPkc3ViewDataGoneSaid < 20'), '上限の `< 20` が 1 件でない').toBe(1);
    expect(count(after, '++g_nPkc3ViewDataGoneSaid;'), '`++` が 1 件でない').toBe(1);
    const capAt = after.indexOf('g_nPkc3ViewDataGoneSaid < 20');
    const incAt = after.indexOf('++g_nPkc3ViewDataGoneSaid;');
    const putsAt = after.indexOf('std::fputs(');
    expect(capAt).toBeLessThan(incAt);
    expect(incAt).toBeLessThan(putsAt);
  });

  it('🔴 原文の他の所は動かない: GetViewData の nullptr 返し・GetOptimalSize が元のまま', () => {
    const after = patched();
    expect(after).toContain('    if (itr == m_DataTable.end())\n        return nullptr;\n    return &itr->second;\n');
    expect(after).toContain('Size aRet(0, getPreferredDimensions(aWidths));');
    // `while (pEntry)` は元のまま 1 件(足したのは門であって while ではない)
    expect(count(EXCERPT, 'while (pEntry)')).toBe(1);
    expect(count(after, 'while (pEntry)')).toBe(1);
  });

  it('🔴 `#include <cstdio>` が `<vcl/toolkit/treelistbox.hxx>` の直後に足されている(`std::fputs` の宣言)', () => {
    const after = patched();
    expect(count(EXCERPT, '#include <cstdio>'), '抜粋の前提(元には無い)').toBe(0);
    expect(after).toContain(`#include <vcl/toolkit/treelistbox.hxx>\n#include <cstdio> // ${MARK}\n`);
    expect(after.indexOf('#include <cstdio>')).toBeLessThan(after.indexOf('std::fputs'));
  });

  it('🔴 足した行は全部印を含み、原文の行は 1 行も書き換えない(印の行を除くと原文と一致)', () => {
    const after = patched();
    expect(after).not.toBe(EXCERPT);
    expect(restore(after)).toBe(EXCERPT);
    // 足した行は 16 行(include 1 + カウンタ 1 + 注釈 4 + 門 10)
    const added = after.split('\n').filter((l) => l.includes(MARK));
    expect(added.length).toBe(16);
    // 🔴 印の無い足し行が無い(原文の行集合に無い行は、全部印を含む)
    const origLines = new Set(EXCERPT.split('\n'));
    const bare = after.split('\n').filter((l) => !origLines.has(l) && !l.includes(MARK));
    expect(bare, '印の無い足し行').toEqual([]);
    // 🔴 中身まで見る(⚠ 期待値は patch から取らず**手で書く**)。注釈を落とした実行行だけ
    const code = added.filter((l) => !/^\s*\/\/ /.test(l)).map((l) => l.trim());
    expect(code).toEqual([
      `#include <cstdio> // ${MARK}`,
      `namespace { int g_nPkc3ViewDataGoneSaid = 0; } // ${MARK}`,
      `if (m_DataTable.find(pEntry) == m_DataTable.end()) // ${MARK}`,
      `{ // ${MARK}`,
      `if (g_nPkc3ViewDataGoneSaid < 20) // ${MARK}`,
      `{ // ${MARK}`,
      `++g_nPkc3ViewDataGoneSaid; // ${MARK}`,
      `std::fputs("${MARK}: entry without view data skipped\\n", stderr); // ${MARK}`,
      `} // ${MARK}`,
      `pEntry = Next(pEntry); // ${MARK}`,
      `continue; // ${MARK}`,
      `} // ${MARK}`,
    ]);
    for (const l of added) {
      expect(l, '行末の \\ は次の行をコメントへ連結する').not.toMatch(/\\\s*$/);
      expect(l, 'ブロックコメントは使わない').not.toMatch(/\/\*|\*\//);
    }
    // 注釈は 4 行で、全部 `//` 始まり(実行文を注釈の顔で足していない)
    expect(added.filter((l) => /^\s*\/\/ /.test(l)).length).toBe(4);
    // 括弧は釣り合っている(文字列を除いて `{` と `}` の数が同じ)
    const braces = code.join('\n').replace(/"[^"]*"/g, '');
    expect(count(braces, '{')).toBe(count(braces, '}'));
  });
});

describe('#1396 の直し(viewdata-gone)── 他の検査との関係', () => {
  it('🔑 当て先が、他の LO patch と重ならない(同じ file を 2 本が触ると当てる順で結果が変わる)', () => {
    const owners = readdirSync('build/office-wasm')
      .filter((f) => /^patch-.*\.py$/.test(f))
      .filter((f) => readFileSync(join('build/office-wasm', f), 'utf-8').includes(`"${REL}"`));
    expect(owners).toEqual(['patch-lo-viewdata-gone.py']);
  });

  it('🔑 check-patches-on-ref.sh が拾える形(`SRC = "…"`)で当て先を宣言している', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/^SRC\s*=\s*"vcl\/source\/treelist\/treelistbox\.cxx"/m);
  });

  it('🔑 workflow の本数の主張が、この 1 本を数えている(26 → 27)', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(yml).toMatch(/26 → 27\(2026-10-07\)/);
    expect(yml).toContain('patch-lo-viewdata-gone.py');
    expect(yml).toContain('test "$n" -eq 35');
  });
});
