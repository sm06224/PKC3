/** @vitest-environment happy-dom */
/**
 * 🔴 **文字起こしを字幕ファイル(.srt)で書き出す**(#1447 の残り「常設のボタン」)。
 *
 * 守る主張:
 * 1. 右クリック / 右の列の `export-entry-srt` が、押した行のノートの lid で `services.exportEntrySrt` へ届く
 * 2. 実体(`exportEntrySrt`)は保存した本文から `<題名>-<日付>.srt` を落とし、推定を知らせで言う
 * 3. 時刻つきの行が無い・ノートが無いときは理由を言い、何も落とさない
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { exportEntrySrt, type ExportDeps } from '../../src/adapter/ui/actions/export-archive';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';

const META = (lid: string, title: string, order: number) => ({
  lid,
  title,
  archetype: 'text',
  created_at: null,
  updated_at: null,
  entry_order: order,
  status: null,
  date: null,
  archived: 0,
});

const BODIES = new Map([
  ['t1', '## 文字起こし\n0:00 こんにちは\n0:15 **晴れ**\n'],
  ['n1', '会議は 14:00 から\n'],
]);

function rig() {
  const downloads: Array<{ name: string; blob: Blob }> = [];
  const notices: string[] = [];
  const source: ArchiveSource = {
    cid: 'c1',
    title: 'テスト',
    listEntryMetas: async () => [META('t1', '録音メモ', 1), META('n1', '普通のメモ', 2)],
    getBody: async (lid) => BODIES.get(lid) ?? null,
    listBodies: async () => ({ rows: [], done: true }),
    listRelations: async () => [],
    listAssetMetas: async () => [],
    getAssetBlob: async () => null,
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
  };
  const deps = {
    source,
    download: (name: string, blob: Blob) => downloads.push({ name, blob }),
    report: () => {},
    settle: async () => {},
    notify: (m: string) => notices.push(m),
    now: () => new Date(2026, 9, 27, 9, 0, 0),
  } as unknown as ExportDeps;
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  return { deps, d, downloads, notices };
}

describe('字幕ファイル(.srt)で書き出す(右クリック / 右の列)', () => {
  it('🔴 保存した本文から .srt を落とし、記号を外し、推定を知らせで言う', async () => {
    const r = rig();
    expect(await exportEntrySrt(r.d, r.deps, 't1')).toBe(true);
    expect(r.downloads).toHaveLength(1);
    expect(r.downloads[0]!.name).toMatch(/^録音メモ-.+\.srt$/);
    expect(r.downloads[0]!.blob.type).toBe('application/x-subrip');
    expect(await r.downloads[0]!.blob.text()).toBe(
      '1\n00:00:00,000 --> 00:00:15,000\nこんにちは\n\n2\n00:00:15,000 --> 00:00:20,000\n晴れ\n\n',
    );
    expect(r.notices.join('\n')).toContain('2 件');
    expect(r.notices.join('\n')).toContain('30 秒');
  });

  it('🔴 時刻つきの行が無いノート・無いノートは、理由を言って何も落とさない', async () => {
    const r = rig();
    expect(await exportEntrySrt(r.d, r.deps, 'n1')).toBe(false);
    expect(r.d.getState().error ?? '').toContain('時刻のある行');
    expect(await exportEntrySrt(r.d, r.deps, 'zzz')).toBe(false);
    expect(r.d.getState().error ?? '').toContain('見つかりません');
    expect(r.downloads).toHaveLength(0);
  });
});

describe('配線', () => {
  it('🔴 export-entry-srt は、選んでいるノートの lid で services.exportEntrySrt へ届く', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'export-entry-srt');
    root.append(btn);
    document.body.append(root);
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [META('t1', '録音メモ', 1) as never], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 't1' });
    const calls: string[] = [];
    bindActions(root, d, { exportEntrySrt: (lid) => calls.push(lid) });
    btn.click();
    expect(calls).toEqual(['t1']);
  });
});

describe('右の列のボタンは、時刻つきの行があるノートのときだけ見える', () => {
  it('🔴 文字起こしのあるノートでは見え、普通のノートでは畳む。本文が読み込まれるまでは畳む', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    const inspector = new InspectorRenderer(buildShell(root).inspector);
    const metas = ['t1', 'n1'].map((lid, i) => ({
      lid, title: lid, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: i + 1,
      status: null, date: null, archived: false, bodyChars: null,
    }));
    let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] }).state;
    const btn = (): HTMLButtonElement =>
      root.querySelector<HTMLButtonElement>('[data-pkc-action="export-entry-srt"]')!;
    const show = (lid: string): void => {
      s = reduce(s, { type: 'SELECT_ENTRY', lid }).state;
      inspector.render(s);
    };
    const load = (lid: string): void => {
      s = reduce(s, { type: 'BODY_LOADED', lid, body: BODIES.get(lid)! }).state;
      inspector.render(s);
    };
    show('t1');
    expect(btn(), 'ボタンそのものが無い').not.toBeNull();
    expect(btn().hidden, '本文が来る前は畳む').toBe(true);
    load('t1');
    expect(btn().hidden, '文字起こしのあるノートなのに畳まれている').toBe(false);
    show('n1');
    load('n1');
    expect(btn().hidden, '時刻の行が無いノートで見えている').toBe(true);
  });
});
