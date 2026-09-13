/** @vitest-environment happy-dom */
/**
 * 🔴 **IDB の絵を `<img>` に差して、寿命の終わりに返す**(#856 段②)。
 *
 * 🔴 守る主張:
 * 1. 差す(借りた URL が `src` に入る)
 * 2. ⚠ **生きている貸出を使い回す**(組み直すたびに借り直さない)
 * 3. 🔴 **使い回した新しい `<img>` は、古い `<img>` が消えても死なない**
 *    (本文の面が 2026-08-18 に踏んだ形 ── `els` に足し忘れると src が死ぬ)
 * 4. 画面から消えたら**返す**(不可侵指示 2026-07-27)
 * 5. ⚠ 借りている間に画面が変わったら、**戻ってきた瞬間に返す**
 * 6. 借りられなかったら**黙らず印を残す**
 */
import { describe, expect, it, vi } from 'vitest';
import { AssetLends } from '../../src/adapter/ui/render/asset-lends';

/**
 * ⚠ `dispose` が**呼ばれたこと**を数える(返したかどうかが、この file の主題)。
 * ⚠ 返す型に注釈を書かない ── `vi.fn` の型を `ReturnType<typeof vi.fn>` で受けると
 *   **引数と戻り値が消える**ので、`AssetLender` に渡せなくなる(tsc が落ちる)。
 */
function fakeLender(opts: { missing?: ReadonlySet<string> } = {}) {
  const disposed: string[] = [];
  let n = 0;
  const lend = vi.fn(async (key: string) => {
    if (opts.missing?.has(key) === true) return null;
    n += 1;
    const url = `blob:${key}#${String(n)}`;
    return { url, dispose: () => disposed.push(url) };
  });
  // ⚠ この file が使うのは `lend` だけだが、型を満たすために置く(甘い stub にしない)
  const getBlob = vi.fn((): Promise<Blob | null> => Promise.resolve(null));
  return { lender: { lend, getBlob }, disposed };
}

/** 鍵を持つ `<img>` を N 枚積んだ器。 */
function host(...keys: string[]): HTMLElement {
  const box = document.createElement('div');
  for (const k of keys) {
    const img = document.createElement('img');
    img.setAttribute('data-pkc-asset-key', k);
    box.append(img);
  }
  document.body.append(box);
  return box;
}

const imgsOf = (box: HTMLElement): HTMLImageElement[] => [...box.querySelectorAll('img')];

describe('借りて差す(#856 段②)', () => {
  it('🔴 借りた URL が src に入る', async () => {
    const f = fakeLender();
    const box = host('a');
    await new AssetLends().hydrate(box, f.lender);
    expect(imgsOf(box)[0]!.src, '差していない').toBe('blob:a#1');
  });

  it('⚠ 鍵を持たない img は触らない(空振り防止)', async () => {
    const f = fakeLender();
    const box = document.createElement('div');
    box.append(document.createElement('img'));
    document.body.append(box);
    await new AssetLends().hydrate(box, f.lender);
    expect(f.lender.lend, '鍵の無い img まで借りにいった').not.toHaveBeenCalled();
  });

  it('🔴 借りられなければ、黙らず印を残す', async () => {
    const f = fakeLender({ missing: new Set(['x']) });
    const box = host('x');
    await new AssetLends().hydrate(box, f.lender);
    expect(imgsOf(box)[0]!.hasAttribute('data-pkc-asset-missing'), '無いことを言っていない').toBe(true);
  });
});

describe('使い回しと返却(#856 段②)', () => {
  it('⚠ 組み直しても、同じ鍵はもう一度借りない', async () => {
    const f = fakeLender();
    const lends = new AssetLends();
    const box = host('a');
    await lends.hydrate(box, f.lender);
    // 組み直す ── 古い img は器に残したまま、新しい img を足す(生きている貸出が在る形)
    const again = document.createElement('img');
    again.setAttribute('data-pkc-asset-key', 'a');
    box.append(again);
    await lends.hydrate(box, f.lender);
    expect(f.lender.lend, '生きている貸出を使い回していない').toHaveBeenCalledTimes(1);
    expect(again.src, '使い回した URL を差していない').toBe('blob:a#1');
  });

  /**
   * 🔴 **この test がこの file の本題である。**
   * ⚠ 使い回した `<img>` を貸出の `els` に足し忘れると、古い `<img>` が消えた瞬間に
   *   `prune` が返してしまい、**画面に出ている新しい `<img>` の src が死ぬ**。
   */
  it('🔴 使い回した新しい img は、古い img が消えても生きている', async () => {
    const f = fakeLender();
    const lends = new AssetLends();
    const box = host('a');
    await lends.hydrate(box, f.lender);
    const old = imgsOf(box)[0]!;

    const fresh = document.createElement('img');
    fresh.setAttribute('data-pkc-asset-key', 'a');
    box.append(fresh);
    await lends.hydrate(box, f.lender);
    // 前提 ── 2 枚が同じ URL を差している(ここが崩れると以降は何も見ていない)
    expect(fresh.src, '前提が崩れている').toBe(old.src);

    old.remove(); // 古いほうだけ画面から消える
    lends.prune();
    expect(f.disposed, '画面に残っている絵まで返した').toEqual([]);
    expect(lends.size, '貸出が消えた').toBe(1);
  });

  it('🔴 画面から全部消えたら返す', async () => {
    const f = fakeLender();
    const lends = new AssetLends();
    const box = host('a');
    await lends.hydrate(box, f.lender);
    box.remove();
    lends.prune();
    expect(f.disposed, '返していない(画面に無い絵の bytes が残る)').toEqual(['blob:a#1']);
    expect(lends.size).toBe(0);
  });

  it('🔴 借りている間に画面が変わったら、戻ってきた瞬間に返す', async () => {
    const f = fakeLender();
    const lends = new AssetLends();
    const box = host('a');
    const flying = lends.hydrate(box, f.lender);
    // ⚠ 借りが返る前に、もう一度組み直す(= 世代が進む)
    const box2 = host('b');
    await Promise.all([flying, lends.hydrate(box2, f.lender)]);
    expect(f.disposed, '古い世代の借用を握ったままにした').toContain('blob:a#1');
  });

  it('🔴 面を畳んだら全部返す', async () => {
    const f = fakeLender();
    const lends = new AssetLends();
    await lends.hydrate(host('a', 'b'), f.lender);
    expect(lends.size, '前提が崩れている(2 本借りていない)').toBe(2);
    lends.disposeAll();
    expect(f.disposed.length, '畳んでも返していない').toBe(2);
    expect(lends.size).toBe(0);
  });
});
