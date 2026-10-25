/** @vitest-environment happy-dom */
/**
 * sandbox の箱を「ワーカー」として貸し出す(#528 ①)。
 *
 * 守る主張:
 * 1. 箱は `sandbox="allow-scripts"` のみ(`allow-same-origin` 無し)で、画面の外に置かれる
 * 2. 箱の準備が済むまで依頼を溜め、済んだら**まとめて**流す(落とさない)
 * 3. 送り主は `event.source === contentWindow` だけで決める(別の窓の「返事」を受けない)
 * 4. 返事が来ない依頼は箱ごと捨てる(`onerror` → `WorkerLease` が待ちを reject する)
 * 5. `terminate()` で箱が DOM から外れ、window の listener も外れる(メモリを手放す)
 * 6. `WorkerLease` と繋いだとき:遅延起動 / アイドルで箱が外れる / dispose で待ちが reject される
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameWorker } from '../../src/adapter/platform/render/frame-worker';
import { WorkerLease } from '../../src/adapter/platform/worker-lease';

const frames = (): HTMLIFrameElement[] => [...document.querySelectorAll<HTMLIFrameElement>('iframe[data-pkc-frame-worker]')];
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 箱の中の窓の代わり。受けた依頼を溜める。 */
function fakeWindow(): { win: Window; got: unknown[] } {
  const got: unknown[] = [];
  return { win: { postMessage: (m: unknown) => void got.push(m) } as unknown as Window, got };
}

function fromBox(source: unknown, data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, source: source as MessageEventSource }));
}

afterEach(() => {
  for (const f of frames()) f.remove();
});

async function boxed(opts: Partial<ConstructorParameters<typeof FrameWorker>[0]> = {}) {
  const w = new FrameWorker({ srcdoc: () => Promise.resolve('<p>x</p>'), ...opts });
  await flush();
  const f = frames()[0]!;
  const fake = fakeWindow();
  Object.defineProperty(f, 'contentWindow', { value: fake.win, configurable: true });
  return { w, f, fake };
}

describe('箱のワーカー', () => {
  it('🔴 sandbox は allow-scripts のみ。画面の外・読み上げ対象外', async () => {
    const { f, w } = await boxed();
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(f.getAttribute('aria-hidden')).toBe('true');
    expect(f.style.visibility).toBe('hidden');
    expect(f.srcdoc).toBe('<p>x</p>');
    w.terminate();
  });

  it('🔴 準備が済むまで依頼を溜め、済んだらまとめて流す', async () => {
    const { w, f, fake } = await boxed();
    w.postMessage({ id: 1, payload: 'a' });
    w.postMessage({ id: 2, payload: 'b' });
    expect(fake.got, '準備前に流している').toHaveLength(0);
    fromBox(f.contentWindow, { ready: true });
    expect(fake.got.map((m) => (m as { id: number }).id)).toEqual([1, 2]);
    w.postMessage({ id: 3, payload: 'c' });
    expect(fake.got, '準備後は直に流れる').toHaveLength(3);
    w.terminate();
  });

  it('🔴 送り主が箱でない返事は受けない / 箱の返事は届く', async () => {
    const { w, f } = await boxed();
    const seen: unknown[] = [];
    w.onmessage = (ev) => void seen.push(ev.data);
    fromBox(f.contentWindow, { ready: true });
    fromBox(window, { id: 1, ok: true, result: 'evil' });
    fromBox(fakeWindow().win, { id: 1, ok: true, result: 'evil2' });
    expect(seen, '別の窓の返事を受けた').toHaveLength(0);
    fromBox(f.contentWindow, { id: 1, ok: true, result: 'good' });
    expect(seen).toEqual([{ id: 1, ok: true, result: 'good' }]);
    w.terminate();
  });

  it('🔴 返事が来ない依頼は onerror(箱ごと捨てるための合図)', async () => {
    vi.useFakeTimers();
    try {
      const w = new FrameWorker({ srcdoc: () => Promise.resolve('<p/>'), jobTimeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      const f = frames()[0]!;
      Object.defineProperty(f, 'contentWindow', { value: fakeWindow().win, configurable: true });
      const errors: string[] = [];
      w.onerror = (ev) => void errors.push(ev.message);
      fromBox(f.contentWindow, { ready: true });
      w.postMessage({ id: 1, payload: 'a' });
      await vi.advanceTimersByTimeAsync(999);
      expect(errors).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(errors).toHaveLength(1);
      w.terminate();
    } finally {
      vi.useRealTimers();
    }
  });

  it('🔴 返事が来た依頼の見張りは外れる(後から誤って箱を捨てない)', async () => {
    vi.useFakeTimers();
    try {
      const w = new FrameWorker({ srcdoc: () => Promise.resolve('<p/>'), jobTimeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      const f = frames()[0]!;
      Object.defineProperty(f, 'contentWindow', { value: fakeWindow().win, configurable: true });
      const errors: string[] = [];
      w.onerror = (ev) => void errors.push(ev.message);
      w.onmessage = () => undefined;
      fromBox(f.contentWindow, { ready: true });
      w.postMessage({ id: 1, payload: 'a' });
      fromBox(f.contentWindow, { id: 1, ok: true, result: 1 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(errors).toHaveLength(0);
      w.terminate();
    } finally {
      vi.useRealTimers();
    }
  });

  it('🔴 terminate で箱が DOM から外れ、以後の返事も依頼も無視する', async () => {
    const { w, f, fake } = await boxed();
    const seen: unknown[] = [];
    w.onmessage = (ev) => void seen.push(ev.data);
    w.terminate();
    expect(frames(), '箱が残っている').toHaveLength(0);
    expect(f.isConnected).toBe(false);
    fromBox(fake.win, { id: 1, ok: true });
    w.postMessage({ id: 9, payload: 1 });
    expect(seen).toHaveLength(0);
    expect(fake.got).toHaveLength(0);
  });

  it('🔴 ready が来ない箱は、上限で onerror(溜めた依頼を永久に待たせない)/ ready が来れば畳む', async () => {
    vi.useFakeTimers();
    try {
      const w = new FrameWorker({ srcdoc: () => Promise.resolve('<p/>'), readyTimeoutMs: 1000, jobTimeoutMs: 99999 });
      await vi.advanceTimersByTimeAsync(0);
      const errors: string[] = [];
      w.onerror = (ev) => void errors.push(ev.message);
      w.postMessage({ id: 1, payload: 'a' }); // ready 前に溜まる
      await vi.advanceTimersByTimeAsync(999);
      expect(errors).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(errors, 'ready が来ないのに待ち続けている').toHaveLength(1);
      expect(errors[0]).toContain('起動しませんでした');
      w.terminate();
      expect(frames()).toHaveLength(0);

      // 対照群: ready が来た箱は、上限を過ぎても捨てない
      const ok = new FrameWorker({ srcdoc: () => Promise.resolve('<p/>'), readyTimeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      const f = frames()[0]!;
      Object.defineProperty(f, 'contentWindow', { value: fakeWindow().win, configurable: true });
      const errors2: string[] = [];
      ok.onerror = (ev) => void errors2.push(ev.message);
      fromBox(f.contentWindow, { ready: true });
      await vi.advanceTimersByTimeAsync(5000);
      expect(errors2).toHaveLength(0);
      ok.terminate();
    } finally {
      vi.useRealTimers();
    }
  });

  it('🔴 ready が来ない箱を WorkerLease が捨て、待っている依頼を reject する', async () => {
    vi.useFakeTimers();
    try {
      const lease = new WorkerLease({
        name: 'plotly',
        spawn: () => new FrameWorker({ srcdoc: () => Promise.resolve('<p/>'), readyTimeoutMs: 1000 }) as unknown as Worker,
      });
      const p = lease.run({ x: 1 });
      const assertion = expect(p).rejects.toThrow('起動しませんでした');
      await vi.advanceTimersByTimeAsync(1500);
      await assertion;
      expect(frames(), '失敗した箱が残っている').toHaveLength(0);
      expect(lease.busy).toBe(0);
      lease.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('箱の中身を作れなかったら onerror', async () => {
    const w = new FrameWorker({ srcdoc: () => Promise.reject(new Error('chunk 404')) });
    const errors: string[] = [];
    w.onerror = (ev) => void errors.push(ev.message);
    await flush();
    await flush();
    expect(errors).toEqual(['chunk 404']);
    expect(frames()).toHaveLength(0);
    w.terminate();
  });
});

describe('WorkerLease と繋ぐ(同じ機構を使う)', () => {
  function leaseWith(timers: Array<() => void>) {
    let made = 0;
    const lease = new WorkerLease({
      name: 'plotly',
      idleMs: 1000,
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: (h) => {
        timers[(h as number) - 1] = () => undefined;
      },
      spawn: () => {
        made += 1;
        return new FrameWorker({ srcdoc: () => Promise.resolve('<p/>') }) as unknown as Worker;
      },
    });
    return { lease, made: () => made };
  }

  it('🔴 遅延起動 → 依頼を溜めて流す → 返事で解決 → アイドルで箱が外れる → 次の依頼で作り直す', async () => {
    const timers: Array<() => void> = [];
    const { lease, made } = leaseWith(timers);
    expect(frames(), '使う前に箱がある').toHaveLength(0);
    const p = lease.run<string>({ x: 1 });
    await flush();
    expect(made()).toBe(1);
    const f = frames()[0]!;
    const fake = fakeWindow();
    Object.defineProperty(f, 'contentWindow', { value: fake.win, configurable: true });
    fromBox(fake.win, { ready: true });
    expect(fake.got).toHaveLength(1);
    const env = fake.got[0] as { id: number; payload: unknown };
    expect(env.payload).toEqual({ x: 1 });
    fromBox(fake.win, { id: env.id, ok: true, result: 'done' });
    await expect(p).resolves.toBe('done');
    // アイドル
    expect(timers.length).toBeGreaterThan(0);
    timers[timers.length - 1]!();
    expect(frames(), 'アイドルで箱が外れていない').toHaveLength(0);
    void lease.run({ x: 2 }).catch(() => undefined);
    await flush();
    expect(made(), '外れた後の依頼で作り直していない').toBe(2);
    lease.dispose();
  });

  it('🔴 dispose は待っている依頼を reject し、箱を外す', async () => {
    const { lease } = leaseWith([]);
    const p = lease.run({ x: 1 });
    await flush();
    const assertion = expect(p).rejects.toThrow('disposed');
    lease.dispose();
    await assertion;
    expect(frames()).toHaveLength(0);
  });
});
