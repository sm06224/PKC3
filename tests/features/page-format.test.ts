/** @vitest-environment node */
/**
 * 紙面フォーマットの**値**(2026-08-08。user 裁定「読み幅は A4 と A3、フル HD と
 * 4:3 の縦横を選べるようにし、デフォは A4 縦」)。
 *
 * 🔴 **値そのものを pin する。** 「規則が在るか」だけを見る検査は、
 * `--read-w: 420rem` の 1 文字変異を**全緑で通す**(2026-08-08 のレビューで実証済み。
 * 上限が上限として働かなくなるのに誰も鳴らない)。だから
 * ① 表の値を literal で持ち ② CSS と 1 対 1 で突き合わせる。
 *
 * 🔑 表(`features/page-format.ts`)と CSS(`styles/tokens.css`)が**別の場所**に
 * 在るのは、画面の差し替えを CSS で書く(JS から CSS を書かない)ためである ──
 * その代わり、片方だけ足す / 片方だけ直すをここが落とす
 * (`theme.ts` と `tokens.css` を突き合わせている `docs-parity` と同じ作法)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_PAGE_FORMAT,
  isPageFormat,
  PAGE_FORMATS,
  pageFormatCss,
  paperRule,
  readWidthRule,
  type PageFormat,
} from '../../src/features/page-format';

/**
 * ⚠ **コメントを剥ぐ** ── 注記に書いた `:root[data-pkc-page-format='…']` が
 * 規則として拾われる(実際に踏んだ)。注釈で満たせる検査は、実装を消しても緑になる。
 */
const TOKENS = readFileSync('src/styles/tokens.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * 期待する表(**この file が正本の写し**)。
 * ⚠ 実装から引き写さない ── 引き写すと「実装を変えたら期待も変わる」ので
 *   何も守らない。値を動かしたいなら、ここも一緒に動かす(= 意図の宣言)。
 */
const EXPECTED: ReadonlyArray<readonly [string, string, string | null]> = [
  ['a4-portrait', '42rem', 'A4 portrait'],
  ['a4-landscape', '62rem', 'A4 landscape'],
  ['a3-portrait', '62rem', 'A3 portrait'],
  ['a3-landscape', '91rem', 'A3 landscape'],
  ['fullhd', 'none', null],
  ['fullhd-portrait', '64rem', null],
  ['43', '60rem', null],
  ['43-portrait', '45rem', null],
];

/** `:root[data-pkc-page-format='x'] { --read-w: y; }` を CSS から読む。 */
function cssReadWidth(id: string): string | null {
  const re = new RegExp(
    `:root\\[data-pkc-page-format='${id}'\\]\\s*\\{[^}]*--read-w:\\s*([^;}]+)`,
  );
  const m = re.exec(TOKENS);
  return m ? m[1]!.trim() : null;
}

describe('紙面フォーマットの表', () => {
  it('🔴 id・読み幅・紙が期待どおり(値を literal で pin する)', () => {
    expect(
      PAGE_FORMATS.map((f) => [f.id, f.readWidth, f.paper] as const),
      '表が動いた ── 値を変えるなら、この期待も一緒に動かす',
    ).toEqual(EXPECTED.map((e) => [e[0], e[1], e[2]]));
  });

  it('🔴 既定は A4 縦で、その読み幅は現行の既定(42rem)と同じ', () => {
    expect(DEFAULT_PAGE_FORMAT).toBe('a4-portrait');
    // ⚠ ここが動くと**既存 user の見え方が変わる**(裁定は「既定は A4 縦」)
    expect(cssReadWidth('a4-portrait')).toBe('42rem');
    // 素の `:root` の既定値も同じであること ── 属性が付く前の一瞬もこの幅
    expect(/:root\s*\{[\s\S]*?--read-w:\s*42rem/.test(TOKENS), '既定値が 42rem でない').toBe(
      true,
    );
  });

  it('🔴 表と tokens.css が 1 対 1(片方だけ足す / 直すを落とす)', () => {
    const inCss = [...TOKENS.matchAll(/:root\[data-pkc-page-format='([^']+)'\]/g)].map(
      (m) => m[1]!,
    );
    expect(inCss.sort(), 'CSS に在るのに選べない / 選べるのに CSS が無い').toEqual(
      PAGE_FORMATS.map((f) => f.id).sort(),
    );
    for (const f of PAGE_FORMATS) {
      expect(cssReadWidth(f.id), `${f.id} の読み幅が CSS と食い違う`).toBe(f.readWidth);
    }
  });

  it('🔴 フル HD だけが上限なし(「画面での閲覧に適した形式」の本体)', () => {
    const none = PAGE_FORMATS.filter((f) => f.readWidth === 'none').map((f) => f.id);
    expect(none, 'cap を外す形式が増減した').toEqual(['fullhd']);
  });

  it('紙系だけが @page を持つ(画面用は受け手の既定紙に任せる)', () => {
    for (const [id, , paper] of EXPECTED) {
      const rule = paperRule(id as PageFormat);
      if (paper === null) expect(rule, `${id} に紙の指定が出ている`).toBe('');
      else expect(rule, `${id} の紙が違う`).toBe(`@page{size:${paper}}`);
    }
  });

  it('🔴 焼く CSS が「読み幅 + 紙」の 2 つを持つ', () => {
    // ⚠ **当たる先**まで見る ── セレクタを `:root` にすると書き出し側の器
    //    (body 要素)に当たらず、配った HTML だけ既定の幅に戻る
    expect(readWidthRule('a3-landscape')).toBe(
      "[data-pkc-page-format='a3-landscape']{--read-w:91rem}",
    );
    expect(pageFormatCss('a3-landscape')).toBe(
      "[data-pkc-page-format='a3-landscape']{--read-w:91rem}@page{size:A3 landscape}",
    );
    expect(pageFormatCss('fullhd'), '画面用に紙が付いている').toBe(
      "[data-pkc-page-format='fullhd']{--read-w:none}",
    );
  });

  it('知らない値は受け取らない(壊れた保存値で起動不能にしない)', () => {
    expect(isPageFormat('a4-portrait')).toBe(true);
    expect(isPageFormat('a4')).toBe(false);
    expect(isPageFormat('')).toBe(false);
  });

  it('⚠ フラグではない(15 枠を食っていない)', () => {
    // user 指示 2026-07-30「flags は最大 15 個 + 正規設定と分離する」
    const flags = readFileSync('src/features/flags.ts', 'utf8');
    expect(flags, '紙面がフラグとして定義されている').not.toContain('page-format');
    expect(flags, '紙面がフラグとして定義されている').not.toContain('pageFormat');
  });
});
