import { describe, expect, it, vi } from 'vitest';
import { retryableImport } from '../../src/adapter/platform/render/retryable-import';
import { DeviceRenderError } from '../../src/adapter/ui/render/mermaid-raster';

describe('retryableImport (#1087)', () => {
  it('失敗は覚えない: 1 回目が落ちても 2 回目は読みに行き、成功した値を返す', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
      .mockResolvedValue('ok');
    const get = retryableImport(load, () => new Error('部品'));
    await expect(get()).rejects.toThrow('部品');
    await expect(get()).resolves.toBe('ok');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('成功したら使い回す(読みに行くのは 1 回)', async () => {
    const load = vi.fn(async () => 'v');
    const get = retryableImport(load, () => new Error('x'));
    await get();
    await get();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('生の例外を画面に出す Error へ包み直す(原因の英語を出さない)', async () => {
    const get = retryableImport(
      () => Promise.reject(new Error('Failed to fetch')),
      () => new DeviceRenderError('図を描くためのライブラリを読み込めませんでした(ページを再読み込みしてください)'),
    );
    const e = await get().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DeviceRenderError);
    expect((e as Error).message).not.toContain('Failed');
  });
});
