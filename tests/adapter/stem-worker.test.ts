/** @vitest-environment node */
/**
 * 歌声と楽器を分けるワーカーの**配線**(#674 / #949)。中身は `stem-run.ts`(`stem-run.test.ts` が見る)。
 *
 * 守りたい主張:
 *  ① 受けた依頼を実行し、`{ id, ok: true, result }` で返す。結果の bytes は transfer(ゼロコピー)
 *  ② 落ちたら `{ id, ok: false, error }`(握り潰さない)
 *  ③ 🔴 ORT の wasm の置き場を**明示で渡してから**使う(渡さないと既定の CDN へ取りに行く)/ ORT 自身の proxy worker は作らない
 *  ④ ORT の読み込みは 1 度だけ
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const runs: unknown[] = [];
const ctorArgs: Array<{ loadOrt: () => Promise<unknown> }> = [];
let nextRun: () => Promise<unknown> = () => Promise.resolve({ ok: true, files: [] });
const fakeOrt = { env: { wasm: { wasmPaths: undefined as unknown, proxy: true } } };

vi.mock('../../src/adapter/platform/stems/stem-run', () => ({
  StemRunner: class {
    constructor(deps: { loadOrt: () => Promise<unknown> }) {
      ctorArgs.push(deps);
    }
    run(job: unknown): Promise<unknown> {
      runs.push(job);
      return nextRun();
    }
  },
}));
vi.mock('onnxruntime-web/wasm', () => {
  return fakeOrt;
});

interface FakeSelf {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
}

async function load(): Promise<FakeSelf> {
  const fake: FakeSelf = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal('self', fake);
  vi.resetModules();
  await import('../../src/adapter/platform/stems/stem-worker');
  return fake;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  runs.length = 0;
  ctorArgs.length = 0;
  fakeOrt.env.wasm = { wasmPaths: undefined, proxy: true } as typeof fakeOrt.env.wasm;
  nextRun = () => Promise.resolve({ ok: true, files: [] });
});

describe('stem-worker の配線', () => {
  it('① 依頼を実行して、id つきの成功で返す。bytes は transfer', async () => {
    const self = await load();
    expect(self.onmessage).toBeTypeOf('function');
    const bytes = new ArrayBuffer(4);
    nextRun = () => Promise.resolve({ ok: true, files: [{ tag: '歌声', bytes, durationMs: 1 }] });
    self.onmessage!({ data: { id: 7, payload: { modelId: 'm' } } });
    await flush();
    expect(runs).toEqual([{ modelId: 'm' }]);
    const call = self.postMessage.mock.calls[0]!;
    expect(call[0]).toMatchObject({ id: 7, ok: true });
    expect(call[1]).toEqual([bytes]);
  });

  it('② 落ちたら理由つきで返す(Error でない値でも文にする)', async () => {
    const self = await load();
    nextRun = () => Promise.reject(new Error('メモリが足りません'));
    self.onmessage!({ data: { id: 8, payload: {} } });
    await flush();
    expect(self.postMessage).toHaveBeenCalledWith({ id: 8, ok: false, error: 'メモリが足りません' });
    nextRun = () => Promise.reject('boom');
    self.onmessage!({ data: { id: 9, payload: {} } });
    await flush();
    expect(self.postMessage).toHaveBeenCalledWith({ id: 9, ok: false, error: 'boom' });
  });

  it('🔴 ③ ORT の wasm / mjs の置き場を明示で渡し(CDN へ出ない)、proxy worker は作らない', async () => {
    await load();
    const loadOrt = ctorArgs[0]!.loadOrt;
    expect(fakeOrt.env.wasm.wasmPaths, '読む前は未設定').toBeUndefined();
    await loadOrt();
    const wp = fakeOrt.env.wasm.wasmPaths as { mjs: string; wasm: string };
    expect(wp.wasm).toMatch(/ort-wasm-simd-threaded.*\.wasm/);
    expect(wp.mjs).toMatch(/ort-wasm-simd-threaded.*\.mjs/);
    expect(wp.wasm.startsWith('http')).toBe(false); // 外のホストを指さない
    expect(fakeOrt.env.wasm.proxy).toBe(false);
  });

  it('④ 読み込みは 1 度だけ(2 回目の依頼で読み直さない)', async () => {
    await load();
    const loadOrt = ctorArgs[0]!.loadOrt;
    let sets = 0;
    Object.defineProperty(fakeOrt.env.wasm, 'wasmPaths', {
      configurable: true,
      set: () => {
        sets += 1;
      },
    });
    const a = await loadOrt();
    const b = await loadOrt();
    expect(a, '読み込みのたびに別の物を返した').toBe(b);
    expect(sets, '2 度目の依頼で置き場を設定し直した(読み直した)').toBe(1);
  });
});
