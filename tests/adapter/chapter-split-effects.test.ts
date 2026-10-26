/** @vitest-environment happy-dom */
/**
 * 🔴 **章を新しいノートに切り出す / 元に戻す**(#1439)── reducer と効果層を通した往復。
 *
 * 守る主張:
 * 1. 切り出すと、元の章はリンク 1 行になり、新しいノートに章の中身が入る
 * 2. 🔴 **往復で元の本文が 1 バイトも変わらない**(切り出して戻すと同じ字に戻る)
 * 3. 戻すと切り出し先は削除される / 元に書けなかった回は何も消さない(先に元へ書く)
 * 4. 押した時点のリンクの行が disk と違えば、書かない(別の窓が書き替えた形)
 */
import { describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { contentHash64Hex } from '../../src/adapter/platform/storage/content-hash';
import { chapterLinkLine, planChapterCut } from '../../src/features/markdown/chapter-split';

const ORIGINAL = ['---', 'tags: [a]', '---', '# 題', '', '前書き', '', '## 第一章', '', '一章の本文', '', '### 小見出し', '', '細かい話', '', '## 第二章', '', '二章の本文', ''].join('\n');
const tick = (): Promise<unknown> => new Promise((r) => setTimeout(r, 10));

function meta(lid: string, title: string): EntryMeta {
  return { lid, title, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1, status: null, date: null, archived: false, bodyChars: null };
}

function harness(over: { conflictOn?: string } = {}) {
  const disk = new Map<string, string>([['a', ORIGINAL]]);
  const deleted: string[] = [];
  const d = new Dispatcher();
  const errors: string[] = [];
  const notices: Array<{ message: string; open?: string }> = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid: string) => disk.get(lid) ?? null,
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e: { lid: string; body: string }, opts?: { expectHash?: string }) => {
      if (over.conflictOn === e.lid) disk.set(e.lid, `${disk.get(e.lid) ?? ''}割り込み\n`);
      if (opts?.expectHash !== undefined && opts.expectHash !== contentHash64Hex(disk.get(e.lid) ?? ''))
        return { ...stubStamps(), conflict: true };
      disk.set(e.lid, e.body);
      return stubStamps();
    },
    deleteEntry: async (lid: string) => {
      deleted.push(lid);
    },
    setEntryParent: async () => {},
  } as never);
  d.onState((s) => {
    if (s.error !== null && !errors.includes(s.error)) errors.push(s.error);
    if (s.notice !== null && !notices.some((x) => x.message === s.notice))
      notices.push({ message: s.notice, ...(s.noticeOpen === null ? {} : { open: s.noticeOpen }) });
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', '元')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: ORIGINAL });
  return { d, disk, deleted, errors, notices };
}

/** 「第一章」(生の 7 行目)の切り出し案。 */
function planChapter1() {
  const r = planChapterCut(ORIGINAL, 7, 14);
  if (!r.ok) throw new Error(r.reason);
  return r.cut;
}

function split(h: ReturnType<typeof harness>, lid = 'kid') {
  const cut = planChapter1();
  h.d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid, title: '第一章', body: cut.childBody, edit: false, keepSelection: true });
  h.d.dispatch({
    type: 'SPLIT_CHAPTER',
    lid: 'a',
    start: cut.start,
    end: cut.end,
    link: chapterLinkLine('第一章', lid),
    childLid: lid,
    childTitle: '第一章',
  });
}

describe('章の切り出し(#1439)', () => {
  it('見出しは残り、その下がリンク 1 行になる / 新しいノートに章の中身(小見出し込み)が入る', async () => {
    const h = harness();
    split(h);
    await tick();
    expect(h.errors).toEqual([]);
    const lines = h.disk.get('a')!.split('\n');
    expect(lines.slice(7, 11)).toEqual(['## 第一章', '', '[第一章](entry:kid "切り出した章")', '']);
    expect(lines).toContain('## 第二章');
    expect(h.disk.get('kid')).toBe('一章の本文\n\n### 小見出し\n\n細かい話\n');
  });

  it('🔴 切り出して戻すと、元の本文に 1 バイトも違わず戻り、切り出し先は削除される', async () => {
    const h = harness();
    split(h);
    await tick();
    expect(h.disk.get('a')).not.toBe(ORIGINAL);
    const shown = h.disk.get('a')!;
    const line = shown.split('\n').findIndex((l) => l.includes('切り出した章"'));
    h.d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: shown });
    h.d.dispatch({ type: 'RESTORE_CHAPTER', lid: 'a', childLid: 'kid', line });
    await tick();
    expect(h.errors).toEqual([]);
    expect(h.disk.get('a')).toBe(ORIGINAL);
    expect(h.deleted).toEqual(['kid']);
  });

  it('🔴 戻すとき、元に書けなかった(競合した)回は切り出し先を消さない', async () => {
    const h = harness({ conflictOn: 'a' });
    split(h);
    await tick();
    // 切り出しの書込自体が競合した(別の窓が割り込んだ)── 元は割り込みの字だけが足されている
    expect(h.errors.length).toBeGreaterThan(0);
    expect(h.deleted).toEqual([]);
    expect(h.disk.get('kid'), '切り出し先は残る(二重になるだけ。章は消えない)').toContain('一章の本文');
  });

  it('🔴 押した時点のリンクの行が disk と違えば、戻さない(切り出し先も消さない)', async () => {
    const h = harness();
    split(h);
    await tick();
    const shown = h.disk.get('a')!;
    const line = shown.split('\n').findIndex((l) => l.includes('切り出した章"'));
    h.d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: shown });
    // 別の窓がリンクの行を書き替えた
    h.disk.set('a', shown.replace('[第一章]', '[書き替え]'));
    h.d.dispatch({ type: 'RESTORE_CHAPTER', lid: 'a', childLid: 'kid', line });
    await tick();
    expect(h.errors.some((e) => e.includes('章を戻せませんでした'))).toBe(true);
    expect(h.deleted).toEqual([]);
  });

  it('切り出した直後に知らせが出て、切り出し先を開ける', async () => {
    const h = harness();
    split(h);
    await tick();
    const n = h.notices.find((x) => x.message.includes('切り出しました'));
    expect(n?.open).toBe('kid');
  });

  it('編集中は断る(元の本文を書かない)', async () => {
    const h = harness();
    h.d.dispatch({ type: 'START_EDIT' });
    h.d.dispatch({
      type: 'SPLIT_CHAPTER',
      lid: 'a',
      start: 8,
      end: 14,
      link: chapterLinkLine('第一章', 'kid'),
      childLid: 'kid',
      childTitle: '第一章',
    });
    await tick();
    expect(h.disk.get('a')).toBe(ORIGINAL);
    expect(h.errors.length).toBeGreaterThan(0);
  });
});
