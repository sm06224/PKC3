/** @vitest-environment happy-dom */
/**
 * 🔴 **大きな画像を縮めるか聞く**(#412)── 繋がりの側。
 *
 * ⚠ 判断そのもの(何を縮めるか)は `tests/features/image-shrink.test.ts`。
 *   ここが見るのは **口が無ければ縮まらない / 断れば元のまま / 受ければ差し替わる**。
 */
import { describe, expect, it } from 'vitest';
import { maybeShrink, type AttachDeps, type AttachItem } from '../../src/adapter/ui/actions/attach';
import { SHRINK_MIN_BYTES } from '../../src/features/asset/image-shrink';

const BIG = SHRINK_MIN_BYTES * 4;
const item = (over: Partial<AttachItem> = {}): AttachItem => ({
  name: '写真.jpg',
  type: 'image/jpeg',
  size: BIG,
  blob: new Blob([new Uint8Array(8)], { type: 'image/jpeg' }),
  ...over,
});

/** 最小の deps ── 縮める口だけを差す(他は呼ばれない)。 */
function deps(over: Partial<AttachDeps> = {}): AttachDeps {
  return {
    putBlob: async () => {},
    putMeta: async () => {},
    listMetas: async () => [],
    ...over,
  };
}

const small = new Blob([new Uint8Array(4)], { type: 'image/jpeg' });
const shrunkOk = async () => ({
  width: 4000,
  height: 3000,
  shrunk: { blob: small, width: 2048, height: 1536 },
});

describe('添付を縮める(#412)', () => {
  it('🔴 聞く口が無ければ、縮めない(黙って縮める道を作らない)', async () => {
    const out = await maybeShrink(deps({ shrinkImage: shrunkOk }), item());
    expect(out.size, '聞かずに縮めた').toBe(BIG);
  });

  it('🔴 縮める口が無ければ、何も起きない', async () => {
    let asked = 0;
    const out = await maybeShrink(
      deps({
        askShrink: async () => {
          asked += 1;
          return true;
        },
      }),
      item(),
    );
    expect(asked, '縮める手段が無いのに聞いた').toBe(0);
    expect(out.size).toBe(BIG);
  });

  it('🔴 断ったら元のまま入る', async () => {
    const out = await maybeShrink(
      deps({ shrinkImage: shrunkOk, askShrink: async () => false }),
      item(),
    );
    expect(out.size, '断ったのに縮んだ').toBe(BIG);
    expect(out.blob.size).toBe(8);
  });

  it('🔴 受けたら縮んだほうに差し替わる(大きさも直る)', async () => {
    const out = await maybeShrink(
      deps({ shrinkImage: shrunkOk, askShrink: async () => true }),
      item(),
    );
    expect(out.blob, '縮んだ blob になっていない').toBe(small);
    expect(out.size, 'size が古いまま(空き容量の判定が狂う)').toBe(small.size);
    // ⚠ 名前と型は変えない(拡張子と中身が食い違うと下流が壊れる)
    expect(out.name).toBe('写真.jpg');
    expect(out.type).toBe('image/jpeg');
  });

  it('🔴 聞く文言に、本当の数字が両方入る', async () => {
    let asked = '';
    await maybeShrink(
      deps({
        shrinkImage: shrunkOk,
        askShrink: async (q) => {
          asked = q;
          return false;
        },
      }),
      item(),
    );
    expect(asked).toContain('4000×3000');
    expect(asked).toContain('2048×1536');
    expect(asked, '戻せないことを言っていない').toContain('戻りません');
  });

  describe('🔴 そもそも聞かない場面', () => {
    it('小さい画像では、縮める口すら呼ばない', async () => {
      let called = 0;
      await maybeShrink(
        deps({
          shrinkImage: async () => {
            called += 1;
            return { width: 0, height: 0, shrunk: null };
          },
          askShrink: async () => true,
        }),
        item({ size: SHRINK_MIN_BYTES - 1 }),
      );
      expect(called, '小さいのにワーカーを起こした').toBe(0);
    });

    it('画像でないものは触らない', async () => {
      let called = 0;
      await maybeShrink(
        deps({
          shrinkImage: async () => {
            called += 1;
            return { width: 0, height: 0, shrunk: null };
          },
          askShrink: async () => true,
        }),
        item({ name: 'a.pdf', type: 'application/pdf' }),
      );
      expect(called).toBe(0);
    });

    it('🔑 対照群 ── 大きい画像なら呼ぶ', async () => {
      let called = 0;
      await maybeShrink(
        deps({
          shrinkImage: async () => {
            called += 1;
            return { width: 0, height: 0, shrunk: null };
          },
          askShrink: async () => true,
        }),
        item(),
      );
      expect(called, '大きいのに呼んでいない').toBe(1);
    });

    it('⚠ 型が空でも、拡張子から画像と分かれば触る', async () => {
      let called = 0;
      await maybeShrink(
        deps({
          shrinkImage: async () => {
            called += 1;
            return { width: 0, height: 0, shrunk: null };
          },
          askShrink: async () => true,
        }),
        item({ type: '' }),
      );
      expect(called, '拡張子から引けていない').toBe(1);
    });
  });

  it('🔴 縮めるのに失敗しても、取込は続く(元のまま入る)', async () => {
    const out = await maybeShrink(
      deps({
        shrinkImage: async () => {
          throw new Error('壊れた画像');
        },
        askShrink: async () => true,
      }),
      item(),
    );
    expect(out.size).toBe(BIG);
  });

  it('🔴 縮まらなかった(採らなかった)ときは聞かない', async () => {
    let asked = 0;
    const out = await maybeShrink(
      deps({
        shrinkImage: async () => ({ width: 4000, height: 3000, shrunk: null }),
        askShrink: async () => {
          asked += 1;
          return true;
        },
      }),
      item(),
    );
    expect(asked, '縮んでいないのに聞いた').toBe(0);
    expect(out.size).toBe(BIG);
  });
});
