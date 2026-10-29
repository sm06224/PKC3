/** @vitest-environment happy-dom */
/**
 * 音源分離モデルの取り込み・消去・使うときの取り出し(#674 / #949。レビュー裁定: 取り込んで残す・消せる・次からは取りに行かない)。
 *
 * 守りたい主張:
 *  ① 🔴 **2 回目からは取りに行かない**(入っていれば取得を 1 本も呼ばない)
 *  ② 🔴 無ければ取得して**端末に残す**(Blob と meta を書く)。保存に失敗しても、その 1 回は取れた Blob で動かす(理由は言う)
 *  ③ 🔴 **消せる**(両方向)。消した後は、また取得する
 *  ④ 取れなかったときは理由を値で返し、何も書かない / 二重起動は断る / 取得を止められる
 *  ⑤ 投げない
 */
import { describe, expect, it, vi } from 'vitest';
import { StemModelInstaller, stemProgressText } from '../../src/adapter/platform/stems/stem-model-install';
import type { StemModelMeta, StemModelStorePort } from '../../src/adapter/platform/stems/stem-model-store';
import { STEM_MODELS } from '../../src/features/audio/stem-model';

const model = STEM_MODELS[0]!;

function memoryStore(over: { failPut?: boolean } = {}) {
  const metas = new Map<string, StemModelMeta>();
  const blobs = new Map<string, Blob>();
  const store: StemModelStorePort = {
    readMeta: async (id) => (metas.has(id) && blobs.has(id) ? metas.get(id)! : null),
    readBlob: async (id) => blobs.get(id) ?? null,
    put: async (id, b, m) => {
      if (over.failPut) throw new Error('QuotaExceededError');
      blobs.set(id, b);
      metas.set(id, m);
    },
    remove: async (id) => {
      blobs.delete(id);
      metas.delete(id);
    },
  };
  return { store, metas, blobs };
}

const okFetch = (size = 8) =>
  vi.fn(async (_m: unknown, opts: { onProgress?: (g: number, t: number, h: string) => void }) => {
    opts.onProgress?.(size, size, 'huggingface.co');
    return { ok: true as const, blob: new Blob([new Uint8Array(size)]), url: 'https://huggingface.co/x/m.onnx' };
  });

describe('取り出し(obtain)', () => {
  it('🔴 ① 入っていれば取得を 1 本も呼ばない。② 無ければ取得して残し、次からは取らない', async () => {
    const w = memoryStore();
    const fetchModel = okFetch();
    const inst = new StemModelInstaller({ store: w.store, fetchModel, persist: async () => true, now: () => 42 });
    const first = await inst.obtain(model);
    expect(first).toMatchObject({ ok: true, fromStore: false });
    expect(fetchModel).toHaveBeenCalledTimes(1);
    expect(w.metas.get(model.id)).toEqual({ bytes: 8, url: 'https://huggingface.co/x/m.onnx', installedAt: 42 });
    expect(first.ok && first.note).toContain('端末に取り込みました');
    const second = await inst.obtain(model);
    expect(second).toMatchObject({ ok: true, fromStore: true, note: '' });
    expect(fetchModel, '2 回目に取りに行った').toHaveBeenCalledTimes(1);
  });

  it('保存を許されなかった回は、その旨を添える(黙って消えうることを黙らない)', async () => {
    const inst = new StemModelInstaller({ store: memoryStore().store, fetchModel: okFetch(), persist: async () => false });
    const r = await inst.obtain(model);
    expect(r.ok && r.note).toContain('消さずに残す');
  });

  it('🔴 保存に失敗しても(容量)、この 1 回は取れた Blob で動かす。理由は言う。入ったとは言わない', async () => {
    const w = memoryStore({ failPut: true });
    const inst = new StemModelInstaller({ store: w.store, fetchModel: okFetch(), persist: async () => true });
    const r = await inst.obtain(model);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.blob.size).toBe(8);
      expect(r.note).toContain('空き容量が足りません');
      expect(r.note).toContain('保存せずに分離');
    }
    expect(w.metas.size).toBe(0);
  });

  it('④ 取れなかったときは理由を返し、何も書かない', async () => {
    const w = memoryStore();
    const inst = new StemModelInstaller({ store: w.store, fetchModel: vi.fn(async () => ({ ok: false as const, why: 'huggingface.co につながりませんでした' })) });
    expect(await inst.obtain(model)).toEqual({ ok: false, why: 'huggingface.co につながりませんでした' });
    expect(w.metas.size + w.blobs.size).toBe(0);
    expect(inst.isRunning(), '失敗のあとも走っている扱いが残った').toBe(false);
  });

  it('④ 二重に取得しない(2 本目は断る)/ 止められる', async () => {
    let release: (() => void) | null = null;
    let seenSignal: AbortSignal | undefined;
    const fetchModel = vi.fn(async (_m: unknown, opts: { signal?: AbortSignal }) => {
      seenSignal = opts.signal;
      await new Promise<void>((r) => {
        release = r;
      });
      return { ok: false as const, why: '取得をやめました' };
    });
    const inst = new StemModelInstaller({ store: memoryStore().store, fetchModel });
    const p = inst.obtain(model);
    await new Promise((r) => setTimeout(r, 0));
    expect(inst.isRunning()).toBe(true);
    expect(await inst.obtain(model)).toMatchObject({ ok: false });
    expect(fetchModel).toHaveBeenCalledTimes(1);
    inst.cancel();
    expect(seenSignal?.aborted).toBe(true);
    release!();
    await p;
    expect(inst.isRunning()).toBe(false);
  });
});

describe('設定からの取り込み・消去(両方向)', () => {
  it('🔴 取り込む → 入っている(控えが返る)→ 取り込み済みならもう一度取得しない → 消す → 入っていない → また取れる', async () => {
    const w = memoryStore();
    const fetchModel = okFetch();
    const inst = new StemModelInstaller({ store: w.store, fetchModel, persist: async () => true });
    const progress: string[] = [];
    const a = await inst.install(model.id, (t) => progress.push(t));
    expect(a.ok && Object.keys(a.installed)).toEqual([model.id]);
    expect(progress.at(-1), '終わったら進み具合を空へ戻す').toBe('');
    expect(progress.some((t) => t.includes('100%'))).toBe(true);
    const b = await inst.install(model.id);
    expect(b.ok && b.message).toContain('取り込み済み');
    expect(fetchModel).toHaveBeenCalledTimes(1);
    const c = await inst.remove(model.id);
    expect(c).toMatchObject({ ok: true });
    expect(c.ok && c.installed).toEqual({});
    expect(await inst.readInstalled([model.id])).toEqual({});
    await inst.install(model.id);
    expect(fetchModel, '消した後は取り直す').toHaveBeenCalledTimes(2);
  });

  it('保存が通らなかった取り込みは、入ったと言わない', async () => {
    const inst = new StemModelInstaller({ store: memoryStore({ failPut: true }).store, fetchModel: okFetch(), persist: async () => true });
    const r = await inst.install(model.id);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('空き容量が足りません');
  });

  it('知らない id は断る。取得中は消せない', async () => {
    const inst = new StemModelInstaller({ store: memoryStore().store, fetchModel: okFetch() });
    expect(await inst.install('nope')).toMatchObject({ ok: false });
    expect(await inst.remove('nope')).toMatchObject({ ok: false });
  });

  it('進み具合の字: 全体が分かれば %、分からなければ byte だけ', () => {
    expect(stemProgressText(50, 100, 'h')).toContain('50%');
    expect(stemProgressText(50, 0, 'h')).not.toContain('%');
  });
});
