/**
 * 🔴 **ノートから連絡先を読む**(#278 段①)。
 *
 * ⚠ ここが見るのは**読み方**だけ ── 集めるのは worker、並べるのは面。
 */
import { describe, expect, it } from 'vitest';
import {
  CONTACT_LIMITS,
  contactLine,
  contactOf,
  displayWays,
  mailHref,
  matchContact,
  sortContacts,
  telHref,
} from '../../src/features/contact/contact-card';
import { sortOrder } from '../../src/features/filter/entry-sort';

const fm = (lines: string) => `---\n${lines}\n---\n\n# 本文\n`;

describe('連絡先として読む(#278)', () => {
  it('🔴 電話かメールが 1 つでもあれば連絡先', () => {
    expect(contactOf('a', '山田', fm('tel: 090-1234-5678'))?.tels).toEqual(['090-1234-5678']);
    expect(contactOf('a', '山田', fm('email: t@example.com'))?.emails).toEqual(['t@example.com']);
  });

  it('🔴 所属だけでは連絡先にしない(議事録が全部並ばないように)', () => {
    expect(contactOf('a', '打合せ', fm('org: 例の会社')), '所属だけで連絡先にした').toBeNull();
  });

  it('🔴 連絡の手段が無ければ null', () => {
    expect(contactOf('a', 'ふつうのノート', '# ふつう\n')).toBeNull();
    expect(contactOf('a', 'x', fm('tags:\n  - a')), 'frontmatter が在るだけで連絡先にした').toBeNull();
  });

  it('🔴 名前は題名(name: の鍵を作らない)', () => {
    // ⚠ `name:` を書いても**題名が勝つ** ── 名前の出どころを 2 つにしない
    expect(contactOf('a', '山田太郎', fm('tel: 03-1111-2222\nname: 別名'))?.name).toBe('山田太郎');
  });

  it('🔴 電話もメールも、並べて何本でも書ける', () => {
    const c = contactOf('a', '山田', fm('tel:\n  - 090-1111-2222\n  - 03-3333-4444'));
    expect(c?.tels).toEqual(['090-1111-2222', '03-3333-4444']);
  });

  it('⚠ 数として読まれた電話番号を捨てない', () => {
    // ⚠ `tel: 0312345678` は frontmatter では**数**になりうる ── 捨てるより出す
    const c = contactOf('a', '山田', fm('tel: 0312345678'));
    expect(c, '数の電話番号を落とした').not.toBeNull();
    expect(c?.tels[0]).toContain('312345678');
  });

  it('⚠ 空の値は落とす(空の札を作らない)', () => {
    expect(contactOf('a', '山田', fm('tel:\nemail: t@example.com'))?.tels).toEqual([]);
  });

  /**
   * 🔴 **丸めは `contactOf` の仕事ではない**(着地前レビュー 2026-08-28)。
   *
   * ⚠ 1 稿目はここで 8 件 / 120 字に切っており、その切った値が
   *   **そのまま .vcf へ書き出されていた** ── 9 本目の電話は消え、
   *   130 字のメールは `…` 付きで相手の端末に保存される。
   * 🔑 だから **`ContactCard` は原値を持つ**(この test が守るのはそこ)。
   *   丸めは `displayWays`(下の describe)である。
   */
  it('🔴 原値を丸めない ── 切るのは画面の仕事(書き出しに丸めを流さない)', () => {
    const many = Array.from({ length: 30 }, (_, i) => `  - 090-0000-${String(i).padStart(4, '0')}`);
    const c = contactOf('a', '山田', fm(`tel:\n${many.join('\n')}`));
    expect(c?.tels, '原値が丸められている(書き出しに漏れる)').toHaveLength(30);
    expect(c?.tels.at(-1)).toBe('090-0000-0029');
    const long = `${'x'.repeat(CONTACT_LIMITS.chars + 50)}@example.com`;
    const c2 = contactOf('a', '山田', fm(`email: ${long}`));
    expect(c2?.emails[0], '長い宛先が切られている').toBe(long);
  });
});

/**
 * 🔴 **画面の丸め**(#278 段③ の着地前レビュー 2026-08-28)。
 *
 * ⚠ 上の describe と**対**である ── 片方だけだと
 *   「原値のまま画面に 30 本並ぶ」か「書き出しに `…` が漏れる」かの
 *   どちらかへ倒れる。⚠ **切った件数を返すこと**も見る(黙って落とさない)。
 */
describe('画面に出す分だけ丸める(#278)', () => {
  it('🔴 8 件で切り、切った数を返す', () => {
    const many = Array.from({ length: 30 }, (_, i) => `090-0000-${String(i).padStart(4, '0')}`);
    const out = displayWays(many);
    expect(out.shown).toHaveLength(CONTACT_LIMITS.each);
    expect(out.hidden, '切ったのに 0 と言った(user は「無い」と読む)').toBe(
      30 - CONTACT_LIMITS.each,
    );
  });

  /**
   * 🔴 **字は丸めるが、原値は必ず添えて返す**(2 巡目の着地前レビュー 2026-08-28)。
   * ⚠ 1 稿目は丸めた字を 1 本返すだけだったので、描画が `mailHref(丸めた字)` を
   *   作っていた ── **押すと別の宛先へ送る**(`…` は `[^\s@]` に当たるので
   *   `mailHref` の検査をすり抜け、押せない口にもならない)。
   */
  it('🔴 長い値は 120 字 + … にする ── ただし原値も返す(押し先を作るため)', () => {
    const long = 'x'.repeat(CONTACT_LIMITS.chars + 50);
    const out = displayWays([long]).shown[0]!;
    expect(out.text).toBe(`${'x'.repeat(CONTACT_LIMITS.chars)}…`);
    expect(out.raw, '原値を返していない(押し先が作れない)').toBe(long);
    const exact = 'y'.repeat(CONTACT_LIMITS.chars);
    const same = displayWays([exact]).shown[0]!;
    expect(same.text, 'ちょうどの長さに … を足した').toBe(exact);
    expect(same.raw).toBe(exact);
  });

  it('⚠ 収まっているときは 0 件と言う(要らない「ほか N 件」を出さない)', () => {
    const out = displayWays(['090', 't@example.com']);
    expect(out.hidden).toBe(0);
    // ⚠ 丸めが要らない値でも `raw` は必ず在る(呼び側が `text` と使い分けられる)
    expect(out.shown.map((w) => w.raw)).toEqual(['090', 't@example.com']);
  });
});

describe('押せる宛先にする(#278)', () => {
  it('🔴 電話は記号を落として渡す(字はそのまま出す)', () => {
    expect(telHref('090-1234-5678')).toBe('tel:09012345678');
    expect(telHref('+81 (3) 1234-5678')).toBe('tel:+81312345678');
  });

  it('🔴 数字が 1 桁も無ければ押せない(押しても何も起きない口を作らない)', () => {
    expect(telHref('あとで聞く')).toBeNull();
    expect(telHref('')).toBeNull();
  });

  it('🔴 メールは @ を挟んで前後があれば通す(厳しくしすぎない)', () => {
    expect(mailHref('t@example.com')).toBe('mailto:t@example.com');
    expect(mailHref('  t@example.com  '), '前後の空白で押せなくなった').toBe('mailto:t@example.com');
    /**
     * 🔴 **厳しくしすぎない**(変異試験 C5 が SURVIVED で教えた)── 1 稿目は
     *   `t@example.com` しか見ておらず、**`^[a-z]+@[a-z]+\\.(com|jp)$` へ狭めても緑**
     *   だった。⚠ そこまで狭めると、下の宛先が**黙って押せなくなる**。
     */
    expect(mailHref('taro.yamada+pkc@sub.example.co.jp'), '普通の宛先を弾いた').toBe(
      'mailto:taro.yamada+pkc@sub.example.co.jp',
    );
    expect(mailHref('山田@例え.jp'), '日本語の宛先を弾いた').toBe('mailto:山田@例え.jp');
    expect(mailHref('example.com'), '@ が無いのに通した').toBeNull();
    expect(mailHref('a b@example.com'), '空白が入っているのに通した').toBeNull();
  });
});

describe('並べ方と絞り込み(#278)', () => {
  const card = (
    lid: string,
    name: string,
    org = '',
    tels: string[] = [],
    emails: string[] = [],
  ) => ({
    birthday: '',
    lid,
    name,
    org,
    tels,
    emails,
  });

  it('🔴 一覧の「題名順」と、同じ並びになる(面によって順が違わない)', () => {
    /**
     * 🔑 **期待値は「別の観測」から作る**(CLAUDE.md §1)── 規則を写し直すと
     *   同じ盲点を共有する。ここでは**一覧の実物**(`sortOrder`)に同じ題名を
     *   並べさせて、それと一致することを見る。
     * ⚠ 1 稿目は `localeCompare` を使っており、この形にしたら落ちた
     *   (変異試験 C6 が SURVIVED で教えた ── 写した期待値では見抜けなかった)。
     * ⚠ **書体で差が出る組**を入れる(`é` / `f`)── 日本語だけだと
     *   `localeCompare` と符号位置順が**たまたま一致**して素通りする。
     */
    const names: Array<[string, string]> = [
      ['b', '山田'],
      ['a', '山田'],
      ['c', '青木'],
      ['d', 'éclair'],
      ['e', 'fig'],
      ['f', 'Apple'],
    ];
    const metas = new Map(
      names.map(([lid, name]) => [lid, { lid, title: name } as never]),
    );
    const expected = sortOrder(
      names.map(([lid]) => lid),
      (lid) => metas.get(lid),
      'title',
      false,
    );
    const out = sortContacts(names.map(([lid, name]) => card(lid, name)));
    expect(out.map((c) => c.lid), '一覧と並びが違う').toEqual(expected);
  });

  it('🔴 名前でも所属でも電話でもメールでも当たる(user はどれでも探す)', () => {
    const c = card('a', '山田太郎', '例の会社', ['090-1234-5678'], ['Taro@Example.com']);
    expect(matchContact(c, '山田')).toBe(true);
    expect(matchContact(c, '例の')).toBe(true);
    expect(matchContact(c, '090')).toBe(true);
    expect(matchContact(c, 'taro@'), '大文字小文字で外れた').toBe(true);
    expect(matchContact(c, '鈴木')).toBe(false);
    expect(matchContact(c, ''), '空の絞りで全部落ちた').toBe(true);
  });

  it('⚠ 所属が無ければ括弧を出さない', () => {
    expect(contactLine(card('a', '山田'))).toBe('山田');
    expect(contactLine(card('a', '山田', '例の会社'))).toBe('山田(例の会社)');
  });
});
