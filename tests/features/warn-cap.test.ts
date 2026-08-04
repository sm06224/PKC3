/** @vitest-environment node */
/**
 * P8 段㉒: 注意を**数で畳む**規則。
 *
 * 🔴 生まれた理由: 同じ規則が md ZIP にだけあり、アーカイブ側に無かった。
 * アーカイブの取込は**衝突した entry 1 件につき 1 行**積むので、同じバックアップを
 * 2 回取り込むと**全件が該当**する ── 200 件なら 200 行。注意の面には高さの上限も
 * scroll も無かったので、3 列が数十 px まで押し潰され、閉じるまで作業できなかった。
 */
import { describe, expect, it } from 'vitest';
import { createWarnCollector, WARN_CAP } from '../../src/features/export/warn-cap';
import { restoreArchive } from '../../src/features/export/pkc3-archive';

describe('注意の畳み方', () => {
  it('🔴 上限までは出し、超えたぶんは「ほか N 件」に畳む', () => {
    const out = createWarnCollector();
    for (let i = 0; i < WARN_CAP + 25; i++) out.add('b', '衝突した lid', `衝突 ${i}`);
    const lines = out.finish();
    // ⚠ 畳んだ行(「…はほか N 件」)を数に入れない ── 入れると上限 +1 で通る
    expect(lines.filter((l) => /^衝突 \d/.test(l)), '上限を超えて並べている').toHaveLength(
      WARN_CAP,
    );
    expect(lines.at(-1), '畳んだ件数を言っていない').toBe('衝突した lidはほか 25 件あります');
  });

  it('⚠ 上限内なら「ほか」の行を足さない(1 件で 2 行にしない)', () => {
    const out = createWarnCollector();
    out.add('b', 'ラベル', '注意 1');
    expect(out.finish()).toEqual(['注意 1']);
  });

  it('⚠ 種類ごとに数える(別の注意が混ざって畳まれない)', () => {
    const out = createWarnCollector();
    for (let i = 0; i < WARN_CAP; i++) out.add('a', 'A の注意', `a${i}`);
    for (let i = 0; i < WARN_CAP; i++) out.add('b', 'B の注意', `b${i}`);
    // どちらも上限ちょうど = 畳まない
    expect(out.finish().filter((l) => l.includes('ほか'))).toEqual([]);
  });

  /**
   * 🔴 **実際の取込で効いていること**を見る(規則が在るだけでは足りない)。
   * ⚠ 同じアーカイブを 2 回取り込む = 全 entry の lid が衝突する、という
   *   一番出やすい形をそのまま作る。
   */
  it('🔴 同じバックアップを 2 回取り込んでも、注意が件数ぶん並ばない', () => {
    const N = 60;
    const archive = {
      version: 2,
      entries: Array.from({ length: N }, (_, i) => ({
        lid: `n${i}`,
        title: `ノート ${i}`,
        archetype: 'text',
        body: 'x',
        created_at: null,
        updated_at: null,
        entry_order: i + 1,
        status: null,
        date: null,
        archived: 0,
      })),
      relations: [],
      assets: [],
      revisions: [],
      assetSources: new Map<string, Blob>(),
      warnings: [],
    } as unknown as Parameters<typeof restoreArchive>[0];

    let seq = 0;
    const res = restoreArchive(archive, {
      // 既存 lid が全部埋まっている = 2 回目の取込
      existingLids: new Set(Array.from({ length: N }, (_, i) => `n${i}`)),
      existingRelationIds: new Set<string>(),
      genLid: () => `fresh-${seq++}`,
      genRelationId: () => 'r',
      orderBase: 0,
    });

    // 前提: 実際に全件が付け替わっている(この次元が非ゼロ)
    expect(seq, '衝突が起きていない(測れていない)').toBe(N);
    const clash = res.warnings.filter((w) => w.includes('付け替えました'));
    expect(clash.length, `注意が件数ぶん並んでいる(${clash.length} 行)`).toBeLessThanOrEqual(
      WARN_CAP,
    );
    expect(res.warnings.join('\n'), '畳んだ件数を言っていない').toContain('ほか');
  });
});
