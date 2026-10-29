/** @vitest-environment happy-dom */
/**
 * 🔴 **録ったものを仕上げる段取り**(#952 A2・A4・A5・B1・B4・B5・B6、#674)。
 *
 * 見るのは **user がどう受け取るか**:
 *   ①元は残る ②結果は元と同じフォルダへ新しい添付 ③読んでいたノートを動かさない
 *   ④黙って終わらない(断る理由が出る・進行中の字が居座らない)⑤2 本同時に走らない
 *   ⑥本文へ足す道具は、書けないとき預かる(捨てない)
 */
import { describe, expect, it, vi } from 'vitest';
import { createCaptureProcessor, type ToolRunner } from '../../src/adapter/ui/actions/capture-process';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { captureItemsFrom } from '../../src/features/capture/capture-item';
import { canProcess, PROCESS_TOOLS, processedCaptureName } from '../../src/features/capture/capture-process';
import type { AttachItem } from '../../src/adapter/ui/actions/attach';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const body = (name: string, mime: string, extra = ''): string =>
  ['---', `attachment.name: ${name}`, `attachment.mime: ${mime}`, 'attachment.size: 2048', 'attachment.asset_key: k-1', '---', extra].join('\n');

const itemsOf = (mime = 'video/webm;codecs=vp8,opus', name = '画面録画-2026-09-12-143000.webm', extra = ''): AppState['captureItems'] =>
  captureItemsFrom([{ lid: 'v', title: 'v', body: body(name, mime, extra) }]);

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

function harness(tools: Parameters<typeof createCaptureProcessor>[0]['tools'], stateOver: Partial<AppState> = {}) {
  const dispatcher = new Dispatcher({
    ...initialState,
    phase: 'ready',
    entryMetas: new Map([['v', meta('v')]]),
    captureItems: itemsOf(),
    ...stateOver,
  } as AppState);
  const attached: { item: AttachItem; place: { parentLid: string | null; keepSelection: boolean } }[] = [];
  const notes: string[] = [];
  const deps = {
    dispatcher,
    readBlob: vi.fn(async () => new Blob([new Uint8Array(16)], { type: 'video/webm' })),
    readBody: vi.fn(async () => null as string | null),
    tools,
    parentOf: vi.fn((lid: string) => (lid === 'v' ? 'folder-1' : null) as string | null),
    attach: vi.fn(async (item: AttachItem, place: { parentLid: string | null; keepSelection: boolean }) => {
      attached.push({ item, place });
      return { lid: 'new', assetKey: 'k-2', mime: item.type, hash: 'h' };
    }),
    notify: (t: string) => void notes.push(t),
  };
  return { dispatcher, deps, attached, notes, processor: createCaptureProcessor(deps) };
}

const attachTool: ToolRunner = async () => ({
  kind: 'attach',
  items: [{ tag: '静止区間をまとめた', blob: new Blob([new Uint8Array(8)], { type: 'video/webm' }), mime: 'video/webm' }],
  summary: 'まとめました',
});

describe('道具の表と門(canProcess)', () => {
  it('表の id は重複せず、押し所の字は全部違う', () => {
    expect(new Set(PROCESS_TOOLS.map((t) => t.id)).size).toBe(PROCESS_TOOLS.length);
    expect(new Set(PROCESS_TOOLS.map((t) => t.label)).size).toBe(PROCESS_TOOLS.length);
  });

  it('🔴 形ごとに出し分ける ── 動画(VP8)・opus の動画・音・VP9 の動画・中身の無い行', () => {
    const vp8 = itemsOf('video/webm;codecs=vp8,opus')![0]!;
    const vp9 = itemsOf('video/webm;codecs=vp9,opus')![0]!;
    const audio = itemsOf('audio/webm;codecs=opus', '録音.webm')![0]!;
    const mp4 = itemsOf('audio/mp4', '録音.m4a')![0]!;
    const ids = (item: typeof vp8): string[] => PROCESS_TOOLS.filter((t) => canProcess(item, t.id)).map((t) => t.id);
    expect(ids(vp8)).toEqual(['fold-still', 'contact-sheet', 'denoise', 'separate', 'separate-stems', 'balance', 'chapters', 'speakers']);
    expect(ids(vp9)).toEqual(['denoise', 'separate', 'separate-stems', 'balance', 'chapters', 'speakers']); // 映像を触る道具は出ない
    expect(ids(audio)).toEqual(['denoise', 'separate', 'separate-stems', 'balance', 'chapters', 'speakers']);
    expect(ids(mp4), 'mp4 でも聞ける音の分析系は出す(復号はブラウザ)').toContain('denoise');
    expect(canProcess({ ...vp8, assetKey: null }, 'fold-still')).toBe(false);
    // 話者を直すは、本文に話者の一覧があるときだけ
    expect(canProcess(audio, 'fix-speakers')).toBe(false);
    expect(canProcess(audio, 'fix-speakers', true)).toBe(true);
  });

  it('本文に「## 話者」の見出しがあるときだけ hasSpeakers が立つ', () => {
    expect(itemsOf(undefined, undefined, '## 話者 2026-10-25 10:00\n- 0:00 話者A')![0]!.hasSpeakers).toBe(true);
    expect(itemsOf(undefined, undefined, '## 話者つき文字起こし\n')![0]!.hasSpeakers).toBe(false);
    expect(itemsOf()![0]!.hasSpeakers).toBe(false);
  });

  it('名前は拡張子の前に入る(拡張子の差し替えもできる)', () => {
    expect(processedCaptureName('録画.webm', '静止区間をまとめた')).toBe('録画 (静止区間をまとめた).webm');
    expect(processedCaptureName('録画', '静止区間をまとめた')).toBe('録画 (静止区間をまとめた)');
    expect(processedCaptureName('録画.webm', 'コンタクトシート', 'png')).toBe('録画 (コンタクトシート).png');
  });
});

describe('添付を作る道具の段取り', () => {
  it('🔴 新しい添付が 1 件できる ── 名前は元 + 語、元と同じフォルダ、選択は動かさない、元は残る', async () => {
    const h = harness({ 'fold-still': attachTool });
    await h.processor.run('v', 'fold-still');
    expect(h.attached).toHaveLength(1);
    expect(h.attached[0]!.item.name).toBe('画面録画-2026-09-12-143000 (静止区間をまとめた).webm');
    expect(h.attached[0]!.item.type).toBe('video/webm');
    expect(h.attached[0]!.place).toEqual({ parentLid: 'folder-1', keepSelection: true });
    expect(h.dispatcher.getState().captureItems?.map((i) => i.lid)).toEqual(['v']);
    expect(h.deps.readBlob).toHaveBeenCalledWith('k-1');
    expect(h.dispatcher.getState().error).toBeNull();
    expect(h.notes[0]).toBe('静止している区間を探しています…');
    expect(h.notes[h.notes.length - 1]).toBe('まとめました:「画面録画-2026-09-12-143000 (静止区間をまとめた).webm」');
  });

  it('複数の添付を返す道具は、全部を順に保存する', async () => {
    const two: ToolRunner = async () => ({
      kind: 'attach',
      items: [
        { tag: '話し声', blob: new Blob([new Uint8Array(2)]), mime: 'audio/webm' },
        { tag: '伴奏', blob: new Blob([new Uint8Array(3)]), mime: 'audio/webm' },
      ],
      summary: '分けました',
    });
    const h = harness({ separate: two });
    await h.processor.run('v', 'separate');
    expect(h.attached.map((a) => a.item.name)).toEqual([
      '画面録画-2026-09-12-143000 (話し声).webm',
      '画面録画-2026-09-12-143000 (伴奏).webm',
    ]);
  });

  it('🔴 断りは理由を出し、何も作らない。進行中の字は残らない', async () => {
    const h = harness({ 'fold-still': async () => ({ kind: 'refused', text: 'まとめられる静止区間がありませんでした' }) });
    await h.processor.run('v', 'fold-still');
    expect(h.attached).toHaveLength(0);
    expect(h.dispatcher.getState().error).toBe('まとめられる静止区間がありませんでした');
    expect(h.notes[h.notes.length - 1]).toBe('');
  });

  it('🔴 例外は理由つきで出し、busy を解く(次の押下が通る)', async () => {
    let n = 0;
    const flaky: ToolRunner = async (c) => {
      n += 1;
      if (n === 1) throw new Error('boom');
      return attachTool(c);
    };
    const h = harness({ 'fold-still': flaky });
    await h.processor.run('v', 'fold-still');
    expect(h.dispatcher.getState().error).toContain('boom');
    expect(h.processor.busy).toBe(false);
    await h.processor.run('v', 'fold-still');
    expect(h.attached).toHaveLength(1);
  });

  it('🔴 2 本同時には走らせず、2 本目は理由つきで断る', async () => {
    let release!: () => void;
    const slow: ToolRunner = (c) => new Promise((res) => { release = () => res({ kind: 'refused', text: 'x' }); void c; });
    const h = harness({ 'fold-still': slow });
    const first = h.processor.run('v', 'fold-still');
    await Promise.resolve();
    await Promise.resolve();
    expect(h.processor.busy).toBe(true);
    await h.processor.run('v', 'fold-still');
    expect(h.dispatcher.getState().error).toContain('別の仕上げか切り出し');
    release();
    await first;
    expect(h.processor.busy).toBe(false);
  });

  it('中身が無い・実体が配線されていない・使えない形は、理由を出して始めない', async () => {
    const h = harness({ 'fold-still': attachTool });
    await h.processor.run('v', 'denoise');
    expect(h.dispatcher.getState().error).toContain('古い');
    const h2 = harness({ 'fold-still': attachTool }, { captureItems: itemsOf('video/webm;codecs=vp9,opus') });
    await h2.processor.run('v', 'fold-still');
    expect(h2.dispatcher.getState().error).toContain('この形の動画にはまだ使えません');
    expect(h2.deps.readBlob).not.toHaveBeenCalled();
    const h3 = harness({ 'fold-still': attachTool });
    h3.deps.readBlob.mockResolvedValueOnce(null as unknown as Blob);
    await h3.processor.run('v', 'fold-still');
    expect(h3.dispatcher.getState().error).toContain('中身が見つかりません');
  });
});
