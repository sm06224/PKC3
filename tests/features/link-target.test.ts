/**
 * 🔴 **本文のリンクが指す先を解く**(2026-08-08)。
 *
 * ⚠ `entry-ref.ts` は 315 行あるのに、**直接 import する test が 1 件も無かった**
 * (間接に文字列を見る test が 1 件だけ)。ここで実測した全数表をそのまま
 * 回帰 test にする ── **組み合わせが有限なら全部当てる**(CLAUDE.md)。
 */
import { describe, expect, it } from 'vitest';
import { parseLinkTarget } from '../../src/features/entry-ref/link-target';
import { renderMarkdown } from '@features/markdown/markdown-render';

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
   * ⚠ 自分の cid を渡されていないときは**外と見なさない**(既定で断ると
   *   全部断ってしまう)。⚠ **受け手側(binder)はまだ cid を渡していない** ──
   *   描画側は Issue #100 段① で受け取ったので、`navigate-entry-ref` に焼かれる
   *   `pkc://` は必ず同一コンテナである(外が来るのは card 経由だけ)。
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

/**
 * 🔴 添付の携帯参照(Issue #100)。段①(2026-08-08)では受け手が無く
 * 「焼くと無言の dead click」だったため札のままにしていた ──
 * **段②(2026-08-14)で受け手(`navigate-asset-ref` → worker の逆引き)と
 * 同じ PR で枝を開けた**。ここが守るのは「同一コンテナだけ焼く」の線引き。
 */
describe('添付の携帯参照(#100 段② ── 受け手と同じ PR で開けた)', () => {
  const render = (src: string): string =>
    renderMarkdown(src, { currentContainerId: 'c-mine', silentHallucinationWarnings: true });

  it('🔴 自分あての asset は所有ノートへ飛ぶリンクになる(受け手が読む key 属性つき)', () => {
    const html = render('[添付](pkc://c-mine/asset/ast-1)\n');
    expect(html, '段②の枝が開いていない').toContain('navigate-asset-ref');
    expect(html, '受け手が読む key が載っていない').toContain('data-pkc-asset-ref="ast-1"');
    expect(html, 'リンクにしたのに札も重ねている').not.toContain(
      'pkc-portable-reference-placeholder',
    );
  });

  it('🔑 対照群: 別コンテナあての asset は札のまま(cid を見ずに全部焼く実装を落とす)', () => {
    const html = render('[添付](pkc://c-other/asset/ast-1)\n');
    expect(html, '外あてまでリンクにしている').not.toContain('navigate-asset-ref');
    expect(html).toContain('pkc-portable-reference-placeholder');
    expect(html).toContain('data-pkc-portable-target="ast-1"');
  });

  it('🔑 対照群: 自分あての entry は押せるリンクになる(段①の本体)', () => {
    const html = render('[ノート](pkc://c-mine/entry/b)\n');
    expect(html, '段① が効いていない(この test 全体が空振りする)').toContain(
      'navigate-entry-ref',
    );
  });
});
