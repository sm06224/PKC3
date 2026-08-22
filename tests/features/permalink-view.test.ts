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
  dropViewWindowToken,
  formatViewDeepLink,
  parseExternalPermalink,
  parseViewDeepLink,
  parseViewDeepLinkEntry,
  parseViewWindowToken,
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
    // ⚠ 合図(`w`)は道連れにする ── 面を離れた窓は「開いたか」をもう聞かれない
    expect(dropViewFromHash('#pkc?container=c1&entry=e1&view=dual&w=tok-1')).toBe(
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

/**
 * 🔴 **別窓へ渡すもの**(#300 段③ の直し、2026-08-22)。
 *
 * 渡すのは 2 つ ── ⑴ **読んでいたノート**(渡さないと別窓のカレンダーは
 * 「ノートを選んでください」で立ち上がる)⑵ **1 回限りの合図**
 * (渡さないと「窓が出たか」を名乗りで当てるしかなく、誤爆する)。
 */
describe('別窓へ渡すもの(#300 段③)', () => {
  it('🔴 ノートと合図を載せて組める', () => {
    expect(
      formatViewDeepLink('https://x.test/', 'calendar', {
        containerId: 'c1',
        entry: 'e7',
        token: 'tok-1',
      }),
    ).toBe('https://x.test/#pkc?container=c1&entry=e7&view=calendar&w=tok-1');
  });

  /**
   * 🔴 **`view` を落とすと、そのまま正しい External Permalink になる。**
   * 🔑 これが「新しい綴りを作らない」の実利である ── 面を離れたアドレスは
   *   **そのノートを指す共有リンク**として意味を持ち続ける。
   */
  it('🔴 view と合図を落とすと External Permalink として読める', () => {
    const url = formatViewDeepLink('https://x.test/', 'calendar', {
      containerId: 'c1',
      entry: 'e7',
      token: 'tok-1',
    })!;
    const rest = dropViewFromHash(url);
    expect(parseExternalPermalink(rest)).toMatchObject({
      kind: 'entry',
      containerId: 'c1',
      targetId: 'e7',
    });
  });

  it('🔴 ノートは container と対でしか読まない', () => {
    expect(parseViewDeepLinkEntry('#pkc?container=c1&entry=e7&view=calendar')).toEqual({
      containerId: 'c1',
      lid: 'e7',
    });
    // ⚠ 片方だけ ── 別の container の lid を偶然の一致で拾わない
    expect(parseViewDeepLinkEntry('#pkc?entry=e7&view=calendar')).toBeNull();
    expect(parseViewDeepLinkEntry('#pkc?container=c1&view=calendar')).toBeNull();
    expect(parseViewDeepLinkEntry('#some-heading')).toBeNull();
  });

  /** ⚠ 綴りが通らないものは**読まない**(外から来た字をそのまま使わない)。 */
  it('⚠ 綴りが通らない container / entry は読まない', () => {
    expect(parseViewDeepLinkEntry('#pkc?container=c%201&entry=e7')).toBeNull();
    expect(parseViewDeepLinkEntry('#pkc?container=c1&entry=e%207')).toBeNull();
  });

  /**
   * 🔴 **ノートが組めなくても、面は開く。**
   * ⚠ 「連れて行けなかった」ために**窓ごと開かない**ほうが困る ──
   *   user が押したのは「カレンダーを開く」である。
   */
  it('🔴 ノートの綴りが通らなくても、面は組む', () => {
    expect(
      formatViewDeepLink('https://x.test/', 'calendar', { containerId: 'c 1', entry: 'e7' }),
    ).toBe('https://x.test/#pkc?view=calendar');
  });

  it('🔴 合図を読み、合図だけを落とせる(面は残る)', () => {
    expect(parseViewWindowToken('#pkc?view=calendar&w=tok-1')).toBe('tok-1');
    expect(parseViewWindowToken('#pkc?view=calendar')).toBeNull();
    expect(dropViewWindowToken('#pkc?container=c1&entry=e7&view=calendar&w=tok-1')).toBe(
      '#pkc?container=c1&entry=e7&view=calendar',
    );
    // ⚠ 自分の断片でないものは 1 文字も触らない
    expect(dropViewWindowToken('#some-heading')).toBe('#some-heading');
  });

  /** ⚠ 綴りの通らない合図は載せない(アドレスに壊れた字を作らない)。 */
  it('⚠ 綴りの通らない合図は載せない', () => {
    expect(formatViewDeepLink('https://x.test/', 'calendar', { token: 'a b' })).toBe(
      'https://x.test/#pkc?view=calendar',
    );
  });
});
