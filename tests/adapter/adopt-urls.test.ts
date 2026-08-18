/**
 * 貼り付けた `data:` / `blob:` を資産にする実体(#251 の B + C。着地前レビューで
 * `main.ts` から取り出した ── あそこは原文を読む test しか持てない)。
 *
 * 🔴 守る主張:
 * 1. **整理中でも断らずに待つ** ── 断ると `blob:` は永久に失われる(貼付に picker は無い)
 * 2. **読めない**と**置けない**を分ける(後者は理由を言う)
 * 3. **画像だけ**受ける(読んでみるまで種類は分からない)
 * 4. 整理(未参照 GC)と**排他**である
 */
import { describe, expect, it, vi } from 'vitest';
import { adoptPastedUrls } from '../../src/adapter/ui/actions/adopt-urls';
import { createAssetGate } from '../../src/adapter/ui/actions/asset-gate';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { AttachDeps } from '../../src/adapter/ui/actions/attach';

const png = (size = 4): Blob => new Blob([new Uint8Array(size)], { type: 'image/png' });

function deps(over: Partial<AttachDeps> = {}) {
  const put: string[] = [];
  const attach: AttachDeps = {
    putBlob: async (key) => void put.push(key),
    putMeta: async () => {},
    listMetas: async () => [],
    hashBlob: async (blob) => `h${blob.size}`,
    ...over,
  };
  return { attach, put };
}

function harness(over: Partial<AttachDeps> = {}) {
  const d = new Dispatcher();
  const gate = createAssetGate(d);
  const { attach, put } = deps(over);
  return {
    gate,
    attach,
    put,
    run: (urls: string[], fetchBlob: (u: string) => Promise<Blob>) =>
      adoptPastedUrls(
        { gate, attach, fetchBlob, now: () => new Date('2026-08-18T14:30:05') },
        urls,
      ),
  };
}

describe('貼り付けた URL を資産にする', () => {
  it('画像を資産にして `asset:` を返す', async () => {
    const h = harness();
    const { adopted, problems } = await h.run(['data:image/png;base64,AA'], async () => png());
    expect(adopted.get('data:image/png;base64,AA')).toMatch(/^asset:/);
    expect(h.put, 'bytes を置いていない').toHaveLength(1);
    // ⚠ 余計な断りを出していない(黙って成功したのに理由が出る、を作らない)
    expect(problems).toEqual([]);
  });

  it('🔴 画像でないものは受けない(読んでみるまで種類は分からない)', async () => {
    const h = harness();
    const { adopted, problems } = await h.run(['blob:x'], async () => new Blob(['x'], { type: 'text/html' }));
    expect(adopted.size, '画像でないものを資産にした').toBe(0);
    expect(h.put).toHaveLength(0);
    // ⚠ 余計な断りを出していない(黙って成功したのに理由が出る、を作らない)
    expect(problems).toEqual([]);
  });

  it('空の bytes も受けない', async () => {
    const h = harness();
    const { adopted, problems } = await h.run(['blob:x'], async () => new Blob([], { type: 'image/png' }));
    expect(adopted.size).toBe(0);
    // ⚠ 余計な断りを出していない(黙って成功したのに理由が出る、を作らない)
    expect(problems).toEqual([]);
  });

  it('🔴 読めない 1 件で全部を失わない(その 1 件だけ元のまま)', async () => {
    const h = harness();
    const { adopted, problems } = await h.run(['blob:a', 'blob:b'], async (u) => {
      if (u === 'blob:a') throw new Error('gone');
      return png();
    });
    expect(adopted.has('blob:a'), '読めないものを資産にした').toBe(false);
    expect(adopted.get('blob:b')).toMatch(/^asset:/);
    // ⚠ 読めないだけなら**理由は言わない**(呼び側が件数で言う)
    expect(problems).toEqual([]);
  });

  it('🔴 **置けない**ときは理由を言う(空き容量を「読み込めませんでした」に畳まない)', async () => {
    const h = harness({
      estimate: async () => ({ usage: 100, quota: 100 }),
    });
    const { adopted, problems } = await h.run(['data:image/png;base64,AA'], async () => png());
    expect(adopted.size).toBe(0);
    expect(problems, '直せる原因が user に届かない').toHaveLength(1);
    expect(problems[0]).toContain('空き容量');
    // ⚠ 名前も出す ── 貼付の画像は**この文言が唯一の出口**である
    //   (添付の一覧には並ばない ── 資産だけ置いて entry は作らないため)
    expect(problems[0], 'どれが置けなかったのか分からない').toContain('貼付画像');
  });

  it('🔴 整理・取込の最中でも**断らずに待つ**(`blob:` は貼った瞬間しか読めない)', async () => {
    const h = harness();
    let release = (): void => {};
    const busy = new Promise<void>((r) => {
      release = r;
    });
    // 先に gate を掴む(整理が走っている状態)
    void h.gate(async () => busy);
    const started = h.run(['blob:a'], async () => png());
    // ⚠ まだ動いていない(排他が効いている = この test はその次元を測れている)
    await Promise.resolve();
    expect(h.put, '排他が効いていない(整理中に put した)').toHaveLength(0);
    release();
    const { adopted } = await started;
    expect(adopted.get('blob:a'), '断られて資産にならなかった(貼ったものが永久に失われる)').toMatch(
      /^asset:/,
    );
  });

  it('同じ bytes は 1 件に畳む(content addressing)', async () => {
    const h = harness();
    const { adopted, problems } = await h.run(['blob:a', 'blob:b'], async () => png());
    expect(new Set(adopted.values()).size, '同じ絵なのに別の鍵になった').toBe(1);
    expect(h.put, '同じ bytes を 2 回置いた').toHaveLength(1);
    // ⚠ 余計な断りを出していない(黙って成功したのに理由が出る、を作らない)
    expect(problems).toEqual([]);
  });

  it('空の一覧では gate を掴まない(無駄に待たせない)', async () => {
    const h = harness();
    const spy = vi.fn();
    const { adopted } = await h.run([], async () => {
      spy();
      return png();
    });
    expect(adopted.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
