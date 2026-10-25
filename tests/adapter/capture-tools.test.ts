/** @vitest-environment happy-dom */
/**
 * 🔴 **仕上げの道具の実体**(`capture-tools.ts`)と、本文へ足す道の段取り(`capture-process.ts` の note)。
 *
 * 見るのは user がどう受け取るか:
 *   ①動画は場面の変わり目、見つからなければ無音の区切れ、どちらも無ければ理由つきで何も足さない
 *   ②足す先は元のノートの末尾(見出しつき・本文を上書きする口を使わない)
 *   ③書けない間は預かり、別のタブが編集中なら足さずに理由を言う
 */
import { describe, expect, it, vi } from 'vitest';
import { createCaptureProcessor } from '../../src/adapter/ui/actions/capture-process';
import { createCaptureTools, type CaptureToolDeps } from '../../src/adapter/ui/actions/capture-tools';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { captureItemsFrom } from '../../src/features/capture/capture-item';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { chaptersHeading } from '../../src/features/capture/chapters';

const body = (name: string, mime: string): string =>
  ['---', `attachment.name: ${name}`, `attachment.mime: ${mime}`, 'attachment.size: 2048', 'attachment.asset_key: k-1', '---', ''].join('\n');

const meta = (lid: string): EntryMeta => ({
  lid,
  title: `${lid}.webm`,
  archetype: 'attachment',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const NOW = new Date(2026, 9, 25, 10, 30);
const RATE = 16_000;

/** 秒ごとの大きさの PCM(16kHz)。 */
const pcmOf = (levels: readonly number[]): Float32Array => {
  const out = new Float32Array(levels.length * RATE);
  levels.forEach((v, s) => out.fill(v, s * RATE, (s + 1) * RATE));
  return out;
};
const rep = (v: number, n: number): number[] => Array.from({ length: n }, () => v);

function harness(opts: {
  mime?: string;
  name?: string;
  tools?: Partial<CaptureToolDeps>;
  lock?: Parameters<typeof createCaptureProcessor>[0]['lock'];
  stateOver?: Partial<AppState>;
}) {
  const dispatcher = new Dispatcher({
    ...initialState,
    phase: 'ready',
    entryMetas: new Map([['a', meta('a')]]),
    captureItems: captureItemsFrom([{ lid: 'a', title: 'a', body: body(opts.name ?? '録音.webm', opts.mime ?? 'audio/webm;codecs=opus') }]),
    ...opts.stateOver,
  } as AppState);
  const appends: Array<{ lid: string; heading: string | null; text: string }> = [];
  dispatcher.onEvent((e) => {
    if (e.type === 'REQUEST_APPEND') {
      appends.push({ lid: e.lid, heading: e.heading, text: e.text });
      const { lid, gen } = e;
      queueMicrotask(() =>
        dispatcher.dispatch({ type: 'ENTRY_APPENDED', lid, gen, body: '本文', status: null, date: null, archived: false, inserted: null }),
      );
    }
  });
  const notes: string[] = [];
  const toolDeps: CaptureToolDeps = {
    foldStill: vi.fn(async () => ({ ok: false as const, reason: 'nothing-to-fold' as const })),
    scenes: vi.fn(async () => ({ ok: true as const, startsMs: [0], sourceEndMs: 1000 })),
    decode16k: vi.fn(async () => pcmOf([...rep(0.3, 20), ...rep(0.001, 3), ...rep(0.3, 20)])),
    now: () => NOW,
    ...opts.tools,
  };
  const deps = {
    dispatcher,
    readBlob: vi.fn(async () => new Blob([new Uint8Array(16)])),
    readBody: vi.fn(async () => null as string | null),
    tools: createCaptureTools(toolDeps),
    parentOf: vi.fn(() => null as string | null),
    attach: vi.fn(async () => null),
    notify: (t: string) => void notes.push(t),
    lock: opts.lock,
  };
  const real = createCaptureProcessor(deps);
  const run = async (tool: Parameters<typeof real.run>[1]): Promise<void> => {
    await real.run('a', tool);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { dispatcher, toolDeps, appends, notes, run, real, deps };
}

describe('チャプター(音)', () => {
  it('🔴 無音の区切れで刻み、元のノートの末尾に見出しつきで足す', async () => {
    const h = harness({});
    await h.run('chapters');
    expect(h.appends).toEqual([
      { lid: 'a', heading: chaptersHeading(NOW), text: '0:00 チャプター 1\n0:23 チャプター 2' },
    ]);
    expect(h.dispatcher.getState().error).toBeNull();
    expect(h.notes.at(-1)).toBe('「録音.webm」に2 件のチャプターを足しました');
    expect(h.toolDeps.scenes, '音の添付で映像の走査をしている').not.toHaveBeenCalled();
  });

  it('🔴 区切れが無い音は何も足さず、理由を出す', async () => {
    const h = harness({ tools: { decode16k: vi.fn(async () => pcmOf(rep(0.3, 40))) } });
    await h.run('chapters');
    expect(h.appends).toHaveLength(0);
    expect(h.dispatcher.getState().error).toMatch(/チャプターに分けられる所が見つかりませんでした.*ノートは変えていません/);
  });

  it('読めない音は理由つきで断る(例外にしない)', async () => {
    const h = harness({ tools: { decode16k: vi.fn(async () => { throw new Error('bad'); }) } });
    await h.run('chapters');
    expect(h.appends).toHaveLength(0);
    expect(h.dispatcher.getState().error).toContain('この音を読み取れませんでした');
  });
});

describe('チャプター(動画)', () => {
  const VIDEO = { mime: 'video/webm;codecs=vp8,opus', name: '画面録画.webm' };

  it('🔴 場面の変わり目があればそれを使い、音は復号しない', async () => {
    const h = harness({ ...VIDEO, tools: { scenes: vi.fn(async () => ({ ok: true as const, startsMs: [0, 15_000, 3_723_000], sourceEndMs: 4_000_000 })) } });
    await h.run('chapters');
    expect(h.appends[0]!.text).toBe('0:00 チャプター 1\n0:15 チャプター 2\n1:02:03 チャプター 3');
    expect(h.toolDeps.decode16k).not.toHaveBeenCalled();
  });

  it('🔴 場面が見つからない動画は、音の無音の区切れに回る', async () => {
    const h = harness({ ...VIDEO });
    await h.run('chapters');
    expect(h.toolDeps.scenes).toHaveBeenCalledTimes(1);
    expect(h.toolDeps.decode16k).toHaveBeenCalledTimes(1);
    expect(h.appends[0]!.text).toContain('0:23 チャプター 2');
  });

  it('動画が読めなければ理由を出して止まる(音には回らない)', async () => {
    const h = harness({ ...VIDEO, tools: { scenes: vi.fn(async () => ({ ok: false as const, reason: 'broken' as const })) } });
    await h.run('chapters');
    expect(h.dispatcher.getState().error).toBe('この動画は途中までしか読めませんでした。');
    expect(h.toolDeps.decode16k).not.toHaveBeenCalled();
  });
});

describe('本文へ足す道の段取り', () => {
  it('🔴 別のタブが編集中なら足さず、「足しました」とも言わず、理由を言う', async () => {
    const h = harness({ lock: { acquireEditLock: async () => 'denied' } });
    await h.run('chapters');
    expect(h.appends).toEqual([]);
    expect(h.notes.some((t) => t.includes('足しました'))).toBe(false);
    expect(h.notes.at(-1)).toMatch(/別のタブまたはウィンドウで編集中なので足していません/);
    expect(h.real.busy).toBe(false);
  });

  it('🔴 書込中(錠が立っている)は預かり、そう言い、解けたら足す。捨てない', async () => {
    const h = harness({ stateOver: { writeLock: { lid: 'other' } } as unknown as Partial<AppState> });
    await h.run('chapters');
    expect(h.appends, '書けないのに足した').toEqual([]);
    expect(h.notes.at(-1)).toMatch(/編集中なのでまだ足していません/);
    h.dispatcher.dispatch({ type: 'FORCE_RELEASE_LOCK', discardDraft: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.appends, '解けても足されない(預かりを捨てた)').toHaveLength(1);
    expect(h.appends[0]!.lid).toBe('a');
  });
});
