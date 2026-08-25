/** @vitest-environment happy-dom */
import { describe, it, expect } from 'vitest';
import { deliveredEntryOf } from '../../src/features/extension/ext-delivery';
import { EXT_OMITTED } from '../../src/features/extension/ext-projection';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const meta = (over: Partial<EntryMeta> = {}): EntryMeta => ({
  lid: 'a1',
  title: '買い物',
  archetype: 'text',
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T01:00:00.000Z',
  entryOrder: 3,
  status: null,
  date: null,
  archived: false,
  bodyChars: 1234,
  ...over,
});

describe('拡張へ渡す実体(#195 / C-5 段②)', () => {
  /**
   * 🔴 **写す列を名指ししていること**を、列の集合そのもので pin する。
   *
   * ⚠ 「本文が入っている」だけを見る test は、実装が `...meta` で
   *   全部撒くようになっても**緑のまま**である ── そのとき
   *   `bodyChars`(本文の長さ)が黙って拡張まで流れる。
   * 🔑 だから**等値で pin する**(`repo-hygiene` の `KNOWN_DEAD` と同じ倒し方 ──
   *   列を足したらここを直さないと落ちるので、忘れられない)。
   */
  it('🔴 渡す列は名指しの集合そのもの(増えても減っても落ちる)', () => {
    expect(Object.keys(deliveredEntryOf(meta(), 'x')).sort()).toEqual(
      [
        'archetype',
        'archived',
        'assetRefsApprox',
        'body',
        'createdAt',
        'date',
        'lid',
        'status',
        'title',
        'updatedAt',
      ].sort(),
    );
  });

  /**
   * 🔴 **段① で渡さないと決めた列は、段② でも渡らない。**
   * ⚠ 本文を載せた瞬間「もう長さくらい良いだろう」と緩みやすいので、
   *   段① の宣言(`EXT_OMITTED`)を**こちらからも読んで**縛る
   *   ── 2 か所に別々の一覧を書かない(§7)。
   */
  it('🔴 段① が「渡さない」と宣言した列は 1 つも入っていない', () => {
    const keys = Object.keys(deliveredEntryOf(meta(), 'x'));
    expect(EXT_OMITTED.length, '宣言が空だと、この検査は何も見ていない').toBeGreaterThan(0);
    for (const omitted of EXT_OMITTED) expect(keys).not.toContain(omitted);
  });

  it('本文は 1 バイトも切らずに乗る', () => {
    const body = 'あ'.repeat(200_000);
    expect(deliveredEntryOf(meta(), body).body).toHaveLength(200_000);
  });

  /**
   * 添付は**数だけ**渡す(key も bytes も渡さない)。
   * ⚠ 0 件のときも `0` が入ること ── 欄ごと消すと、拡張の作者は
   *   「壊れている」と「参照が無い」を見分けられない。
   */
  it('添付の参照はおおよその件数だけを渡す(key も bytes も渡さない)', () => {
    const d = deliveredEntryOf(meta(), '![a](asset:k1) と ![b](asset:k2) と asset:k1');
    expect(d.assetRefsApprox).toBe(3);
    expect(JSON.stringify(d)).not.toContain('bytes');
    expect(deliveredEntryOf(meta(), '添付なし').assetRefsApprox).toBe(0);
  });

  /** ⚠ 段① の列は `extEntryOf` を**呼んで**作る ── 写し直していないことを見る。 */
  it('段① の列は段① と同じ値になる', () => {
    const m = meta({ status: 'done', date: '2026-09-01', archived: true });
    const d = deliveredEntryOf(m, 'body');
    expect([d.lid, d.title, d.archetype, d.status, d.date, d.archived]).toEqual([
      'a1',
      '買い物',
      'text',
      'done',
      '2026-09-01',
      true,
    ]);
  });
});
