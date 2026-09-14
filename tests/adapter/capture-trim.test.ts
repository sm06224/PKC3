/** @vitest-environment happy-dom */
/**
 * 🔴 **音の切り出しの段取り**(#683 段②a。user 裁定 2026-09-14)。
 *
 * ⚠ 見るのは **user がどう受け取るか**:
 *   ①**元は残る**(裁定)②**黙って終わらない**(切り出せない形・中身が消えている・
 *   保存できない、どれも理由が出る)③**2 本同時に走らない**
 *   ④**成功したら印が消える**(同じ範囲をもう一度押して 2 つ作らせない)。
 */
import { describe, expect, it, vi } from 'vitest';
import { createCaptureTrimmer } from '../../src/adapter/ui/actions/capture-trim';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { captureItemsFrom } from '../../src/features/capture/capture-item';
import type { AudioTrimResult } from '../../src/adapter/platform/audio/audio-codec';
import type { AttachItem } from '../../src/adapter/ui/actions/attach';

const body = (name: string, mime: string): string =>
  ['---', `attachment.name: ${name}`, `attachment.mime: ${mime}`, 'attachment.size: 2048', 'attachment.asset_key: k-1', '---', ''].join('\n');

const ITEMS = (mime = 'audio/webm'): AppState['captureItems'] =>
  captureItemsFrom([{ lid: 'a', title: 'a', body: body('録音-2026-09-12-143000.webm', mime) }]);

const cut = (): AudioTrimResult => ({
  ok: true,
  bytes: new Uint8Array([1, 2, 3, 4]).buffer,
  keptPackets: 20,
  codecDelayNs: 160_000_000,
  discardPaddingNs: 40_000_000,
  durationMs: 53_000,
  sourceBytes: 38_456,
});

function harness(over: Partial<Parameters<typeof createCaptureTrimmer>[0]> = {}) {
  const dispatcher = new Dispatcher({ ...initialState, captureItems: ITEMS() } as AppState);
  const attached: AttachItem[] = [];
  const notes: string[] = [];
  const deps = {
    dispatcher,
    readBlob: vi.fn(async () => new Blob([new Uint8Array(16)], { type: 'audio/webm' })),
    trim: vi.fn(async () => cut()),
    attach: vi.fn(async (item: AttachItem) => {
      attached.push(item);
      return { lid: 'new', assetKey: 'k-2', mime: item.type, hash: 'h' };
    }),
    notify: (t: string) => void notes.push(t),
    ...over,
  };
  return { dispatcher, deps, attached, notes, trimmer: createCaptureTrimmer(deps) };
}

const error = (d: Dispatcher): string | null => d.getState().error;

describe('切り出す(成功する道)', () => {
  it('🔴 新しい添付が 1 件できる ── 名前は元 + 範囲、形は元のまま', async () => {
    const h = harness();
    await h.trimmer.run('a', 12_000, 65_000);
    expect(h.attached).toHaveLength(1);
    expect(h.attached[0]!.name).toBe('録音-2026-09-12-143000 (0:12〜1:05).webm');
    // 🔑 **元と同じ形**(裁定)── 入れ物も codec も変えないので mime も変えない
    expect(h.attached[0]!.type).toBe('audio/webm');
    expect(h.attached[0]!.size).toBe(4);
    expect(error(h.dispatcher), '成功したのに理由が出ている').toBeNull();
  });

  it('🔴 元は触らない(消しにも書きにも行かない)', async () => {
    const h = harness();
    await h.trimmer.run('a', 12_000, 65_000);
    // ⚠ 元のノートは一覧に残ったまま
    expect(h.dispatcher.getState().captureItems?.map((i) => i.lid)).toEqual(['a']);
    // ⚠ 読んだのは 1 回だけ(書き戻す口を呼んでいない)
    expect(h.deps.readBlob).toHaveBeenCalledTimes(1);
    expect(h.deps.readBlob).toHaveBeenCalledWith('k-1');
  });

  it('🔴 済んだら印が消える(同じ範囲で 2 つ作らせない)', async () => {
    const h = harness();
    h.dispatcher.dispatch({ type: 'SET_CAPTURE_PLAYING', lid: 'a' });
    h.dispatcher.dispatch({ type: 'SET_CAPTURE_TRIM_MARK', edge: 'start', ms: 12_000 });
    h.dispatcher.dispatch({ type: 'SET_CAPTURE_TRIM_MARK', edge: 'end', ms: 65_000 });
    expect(h.dispatcher.getState().captureTrim).not.toBeNull();
    await h.trimmer.run('a', 12_000, 65_000);
    expect(h.dispatcher.getState().captureTrim, '印が残っている').toBeNull();
  });

  it('⚠ 走っている間も、終わりも、声に出す', async () => {
    const h = harness();
    await h.trimmer.run('a', 12_000, 65_000);
    expect(h.notes[0]).toContain('切り出しています');
    expect(h.notes[1]).toContain('切り出しました');
    expect(h.notes[1]).toContain('(0:53)');
  });

  it('🔴 範囲はそのままワーカーへ渡る(丸めていない)', async () => {
    const h = harness();
    await h.trimmer.run('a', 12_345, 65_678);
    expect(h.deps.trim).toHaveBeenCalledWith(expect.any(Blob), 12_345, 65_678);
  });
});

describe('断る道 ── どれも黙って終わらない', () => {
  it('🔴 切り出せない形なら、その理由が出る', async () => {
    const h = harness({ trim: vi.fn(async () => ({ ok: false as const, reason: 'lacing' as const })) });
    await h.trimmer.run('a', 0, 1000);
    expect(error(h.dispatcher)).toBe('この録音は切り出しに対応していない詰め方です。');
    expect(h.deps.attach, '断ったのに添付を作っている').not.toHaveBeenCalled();
  });

  it('🔴 中身が消えていたら、そう言う', async () => {
    const h = harness({ readBlob: vi.fn(async () => null) });
    await h.trimmer.run('a', 0, 1000);
    expect(error(h.dispatcher)).toContain('中身が見つかりません');
  });

  it('🔴 保存できなかったら、そう言う(黙って消さない)', async () => {
    const h = harness({ attach: vi.fn(async () => null) });
    await h.trimmer.run('a', 0, 1000);
    expect(error(h.dispatcher)).toContain('保存できませんでした');
    expect(h.dispatcher.getState().captureTrim, '失敗したのに印を消している').toBeNull();
  });

  it('🔴 居ない録音を指されたら、そう言う', async () => {
    const h = harness();
    await h.trimmer.run('zzz', 0, 1000);
    expect(error(h.dispatcher)).toContain('見つかりませんでした');
  });

  it('🔴 範囲が決まっていなければ、決めろと言う', async () => {
    const h = harness();
    await h.trimmer.run('a', 1000, 1000);
    expect(error(h.dispatcher)).toContain('ここから');
    expect(h.deps.trim).not.toHaveBeenCalled();
  });

  it('🔴 途中で例外が飛んでも、黙らない', async () => {
    const h = harness({
      trim: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await h.trimmer.run('a', 0, 1000);
    expect(error(h.dispatcher)).toContain('切り出せませんでした');
  });

  /**
   * 🔴 **2 本同時に走らせない** ── 12 時間の録音を 2 本ほどくと箱が詰まる。
   * ⚠ そして**2 本目は断る**(黙って無視すると、押したのに何も起きないのと同じ)。
   */
  it('🔴 走っている最中の 2 本目は断る', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      trim: vi.fn(async () => {
        await gate;
        return cut();
      }),
    });
    const first = h.trimmer.run('a', 0, 1000);
    expect(h.trimmer.busy).toBe(true);
    await h.trimmer.run('a', 0, 1000);
    expect(error(h.dispatcher)).toContain('待ってください');
    release();
    await first;
    expect(h.trimmer.busy, '終わったのに錠が残っている').toBe(false);
  });

  /** 🔴 **1 度失敗しただけで、以後ずっと断るようにならない**(`finally` が効いている)。 */
  it('🔴 失敗した後も、次は走る', async () => {
    let fail = true;
    const h = harness({
      trim: vi.fn(async () => {
        if (fail) {
          fail = false;
          throw new Error('boom');
        }
        return cut();
      }),
    });
    await h.trimmer.run('a', 0, 1000);
    await h.trimmer.run('a', 12_000, 65_000);
    expect(h.attached, '2 回目が走っていない').toHaveLength(1);
  });
});
