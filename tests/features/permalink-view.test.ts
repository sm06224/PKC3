/**
 * 🔴 **`#pkc?view=…` の綴りを読む / 組む**(#300 段②、2026-08-22)。
 *
 * ⚠ `permalink.ts` は「pure: no side effects, no DOM, no state, no I/O」を
 *   名乗っている ── ここは**文字列の話だけ**。`location` を読むのも、
 *   実在の面かを照合するのも adapter 側(`tests/adapter/deep-link.test.ts`)。
 *
 * 🔴 **この file が守るのは「読み」と「組み」が対になっていること**。
 *   片方だけ直すと、PKC が自分で組んだ URL を自分で読めなくなる。
 */
import { describe, expect, it } from 'vitest';
import {
  dropViewFromHash,
  formatViewDeepLink,
  parseViewDeepLink,
} from '../../src/features/link/permalink';

describe('view のディープリンク(#300 段②)', () => {
  it('🔴 `#pkc?view=<name>` から名前を読む', () => {
    expect(parseViewDeepLink('#pkc?view=calendar')).toBe('calendar');
    // 🔑 base 付きの丸ごとの URL でも読める(共有された形はこちら)
    expect(parseViewDeepLink('https://例.test/pkc/#pkc?view=dual')).toBe('dual');
  });

  it('🔴 他の key と併記できる(順序も問わない)', () => {
    expect(parseViewDeepLink('#pkc?container=c1&entry=e1&view=kanban')).toBe('kanban');
    expect(parseViewDeepLink('#pkc?view=kanban&container=c1')).toBe('kanban');
  });

  /** ⚠ 断る形の全数。⚠ 「読めない」を `null` で返す(投げない)。 */
  it('⚠ view が書かれていない形は null(投げない)', () => {
    for (const raw of [
      '', // 空
      '#', // 断片だけ
      '#pkc?', // 中身が無い
      '#pkc?container=c1&entry=e1', // view が無い
      '#other?view=calendar', // 断片の名前が違う
      '?view=calendar', // 断片ではなくクエリ ── **ここを受けると抜け穴になる**
      '#pkc?view=', // 空の値
    ]) {
      expect(parseViewDeepLink(raw), `${JSON.stringify(raw)} を受けてしまう`).toBeNull();
    }
  });

  /**
   * 🔴 **綴りの検査はここでしない**(2026-08-22 に外した)。
   *
   * ⚠ 初稿は `TOKEN_RE` で弾いていたが、そうすると `#pkc?view=カレンダー` が
   *   **「書いていない」と見分けがつかず、呼び側は黙って本文を開く**しかなかった。
   *   直前の断り文が「カレンダー」と案内していたので、user は
   *   **絶対に効かない書き方へ誘導されて詰まる**形だった(動線レビュー)。
   * 🔑 ここは**取り出すだけ**。使える名前かの判定と断り文は adapter 側。
   */
  it('🔴 書いてあれば、使えない綴りでもそのまま返す(黙って捨てない)', () => {
    expect(parseViewDeepLink('#pkc?view=カレンダー')).toBe('カレンダー');
    expect(parseViewDeepLink('#pkc?view=a b')).toBe('a b');
    expect(parseViewDeepLink('#pkc?view=../x')).toBe('../x');
  });

  /**
   * 🔴 **落とすのは `view` だけ**(#300 段②のレビュー)。
   * ⚠ 断片ごと落とすと、併記された `container` / `entry` を道連れにする。
   */
  it('🔴 view だけを断片から落とす(併記した相手を道連れにしない)', () => {
    expect(dropViewFromHash('#pkc?container=c1&entry=e1&view=dual')).toBe(
      '#pkc?container=c1&entry=e1',
    );
    // ⚠ 何も残らないなら断片ごと落とす(`#pkc?` だけをアドレスに残さない)
    expect(dropViewFromHash('#pkc?view=dual')).toBe('');
    // ⚠ 自分の断片でないものは 1 文字も触らない
    expect(dropViewFromHash('#some-heading')).toBe('#some-heading');
    expect(dropViewFromHash('')).toBe('');
  });

  it('🔴 組んだものを読み返せる(往復)', () => {
    const url = formatViewDeepLink('https://例.test/pkc/', 'calendar');
    expect(url).toBe('https://例.test/pkc/#pkc?view=calendar');
    expect(parseViewDeepLink(url!)).toBe('calendar');
  });

  /**
   * ⚠ **古い断片を黙って隠さない**(`formatExternalPermalink` と同じ作法)。
   * 剥がして組むと、出来上がった URL の中に前の断片が紛れて見えなくなる。
   */
  it('⚠ base に `#` が残っていたら組まない(断る)', () => {
    expect(formatViewDeepLink('https://例.test/pkc/#pkc?view=old', 'calendar')).toBeNull();
    expect(formatViewDeepLink('', 'calendar')).toBeNull();
    expect(formatViewDeepLink('https://例.test/', 'a b')).toBeNull();
  });
});
