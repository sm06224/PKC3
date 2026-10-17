/** @vitest-environment happy-dom */
/**
 * 🔴 **動画から音だけ / 絵だけを取り出す段取り**(#952 A1。裁定済み = 元の添付は残す)。
 *
 * ⚠ 見るのは **user がどう受け取るか**:
 *   ①**元は残る**(消しにも書きにも行かない)②**元と同じフォルダへ新しい添付が 1 件増える**
 *   ③**読んでいたノートを動かさない** ④**黙って終わらない**(断る理由が出る・進行中の字が居座らない)
 *   ⑤**2 本同時に走らない**
 */
import { describe, expect, it, vi } from 'vitest';
import { createCaptureExtractor } from '../../src/adapter/ui/actions/capture-extract';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { captureItemsFrom } from '../../src/features/capture/capture-item';
import type { AudioTrimResult } from '../../src/adapter/platform/audio/audio-codec';
import type { VideoPictureResult } from '../../src/adapter/platform/video/video-codec';
import type { AttachItem } from '../../src/adapter/ui/actions/attach';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const body = (name: string, mime: string): string =>
  ['---', `attachment.name: ${name}`, `attachment.mime: ${mime}`, 'attachment.size: 2048', 'attachment.asset_key: k-1', '---', ''].join('\n');

const ITEMS = (mime = 'video/webm;codecs=vp8,opus', name = '画面収録-2026-09-12-143000.webm'): AppState['captureItems'] =>
  captureItemsFrom([{ lid: 'v', title: 'v', body: body(name, mime) }]);

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

const audioOut = (): AudioTrimResult => ({
  ok: true,
  bytes: new Uint8Array([1, 2, 3, 4, 5]).buffer,
  keptPackets: 20,
  codecDelayNs: 0,
  discardPaddingNs: 0,
  durationMs: 65_000,
  sourceBytes: 4096,
});
const pictureOut = (): VideoPictureResult => ({
  ok: true,
  blob: new Blob([new Uint8Array(8)], { type: 'video/webm' }),
  durationMs: 70_000,
  keptVideo: 100,
  droppedAudio: 90,
});

function harness(over: Partial<Parameters<typeof createCaptureExtractor>[0]> = {}, stateOver: Partial<AppState> = {}) {
  const dispatcher = new Dispatcher({
    ...initialState,
    phase: 'ready',
    entryMetas: new Map([['v', meta('v')], ['other', meta('other')]]),
    captureItems: ITEMS(),
    ...stateOver,
  } as AppState);
  const attached: { item: AttachItem; place: { parentLid: string | null; keepSelection: boolean } }[] = [];
  const notes: string[] = [];
  const deps = {
    dispatcher,
    readBlob: vi.fn(async () => new Blob([new Uint8Array(16)], { type: 'video/webm' })),
    extractAudio: vi.fn(async () => audioOut()),
    extractPicture: vi.fn(async () => pictureOut()),
    parentOf: vi.fn((lid: string) => (lid === 'v' ? 'folder-1' : null) as string | null),
    attach: vi.fn(async (item: AttachItem, place: { parentLid: string | null; keepSelection: boolean }) => {
      attached.push({ item, place });
      return { lid: 'new', assetKey: 'k-2', mime: item.type, hash: 'h' };
    }),
    notify: (t: string) => void notes.push(t),
    ...over,
  };
  return { dispatcher, deps, attached, notes, extractor: createCaptureExtractor(deps) };
}

const error = (d: Dispatcher): string | null => d.getState().error;

describe('音だけ取り出す(成功する道)', () => {
  it('🔴 新しい添付が 1 件できる ── 名前は元 + (音だけ)、形は音の webm、元と同じフォルダ、選択は動かさない', async () => {
    const h = harness();
    await h.extractor.run('v', 'audio');
    expect(h.attached).toHaveLength(1);
    const { item, place } = h.attached[0]!;
    expect(item.name).toBe('画面収録-2026-09-12-143000 (音だけ).webm');
    expect(item.type).toBe('audio/webm');
    expect(item.size).toBe(5);
    expect(item.blob.size).toBe(5);
    // 🔴 置き場は元の添付のフォルダ・読んでいるノートは動かさない
    expect(place).toEqual({ parentLid: 'folder-1', keepSelection: true });
    expect(h.deps.parentOf).toHaveBeenCalledWith('v');
    expect(error(h.dispatcher), '成功したのに理由が出ている').toBeNull();
  });

  it('🔴 元は触らない ── 元の一覧の行は残り、読んだのは 1 回、映像の取り出し口は呼ばない', async () => {
    const h = harness();
    await h.extractor.run('v', 'audio');
    expect(h.dispatcher.getState().captureItems?.map((i) => i.lid)).toEqual(['v']);
    expect(h.deps.readBlob).toHaveBeenCalledTimes(1);
    expect(h.deps.readBlob).toHaveBeenCalledWith('k-1');
    expect(h.deps.extractPicture).not.toHaveBeenCalled();
  });

  it('🔴 済んだら結果を言い、進行中の字は残さない', async () => {
    const h = harness();
    await h.extractor.run('v', 'audio');
    expect(h.notes[0]).toBe('取り出しています…');
    expect(h.notes[h.notes.length - 1]).toBe('取り出しました:「画面収録-2026-09-12-143000 (音だけ).webm」(1:05)');
  });
});

describe('絵だけ取り出す(成功する道)', () => {
  it('🔴 新しい動画の添付が 1 件できる ── 名前は元 + (絵だけ)、形は動画の webm、音の取り出し口は呼ばない', async () => {
    const h = harness();
    await h.extractor.run('v', 'picture');
    expect(h.attached).toHaveLength(1);
    const { item, place } = h.attached[0]!;
    expect(item.name).toBe('画面収録-2026-09-12-143000 (絵だけ).webm');
    expect(item.type).toBe('video/webm');
    expect(item.size).toBe(8);
    expect(place).toEqual({ parentLid: 'folder-1', keepSelection: true });
    expect(h.deps.extractAudio).not.toHaveBeenCalled();
  });

  it('ルートに置かれた元は、ルートへ置く(親が無い)', async () => {
    const h = harness({ parentOf: vi.fn(() => null) });
    await h.extractor.run('v', 'picture');
    expect(h.attached[0]!.place.parentLid).toBeNull();
  });
});

describe('黙って終わらない', () => {
  it.each([
    ['audio' as const, { ok: false as const, reason: 'not-opus' as const }, 'この動画には取り出せる音が入っていません。'],
    ['audio' as const, { ok: false as const, reason: 'broken' as const }, 'この動画は途中までしか読めませんでした。'],
  ])('音だけが断られたら理由を出し、何も作らない(%s / %s)', async (_p, refusal, text) => {
    const h = harness({ extractAudio: vi.fn(async () => refusal) });
    await h.extractor.run('v', 'audio');
    expect(error(h.dispatcher)).toBe(text);
    expect(h.attached).toHaveLength(0);
    expect(h.notes[h.notes.length - 1], '進行中の字が居座った').toBe('');
  });

  it('絵だけが断られたら理由を出し、何も作らない', async () => {
    const h = harness({ extractPicture: vi.fn(async () => ({ ok: false as const, reason: 'not-vp8' as const })) });
    await h.extractor.run('v', 'picture');
    expect(error(h.dispatcher)).toBe('この動画は取り出しに対応していない映像の形式です。');
    expect(h.attached).toHaveLength(0);
    expect(h.notes[h.notes.length - 1]).toBe('');
  });

  it('中身がもう無いときは理由を出す', async () => {
    const h = harness({ readBlob: vi.fn(async () => null) });
    await h.extractor.run('v', 'audio');
    expect(error(h.dispatcher)).toBe('この動画の中身が見つかりませんでした。');
    expect(h.deps.extractAudio).not.toHaveBeenCalled();
    expect(h.notes[h.notes.length - 1]).toBe('');
  });

  it('一覧に無い行・取り出せない形(音の添付)は、重い仕事を始めずに断る', async () => {
    const h1 = harness();
    await h1.extractor.run('nope', 'audio');
    expect(error(h1.dispatcher)).toBe('この添付が見つかりませんでした。');
    const h2 = harness({}, { captureItems: ITEMS('audio/webm', '録音.webm') });
    await h2.extractor.run('v', 'audio');
    expect(error(h2.dispatcher)).toBe('この形の動画からはまだ取り出せません。');
    expect(h2.deps.readBlob).not.toHaveBeenCalled();
  });

  it('保存できなかったときは、取り込み口が先に出した理由を塗り潰さない', async () => {
    const dispatcherRef: { d: Dispatcher | null } = { d: null };
    const h = harness({
      attach: vi.fn(async () => {
        dispatcherRef.d!.dispatch({ type: 'OP_FAILED', error: '空き容量が足りません' });
        return null;
      }),
    });
    dispatcherRef.d = h.dispatcher;
    await h.extractor.run('v', 'audio');
    expect(error(h.dispatcher)).toBe('空き容量が足りません');
    expect(h.notes[h.notes.length - 1]).toBe('');
  });

  it('保存できず理由も出ていないときは、汎用の理由を出す', async () => {
    const h = harness({ attach: vi.fn(async () => null) });
    await h.extractor.run('v', 'audio');
    expect(error(h.dispatcher)).toBe('取り出したものを保存できませんでした。');
  });

  it('途中で例外が出ても理由を出し、次の取り出しを断り続けない', async () => {
    let boom = true;
    const h = harness({
      extractAudio: vi.fn(async () => {
        if (boom) throw new Error('worker died');
        return audioOut();
      }),
    });
    await h.extractor.run('v', 'audio');
    expect(error(h.dispatcher)).toContain('取り出せませんでした');
    expect(h.extractor.busy).toBe(false);
    boom = false;
    await h.extractor.run('v', 'audio');
    expect(h.attached).toHaveLength(1);
  });
});

describe('本文に書けない間・同時に走らせない', () => {
  it('🔴 書き込めない間は仕事を始めず、理由を出す', async () => {
    const h = harness({}, { phase: 'initializing' } as Partial<AppState>);
    await h.extractor.run('v', 'audio');
    expect(error(h.dispatcher)).toContain('いま本文に書き込めない');
    expect(h.deps.readBlob).not.toHaveBeenCalled();
    expect(h.notes).toEqual([]);
  });

  it('🔴 走っている間の 2 本目は断る(黙って無視しない)。1 本目は最後まで走る', async () => {
    let release: (v: AudioTrimResult) => void = () => {};
    const gate = new Promise<AudioTrimResult>((r) => (release = r));
    const h = harness({ extractAudio: vi.fn(() => gate) });
    const first = h.extractor.run('v', 'audio');
    await vi.waitFor(() => expect(h.extractor.busy).toBe(true));
    await h.extractor.run('v', 'picture');
    expect(error(h.dispatcher)).toBe('いま別の取り出しか切り出しをしています。終わるまで待ってください。');
    expect(h.deps.extractPicture).not.toHaveBeenCalled();
    release(audioOut());
    await first;
    expect(h.attached).toHaveLength(1);
    expect(h.extractor.busy).toBe(false);
  });

  it('切り出しが走っている間も断る', async () => {
    const h = harness({}, { captureTrimBusy: true } as Partial<AppState>);
    await h.extractor.run('v', 'audio');
    expect(error(h.dispatcher)).toBe('いま別の取り出しか切り出しをしています。終わるまで待ってください。');
    expect(h.deps.readBlob).not.toHaveBeenCalled();
  });
});
