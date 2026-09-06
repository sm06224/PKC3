/**
 * 🔴 **ヘルプの面の中の目次の規則**(#719)── CSS の字面を**構文で** pin する。
 *
 * ⚠ **なぜ要るか**:着地前レビュー(実装 ⚠-9)が変異試験で示した ── 目次の
 *   `max-height` / `overflow` / 行の高さ外しを消しても、unit も smoke も
 *   **1 つも落ちなかった**(happy-dom は組まない / smoke は「1 画面に在るか」しか
 *   見ておらず、目次が 100 行に伸びても先頭は 1 画面の中に在る)。
 *
 * ⚠ ここは「規則が在って、当たる先が合っている」だけを見る ── 選択子リストを
 *   `,` で割って**丸ごと一致**(`tests/helpers/css-blocks.ts`。CLAUDE.md §1 に
 *   **5 回**踏んだ記録がある形)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';

const css = (): string => withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));

const TOC = "[data-pkc-region='help-toc']";
const ROW = `${TOC} [data-pkc-field='help-toc-row']`;

describe('ヘルプの目次は高さを切って自分で流す(#719)', () => {
  /**
   * 🔴 **切らないと目次だけで画面が埋まる**。⚠ 行は **85 本**(実測)なので、
   *   高さを切らずに置くと「先頭にマニュアルを置いた」裁定が丸ごと無意味になる
   *   ── 開いた 1 画面が目次で終わり、本文もお知らせも見えない。
   * ⚠ `max-height` だけでも `overflow` だけでも足りない:前者だけだと
   *   **はみ出した行が読めず押せない**、後者だけだと**切る高さが無いので流れない**。
   */
  it('🔴 目次の器に max-height と overflow の両方が在る', () => {
    const b = blocksFor(css(), TOC);
    expect(b.length, '目次の器の規則が無い(空振り)').toBeGreaterThan(0);
    const joined = b.join('\n');
    expect(joined, '高さを切っていない(目次だけで 1 画面が埋まる)').toMatch(
      decl('max-height', '30vh'),
    );
    expect(joined, '自分で流していない(切った先の行が読めず押せない)').toMatch(
      decl('overflow', 'auto'),
    );
  });

  /**
   * 🔴 **行はボタンの既定を外す**。⚠ この repo のボタンは
   *   「高さ固定・中央寄せ・1 行(`white-space: nowrap`)」なので、そのまま使うと
   *   長い見出し(マニュアルには 40 字を超える見出しが在る)が**中央で切れて読めない**。
   * ⚠ **対照群を置く** ── 素のボタンの側に、外している当の宣言が実在すること。
   *   在らなければこの規則は要らない(そのときはこの `it` ごと消してよい)。
   */
  it('🔴 目次の行は、ボタンの既定(高さ固定・1 行)を外している', () => {
    const text = css();
    /**
     * ⚠ **対照群:素のボタンが高さを固定している**(外す理由が実在する)。
     * 🔴 固定は **3 本立て**である(`height` / `min-height` / `max-height`)──
     *   2 本外して `max-height` を残すと、**折り返した見出しだけが 26px に切られる**
     *   (着地前レビュー 2 巡目・[中] 3。1 稿目は 2 本しか留めていなかった)。
     */
    const base = blocksFor(text, 'button').join('\n');
    for (const prop of ['height', 'min-height', 'max-height'])
      expect(base, `前提が変わった: 素のボタンの ${prop} 固定が消えた`).toMatch(
        decl(prop, 'var\\(--row-h\\)'),
      );

    const b = blocksFor(text, ROW);
    expect(b.length, '目次の行の規則が無い(空振り)').toBeGreaterThan(0);
    const joined = b.join('\n');
    expect(joined, '行の高さが固定のまま(長い見出しが縦に潰れる)').toMatch(decl('height', 'auto'));
    expect(joined, 'min-height を外していない(2 行の見出しが押し込まれる)').toMatch(
      decl('min-height', '0'),
    );
    expect(joined, 'max-height を外していない(折り返した見出しが 26px に切られる)').toMatch(
      decl('max-height', 'none'),
    );
    expect(joined, '折り返しを許していない(長い見出しが横に切れて読めない)').toMatch(
      decl('white-space', 'normal'),
    );
    expect(joined, '行が左揃えになっていない(目次が中央に並ぶ)').toMatch(
      decl('text-align', 'start'),
    );
    /**
     * ⚠ **折り返しを許したら行間も戻す**(着地前レビュー 2 巡目・記録 2)。
     * 素のボタンは 1 行しか出さないので `line-height: 1` ── そのままだと
     * **2 行になった見出しが行間 0 で密着する**。
     */
    expect(base, '前提が変わった: 素のボタンの line-height: 1 が消えた').toMatch(
      decl('line-height', '1;'),
    );
    expect(joined, '行間を戻していない(2 行の見出しが密着する)').toMatch(
      decl('line-height', '1\\.4'),
    );
  });

  /**
   * 🔴 **段付けは押し込みの深さだけ**(地は無彩色 ── 業務画面の作法)。
   * ⚠ 3 段そろって初めて「どれが大見出しか」が読める ── 1 段でも消えると、
   *   85 行が**平らな 1 枚の壁**になる(それが直す前の姿だった)。
   */
  it('🔴 見出しの段が 3 つとも段付けされている', () => {
    const text = css();
    /**
     * 🔴 **選択子は「行の名前ごと」名指しであること**(着地前レビュー 2 巡目・[中] 4)。
     * ⚠ `${TOC} [data-pkc-level='2']` は行の `padding` shorthand と**詳細度が同じ**なので、
     *   勝敗が**書いた順**だけで決まる ── 3 規則を上へ動かすと段付けが丸ごと消えるのに、
     *   宣言は在るままなので**字面を見る検査は全部緑**である。
     * 🔑 だから**弱いほうの綴りが在ったら落とす**(順序ではなく詳細度で守る)。
     */
    for (const lv of ['1', '2', '3'])
      expect(
        blocksFor(text, `${TOC} [data-pkc-level='${lv}']`),
        `段 ${lv} が行の名前で名指しされていない ── 書いた順しだいで段付けが消える`,
      ).toHaveLength(0);
    // h1: 太さで出す
    expect(
      blocksFor(text, `${ROW}[data-pkc-level='1']`).join('\n'),
      '大見出しが目立たない(段が平らになる)',
    ).toMatch(decl('font-weight', '600'));
    // h2 / h3: 押し込みの深さで出す(⚠ h3 のほうが深いこと)
    const l2 = blocksFor(text, `${ROW}[data-pkc-level='2']`).join('\n');
    const l3 = blocksFor(text, `${ROW}[data-pkc-level='3']`).join('\n');
    expect(l2, '中見出しが押し込まれていない').toMatch(decl('padding-inline-start', 'var'));
    expect(l3, '小見出しが押し込まれていない').toMatch(decl('padding-inline-start', 'var'));
    const s2 = Number(/--s(\d)/.exec(l2)![1]);
    const s3 = Number(/--s(\d)/.exec(l3)![1]);
    expect(s3, '小見出しが中見出しより深く押し込まれていない(段が逆か同じ)').toBeGreaterThan(s2);
  });
});
