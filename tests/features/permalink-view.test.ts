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
  isHeadingAnchor,
  parseExternalPermalink,
  parseViewDeepLink,
  parseViewDeepLinkEntry,
  parseViewWindowToken,
  setHashEntry,
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

/**
 * 🔴 **面を指さない断片も組める**(#685 段②、2026-09-04)。
 *
 * ⚠ 付箋の窓は「面」ではなく**ノートそのもの**を開くので、`view=` を載せない。
 * 🔑 そのぶん **`container` + `entry` が必ず要る** ── 行き先の無い断片
 *   (`#pkc?w=…` だけ)は、開いた窓が**何も選ばずに立ち上がる**だけである。
 */
describe('面を指さない断片(#685 段②)', () => {
  it('🔴 view を null にすると、ノートだけの断片になる', () => {
    expect(
      formatViewDeepLink('https://x/', null, { containerId: 'c1', entry: 'e1' }),
    ).toBe('https://x/#pkc?container=c1&entry=e1');
  });

  it('🔴 合図も載る(窓が開いたかを確かめるため)', () => {
    expect(
      formatViewDeepLink('https://x/', null, { containerId: 'c1', entry: 'e1', token: 'tok1' }),
    ).toBe('https://x/#pkc?container=c1&entry=e1&w=tok1');
  });

  /**
   * 🔴 **行き先が無ければ組まない**(対照群)。⚠ ここを緩めると
   *   `#pkc?w=<合図>` だけの断片が出来て、付箋のつもりが**空の PKC** になる。
   */
  it.each([
    ['何も渡さない', {}],
    ['container だけ', { containerId: 'c1' }],
    ['entry だけ', { entry: 'e1' }],
    ['綴りが通らない', { containerId: 'c1', entry: 'e 1' }],
    ['合図だけ', { token: 'tok1' }],
  ])('🔴 %s なら null(空の窓を開かせない)', (_name, input) => {
    expect(formatViewDeepLink('https://x/', null, input)).toBeNull();
  });

  /**
   * ⚠ **面のときは今までどおり「落としてでも開く」**(対照群)── 面そのものは
   *   開くべきなので、連れて行けないノートは黙って落とす。
   */
  it('⚠ 面を指すときは、ノートが無くても組める', () => {
    expect(formatViewDeepLink('https://x/', 'dual')).toBe('https://x/#pkc?view=dual');
    expect(formatViewDeepLink('https://x/', 'dual', { containerId: 'c1', entry: 'e 1' })).toBe(
      'https://x/#pkc?view=dual',
    );
  });
});

/**
 * 🔴 **住所を、いま見ているノートへ追随させる**(#689 案 B、2026-09-04)。
 *
 * ⚠ 直す前は `dropViewFromHash` が `container` / `entry` を残すだけで、
 *   **残した後に更新する口が 1 つも無かった** ── その窓で別のノートを開いた
 *   瞬間に住所が嘘になり、`F5` が最初のノートへ引き戻していた。
 */
describe('住所の追随(#689 案 B)', () => {
  it('🔴 名乗っている断片は、いまのノートへ書き換わる', () => {
    expect(setHashEntry('#pkc?container=c1&entry=e1', 'c1', 'e2')).toBe('#pkc?container=c1&entry=e2');
  });

  /**
   * 🔴 **併記された相手を巻き込まない** ── 面の窓(`view=`)でも
   *   住所は追随する(見ているノートが移るのは面の中でも同じである)。
   * ⚠ `URLSearchParams.set` は**その場で置き換える**ので、並びも動かない。
   */
  it('🔴 view / w は残り、並びも変わらない', () => {
    expect(setHashEntry('#pkc?container=c1&entry=e1&view=dual&w=tok1', 'c1', 'e2')).toBe(
      '#pkc?container=c1&entry=e2&view=dual&w=tok1',
    );
  });

  /** 🔑 base 付きの丸ごとの URL でも、断片だけを書き換える。 */
  it('🔑 base は触らない', () => {
    expect(setHashEntry('https://例.test/pkc/?pkc-flag=x#pkc?container=c1&entry=e1', 'c1', 'e2')).toBe(
      'https://例.test/pkc/?pkc-flag=x#pkc?container=c1&entry=e2',
    );
  });

  /**
   * 🔴 **名乗っていない断片には生やさない**(対照群つき)。
   *
   * ⚠ ここを緩めると、ふつうに開いたタブのアドレスが**操作のたびに伸びる** ──
   *   誰も頼んでいない見え方の変更である(user 指示 2026-08-28)。
   */
  it.each([
    ['断片が無い', 'https://例.test/pkc/'],
    ['pkc の断片ではない', '#見出し'],
    ['中身が無い', '#pkc?'],
    ['container だけ', '#pkc?container=c1'],
    ['entry だけ', '#pkc?entry=e1'],
    ['面だけ', '#pkc?view=dual'],
  ])('🔴 %s 断片は 1 バイトも変わらない', (_name, raw) => {
    expect(setHashEntry(raw, 'c1', 'e2')).toBe(raw);
  });

  /**
   * 🔴 **読む側が受けない字は書き込まない** ── 書き込むと
   *   「アドレスは変わったのに `F5` では拾われない」といういちばん気づけない
   *   壊れ方になる(`parseViewDeepLinkEntry` が `TOKEN_RE` で断るため)。
   */
  it.each([['空', ''], ['空白入り', 'e 2'], ['記号入り', 'e/2']])(
    '🔴 %s の lid は書き込まない',
    (_name, lid) => {
      expect(setHashEntry('#pkc?container=c1&entry=e1', 'c1', lid)).toBe(
        '#pkc?container=c1&entry=e1',
      );
    },
  );

  /**
   * 🔑 **往復で閉じる**(空振り防止)── 書き換えた結果を読み直すと、
   *   渡した lid がそのまま返る。⚠ これが無いと「書き換えたが読めない綴り」を
   *   検出できない。
   */
  it('🔑 書き換えた断片は、そのまま読み直せる', () => {
    const next = setHashEntry('#pkc?container=c1&entry=e1&view=dual', 'c1', 'e2');
    expect(parseViewDeepLinkEntry(next)).toEqual({ containerId: 'c1', lid: 'e2' });
    expect(parseViewDeepLink(next), '面を道連れにした').toBe('dual');
  });

  /**
   * 🔴 **別の PKC の入れ物なら、1 バイトも触らない**(#689 動線レビュー 欠陥 1)。
   *
   * ⚠ 読む側の門は 2 段(綴り / `cid` の一致)だが、1 稿目の書く側は**綴りしか
   *   見ていなかった** ── 他人の PKC のリンクを開いたタブで自分のノートを選ぶと、
   *   住所が `container=他人 & entry=自分の lid` という**どこも指さない形**に化け、
   *   `Ctrl+D` の栞は「開くがノートは 1 件も出ない」になった。
   * ⚠ そのうえ**もらったリンクの原文まで上書きされて消える**(送り主に
   *   「開かない」と返す材料が無くなる)。
   */
  it.each([
    ['別の入れ物', 'other'],
    ['まだ開いていない', null],
  ])('🔴 %s なら住所を書き換えない', (_name, cid) => {
    const raw = '#pkc?container=c1&entry=e1';
    expect(setHashEntry(raw, cid, 'e2'), 'よその入れ物の住所を書き換えた').toBe(raw);
  });

  /**
   * ⚠ **対照群** ── 一致していれば書き換わる(上の 2 件が「常に何もしない」
   *   実装でも通ってしまうのを止める)。
   */
  it('⚠ 入れ物が一致していれば書き換わる(対照群)', () => {
    expect(setHashEntry('#pkc?container=c1&entry=e1', 'c1', 'e2')).toBe(
      '#pkc?container=c1&entry=e2',
    );
  });
});

/**
 * 🔴 **見出しの飛び先か**(#693 案 A、2026-09-04)。
 *
 * 目次(`:::toc`)と脚注のリンクは素の `<a href="#…">` なので、押すと断片が
 * `#pkc?container=…&entry=…` から `#midashi-1` へ**丸ごと入れ替わる**。
 * `deep-link.ts` はこれで「付箋の住所を戻すか」を分けるので、
 * ⚠ **`#pkc?` を持つ断片を飛び先と読んではいけない**(読むと、面を指し直した
 * 正しい書き換えまで巻き戻す)。
 */
describe('見出しの飛び先(#693)', () => {
  it('🔴 `#<id>` は飛び先である', () => {
    expect(isHeadingAnchor('#midashi-1')).toBe(true);
    expect(isHeadingAnchor('#fn-1')).toBe(true);
  });

  it('🔴 PKC の断片は飛び先ではない(entry / view / 合図のどれでも)', () => {
    expect(isHeadingAnchor('#pkc?container=c1&entry=e1')).toBe(false);
    expect(isHeadingAnchor('#pkc?view=dual')).toBe(false);
    expect(isHeadingAnchor('#pkc?w=tok')).toBe(false);
  });

  it('⚠ 空・`#` だけ・文字列でない物は飛び先ではない(「消した」と区別する)', () => {
    expect(isHeadingAnchor('')).toBe(false);
    expect(isHeadingAnchor('#')).toBe(false);
    expect(isHeadingAnchor(undefined as unknown as string)).toBe(false);
  });
});
