/** @vitest-environment happy-dom */
/**
 * 🔴 **字幕(SRT)を本文の末尾に埋め込む**(#1447)── 本物の保存経路(追記 → disk)を通して見る。
 *
 * 守る主張:
 * 1. 実行すると disk の本文に `## 字幕(SRT)` と ```srt のコードブロックが足される
 * 2. 2 回目は断る(同じ字幕が 2 つ並ばない)。disk は変わらない
 * 3. 「追記を元に戻す」(UNDO_APPEND)で、本文が元の 1 バイトまで戻る(片道にしない)
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions, runGlobalCommand } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { stubRevisionOps } from '../helpers/revision-stub';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: 't-' + lid,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ORIGINAL = '## 文字起こし\n0:00 こんにちは\n0:15 さようなら\n';

beforeEach(() => {
  document.body.textContent = '';
});

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  bindActions(root, d, {});
  const disk: Record<string, string> = { t1: ORIGINAL };
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => disk[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      disk[e.lid] = e.body;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('t1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 't1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 't1', body: ORIGINAL });
  const told: string[] = [];
  const run = (): boolean =>
    runGlobalCommand('embed-transcript-srt', root, d, new KeymapStore(), () => {}, (t) => told.push(t));
  return { d, disk, told, run };
}

describe('字幕(SRT)を本文の末尾に埋め込む(本物の保存経路)', () => {
  it('🔴 disk の本文に見出しとコードブロックが足され、「追記を元に戻す」で元の本文へ戻る', async () => {
    const s = setup();
    expect(s.run()).toBe(true);
    await tick();
    expect(s.disk['t1'], '元の本文が消えている').toContain('0:15 さようなら');
    expect(s.disk['t1'], '見出しが足されていない').toContain('## 字幕(SRT)');
    expect(s.disk['t1'], 'コードブロックが足されていない').toContain('```srt\n1\n00:00:00,000 --> 00:00:15,000\nこんにちは');
    expect(s.d.getState().lastAppend?.lid, '戻す材料(lastAppend)が無い').toBe('t1');
    s.d.dispatch({ type: 'UNDO_APPEND' });
    await tick(60);
    expect(s.disk['t1'], '戻しても元の本文にならない').toBe(ORIGINAL);
  });

  it('🔴 2 回目は断り(すでに埋め込み済み)、disk は変わらない', async () => {
    const s = setup();
    s.run();
    await tick();
    const after = s.disk['t1']!;
    // 開いている本文を disk の最新に合わせてから、もう 1 度
    s.d.dispatch({ type: 'BODY_LOADED', lid: 't1', body: after });
    expect(s.run()).toBe(true);
    await tick();
    expect(s.told.at(-1), '断りの理由が出ていない').toContain('すでに本文に埋め込まれています');
    expect(s.disk['t1'], '2 回目で二重に足された').toBe(after);
    expect((after.match(/```srt/g) ?? []).length).toBe(1);
  });
});
