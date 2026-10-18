/**
 * 🔴 取り込んだノートを、いま開いているフォルダの中へ入れる(台帳 #1852 束 F1、依頼 340)。
 */
import { describe, expect, it } from 'vitest';
import { withFolderHome } from '../../src/adapter/ui/actions/import-folder-home';
import { openFolderLid } from '../../src/adapter/ui/actions/open-folder-lid';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';

const row = (lid: string): EntryUpsert =>
  ({ lid, title: lid, archetype: 'text', body: '', entryOrder: 1, status: null, date: null, archived: false }) as EntryUpsert;

type Rel = { id: string; fromLid: string; toLid: string; kind: string };

function setup(failRelations = false) {
  const log: string[] = [];
  const rels: Rel[] = [];
  const failures: string[] = [];
  const base = {
    bulkUpsertEntries: async (e: EntryUpsert[]) => void log.push(`entries:${e.map((x) => x.lid).join(',')}`),
    bulkUpsertRelations: async (r: Rel[]) => void log.push(`rel-own:${r.length}`),
    reload: async () => void log.push('reload'),
    reportFailure: (m: string) => void failures.push(m),
  };
  let n = 0;
  const put = async (r: Rel[]): Promise<void> => {
    if (failRelations) throw new Error('書込に失敗(注入)');
    rels.push(...r);
    log.push(`rel-home:${r.length}`);
  };
  return { log, rels, failures, base, put, gen: () => `r${++n}` };
}

describe('取り込み先のフォルダ(依頼 340)', () => {
  it('🔴 フォルダを開いているとき、取り込んだ根のノートはそのフォルダの子になる(辺はフォルダ → ノート、reload の前)', async () => {
    const t = setup();
    const d = withFolderHome(t.base, 'F', t.put, t.gen);
    await d.bulkUpsertEntries([row('a'), row('b')]);
    await d.reload();
    expect(t.rels).toEqual([
      { id: 'r1', fromLid: 'F', toLid: 'a', kind: 'structural' },
      { id: 'r2', fromLid: 'F', toLid: 'b', kind: 'structural' },
    ]);
    // 反映(reload)より前に書く ── 後だと、画面にはルートの末尾で出る
    expect(t.log.indexOf('rel-home:2')).toBeLessThan(t.log.indexOf('reload'));
  });

  it('🔴 PKC2 の書き出しの親子は保つ ── 親を持つノートは開いているフォルダの子にしない(根だけ入る)', async () => {
    const t = setup();
    const d = withFolderHome(t.base, 'F', t.put, t.gen);
    await d.bulkUpsertEntries([row('dir'), row('child')]);
    await d.bulkUpsertRelations?.([{ id: 'x', fromLid: 'dir', toLid: 'child', kind: 'structural' }]);
    await d.reload();
    expect(t.log, '元の関連の書込を通していない').toContain('rel-own:1');
    expect(t.rels.map((r) => r.toLid)).toEqual(['dir']);
  });

  it('意味の辺(structural でない)は親子と数えない', async () => {
    const t = setup();
    const d = withFolderHome(t.base, 'F', t.put, t.gen);
    await d.bulkUpsertEntries([row('a'), row('b')]);
    await d.bulkUpsertRelations?.([{ id: 'x', fromLid: 'a', toLid: 'b', kind: 'categorical' }]);
    await d.reload();
    expect(t.rels.map((r) => r.toLid)).toEqual(['a', 'b']);
  });

  it('入れ先が無い(null)なら deps をそのまま返す = これまでどおりルート', () => {
    const t = setup();
    expect(withFolderHome(t.base, null, t.put, t.gen)).toBe(t.base);
  });

  it('reload が 2 回呼ばれても辺は 1 度だけ(失敗の出口と成功の出口の重なり)', async () => {
    const t = setup();
    const d = withFolderHome(t.base, 'F', t.put, t.gen);
    await d.bulkUpsertEntries([row('a')]);
    await d.reload();
    await d.reload();
    expect(t.rels).toHaveLength(1);
  });

  it('🔴 辺を書けなかったら黙らず、ルートに入っていることを言う(取り込み自体は続く)', async () => {
    const t = setup(true);
    const d = withFolderHome(t.base, 'F', t.put, t.gen);
    await d.bulkUpsertEntries([row('a')]);
    await d.reload();
    expect(t.log).toContain('reload');
    expect(t.failures[0]).toContain('ルートに入っています');
  });
});

describe('openFolderLid(「新しく作るものは「X」に入ります」と同じ判定)', () => {
  const metas = new Map<string, { lid: string; archetype: string }>([
    ['F', { lid: 'F', archetype: 'folder' }],
    ['S', { lid: 'S', archetype: 'smart' }],
    ['T', { lid: 'T', archetype: 'text' }],
  ]);
  const st = (scopeLid: string | null) => ({ scopeLid, entryMetas: metas }) as never;
  it('ふつうのフォルダだけ lid を返す。ルート・スマートフォルダ・ノート・消えた物は null', () => {
    expect(openFolderLid(st('F'))).toBe('F');
    expect(openFolderLid(st(null))).toBeNull();
    expect(openFolderLid(st('S'))).toBeNull();
    expect(openFolderLid(st('T'))).toBeNull();
    expect(openFolderLid(st('gone'))).toBeNull();
  });
});
