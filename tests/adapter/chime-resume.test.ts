/** @vitest-environment node */
/**
 * 🔴 **音を鳴らす前の `resume()` が決着しなくても、context を開いたまま残さない**(自動再生の制限下)。
 * 残すと、後から来た知らせの音が束になって鳴る。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHIME_RESUME_TIMEOUT_MS, createChime } from '../../src/adapter/platform/chime';

afterEach(() => vi.useRealTimers());

describe('chime の resume 待ち', () => {
  it('resume() が決着しないとき、上限で諦めて context を閉じ、false を返す', async () => {
    vi.useFakeTimers();
    let closed = 0;
    let created = 0;
    class FakeCtx {
      state = 'suspended';
      constructor() {
        created += 1;
      }
      resume(): Promise<void> {
        return new Promise(() => undefined);
      }
      async close(): Promise<void> {
        closed += 1;
      }
    }
    const chime = createChime(FakeCtx as never);
    let result: boolean | null = null;
    void chime.play().then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(CHIME_RESUME_TIMEOUT_MS - 1);
    expect(result, '上限の前に諦めた').toBeNull();
    expect(closed).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(result, '上限を過ぎても返らない').toBe(false);
    expect(created).toBe(1);
    expect(closed, '開いたまま残った').toBe(1);
  });

  it('対照群: resume() がすぐ決着して running になれば鳴らす(閉じるのは鳴り終わってから)', async () => {
    vi.useFakeTimers();
    let closed = 0;
    class OkCtx {
      state = 'suspended';
      currentTime = 0;
      destination = {};
      async resume(): Promise<void> {
        this.state = 'running';
      }
      async close(): Promise<void> {
        closed += 1;
      }
      createOscillator(): Record<string, unknown> {
        return { frequency: {}, start() {}, stop() {}, connect: () => ({ connect: () => undefined }) };
      }
      createGain(): Record<string, unknown> {
        return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } };
      }
    }
    const chime = createChime(OkCtx as never);
    const p = chime.play();
    await vi.advanceTimersByTimeAsync(0);
    expect(await p).toBe(true);
    expect(closed, '鳴らす前に閉じた').toBe(0);
  });
});
