/** @vitest-environment node */
/**
 * 🔴 **タイルの目印に選べる絵**(#770 段②、2026-09-12)。
 *
 * > user 要望 2026-09-07:「**アプリで使えるアイコンにも使用したい**」
 *
 * ⚠ 段① の 40 種は**アプリ自身のボタン**の絵で、**アプリらしい絵が 1 つも無かった**
 *   (起票時の実測:14 分類すべて 0 件)。ここが守るのは
 *   「**その 14 分類が在り続けること**」と「**選ばせてはいけない物が混ざらないこと**」。
 */
import { describe, expect, it } from 'vitest';
import { TILE_ICON_CHOICES } from '../../src/features/icon/tile-icons';
import { PKC_SYMBOLS } from '../../src/features/icon/symbols';

describe('タイルの目印に選べる絵(#770 段②)', () => {
  it('🔴 並べた絵は 1 つ残らず表に在る(無い絵を押すと豆腐になる)', () => {
    // ⚠ 空振り防止 ── 一覧が空なら下の for は 1 度も回らない
    expect(TILE_ICON_CHOICES.length, '選べる絵が少なすぎる(前提が崩れている)').toBeGreaterThan(20);
    for (const c of TILE_ICON_CHOICES) {
      expect(PKC_SYMBOLS[c.name], `${c.name} が図案の表に無い`).toBeDefined();
    }
  });

  /**
   * 🔴 **user が挙げた「アプリらしい絵」が在る**(起票時に 14 分類すべて 0 件だった)。
   * ⚠ 名指しで pin する ── 件数だけだと、同じ数だけ入れ替わっても気づけない。
   */
  it('🔴 アプリらしい 14 分類が在る(起票の理由そのもの)', () => {
    const have = new Set(TILE_ICON_CHOICES.map((c) => c.name));
    for (const name of [
      'terminal', // 端末
      'calculator', // 電卓
      'map', // 地図
      'music', // 音楽
      'camera', // 写真
      'mail', // メール
      'chat', // チャット
      'cart', // 買い物
      'book', // 本
      'movie', // 動画
      'chart', // グラフ
      'sunny', // 天気
      'game', // ゲーム
      'key', // 鍵
    ]) {
      expect(have.has(name as never), `${name} が選べない(#770 が挙げた分類)`).toBe(true);
    }
  });

  /**
   * 🔴 **操作の意味が固まっている絵は並べない。**
   * ⚠ とくに `trash` は画面の他の場所で**必ず「削除」**を意味し、**赤**が当たっている
   *   ── 目印の一覧に並べると「押したら消える物」に見える。
   * 🔑 ⚠ ただし**打った人には当てる**(`tiles.ts`)── 動線は減らさない。
   */
  it('🔴 操作の絵は選ばせない(押したら何か起きる物に見える)', () => {
    const have = new Set<string>(TILE_ICON_CHOICES.map((c) => c.name));
    for (const name of [
      'trash',
      'close',
      'check',
      'plus',
      'pencil',
      'broom',
      'arrow-in',
      'arrow-out',
      'arrow-down',
      'chevron-up',
      'chevron-down',
      'chevron-left',
      'chevron-right',
    ]) {
      expect(have.has(name), `${name} が目印の一覧に並んでいる`).toBe(false);
    }
  });

  /**
   * 🔴 **名前は選択子に直に埋められる字だけ**(2026-09-12)。
   *
   * ⚠ 押した絵へ焦点を戻す所(`detail.ts` の `refocusPick`)が
   *   `[data-pkc-icon-name="<名前>"]` を組むので、引用符や空白が混じると
   *   **選択子が壊れて、静かに焦点が戻らなくなる**(例外も出ない)。
   * 🔑 だから**表の側で字を縛る** ── 逃がす処理を足すより、入れない。
   */
  it('🔴 名前は英小文字・数字・ハイフンだけ(選択子に直に埋めるため)', () => {
    for (const c of TILE_ICON_CHOICES) {
      expect(c.name, `${c.name} に選択子を壊す字が混ざっている`).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('🔴 名前も日本語の名も重複しない(同じ物が 2 つ並ぶ)', () => {
    expect(new Set(TILE_ICON_CHOICES.map((c) => c.name)).size).toBe(TILE_ICON_CHOICES.length);
    expect(new Set(TILE_ICON_CHOICES.map((c) => c.label)).size).toBe(TILE_ICON_CHOICES.length);
  });

  /**
   * 🔴 **画面に出す名前は日本語**(`symbols.ts`:図案名は**内部語**)。
   * ⚠ `title` と読み上げに `terminal` と出ると、user は**押す前に何か分からない**。
   */
  it('🔴 画面に出す名前が内部語になっていない', () => {
    for (const c of TILE_ICON_CHOICES) {
      expect(c.label, `${c.name} の名前が空`).not.toBe('');
      expect(
        /[^\x20-\x7e]/.test(c.label),
        `${c.name} の名前が ASCII だけ(内部語が画面に出ている): ${c.label}`,
      ).toBe(true);
    }
  });
});
