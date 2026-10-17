/** @vitest-environment happy-dom */
/**
 * 🔴 **大きな画像を縮めるか聞く**(#412)── 繋がりの側。
 *
 * ⚠ 判断そのもの(何を縮めるか)は `tests/features/image-shrink.test.ts`。
 *   ここが見るのは **口が無ければ縮まらない / 断れば元のまま / 受ければ差し替わる**。
 */
import { describe, expect, it } from 'vitest';
import { maybeShrink, newShrinkRun, type AttachDeps, type AttachItem } from '../../src/adapter/ui/actions/attach';
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
    gate: (run) => run(), // #724 ⑤: 単体では門を模さない(そのまま走らせる)
    putBlob: async () => {},
    putMeta: async () => {},
    listStoredBlobKeys: async () => [],
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

  it('🔴 縮めるのに失敗しても、取り込みは続く(元のまま入る)', async () => {
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

describe('何枚も入れるとき ── どの写真か分かる / 残りも同じにする(#1652 3)', () => {
  const photos = (n: number): AttachItem[] =>
    Array.from({ length: n }, (_, i) => item({ name: `写真${i + 1}.jpg` }));

  it('🔴 窓の字に、ファイル名と「5 枚中 2 枚目」が出る', async () => {
    const all = [...photos(4), item({ name: '地図.pdf', type: 'application/pdf' }), item({ name: '写真5.jpg' })];
    const run = newShrinkRun(all);
    // ⚠ PDF は候補に数えない(「6 枚中」にならない)
    expect(run.total).toBe(5);
    const asked: string[] = [];
    const d = deps({
      shrinkImage: shrunkOk,
      askShrink: async (q) => {
        asked.push(q);
        return false;
      },
    });
    for (const it of all) await maybeShrink(d, it, run);
    expect(asked, '写真 5 枚ぶん聞くはず').toHaveLength(5);
    expect(asked[1]).toContain('「写真2.jpg」(5 枚中 2 枚目)');
    expect(asked[4], 'PDF を挟んでも、最後は 5 枚中 5 枚目').toContain('「写真5.jpg」(5 枚中 5 枚目)');
  });

  it('🔴 「残りも同じにする」は、残りの写真が在るときだけ出す(最後の 1 枚には出さない)', async () => {
    const run = newShrinkRun(photos(2));
    const offers: Array<string | undefined> = [];
    const d = deps({
      shrinkImage: shrunkOk,
      askShrink: async (_q, o) => {
        offers.push(o?.rememberLabel);
        return false;
      },
    });
    for (const it of photos(2)) await maybeShrink(d, it, run);
    expect(offers[0], '残りが在るのに出ていない').toBe('残りも同じにする');
    expect(offers[1], '最後の 1 枚に出している').toBeUndefined();
  });

  it('🔴 「縮める + 残りも」を選ぶと、残りは聞かずに縮む', async () => {
    const run = newShrinkRun(photos(3));
    let asked = 0;
    const d = deps({
      shrinkImage: shrunkOk,
      askShrink: async () => {
        asked += 1;
        return { ok: true, remember: true };
      },
    });
    const outs = [];
    for (const it of photos(3)) outs.push(await maybeShrink(d, it, run));
    expect(asked, '残りも聞いている').toBe(1);
    expect(outs.map((o) => o.blob === small)).toEqual([true, true, true]);
  });

  it('🔴 「そのまま + 残りも」を選ぶと、残りは聞かず、縮める支度(ワーカー)も起こさない', async () => {
    const run = newShrinkRun(photos(3));
    let asked = 0;
    let shrinkCalls = 0;
    const d = deps({
      shrinkImage: async () => {
        shrinkCalls += 1;
        return shrunkOk();
      },
      askShrink: async () => {
        asked += 1;
        return { ok: false, remember: true };
      },
    });
    const outs = [];
    for (const it of photos(3)) outs.push(await maybeShrink(d, it, run));
    expect(asked).toBe(1);
    expect(shrinkCalls, '残りのためにワーカーを起こした').toBe(1);
    expect(outs.every((o) => o.size === BIG)).toBe(true);
  });

  it('🔑 対照群 ── 「残りも」を選ばなければ、1 枚ずつ聞く(黙って全部に当てない)', async () => {
    const run = newShrinkRun(photos(3));
    let asked = 0;
    const d = deps({
      shrinkImage: shrunkOk,
      askShrink: async () => {
        asked += 1;
        return { ok: true, remember: false };
      },
    });
    for (const it of photos(3)) await maybeShrink(d, it, run);
    expect(asked).toBe(3);
  });

  it('🔑 次の取り込みには持ち越さない(記憶は 1 回の取り込みの run に閉じる)', async () => {
    const d = deps({
      shrinkImage: shrunkOk,
      askShrink: async () => ({ ok: false, remember: true }),
    });
    const first = newShrinkRun(photos(2));
    await maybeShrink(d, photos(2)[0]!, first);
    expect(first.remembered).toBe(false);
    expect(newShrinkRun(photos(2)).remembered, '新しい取り込みが前の答えを引き継いだ').toBeNull();
  });
});
