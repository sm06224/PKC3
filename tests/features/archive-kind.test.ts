/**
 * 🔴 **file の型は「含まれる型の積」**(#1017 段④b)。
 *
 * ⚠ ここで守るのは**末尾の生成**だけ(pure)。取込側が中身(manifest)で
 * 判定していることは `tests/adapter/import-pkc2.test.ts` の
 * 「旧 `.pkc3.zip` も読める」/ `tests/features/pkc3-archive.test.ts` の
 * 「manifest の等値」が見る。
 */
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_SUFFIXES,
  LEGACY_ARCHIVE_SUFFIX,
  archiveFileName,
  archiveKindContains,
  archiveSuffix,
  type ArchiveKind,
} from '../../src/features/export/archive-kind';

describe('末尾の生成(#1017 段④b)', () => {
  it('🔴 3 種の末尾を取り違えない', () => {
    expect(archiveSuffix('full')).toBe('.pkc3-full.zip');
    expect(archiveSuffix('notes')).toBe('.pkc3-notes.zip');
    expect(archiveSuffix('part')).toBe('.pkc3-part.zip');
    // ⚠ 空振り防止 ── 3 つとも別の文字列であること
    expect(new Set([archiveSuffix('full'), archiveSuffix('notes'), archiveSuffix('part')]).size).toBe(3);
  });

  it('🔴 base に末尾を付けるだけ(safeName 済みの前提を壊さない)', () => {
    expect(archiveFileName('タイトル-2026-09-21', 'full')).toBe('タイトル-2026-09-21.pkc3-full.zip');
    expect(archiveFileName('タイトル-2026-09-21', 'notes')).toBe('タイトル-2026-09-21.pkc3-notes.zip');
    expect(archiveFileName('タイトル-2026-09-21', 'part')).toBe('タイトル-2026-09-21.pkc3-part.zip');
  });

  it('⚠ 旧形式は 3 種と別で、なおかつ一覧に入っている', () => {
    expect(LEGACY_ARCHIVE_SUFFIX).toBe('.pkc3.zip');
    for (const kind of ['full', 'notes', 'part'] as const) {
      expect(ARCHIVE_SUFFIXES).toContain(archiveSuffix(kind));
    }
    expect(ARCHIVE_SUFFIXES).toContain(LEGACY_ARCHIVE_SUFFIX);
    // ⚠ 空振り防止 ── ちょうど 4 件(3 種 + 旧形式)であること
    expect(ARCHIVE_SUFFIXES).toHaveLength(4);
  });

  it('🔑 「何が含まれるか」の短い説明が、種ごとに違う', () => {
    const kinds: readonly ArchiveKind[] = ['full', 'notes', 'part'];
    const seen = new Set(kinds.map((k) => archiveKindContains(k)));
    expect(seen.size, '説明が使い回されている').toBe(3);
    // 🔑 §5 の検算:`.pkc3-part.zip` の説明は「つながり・履歴」の欠落に触れる
    expect(archiveKindContains('part')).toMatch(/つながり|履歴/);
  });
});
