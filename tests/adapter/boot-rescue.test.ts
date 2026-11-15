/**
 * 🔴 **起動に失敗した画面の「バックアップ」の中身**(#1163 依頼 208)。
 *
 * - 保存領域を開き直し、読める分だけを `.pkc3-part.zip` で保存する(取り込めば戻せる形)
 * - 開けない / 1 件も読めない / 書き出せないときは、そう言う(投げない)
 * - 🔴 開き直した口は必ず閉じる(閉じないと、再読み込みした後の起動が保存領域を取れない)
 */
import { describe, expect, it } from 'vitest';
import {
  BOOT_RESCUE_EMPTY,
  BOOT_RESCUE_OPEN_FAILED,
  bootRescueBackup,
  type BootRescueStore,
} from '../../src/adapter/ui/actions/boot-rescue';
import type { RescuePageLike } from '../../src/features/storage/rescue-archive';
import { readArchive } from '../../src/features/export/pkc3-archive';

type Row = RescuePageLike['rows'][number];
const rows: Row[] = [
  { rowid: 1, lid: 'a1', title: '牛乳を買う', archetype: 'text', body: '# 牛乳を買う\n\n近所で\n' },
  { rowid: 2, lid: 'b2', title: '会議のメモ', archetype: 'text', body: '- 決めたこと\n' },
];

function store(over: Partial<BootRescueStore> & { rows?: Row[] } = {}): BootRescueStore & { closed: number } {
  const list = over.rows ?? rows;
  const s = {
    closed: 0,
    cid: over.cid === undefined ? 'c1' : over.cid,
    pick: async (after: number): Promise<RescuePageLike> => {
      const page = list.filter((r) => r.rowid > after);
      return {
        rows: page,
        lastRowid: page.at(-1)?.rowid ?? after,
        skipped: 0,
        empty: 0,
        maxRowid: list.at(-1)?.rowid ?? null,
        done: true,
      };
    },
    close() {
      s.closed += 1;
    },
  };
  return s;
}

describe('起動に失敗した画面の「バックアップ」(依頼 208)', () => {
  it('🔴 読める分を .pkc3-part.zip で保存し、取り込めば同じノートが戻る。開き直した口は閉じる', async () => {
    const s = store();
    const saved: Array<{ name: string; blob: Blob }> = [];
    const said = await bootRescueBackup({
      open: async () => s,
      title: 'PKC3',
      download: (name, blob) => saved.push({ name, blob }),
      now: () => new Date('2026-11-15T03:00:00Z'),
    });
    expect(saved.length, '保存していない').toBe(1);
    expect(saved[0]!.name).toMatch(/^PKC3-\d{8}\.pkc3-part\.zip$/);
    expect(said).toContain(`「${saved[0]!.name}」を保存しました`);
    expect(said, '件数を言っていない').toContain('2 件のうち 2 件');
    expect(s.closed, '開き直した口を閉じていない').toBe(1);
    // 🔑 取り込めば戻せる形(読む口で読み戻す)
    const back = await readArchive(saved[0]!.blob);
    expect(back.entries.map((e) => e.title).sort()).toEqual(['会議のメモ', '牛乳を買う']);
  });

  it('⚠ 開けなければ、そう言う(投げない・保存しない)', async () => {
    const saved: string[] = [];
    const said = await bootRescueBackup({
      open: async () => {
        throw new Error('開けない');
      },
      title: 'PKC3',
      download: (name) => saved.push(name),
    });
    expect(said).toBe(BOOT_RESCUE_OPEN_FAILED);
    expect(saved).toEqual([]);
  });

  it('⚠ 1 件も読めなければ、そう言い(空の zip を保存しない)、口は閉じる', async () => {
    const s = store({ rows: [] });
    const saved: string[] = [];
    const said = await bootRescueBackup({ open: async () => s, title: 'PKC3', download: (n) => saved.push(n) });
    expect(said).toBe(BOOT_RESCUE_EMPTY);
    expect(saved).toEqual([]);
    expect(s.closed, '読めなかった回に口を閉じていない').toBe(1);
  });

  it('⚠ 入れ物の id が引けなくても、本文は取り出す(添付は入れない)', async () => {
    const s = store({ cid: null });
    let asked = 0;
    const saved: string[] = [];
    const said = await bootRescueBackup({
      open: async () => s,
      title: 'PKC3',
      download: (n) => saved.push(n),
      assets: {
        listKeys: async () => {
          asked += 1;
          return [];
        },
        get: async () => null,
      },
    });
    expect(saved.length).toBe(1);
    expect(said).toContain('2 件のうち 2 件');
    expect(asked, 'id が無いのに添付を探した').toBe(0);
  });
});
