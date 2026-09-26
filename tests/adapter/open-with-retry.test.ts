/** @vitest-environment node */
/**
 * 🔴 **保存先が取れなかったときに、少し待ってもう一度試す**(#811 の 3 番目)。
 *
 * 守る主張:
 * 1. 一発で取れたら**待たない**(普通の起動を 1.7 秒遅くしない)
 * 2. 落ちた回は**待って開き直す** ── 途中で取れたら**そこで止める**
 * 3. 🔴 最後まで駄目でも**投げない**(止めると iPhone が読むこともできなくなる)
 * 4. 🔴 捨てる側は**必ず閉じる**(worker を積み上げない)
 * 5. 持ち歩ける 1 枚の HTML(`retryable: false`)は**1 度も待たない**
 */
import { describe, expect, it } from 'vitest';
import {
  openStorageWithRetry,
  STORAGE_RETRY_DELAYS_MS,
} from '../../src/adapter/platform/storage/open-with-retry';

/** `vfs` を順に返す台。⚠ 開くたびに別の client を渡す(閉じ忘れが見える形)。 */
function stand(
  vfsSeq: readonly string[],
  retryable = true,
  report?: (detail: { init: { vfs: string }; tries: number }) => void,
) {
  const opened: string[] = [];
  const closed: string[] = [];
  const waited: number[] = [];
  let n = 0;
  const run = () =>
    openStorageWithRetry<string, { vfs: string }>({
      open: async () => {
        const id = `c${String(n)}`;
        const vfs = vfsSeq[Math.min(n, vfsSeq.length - 1)]!;
        n += 1;
        opened.push(id);
        return { client: id, init: { vfs } };
      },
      close: (c) => {
        closed.push(c);
      },
      wait: async (ms) => {
        waited.push(ms);
      },
      retryable,
      report,
    });
  return { run, opened, closed, waited };
}

describe('保存先の再試行(#811 の 3 番目)', () => {
  it('🔴 一発で取れたら、1 度も待たない', async () => {
    const s = stand(['opfs-sahpool']);
    const r = await s.run();
    expect(r.init.vfs).toBe('opfs-sahpool');
    expect(r.tries, '取れているのに開き直した').toBe(1);
    expect(s.waited, '普通の起動を遅くしている').toEqual([]);
    expect(s.closed, '使う相手を閉じた').toEqual([]);
  });

  it('🔴 落ちたら待って開き直し、取れたらそこで止める', async () => {
    // 1 回目 memory → 2 回目で取れる
    const s = stand(['memory', 'opfs-sahpool']);
    const r = await s.run();
    expect(r.init.vfs, '取れたのに memory を返した').toBe('opfs-sahpool');
    expect(r.tries).toBe(2);
    // ⚠ **1 回目の待ち時間だけ**待つ(取れたら残りの 2 回は待たない)
    expect(s.waited).toEqual([STORAGE_RETRY_DELAYS_MS[0]]);
    // 🔴 捨てた側は閉じる ── 返した相手(2 つ目)は閉じない
    expect(s.closed, '捨てた worker を閉じていない / 使う worker を閉じた').toEqual(['c0']);
    expect(r.client).toBe('c1');
  });

  it('🔴 最後まで取れなくても投げない ── 開いて返す', async () => {
    const s = stand(['memory']);
    const r = await s.run();
    expect(r.init.vfs, '取れないのに取れたことにした').toBe('memory');
    // 1 回 + 待つ回数ぶん
    expect(r.tries).toBe(1 + STORAGE_RETRY_DELAYS_MS.length);
    expect(s.waited, '待つ回数が表と違う').toEqual([...STORAGE_RETRY_DELAYS_MS]);
    // ⚠ **返した最後の 1 つ以外は全部閉じる**
    expect(s.closed).toEqual(s.opened.slice(0, -1));
    expect(r.client, '返した相手を閉じている').toBe(s.opened[s.opened.length - 1]);
  });

  it('🔴 持ち歩ける 1 枚の HTML は、memory でも 1 度も待たない', () => {
    // ⚠ **対照群つき** ── 同じ台で `retryable` だけを変える
    const off = stand(['memory'], false);
    const on = stand(['memory'], true);
    return Promise.all([off.run(), on.run()]).then(([a, b]) => {
      expect(a.tries, '選んだ memory で待たされた').toBe(1);
      expect(off.waited).toEqual([]);
      // 対照群 ── 規則そのものは生きている
      expect(b.tries, '落ちた回まで待たなくなった').toBeGreaterThan(1);
    });
  });

  /**
   * 🔴 **`report` は「知らせる」の判断を持つ**(#1073)。⚠ ここで殺せない変異は
   *   `main.ts` の console.error を毎回鳴らす側へ倒す ── 途中で開けた回・
   *   選んで memory の回まで「壊れて見える」ことになる。
   */
  it('🔴 途中で開けたら report を呼ばない', async () => {
    const calls: Array<{ init: { vfs: string }; tries: number }> = [];
    const s = stand(['memory', 'opfs-sahpool'], true, (d) => calls.push(d));
    await s.run();
    expect(calls, '途中で開けたのに report が呼ばれた').toEqual([]);
  });

  it('🔴 一発で取れた回も report を呼ばない', async () => {
    const calls: Array<{ init: { vfs: string }; tries: number }> = [];
    const s = stand(['opfs-sahpool'], true, (d) => calls.push(d));
    await s.run();
    expect(calls, '一発で取れたのに report が呼ばれた').toEqual([]);
  });

  it('🔴 再試行が尽きても memory のままなら、1 回だけ report を呼ぶ', async () => {
    const calls: Array<{ init: { vfs: string }; tries: number }> = [];
    const s = stand(['memory'], true, (d) => calls.push(d));
    const r = await s.run();
    expect(calls, 'report が呼ばれていない、または 2 回以上呼ばれた').toHaveLength(1);
    expect(calls[0]!.init.vfs).toBe('memory');
    expect(calls[0]!.tries).toBe(r.tries);
  });

  it('🔴 `retryable: false`(選んで memory)は report を呼ばない', async () => {
    const calls: Array<{ init: { vfs: string }; tries: number }> = [];
    const s = stand(['memory'], false, (d) => calls.push(d));
    await s.run();
    expect(calls, '選んだ memory なのに report が呼ばれた').toEqual([]);
  });

  it('⚠ 待つ間隔は伸びていく(短い解放待ちを最初の 1 回で拾う)', () => {
    const d = [...STORAGE_RETRY_DELAYS_MS];
    expect(d.length, '1 度も待たない表になっている').toBeGreaterThan(0);
    expect([...d].sort((a, b) => a - b), '間隔が伸びる順になっていない').toEqual(d);
    // ⚠ 合計は「開くのが少し遅くなる」で収まる範囲(取れない端末は毎回これを払う)
    expect(d.reduce((a, b) => a + b, 0), '待ちが長すぎる').toBeLessThanOrEqual(2000);
  });
});
