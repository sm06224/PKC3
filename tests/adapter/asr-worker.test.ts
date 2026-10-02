/** @vitest-environment node */
/**
 * 音声認識ワーカーの**配線**(#772 段②)。中身は `asr-run.ts`(`asr-run.test.ts` が見る)。
 *
 * ⚠ **worker は node で動く**(この repo の規律)── `self` を差して実物を読み、
 *   `onmessage` が付くこと・応答の形(成功 / 失敗)を見る。
 *
 * 守りたい主張:
 *  ① 受けた依頼を実行し、`{ id, ok: true, result }` で返す
 *  ② 落ちたら `{ id, ok: false, error }` で返す(握り潰さない ── 呼び側が「この 1 件だけ」と分かる)
 *  ③ runner へ渡す口の形(blob URL は `URL.createObjectURL` で作る)
 *     ⚠ 守っていない物:`import(/* @vite-ignore *\/ url)` が実際に blob: を読めること ── node では
 *       読めない。実ブラウザ(smoke)と、scratch の実走(本物の部品で通した)が見た。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const runs: unknown[] = [];
const ctorArgs: Array<{ importModule: unknown; createObjectURL: unknown }> = [];
let nextRun: () => Promise<unknown> = () => Promise.resolve({ text: 'x', loadMs: 0, runMs: 0 });

vi.mock('../../src/adapter/platform/asr/asr-run', () => ({
  AsrRunner: class {
    constructor(deps: { importModule: unknown; createObjectURL: unknown }) {
      ctorArgs.push(deps);
    }
    run(job: unknown): Promise<unknown> {
      runs.push(job);
      return nextRun();
    }
  },
}));

interface FakeSelf {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
}

async function load(): Promise<FakeSelf> {
  const fake: FakeSelf = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal('self', fake);
  vi.resetModules();
  await import('../../src/adapter/platform/asr/asr-worker');
  return fake;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  runs.length = 0;
  ctorArgs.length = 0;
  nextRun = () => Promise.resolve({ text: 'x', loadMs: 0, runMs: 0 });
});

describe('asr-worker の配線', () => {
  it('① 依頼を実行して、id つきの成功で返す', async () => {
    const self = await load();
    expect(self.onmessage, 'onmessage を付けていない').toBeTypeOf('function');
    nextRun = () => Promise.resolve({ text: 'こんにちは', loadMs: 1, runMs: 2 });
    self.onmessage!({ data: { id: 7, payload: { modelId: 'm' } } });
    await flush();
    expect(runs).toEqual([{ modelId: 'm' }]);
    expect(self.postMessage).toHaveBeenCalledWith({
      id: 7,
      ok: true,
      result: { text: 'こんにちは', loadMs: 1, runMs: 2 },
    });
  });

  it('🔴 ② 落ちたら理由つきで返す(握り潰さない)', async () => {
    const self = await load();
    nextRun = () => Promise.reject(new Error('メモリが足りません'));
    self.onmessage!({ data: { id: 8, payload: {} } });
    await flush();
    expect(self.postMessage).toHaveBeenCalledWith({ id: 8, ok: false, error: 'メモリが足りません' });
    // Error でない値でも文にする
    nextRun = () => Promise.reject('boom');
    self.onmessage!({ data: { id: 9, payload: {} } });
    await flush();
    expect(self.postMessage).toHaveBeenCalledWith({ id: 9, ok: false, error: 'boom' });
  });

  it('③ runner へ渡す口: blob URL は URL.createObjectURL で作る', async () => {
    await load();
    expect(ctorArgs).toHaveLength(1);
    const { createObjectURL } = ctorArgs[0]! as {
      importModule: (url: string) => Promise<unknown>;
      createObjectURL: (b: Blob) => string;
    };
    const created = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', { createObjectURL: created });
    expect(createObjectURL(new Blob(['a']))).toBe('blob:x');
    expect(created).toHaveBeenCalledTimes(1);
  });
});
