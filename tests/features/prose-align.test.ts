/** @vitest-environment node */
/**
 * 本文の置き場所の**値**(#722、2026-09-08)。
 *
 * 🔴 **値そのものを pin する。** 「規則が在るか」だけを見る検査は、
 * `--prose-lead: auto` を `--prose-lead: 0` にする 1 文字変異を**全緑で通す**
 * (既定が左寄せに化けるのに誰も鳴らない)。だから
 * ① 表の値を literal で持ち ② CSS と 1 対 1 で突き合わせる
 * (`page-format.test.ts` と同じ作法)。
 *
 * 🔑 中央寄せは `app.css` の **2 か所**で成り立っている ── 散文の塊の
 * `margin-inline` と、表・図・コードの `margin-inline-start`。**どちらも**
 * トークンを読んでいることを見る(片方が literal のまま残ると、
 * 「段落は左端なのに表だけ 126px 内側」という食い違いが出る)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_PROSE_ALIGN,
  isProseAlign,
  PROSE_ALIGNS,
  PROSE_ALIGN_ATTR,
  proseAlignCss,
  proseAlignSpec,
} from '../../src/features/prose-align';

/**
 * ⚠ **コメントを剥ぐ** ── 注記に書いた `:root[data-pkc-prose-align='…']` が
 * 規則として拾われる(`page-format.test.ts` が実際に踏んだ)。
 */
const TOKENS = readFileSync('src/styles/tokens.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const APP = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * 期待する表(**この file が正本の写し**)。
 * ⚠ 実装から引き写さない ── 引き写すと「実装を変えたら期待も変わる」ので何も守らない。
 */
const EXPECTED: ReadonlyArray<readonly [string, string, string]> = [
  ['center', 'auto', 'max(0px, calc((100% - var(--read-w)) / 2))'],
  ['start', '0', '0px'],
];

describe('本文の置き場所の表(#722)', () => {
  it('🔴 id・lead・indent が期待どおり(値を literal で pin する)', () => {
    expect(PROSE_ALIGNS.map((a) => [a.id, a.lead, a.indent])).toEqual(
      EXPECTED.map(([id, lead, indent]) => [id, lead, indent]),
    );
  });

  it('🔴 既定は中央 ── 選ばなければ 2026-09-06 の見え方のまま', () => {
    expect(DEFAULT_PROSE_ALIGN).toBe('center');
    expect(proseAlignSpec(DEFAULT_PROSE_ALIGN).lead).toBe('auto');
  });

  it('⚠ 引き当てられない値は既定へ落ちる(壊れた設定で起動不能にしない)', () => {
    expect(isProseAlign('right')).toBe(false);
    expect(proseAlignSpec('right').id).toBe('center');
    expect(proseAlignSpec('').id).toBe('center');
  });
});

describe('🔴 表と CSS が食い違っていない(#722)', () => {
  it('既定(中央)の値は `:root` が持っている', () => {
    // ⚠ `:root {` の中(最初のブロック)で見る ── 属性つきの規則に満たされない
    const root = /:root\s*\{([\s\S]*?)\}/.exec(TOKENS);
    expect(root, ':root ブロックを読めていない').not.toBeNull();
    const body = root![1]!;
    expect(body, '既定の lead が :root に無い').toMatch(/--prose-lead:\s*auto\s*;/);
    expect(body, '既定の indent が :root に無い').toContain(
      '--prose-indent: max(0px, calc((100% - var(--read-w)) / 2));',
    );
  });

  it('「左」の値は属性つきの規則が持っている', () => {
    const re = /:root\[data-pkc-prose-align='start'\]\s*\{([\s\S]*?)\}/.exec(TOKENS);
    expect(re, '左寄せの規則が CSS に無い').not.toBeNull();
    const body = re![1]!;
    expect(body).toMatch(/--prose-lead:\s*0\s*;/);
    expect(body).toMatch(/--prose-indent:\s*0px\s*;/);
  });

  it('⚠ 中央の規則は CSS に**書かない**(既定を 2 か所に持たない)', () => {
    expect(TOKENS, '中央が属性つきでも書かれている ── 既定が 2 か所になる').not.toContain(
      "data-pkc-prose-align='center'",
    );
  });

  it('🔴 app.css の 2 か所ともトークンを読んでいる', () => {
    // ① 散文の塊(中央寄せの本体)
    expect(APP, '散文の塊がトークンを読んでいない').toContain(
      'margin-inline: var(--prose-lead) auto;',
    );
    // ② 表・図・コード(段落と同じ左端に揃える側)
    expect(APP, '表・図・コードがトークンを読んでいない').toContain(
      'margin-inline-start: var(--prose-indent);',
    );
    // 🔑 **古い literal が残っていない** ── 残っていると設定が片側にしか効かない
    expect(APP, '中央寄せの literal が残っている').not.toContain('margin-inline: auto;\n}');
    expect(APP, '左端の literal が残っている').not.toContain(
      'margin-inline-start: max(0px, calc((100% - var(--read-w)) / 2));',
    );
  });
});

describe('🔴 書き出す HTML に焼く分(#722)', () => {
  it('器の印に当てる ── `:root` を前置きしない', () => {
    const css = proseAlignCss('start');
    expect(css.startsWith(`[${PROSE_ALIGN_ATTR}='start']{`), css).toBe(true);
    expect(css, ':root を前置きすると器の body に当たらない').not.toContain(':root');
  });

  it('🔴 既定(中央)でも空文字にしない(焼いた側を正本に保つ)', () => {
    const css = proseAlignCss('center');
    expect(css, '既定だけ焼かれない ── :root の値へ暗黙に依存する').not.toBe('');
    expect(css).toContain('--prose-lead:auto');
    expect(css).toContain('--prose-indent:max(0px, calc((100% - var(--read-w)) / 2))');
  });

  it('⚠ 2 つの値が両方載る(片方だけ焼くと配った先で食い違う)', () => {
    for (const a of PROSE_ALIGNS) {
      const css = proseAlignCss(a.id);
      expect(css, `${a.id}: lead が無い`).toContain(`--prose-lead:${a.lead}`);
      expect(css, `${a.id}: indent が無い`).toContain(`--prose-indent:${a.indent}`);
    }
  });
});
