/**
 * O4: 添付の**版の台帳**(#88)。
 *
 * 守りたい主張:
 *  ① 🔴 **世代と容量の両方が効く** ── 片方だけでは 50MB × 5 世代が通る
 *  ② 🔴 **`pinned` は落ちない。ただし合計には数える**
 *  ③ 🔴 **落とすのは古い順**(新しい版を先に捨てない)
 *  ④ 🔴 **収まらなかったことを黙らない**(`pinned` だけで超えていたら言う)
 *  ⑤ 壊れた 1 行で履歴を全部捨てない
 *  ⑥ ラベルに `|` が入っても壊れない(逃がし文字を作らない設計の帰結)
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HISTORY_BYTES,
  DEFAULT_KEEP_GENERATIONS,
  evictVersions,
  parseVersion,
  readVersions,
  serializeVersion,
  totalHistoryBytes,
  versionsValue,
  VERSIONS_KEY,
  type AttachmentVersion,
} from '../../src/features/flavor/attachment-versions';
import { serializeFrontmatter } from '../../src/features/markdown/frontmatter';

const MB = 1024 * 1024;

function v(
  day: number,
  kind: 'auto' | 'pinned' = 'auto',
  bytes = 1,
  label = '',
): AttachmentVersion {
  return {
    savedAt: `2026-08-${String(day).padStart(2, '0')}T00:00:00Z`,
    kind,
    assetKey: `ast-${day}`,
    bytes,
    label,
  };
}

describe('1 行の読み書き', () => {
  it('往復する', () => {
    const one = v(1, 'pinned', 12345, '初稿');
    expect(parseVersion(serializeVersion(one))).toEqual(one);
  });

  it('🔴 ラベルに | が入っても壊れない(最後に置いてあるから)', () => {
    const one = v(2, 'auto', 5, 'A|B|C');
    const back = parseVersion(serializeVersion(one));
    expect(back?.label, 'ラベルを途中で切らない').toBe('A|B|C');
    expect(back?.assetKey).toBe('ast-2');
  });

  it('読めない行は null(壊れた行で全部を捨てない)', () => {
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('a|b|c')).toBeNull(); // 項目が足りない
    expect(parseVersion('2026-08-01|weird|ast-1|5'), '知らない種別').toBeNull();
    expect(parseVersion('2026-08-01|auto|ast-1|abc'), '数字でない').toBeNull();
    expect(parseVersion('2026-08-01|auto||5'), 'key が空').toBeNull();
    expect(parseVersion('|auto|ast-1|5'), '日時が空').toBeNull();
    expect(parseVersion('2026-08-01|auto|ast-1|-3'), '負のバイト数').toBeNull();
  });
});

describe('本文から読む', () => {
  const body = (lines: string[]): string =>
    serializeFrontmatter({ 'attachment.asset_key': 'ast-now', [VERSIONS_KEY]: lines });

  it('🔴 古い順に並べて返す(書いた順に依存しない)', () => {
    const list = readVersions(body([serializeVersion(v(9)), serializeVersion(v(3))]));
    expect(list.map((x) => x.assetKey)).toEqual(['ast-3', 'ast-9']);
  });

  it('🔴 壊れた 1 行があっても、残りは読める', () => {
    const list = readVersions(body(['ごみ', serializeVersion(v(4))]));
    expect(list.map((x) => x.assetKey)).toEqual(['ast-4']);
  });

  it('台帳が無い本文は空(添付は履歴を持たないところから始まる)', () => {
    expect(readVersions(serializeFrontmatter({ 'attachment.name': 'a.docx' }))).toEqual([]);
  });

  it('🔴 いまの版は列に入らない(構造として落ちようがない)', () => {
    // ⚠ `attachment.asset_key` は台帳の外に在る ── 混ざっていないことを見る
    const list = readVersions(body([serializeVersion(v(1))]));
    expect(list.some((x) => x.assetKey === 'ast-now')).toBe(false);
  });

  it('空の列は key ごと消す(無意味な行を本文に残さない)', () => {
    expect(versionsValue([])).toBeUndefined();
    expect(versionsValue([v(1)])).toEqual([serializeVersion(v(1))]);
  });
});

describe('上限で落とす', () => {
  const group = (list: AttachmentVersion[]) => new Map([['a1', list]]);

  it('🔴 世代を超えた自動履歴は、古い順に落ちる', () => {
    const list = [v(1), v(2), v(3), v(4), v(5), v(6), v(7)];
    const r = evictVersions(group(list), { keepGenerations: 5 }).get('a1')!;
    expect(r.keep.map((x) => x.assetKey)).toEqual(['ast-3', 'ast-4', 'ast-5', 'ast-6', 'ast-7']);
    expect(r.dropped.map((x) => x.assetKey), '古い 2 つ').toEqual(['ast-1', 'ast-2']);
  });

  it('🔴 pinned は世代で落ちない(自動履歴だけ数える)', () => {
    const list = [v(1, 'pinned'), v(2), v(3), v(4), v(5), v(6)];
    const r = evictVersions(group(list), { keepGenerations: 2 }).get('a1')!;
    expect(r.keep.map((x) => x.assetKey)).toEqual(['ast-1', 'ast-5', 'ast-6']);
    expect(r.dropped.map((x) => x.assetKey)).toEqual(['ast-2', 'ast-3', 'ast-4']);
  });

  it('🔴 容量でも落ちる ── 世代に収まっていても超えていれば外す', () => {
    // ⚠ **これが「両方」の意味** ── 世代 5 に収まっているのに 250MB ある
    const list = [v(1, 'auto', 50 * MB), v(2, 'auto', 50 * MB), v(3, 'auto', 50 * MB),
      v(4, 'auto', 50 * MB), v(5, 'auto', 50 * MB)];
    const r = evictVersions(group(list), { keepGenerations: 5, maxTotalBytes: 120 * MB }).get('a1')!;
    expect(totalHistoryBytes([r.keep])).toBeLessThanOrEqual(120 * MB);
    expect(r.dropped.map((x) => x.assetKey), '古い順に外す').toEqual(['ast-1', 'ast-2', 'ast-3']);
    expect(r.overBudget).toBe(false);
  });

  it('🔴 容量は添付をまたいで効く(1 つの添付に閉じない)', () => {
    const groups = new Map([
      ['a1', [v(1, 'auto', 60 * MB)]],
      ['a2', [v(2, 'auto', 60 * MB)]],
      ['a3', [v(3, 'auto', 60 * MB)]],
    ]);
    const out = evictVersions(groups, { keepGenerations: 5, maxTotalBytes: 130 * MB });
    const kept = [...out.values()].flatMap((r) => [...r.keep]);
    expect(totalHistoryBytes([kept])).toBeLessThanOrEqual(130 * MB);
    // いちばん古い a1 が外れる
    expect(out.get('a1')!.keep).toEqual([]);
    expect(out.get('a3')!.keep.length).toBe(1);
  });

  it('🔴 pinned は容量でも落ちない ── ただし合計には数える', () => {
    // ⚠ 数えないと、pin を積むほど自動履歴が押し出されず**上限が嘘になる**
    const groups = new Map([
      ['a1', [v(1, 'pinned', 100 * MB)]],
      ['a2', [v(2, 'auto', 60 * MB)]],
    ]);
    const out = evictVersions(groups, { maxTotalBytes: 120 * MB });
    expect(out.get('a1')!.keep.length, 'pinned は残る').toBe(1);
    expect(out.get('a2')!.keep, '自動履歴のほうが押し出される').toEqual([]);
  });

  it('🔴 収まらなかったことを黙らない(pinned だけで超えている)', () => {
    const groups = new Map([['a1', [v(1, 'pinned', 300 * MB)]]]);
    const out = evictVersions(groups, { maxTotalBytes: 200 * MB }).get('a1')!;
    expect(out.keep.length, 'pinned は落とさない').toBe(1);
    expect(out.overBudget, '超えたままだと言う').toBe(true);
  });

  it('上限に収まっていれば何も落とさない', () => {
    const list = [v(1), v(2)];
    const r = evictVersions(group(list)).get('a1')!;
    expect(r.dropped).toEqual([]);
    expect(r.overBudget).toBe(false);
  });

  it('既定の上限が、想定した桁である(数字は真っ先に腐る)', () => {
    expect(DEFAULT_KEEP_GENERATIONS).toBe(5);
    expect(DEFAULT_HISTORY_BYTES).toBe(200 * MB);
  });
});
