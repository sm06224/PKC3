/**
 * 🔴 **定義の無い CSS 変数を使っていない**(#465)。
 *
 * ## user から見て何が起きるか
 *
 * **指定したはずの見た目が、1 ドットも出ません。** CSS は「知らない変数を使った
 * 宣言」を**丸ごと捨てる**ので、枠が消えても色が付かなくても
 * **`npm test` も `lint` も `build` も全部通ります** ── どこにも何も出ない。
 *
 * ⚠ 実際に出荷されていました:`[data-pkc-field='keymap-chord']` の
 * `border: 1px solid var(--line)` ── **`--line` は存在しない**ので、
 * 鍵の割当の画面で**チップの枠が 1 度も出ていません**でした(#466 で `--border` へ)。
 * ⚠ 同じ穴を**もう 1 度作りかけました**(連絡先の宛先に `var(--link)`)──
 * 帰結は「押せる宛先と押せない字が同じ見た目」で、user には
 * 「押しても何も起きない」ようにしか見えません。
 *
 * ## 🔑 なぜ焼いた側の検査では足りないか
 *
 * `auditBodyCss` が**同じ判定を既に持っています**が、見ているのは
 * **書き出し HTML へ焼いた本文の CSS** だけです ── `keymap-chord` は
 * 器(shell)の規則なので**そちらには 1 バイトも入りません**。
 * だから `--line` は**素通りしました**。ここは**原本**を見ます。
 *
 * ⚠ 判定そのものは `undefinedVars` **1 か所**にあり、両方がそれを呼びます
 * (CLAUDE.md §7 ── 2 つ目の正規表現を書くと、次に直したとき片方だけ直る)。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { undefinedVars } from '../../build/body-css.ts';

const STYLES = join(process.cwd(), 'src/styles');

/**
 * 🔑 **一覧を手で書かない** ── ディレクトリから数え上げる。
 * ⚠ 書くと、CSS を 1 本足した日に**その 1 本だけ誰も見ない**
 *   (`BROWSE_MODES` を手書きの判定と二重に持って足し忘れた、と同じ型)。
 */
function cssFiles(): { name: string; text: string }[] {
  return readdirSync(STYLES)
    .filter((f) => f.endsWith('.css'))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(STYLES, name), 'utf8') }));
}

describe('CSS の変数', () => {
  it('🔴 定義の無い var(--x) を使っていない(使うと宣言ごと消える)', () => {
    const files = cssFiles();
    // ⚠ 空振り防止 ── file を 1 本も読めていないのに「0 件だから緑」を作らない
    expect(files.length, 'src/styles に CSS が 1 本も無い(読めていない)').toBeGreaterThanOrEqual(2);

    /**
     * ⚠ **合わせて 1 枚として読む** ── ブラウザは全部読み込んだ状態で解決するので、
     *   `app.css` が使い `tokens.css` が定義する形が**正しい**。
     *   file ごとに見ると、その正しい形が全部「未定義」になる。
     */
    const all = files.map((f) => f.text).join('\n');
    expect(undefinedVars(all), '定義の無い変数を参照している').toEqual([]);
  });

  it('⚠ 空振り防止 ── 走査が実際に当たっている(数が 0 に落ちていない)', () => {
    const all = cssFiles()
      .map((f) => f.text)
      .join('\n');
    /**
     * 🔴 **正規表現が壊れると「0 件だから緑」になる。**
     *   だから**需要と供給の両方**に下限を置く(2026-08-27 時点で 705 / 30)。
     * ⚠ 下限は「壊れたら鳴る」ためのもので、増減を縛るものではない。
     */
    expect(all.match(/var\(\s*--/g)?.length ?? 0, 'var(--…) の一致が減りすぎ').toBeGreaterThan(100);
    expect(all.match(/^\s*--[\w-]+\s*:/gm)?.length ?? 0, '定義の一致が減りすぎ').toBeGreaterThan(20);
  });

  /**
   * 🔴 **検査する側を検査する**(CLAUDE.md §1 の末尾)。
   *
   * ⚠ 上の 2 本は**いま 0 件**なので、`undefinedVars` が何も返さなくなっても緑のままです
   *   ── 「見つからない」と「見つけられない」は区別が付きません。
   * 🔑 だから**見つかるはずの物を食わせて、見つけることを確かめます**。
   */
  describe('判定そのもの', () => {
    it('🔴 定義が無ければ挙げる / 在れば挙げない', () => {
      expect(undefinedVars('a{color:var(--nope)}')).toEqual(['--nope']);
      expect(undefinedVars(':root{--yes:red}a{color:var(--yes)}')).toEqual([]);
    });

    it('🔑 既定値つきは挙げない(壊れないうえ、意図した書き方)', () => {
      // ⚠ 実例: `--pkc-blank-count` は本文の描画が style 属性でその場で入れる
      expect(undefinedVars('a{height:calc(1em * var(--set-at-runtime, 1))}')).toEqual([]);
      // ⚠ ただし**既定値の無い同じ名前**は挙げる(既定値の有無で分かれることを固定する)
      expect(undefinedVars('a{height:var(--set-at-runtime)}')).toEqual(['--set-at-runtime']);
    });

    it('⚠ 注釈は両方向とも数えない(散文に満たされない / 注釈を定義と読まない)', () => {
      // ① 注釈の中の使用を「未定義」と言わない
      expect(undefinedVars('/* var(--talked-about) の話 */ a{color:red}')).toEqual([]);
      // ② 注釈の中の定義を「定義済み」と読まない ── ここが緑だと、
      //    注釈に名前を書いただけで本物の欠陥が隠れる
      expect(undefinedVars('/* --commented: red; */ a{color:var(--commented)}')).toEqual([
        '--commented',
      ]);
    });

    it('⚠ 同じ名前を何度使っても 1 度だけ挙げ、並びは決まっている', () => {
      expect(undefinedVars('a{color:var(--b)}i{color:var(--b)}u{color:var(--a)}')).toEqual([
        '--a',
        '--b',
      ]);
    });
  });
});
