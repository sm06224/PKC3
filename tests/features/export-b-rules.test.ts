/** @vitest-environment happy-dom */
/**
 * 🔴 **書き出し側の `.b` 規則は「焼いた側に対応物が無いもの」だけ**(2026-08-07)。
 *
 * ## 何を掃除したのか
 *
 * 2026-08-07 に `app.css` の本文の規則(116 本)を書き出し HTML へ焼いた。器には
 * `.b` と `.pkc-md-rendered` の**両方**が付き、焼いた分は `.b` 前置きより**後**に
 * 出るので、詳細度が同じなら**焼いた側が勝つ**。つまり同じプロパティを宣言している
 * `.b` の行は、**その日から 1 度も効いていなかった**。
 *
 * 実測(書き出した HTML を実ブラウザで開き、`#body` 配下の**全要素 × 全 computed
 * プロパティ**を 画面 light / 画面 dark / 紙 の 3 通りで突き合わせ)で
 * **38 本の削除 + 5 本の絞り込み**が **171,255 点すべて一致**することを確かめた
 * (当たり先が 0 件の選択子は 0 件 ── 「fixture のゼロ件の次元は測っていない次元」)。
 *
 * ## この test が守るもの
 *
 * 🔑 **消した重複が黙って生え直さないこと**。`.b` に規則を足すのは
 * 「焼いた側に対応物が無い」ときだけで、それ以外は**書いても効かない**
 * (効かない行が増えると、次に読む人が「ここを直せば変わる」と誤解する)。
 *
 * ⚠ **除外リストにしない**。「知らない `.b` が在ったら skip」と書いた瞬間、
 *   この検査は no-op になる(CLAUDE.md「ガードは代替物で満たせない条件にする」)。
 *   代わりに **全件を表に書き、理由を必須**にする。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractBodyCss, parseRules } from '../../build/body-css';

const VIEWER = readFileSync('src/features/export/pkc3-html.ts', 'utf8');
const BAKED = extractBodyCss(
  readFileSync('src/styles/app.css', 'utf8'),
  readFileSync('src/styles/tokens.css', 'utf8'),
).css;

/**
 * いま在ってよい `.b` の規則と、**焼いた側に対応物が無い理由**。
 * ⚠ 足すときは理由も書く。理由が書けないなら、それは焼いた側の仕事である。
 */
const ALLOWED: Readonly<Record<string, string>> = {
  '.b': '読み幅。app.css の読み幅は .pkc-md-rendered 前置きでないので焼かれない',
  '.b>*:first-child': '器の直下の先頭。焼いた側に対応物なし',
  '.b p,.b ul,.b ol': '段落 / 箇条書きの margin を app.css は書いていない(UA 既定)',
  '.b li': '同上',
  '.b pre': '折り返し。焼いた側は overflow-x だけで、紙では効かない',
  '.b blockquote': '濃さ。焼いた側は色だけ',
  '.b hr': '余白。焼いた側は border 系だけ',
  '.b pre.d': '図の原文。閲覧側だけが作る要素(アプリに対応物なし)',
  '.b [data-pkc-asset-missing]': '薄さ。焼いた側は outline / color / min-height',
  '.b>*': '器の直下を溢れさせない。焼いた側に対応物なし',
  '.b a.f': '添付のボタン。閲覧側だけの操作子(焼いた分より後ろに置く)',
  '.b .pkc-render-toggle': '切替の位置。閲覧側はコピーボタンを外す(焼いた分より後ろ)',
};

/** 印刷(`@media print`)で在ってよいもの。 */
const ALLOWED_PRINT: Readonly<Record<string, string>> = {
  '.b': '紙では読み幅をほどく(画面の max-width の対)',
  '.b a': '紙のリンクの下線を消す。焼いた側は text-decoration を触らない',
  '.b .pkc-render-toggle': '紙に操作子は要らない。焼いた print 層に toggle 規則なし',
};

/** `<style>` を画面部と印刷部に割って、`.b` で始まる選択子を集める。 */
function selectors(): { screen: string[]; print: string[] } {
  const m = /<style>([\s\S]*?)<\/style>/.exec(VIEWER);
  expect(m, '書き出しの <style> が見つからない').not.toBeNull();
  // ⚠ コメントを剥ぐ ── 説明文に書いた `.b …{` が規則として拾われる
  const css = m![1]!.replace(/\/\*[\s\S]*?\*\//g, '');
  // 焼いた分(placeholder)より前 / 後 は分けない ── どちらも `.b` は同じ扱い
  const printAt = css.indexOf('@media print{');
  expect(printAt, '@media print が無い').toBeGreaterThan(0);
  const printEnd = css.indexOf('\n}', printAt);
  const grab = (s: string): string[] =>
    [...s.matchAll(/(^|\n)\s*((?:\.b|\.b[^{,\n]*)(?:\s*,\s*[^{,\n]+)*)\s*\{/g)]
      .map((x) => x[2]!.trim())
      .filter((sel) => /(^|,\s*)\.b(?![\w-])/.test(sel));
  return {
    screen: grab(css.slice(0, printAt) + css.slice(printEnd)),
    print: grab(css.slice(printAt, printEnd)),
  };
}

describe('書き出しの `.b` 規則(焼いた側と重複させない)', () => {
  it('🔴 表に無い `.b` 規則が足されていない', () => {
    const { screen, print } = selectors();
    // ⚠ 空振り防止 ── 1 本も拾えていないなら、この検査は何も見ていない
    expect(screen.length, '`.b` の規則を 1 本も拾えていない(選択子の集め方が壊れた)')
      .toBeGreaterThanOrEqual(10);
    expect(print.length, '紙の `.b` 規則を 1 本も拾えていない').toBeGreaterThanOrEqual(3);
    for (const sel of screen) {
      expect(ALLOWED[sel], `表に無い .b 規則が足された: ${sel}(理由を書いて表に足す)`).toBeTruthy();
    }
    for (const sel of print) {
      expect(
        ALLOWED_PRINT[sel],
        `表に無い紙の .b 規則が足された: ${sel}`,
      ).toBeTruthy();
    }
  });

  /**
   * 🔴 **表の側も守る**。「効かない規則を消した」という事実は、
   * **焼いた側がその宣言を持っている**ことに依存している ── 焼き込みが痩せたら
   * 消した分が本当に必要になる。代表を 1 本ずつ突合する。
   */
  it('🔴 消した重複の受け皿が、焼いた側に実在する', () => {
    for (const [sel, decl] of [
      ['.pkc-md-rendered h1', 'font-size'],
      ['.pkc-md-rendered td', 'border'],
      ['.pkc-md-rendered th', 'background'],
      ['.pkc-md-rendered a', 'color'],
      ['.pkc-md-rendered code', 'background'],
      ['.pkc-md-rendered [data-pkc-align=', 'text-align'],
      ['.pkc-md-rendered [data-pkc-asset-missing]', 'outline'],
      ['.pkc-md-rendered .pkc-render-toggle', 'position'],
      ['.pkc-md-rendered .pkc-external-img', 'border'],
    ] as const) {
      /**
       * ⚠ **規則の単位で探す**。`indexOf` で最初の一致を取ると、まとめ書きの
       * 別規則(`h1,h2,h3,h4{margin;line-height}`)を掴んで
       * 「font-size が無い」と誤判定する(2026-08-07 に実際に踏んだ)。
       */
      const hit = parseRules(BAKED).some(
        (r) => r.selector.includes(sel) && r.body.includes(decl),
      );
      expect(hit, `焼いた側に ${sel} の ${decl} が無い(消した .b の受け皿が消えた)`).toBe(true);
    }
  });

  /**
   * ⚠ **読み幅だけは焼かれない**ことを明示的に pin する。
   * ここが焼かれるようになったら `.b{max-width}` は重複になるので、
   * この test が落ちて掃除の機会を作る。
   */
  it('⚠ 読み幅は焼かれていない(だから `.b` が持っている)', () => {
    expect(BAKED, '読み幅が焼かれるようになった ── .b{max-width} が重複になった').not.toContain(
      'var(--read-w)',
    );
    expect(VIEWER, '書き出し側が読み幅を持っていない').toContain('.b{max-width:46em}');
  });
});
