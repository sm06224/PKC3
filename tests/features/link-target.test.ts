/**
 * 🔴 **本文のリンクが指す先を解く**(2026-08-08)。
 *
 * ⚠ `entry-ref.ts` は 315 行あるのに、**直接 import する test が 1 件も無かった**
 * (間接に文字列を見る test が 1 件だけ)。ここで実測した全数表をそのまま
 * 回帰 test にする ── **組み合わせが有限なら全部当てる**(CLAUDE.md)。
 */
import { describe, expect, it } from 'vitest';
import { parseLinkTarget } from '../../src/features/entry-ref/link-target';

/**
 * `entry:` の文法の全数(`parseEntryRef` の 7 kind + 縁)。
 * ⚠ **受理するものは lid まで開ける**、が 1 段目の約束である。
 */
const CASES: readonly (readonly [string, string | null, string])[] = [
  // [入力, 期待する lid(null = 断る), 期待する fragment]
  ['entry:abc', 'abc', ''],
  ['entry:abc#log/01H', 'abc', '#log/01H'],
  ['entry:abc#log/a..b', 'abc', '#log/a..b'],
  ['entry:abc#day/2026-08-08', 'abc', '#day/2026-08-08'],
  ['entry:abc#log/01H/my-slug', 'abc', '#log/01H/my-slug'],
  // 🔑 **PKC2 から取り込んだ本文に実在する形**(`pkc2-convert` が作る)
  ['entry:c-log#2026-07-01-090000', 'c-log', '#2026-07-01-090000'],
  // ⚠ 断る形
  ['entry:abc#day/2026-02-30', null, ''], // 実在しない日
  ['entry:abc#', null, ''],
  ['entry:abc#log/', null, ''],
  ['entry:a.b', null, ''],
  ['entry:abc#見出し', null, ''], // TOKEN_RE が ASCII のみ
  ['https://example.com', null, ''],
  ['', null, ''],
];

describe('リンクの解決(entry:)', () => {
  it.each(CASES)('%s', (raw, lid, fragment) => {
    const t = parseLinkTarget(raw);
    if (lid === null) {
      expect(t.kind, `断るはずが受理した: ${raw}`).toBe('invalid');
      return;
    }
    expect(t.kind, `受理するはずが断った: ${raw}`).toBe('entry');
    if (t.kind !== 'entry') return;
    expect(t.lid).toBe(lid);
    expect(t.fragment).toBe(fragment);
    expect(t.foreign).toBe(false);
  });

  /**
   * 🔑 **fragment は運ぶが、まだ使わない。**
   * ⚠ 「解けないなら何もしない」にすると、PKC2 由来の `#2026-07-01-090000` が
   *   今日も無反応のままになる ── **lid まで開く**のが 1 段目の約束である。
   */
  it('🔴 fragment が付いていても lid で開ける(断らない)', () => {
    for (const raw of ['entry:abc#log/01H', 'entry:abc#day/2026-08-08', 'entry:abc#x1']) {
      const t = parseLinkTarget(raw);
      expect(t.kind, `${raw} を断っている(動線が戻らない)`).toBe('entry');
    }
  });
});

describe('リンクの解決(pkc:// の携帯参照)', () => {
  it('entry の携帯参照は開ける', () => {
    const t = parseLinkTarget('pkc://c1/entry/e9#log/9');
    expect(t.kind).toBe('entry');
    if (t.kind !== 'entry') return;
    expect(t.lid).toBe('e9');
    expect(t.fragment).toBe('#log/9');
  });

  /**
   * 🔴 **asset の携帯参照は開けない**(所有者の逆引きが要る ── 別主題)。
   * ⚠ 黙って entry として開くと**別のノートへ飛ぶ**。
   */
  it('🔴 asset の携帯参照は断る(別のノートへ飛ばさない)', () => {
    expect(parseLinkTarget('pkc://c1/asset/ast-abc').kind).toBe('invalid');
  });

  /**
   * 🔴 **別のコンテナは「開けない」と分かる形で返す**(無言で捨てない)。
   * ⚠ 自分の cid を渡されていないときは**外と見なさない** ── いまアプリは
   *   cid を描画へ渡していないので、既定で断ると全部断ってしまう。
   */
  it('🔴 自分の cid を渡したときだけ、別コンテナを外と見なす', () => {
    const own = parseLinkTarget('pkc://c1/entry/e9', 'c1');
    expect(own.kind === 'entry' && own.foreign, '自分のコンテナを外と見なした').toBe(false);
    const other = parseLinkTarget('pkc://other/entry/e9', 'c1');
    expect(other.kind === 'entry' && other.foreign, '別コンテナを見分けていない').toBe(true);
    // cid を渡していない = 見分けられないので、外とは言わない
    const unknown = parseLinkTarget('pkc://other/entry/e9');
    expect(unknown.kind === 'entry' && unknown.foreign).toBe(false);
  });
});
