/**
 * 🔴 **入れ物ごと捨てる**(#986 段③)。
 *
 * ⚠ ここで守りたいのは 2 つで、**どちらも「取り消せない操作」だから**である:
 * ① **順番** ── 添付を先に消し、DB を捨て、他のタブへ伝える。逆順は半端を残す
 * ② 🔴 **失敗を飲み込まない** ── 消せなかった数を必ず外へ出す
 *   (「まっさらになりました」と嘘をつかせない)
 */
import { describe, expect, it } from 'vitest';
import {
  resetContainer,
  resetDoneMessage,
  type ContainerResetPorts,
} from '../../src/features/storage/container-reset';

const CID = 'c1';

/** 呼ばれた順番を記録する台。⚠ **順番が本題**なので、1 本の列に積む。 */
function bench(over: Partial<ContainerResetPorts> = {}): {
  ports: ContainerResetPorts;
  log: string[];
} {
  const log: string[] = [];
  const ports: ContainerResetPorts = {
    listAssetKeys: async (cid) => {
      log.push(`list:${cid}`);
      return ['a', 'b'];
    },
    deleteAsset: async (cid, key) => {
      log.push(`del:${key}`);
    },
    wipeStorage: async () => {
      log.push('wipe');
      return { wiped: true, note: null };
    },
    forgetLocal: () => {
      log.push('forget');
    },
    announceWiped: () => {
      log.push('announce');
    },
    ...over,
  };
  return { ports, log };
}

describe('捨てる順番(#986 段③)', () => {
  it('🔴 添付 → DB → 知らせる、の順で進む', async () => {
    const { ports, log } = bench();
    const r = await resetContainer(CID, ports);
    expect(log).toEqual(['list:c1', 'del:a', 'del:b', 'wipe', 'forget', 'announce']);
    expect(r).toEqual({ assets: 2, assetFailures: 0, wiped: true, note: null });
  });

  /**
   * 🔴 **DB を捨てる前に添付を消す理由**は「途中で落ちても元の DB が生きている」ことである。
   * ⚠ だから**添付の削除が落ちた回でも、DB は捨てにいく**(user は捨てたい)。
   */
  it('🔴 添付が 1 件消せなくても、残りを消して DB は捨てる', async () => {
    const { ports, log } = bench({
      deleteAsset: async (_cid, key) => {
        log.push(`del:${key}`);
        if (key === 'a') throw new Error('壊れている');
      },
    });
    const r = await resetContainer(CID, ports);
    expect(r.assets, '残りを消していない').toBe(1);
    expect(r.assetFailures, '失敗を数えていない').toBe(1);
    expect(log, 'DB を捨てていない').toContain('wipe');
  });

  /**
   * ⚠ **一覧が引けないのは「0 件」ではない** ── IDB ごと壊れている場合である。
   * 🔑 それでも**捨てにいく**(壊れているときだけ捨てられない、を作らない)。
   */
  it('🔴 添付の一覧が引けなくても、DB は捨てる', async () => {
    const { ports, log } = bench({
      listAssetKeys: async () => {
        log.push('list:boom');
        throw new Error('IDB が開けない');
      },
    });
    const r = await resetContainer(CID, ports);
    expect(log).toEqual(['list:boom', 'wipe', 'forget', 'announce']);
    expect(r.assets).toBe(0);
    // ⚠ **数えられなかった**のであって「消し損ねた」のではない
    expect(r.assetFailures, '引けなかったのを失敗に数えた').toBe(0);
  });

  it('⚠ メモリ上の DB では wiped が false で、理由が付く(失敗ではない)', async () => {
    const { ports } = bench({
      wipeStorage: async () => ({ wiped: false, note: 'メモリ上にあります' }),
    });
    const r = await resetContainer(CID, ports);
    expect(r.wiped).toBe(false);
    expect(r.note).toBe('メモリ上にあります');
  });

  /**
   * 🔴 **他のタブへ伝えるのを落とすと、古いタブが消した中身を書き戻す。**
   * ⚠ 「落ちなかった」では守れない ── **呼ばれたこと**を見る。
   */
  it('🔴 他のタブへ必ず伝える', async () => {
    const { ports, log } = bench();
    await resetContainer(CID, ports);
    expect(log.at(-1), '最後に知らせていない').toBe('announce');
  });

  it('⚠ 添付が 0 件でも、DB は捨てる(対照群)', async () => {
    const { ports, log } = bench({ listAssetKeys: async () => [] });
    const r = await resetContainer(CID, ports);
    expect(log).toEqual(['wipe', 'forget', 'announce']);
    expect(r.assets).toBe(0);
  });
});

describe('終わった後の字(#986 段③)', () => {
  it('🔑 次の一手が書いてある(「消しました」で終わらない)', () => {
    const s = resetDoneMessage({ assets: 3, assetFailures: 0, wiped: true, note: null });
    expect(s, '次に何をすればよいか書いていない').toContain('取り込んで');
    expect(s, '記法が混じっている').not.toMatch(/[*`]/);
  });

  it('🔴 消せなかった添付が在るなら、そう言う', () => {
    const s = resetDoneMessage({ assets: 1, assetFailures: 2, wiped: true, note: null });
    expect(s, '消せなかったことを隠した').toContain('2 件');
    // ⚠ 空振り防止 ── 0 件のときは言わない
    expect(
      resetDoneMessage({ assets: 1, assetFailures: 0, wiped: true, note: null }),
    ).not.toContain('消せませんでした');
  });

  it('⚠ メモリ上だったときは、その理由を出す', () => {
    const s = resetDoneMessage({
      assets: 0,
      assetFailures: 0,
      wiped: false,
      note: 'メモリ上にあります',
    });
    expect(s).toContain('メモリ上にあります');
  });
});
