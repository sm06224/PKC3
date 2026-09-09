/**
 * 🔴 **案内文と手本は、いま調べている相手へ揃う**(#681 の着地前レビュー F2)。
 *
 * ⚠ 直す前は**状態を 1 つも見ない静的な字**だったので、取り込んだ `.sqlite` を
 *   選んでも「調べられるのは entries(ノート)…」のままだった ──
 *   🔴 **書いてあるとおり打つと `no such table: entries` という英語が返る**。
 * ⚠ そのうえ**その file に在る表の名前は画面のどこにも出ていなかった**
 *   (state には届いているのに、描画器は個数だけを使っていた)。
 */
import { describe, expect, it } from 'vitest';
import { sqlPlaceholder, sqlTipText, TIP_TABLES_MAX } from '../../src/features/query/sql-tip';

const guest = (tables: string[]) => ({ name: '売上.sqlite', tables });

describe('案内文', () => {
  it('この PKC のときは、ノートの表を案内する', () => {
    const t = sqlTipText(null);
    expect(t).toContain('entries');
    expect(t, '本文の csv の道を書いていない').toContain('csv name=売上');
  });

  it('🔴 相手を選んだら、その file に在る表の名前を出す', () => {
    const t = sqlTipText(guest(['売上', '明細', '顧客']));
    expect(t, 'どの file か言っていない').toContain('売上.sqlite');
    expect(t, '表の名前が出ていない').toContain('売上, 明細, 顧客');
  });

  /**
   * 🔴 **打てない字を案内しない** ── 客の DB を選んでいる間、`entries` は無い。
   * ⚠ 案内したままだと、そのとおり打った人に英語の断りが返る。
   */
  it('🔴 相手を選んだら、ノートの表は案内しない', () => {
    const t = sqlTipText(guest(['売上']));
    expect(t, 'ノートの表を案内したまま').not.toContain('調べられるのは entries');
    expect(t, '出てこないことを言っていない').toContain('出てきません');
  });

  it('⚠ 表が多い file では、名前を切って「ほか N 個」と言う', () => {
    const many = Array.from({ length: TIP_TABLES_MAX + 3 }, (_, i) => `t${String(i)}`);
    const t = sqlTipText(guest(many));
    expect(t).toContain('ほか 3 個');
    expect(t, '切っていない(案内が画面を埋める)').not.toContain(`t${String(TIP_TABLES_MAX)}`);
  });

  it('⚠ 表が 1 つも無い file でも、そう言う(黙らない)', () => {
    expect(sqlTipText(guest([]))).toContain('表が 1 つもありません');
  });

  /** ⚠ どちらの相手でも、同梱 sqlite の癖は必ず書く(実測から書いている 3 つ)。 */
  it('⚠ 癖の案内は、どちらの相手でも消えない', () => {
    for (const t of [sqlTipText(null), sqlTipText(guest(['x']))]) {
      expect(t, '単引用符の話が消えた').toContain('単引用符');
      expect(t, 'REGEXP の話が消えた').toContain('REGEXP');
      expect(t, '全角の話が消えた').toContain('半角で打ってください');
    }
  });
});

describe('薄字の手本', () => {
  it('この PKC のときは、ノートを引く例', () => {
    expect(sqlPlaceholder(null)).toContain('FROM entries');
  });

  it('🔴 相手を選んだら、その file の表を引く例になる', () => {
    expect(sqlPlaceholder(guest(['売上', '明細']))).toBe('SELECT * FROM "売上" LIMIT 20');
  });

  /** ⚠ 表が 1 つも無い file では、**打てる字**を出す(空の表名を書かない)。 */
  it('⚠ 表が 1 つも無ければ、表の一覧を引く例にする', () => {
    expect(sqlPlaceholder(guest([]))).toBe('SELECT name FROM sqlite_schema');
  });
});
