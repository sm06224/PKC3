/** @vitest-environment happy-dom */
/**
 * 🔴 **手元の画像をアプリの目印にする**(#856 段③)── 受ける / 断る の判断。
 *
 * 守る主張:
 * 1. 画像でなければ・空なら・大きすぎれば**置かずに**理由を返す(bytes を端末に残さない)
 * 2. 画像なら置いて鍵を返す
 * 3. 置くのは**資産の門の中**(整理と重ならない)。門が断ったら理由を返す
 * 4. 置く途中の失敗(空き容量など)は例外にせず、理由で返す
 */
import { describe, expect, it, vi } from 'vitest';
import {
  adoptIconFile,
  ICON_FILE_MAX_BYTES,
  type AdoptIconFileDeps,
} from '../../src/adapter/ui/actions/adopt-icon-file';

function deps(over: Record<string, unknown> = {}, gateRuns = true) {
  const putBlob = vi.fn(async (...args: [string, Blob]) => {
    void args;
  });
  const putMeta = vi.fn(async (...args: [{ key: string; mime: string; size: number; hash: string | null }]) => {
    void args;
  });
  const gate = vi.fn(async (run: () => Promise<void>) => {
    if (gateRuns) await run();
  });
  const d = {
    gate: Object.assign(gate, { queued: gate, busy: false }),
    attach: {
      putBlob,
      putMeta,
      gate,
      listStoredBlobKeys: async () => [],
      ...over,
    },
  } as unknown as AdoptIconFileDeps;
  return { d, putBlob, putMeta, gate };
}

const img = (type = 'image/png', n = 8, name = 'a.png'): File =>
  new File([new Uint8Array(n)], name, { type });

describe('手元の画像をアイコンにする(#856 段③)', () => {
  it('画像なら置いて鍵を返す', async () => {
    const { d, putBlob, putMeta } = deps();
    const got = await adoptIconFile(d, img());
    expect(got.ok).toBe(true);
    expect(got.ok && got.assetKey.length).toBeGreaterThan(0);
    expect(putBlob, 'bytes が置かれていない').toHaveBeenCalledTimes(1);
    expect(putMeta, '登録行が置かれていない').toHaveBeenCalledTimes(1);
    expect(putMeta.mock.calls[0]![0].mime).toBe('image/png');
  });

  it('画像でなければ断り、何も置かない', async () => {
    const { d, putBlob, gate } = deps();
    const got = await adoptIconFile(d, img('text/plain', 8, 'a.txt'));
    expect(got.ok).toBe(false);
    expect(!got.ok && got.why).toContain('画像ではありません');
    expect(putBlob).not.toHaveBeenCalled();
    expect(gate, '断る前に門へ入っている').not.toHaveBeenCalled();
  });

  it('空のファイルは断る', async () => {
    const { d, putBlob } = deps();
    const got = await adoptIconFile(d, img('image/png', 0));
    expect(!got.ok && got.why).toContain('空');
    expect(putBlob).not.toHaveBeenCalled();
  });

  it('大きすぎる画像は断り、上限ちょうどは受ける', async () => {
    const { d, putBlob } = deps();
    const got = await adoptIconFile(d, img('image/png', ICON_FILE_MAX_BYTES + 1));
    expect(!got.ok && got.why).toContain('大きすぎます');
    expect(putBlob).not.toHaveBeenCalled();
    const ok = await adoptIconFile(deps().d, img('image/png', ICON_FILE_MAX_BYTES));
    expect(ok.ok).toBe(true);
  });

  it('門が走らせなかったときは、待って選び直す案内を返す', async () => {
    const { d } = deps({}, false);
    const got = await adoptIconFile(d, img());
    expect(got.ok).toBe(false);
    expect(!got.ok && got.why).toContain('少し待って');
  });

  it('置く途中の失敗は例外にせず、理由で返す', async () => {
    const { d } = deps({
      putBlob: async () => {
        throw new Error('空き容量が足りません');
      },
    });
    const got = await adoptIconFile(d, img());
    expect(got.ok).toBe(false);
    expect(!got.ok && got.why).toBe('空き容量が足りません');
  });
});
