/** @vitest-environment happy-dom */
/**
 * 🔴 **`:::` の開きの判定が、2 つの読み手で一致している**(2026-08-07)。
 *
 * ## なぜこの test が要るのか
 *
 * 判定の読み手は 2 人いる:
 *
 * - **renderer**(`markdown-render.ts`)── 囲いを畳み、入れ子の深さを数える
 * - **走査器**(`source-blocks.ts`)── ライブエディタが原文の囲いの範囲を出す
 *
 * ずれると**行ごとの編集が全文の入力欄へ落ちる**(= user の動線が落ちる)。
 * 実際、走査器が `:::name` を一律に囲いと見ていた頃は `:::foo` と書くだけで落ちていた。
 *
 * 🔑 直し方は「走査器にも名前の表を持たせる」**ではなく**、
 * `directive-open.ts` の判定を**両方が引く**こと ── 表は 1 つしか無い。
 * ⚠ **この test は「1 つしか無い」ことを機械で守る。** 片方が独自の判定を
 * 生やしたら、下の突合が落ちる。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { scanContainers } from '../../src/features/markdown/source-blocks';
import { classifyDirectiveOpen } from '../../src/features/markdown/directive-open';

/**
 * 開きになりうる形の全数。⚠ **記法を足したらここにも足す。**
 * `expectFold` = renderer が畳む(= 囲い)か。
 */
const OPENS: readonly { line: string; expectFold: boolean; why: string }[] = [
  // ── 名前つき(畳む)
  { line: ':::note', expectFold: true, why: 'admonition の短名' },
  { line: ':::section{role=body}', expectFold: true, why: '節' },
  { line: ':::quote{author=x}', expectFold: true, why: '引用' },
  { line: ':::details{summary=s}', expectFold: true, why: '折りたたみ' },
  { line: ':::figure{#f1}', expectFold: true, why: '図' },
  { line: ':::table{#t1}', expectFold: true, why: '表' },
  { line: ':::equation{#e1}', expectFold: true, why: '式' },
  { line: ':::format{.a}', expectFold: true, why: '装飾箱(formal)' },
  { line: ':::frontmatter', expectFold: true, why: '領域' },
  { line: ':::body', expectFold: true, why: '領域' },
  { line: ':::paragraph{align=center}', expectFold: true, why: '段落の寄せ' },
  { line: ':::if{format=html}', expectFold: true, why: '条件' },
  { line: ':::callout{type=tip}', expectFold: true, why: 'callout' },
  { line: ':::admonition{type=warning}', expectFold: true, why: 'admonition' },
  // ── Tier 0(語彙。名前と同じ形なので、語彙照合でしか見分けられない)
  { line: ':::red', expectFold: true, why: 'Tier 0 の色' },
  { line: ':::red,bg-yellow', expectFold: true, why: 'Tier 0 の連結' },
  { line: ':::bold', expectFold: true, why: 'Tier 0 の字面' },
  // ── Tier 1(名前を持たない開き)
  { line: ':::.hl', expectFold: true, why: 'Tier 1 class chain' },
  { line: ':::.a.b#id', expectFold: true, why: 'Tier 1 packed' },
  { line: ':::{.hl}', expectFold: true, why: 'Tier 1 brace' },
  { line: '::: {.hl}', expectFold: true, why: 'Tier 1 pandoc' },
  { line: '::: bareCls', expectFold: true, why: 'Tier 1 bare class' },
  { line: ':::{#id .a}', expectFold: true, why: 'Tier 1 id + class' },
  // ── 畳まない(= 囲いではない)
  { line: ':::foo', expectFold: false, why: 'どの処理も畳まない名前' },
  { line: ':::unknown-thing', expectFold: false, why: '同上' },
  { line: ':::_private', expectFold: false, why: '同上(先頭 _)' },
  { line: '::: bareCls あまり', expectFold: false, why: '末尾に余りが付いた Tier 1' },
  { line: ':::.hl あまり', expectFold: false, why: '同上' },
  { line: ':::{.hl} あまり', expectFold: false, why: '同上' },
  { line: ':::break{kind=page}', expectFold: false, why: '改頁は 1 行の記法(閉じを持たない)' },
];

describe('`:::` の開きの判定が 1 つしか無い', () => {
  /**
   * 🔴 **走査器が囲いと見るものと、判定が言うものが一致する。**
   * ⚠ 「走査器が独自に持っていた表」が復活したら、ここが落ちる。
   */
  for (const o of OPENS) {
    it(`走査器と判定が一致: ${o.line}(${o.why})`, () => {
      const spans = scanContainers(`${o.line}\n中身\n:::\n`);
      const isContainer = classifyDirectiveOpen(o.line) !== null;
      expect(isContainer, `判定が ${o.expectFold ? '囲いと見ていない' : '囲いと見ている'}`).toBe(
        o.expectFold,
      );
      expect(spans.length, `走査器が ${o.expectFold ? '囲いと見ていない' : '囲いと見ている'}`).toBe(
        o.expectFold ? 1 : 0,
      );
    });
  }

  /**
   * 🔴 **判定が「畳む」と言うなら、renderer は実際に畳んでいる。**
   *
   * ⚠ ここが本当の parity である ── 上の突合は「判定 ↔ 走査器」しか見ていないので、
   * **判定そのものが renderer とずれていたら両方まとめて間違う**
   * (CLAUDE.md「ガードは代替物で満たせない条件にする」)。
   * だから **renderer の実出力**を観測点にする。
   */
  for (const o of OPENS) {
    it(`判定と renderer が一致: ${o.line}(${o.why})`, () => {
      const html = renderMarkdown(`${o.line}\n中身\n:::\n`, {
        silentHallucinationWarnings: true,
      });
      // 畳まれていない = 開きの字面が literal の段落として残っている
      const leftLiteral = /<p>:::/.test(html);
      expect(
        leftLiteral,
        o.expectFold
          ? `判定は畳むと言うが、renderer は literal のまま残した:\n${html}`
          : `判定は畳まないと言うが、renderer が畳んだ:\n${html}`,
      ).toBe(!o.expectFold);
    });
  }

  /**
   * ⚠ **閉じの行を開きと読まない**(読むと 1 文書が延々と囲いになる)。
   */
  it('🔴 閉じの行は開きではない', () => {
    for (const close of [':::', '::: ', ':::\t']) {
      expect(classifyDirectiveOpen(close), `${JSON.stringify(close)} を開きと読んでいる`).toBeNull();
      expect(scanContainers(`${close}\n本文\n`).length).toBe(0);
    }
  });

  /**
   * ⚠ **`:::toc` は「中を飲まない」側**。囲いではあるが、閉じの扱いが違う。
   */
  it('🔴 :::toc は self-contained として区別される', () => {
    expect(classifyDirectiveOpen(':::toc')).toBe('self-contained');
    expect(classifyDirectiveOpen(':::toc{depth=2}')).toBe('self-contained');
    expect(classifyDirectiveOpen(':::note')).toBe('container');
    // 中を飲まない ── 直後の本文まで範囲に入れない
    const spans = scanContainers(':::toc\n\n# 見出し\n');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.end, 'toc が後続を飲んでいる').toBe(0);
  });

  /**
   * ⚠ **空振り防止**: 表が「畳む」ばかり / 「畳まない」ばかりだと、
   * 突合は片側だけで満たされてしまう。
   */
  it('⚠ 表に両側が十分に在る', () => {
    expect(OPENS.filter((o) => o.expectFold).length, '畳む形が少なすぎる').toBeGreaterThanOrEqual(20);
    expect(OPENS.filter((o) => !o.expectFold).length, '畳まない形が少なすぎる').toBeGreaterThanOrEqual(6);
  });
});
