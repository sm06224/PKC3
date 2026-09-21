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
  RESET_PASSPHRASE,
  resetContainer,
  resetDoneMessage,
  resetExplainMessage,
  resetPassphraseLabel,
  resetPassphraseOk,
  wipedElsewhere,
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

describe('押す前に読ませる字(#986 段③)', () => {
  const KEEPS = ['Office の部品(約 93MB)', '設定・見た目'];

  it('🔴 消えるものと残るものを、両方言う', () => {
    const t = resetExplainMessage({ notes: 12, keeps: KEEPS, rescued: null, assetsOnDisk: 0 });
    expect(t, '消えるものを言っていない').toContain('消えるもの');
    expect(t, '残るものを言っていない').toContain('残るもの');
    expect(t, '件数が出ていない').toContain('12 件');
    expect(t, '取り消せないことを言っていない').toContain('元に戻せません');
  });

  /**
   * 🔴 **渡された物を 1 つも落とさない。** ⚠ ここが落ちると
   *   「残ると言われた物が残らない」ではなく「**残るのに書いていない**」になり、
   *   user は消えたと思って入れ直す(93MB を取り直させる)。
   */
  it('🔴 残るものは、渡された数だけ並ぶ', () => {
    const t = resetExplainMessage({ notes: 0, keeps: KEEPS, rescued: null, assetsOnDisk: 0 });
    for (const k of KEEPS) expect(t, `${k} が落ちた`).toContain(k);
  });

  /**
   * 🔴 **0 件でも「済み」と言わない**(#971 段③ と同じ向き)。
   * ⚠ 壊れているときは 0 件のファイルが書き出せてしまうので、
   *   真偽ではなく**件数**を見せる。
   */
  it('🔴 拾っていなければそう言い、拾ってあれば件数を言う', () => {
    const none = resetExplainMessage({ notes: 3, keeps: KEEPS, rescued: null, assetsOnDisk: 0 });
    expect(none, 'まだ拾っていないことを言っていない').toContain('まだ拾い出していません');

    const zero = resetExplainMessage({
      notes: 3,
      keeps: KEEPS,
      assetsOnDisk: 0,
      rescued: { entries: 0, skipped: 5, empty: 2, bodyMissing: 0, assets: 0, assetBytes: 0, assetMissing: 0 },
    });
    expect(zero, '0 件なのに済んだ顔をしている').not.toContain('まだ拾い出していません');
    expect(zero, '拾えた件数が出ていない').toContain('0 件');
    expect(zero, '読めなかった数が出ていない').toContain('5');
  });

  it('⚠ 全部拾えた回は、括弧の内訳を出さない(対照群)', () => {
    const all = resetExplainMessage({
      notes: 3,
      keeps: KEEPS,
      assetsOnDisk: 0,
      rescued: { entries: 9, skipped: 0, empty: 0, bodyMissing: 0, assets: 0, assetBytes: 0, assetMissing: 0 },
    });
    expect(all).toContain('9 件');
    expect(all, '拾えなかった物が無いのに内訳が出た').not.toContain('読み込めなかった箇所');
  });

  /**
   * 🔴 **捨てる前に「添付は守られているか」を字にする**（#1005。user の心配 2026-09-17）。
   *
   * ⚠ 直す前のこの窓には添付の字が **1 行も無かった**。
   *   そのうえ拾い出しは bytes を 1 つも出さなかったので、
   *   🔴 **案内どおりに進むと 100% 添付を失う**形だった。
   * 🔑 見るのは**端末の在庫との差** ── 拾い出しの件数だけでは
   *   「添付 0 件」が「元から無い人」なのか「拾えていない人」なのか分からない。
   */
  it('🔴 全部入っていればそう言い、欠けていれば何件消えるかを言う', () => {
    const took = resetExplainMessage({
      notes: 3,
      keeps: KEEPS,
      assetsOnDisk: 3,
      rescued: { entries: 3, skipped: 0, empty: 0, bodyMissing: 0, assets: 3, assetBytes: 99, assetMissing: 0 },
    });
    expect(took, '端末の添付の件数を言っていない').toContain('添付が 3 件あります');
    expect(took, '全部入ったことを言っていない').toContain('3 件とも入っています');

    // 🔴 欠けている回 ── **何件消えるか**が読めないと、止まる判断ができない
    const short = resetExplainMessage({
      notes: 3,
      keeps: KEEPS,
      assetsOnDisk: 3,
      rescued: { entries: 3, skipped: 0, empty: 0, bodyMissing: 0, assets: 1, assetBytes: 9, assetMissing: 2 },
    });
    expect(short, '欠けているのに「全部入った」と読める').not.toContain('とも入っています');
    expect(short, '入った件数が出ていない').toContain('1 件だけです');
    expect(short, '残りが消えることを言っていない').toContain('残りはここで消えます');
  });

  /**
   * 🔴 **拾い出しをまだ押していない人にこそ、添付の数を見せる**。
   * ⚠ `rescued` が `null` のときに黙ると、**一番危ない人が何も知らない**。
   */
  it('🔴 まだ拾っていなくても、添付が何件消えるかは出す', () => {
    const t = resetExplainMessage({ notes: 3, keeps: KEEPS, rescued: null, assetsOnDisk: 4 });
    expect(t, '端末の添付の件数を言っていない').toContain('添付が 4 件あります');
    expect(t, '0 件しか入っていないことを言っていない').toContain('0 件だけです');
  });

  /**
   * ⚠ **対照群 2 つ** ── 元から 0 件の人を威さない /
   *   「無い」と「数えられない」を同じ字にしない。
   */
  it('⚠ 添付 0 件なら黙り、数えられなければそう言う', () => {
    const zero = resetExplainMessage({ notes: 3, keeps: KEEPS, rescued: null, assetsOnDisk: 0 });
    expect(zero, '0 件なのに添付の件数を言っている').not.toContain('添付が 0 件あります');

    const unknown = resetExplainMessage({ notes: 3, keeps: KEEPS, rescued: null, assetsOnDisk: null });
    expect(unknown, '数えられなかったことを黙っている').toContain('数えられませんでした');
  });

  /** ⚠ 出るのは `textContent` ── 記法を書くと記号がそのまま見える(お知らせと同じ規律)。 */
  it('⚠ 記法を書かない', () => {
    const t = resetExplainMessage({ notes: 1, keeps: KEEPS, rescued: null, assetsOnDisk: 0 });
    expect(t, '記法が混じっている').not.toMatch(/[*`]/);
  });

  /**
   * 🔴 **合言葉は、その窓に出ている。**
   * ⚠ ノートの題名にすると、壊れた DB では題名が 1 つも出ないので
   *   **いちばん要る場面で合言葉が読めなくなる**。
   */
  it('🔴 合言葉は窓の中に書いてある(覚えさせない)', () => {
    expect(resetPassphraseLabel(), '合言葉が窓に出ていない').toContain(RESET_PASSPHRASE);
  });

  it('🔴 合言葉でなければ通さない', () => {
    expect(resetPassphraseOk(RESET_PASSPHRASE)).toBe(true);
    // ⚠ 空・null・違う字・部分一致は、どれも通さない
    for (const bad of ['', null, 'はい', `${RESET_PASSPHRASE}ます`, 'す'])
      expect(resetPassphraseOk(bad), `${String(bad)} が通った`).toBe(false);
  });
});

/**
 * 🔴 **別のタブが捨てたと聞いたとき**(#986 段③。着地前レビュー 2 本が挙げた)。
 *
 * ⚠ 直す前は**無条件に読み込み直していた** ── 編集中のタブでは、自分が何も
 *   していないのに**打っていた字が黙って消える**。
 * 🔑 同じ問いには同じ答えを置く(§7)── 更新の案内(`createUpdatePrompt`)は
 *   `isEditing()` を見て聞く。ここもそれに揃える。
 */
describe('別のタブが捨てたとき(#986 段③)', () => {
  it('🔴 編集中なら、黙って読み込み直さない', () => {
    const p = wipedElsewhere(true);
    expect(p.reloadNow, '編集中なのに黙って読み込み直した').toBe(false);
    expect(p.ask, '聞く字が無い').toBeTruthy();
    // ⚠ 何が失われるかを言う(「読み込み直しますか」だけでは判断できない)
    expect(p.ask ?? '', '保存できないことを言っていない').toContain('保存できません');
  });

  it('⚠ 編集していなければ、そのまま読み込み直す(対照群)', () => {
    const p = wipedElsewhere(false);
    expect(p.reloadNow, '失う字が無いのに聞いている').toBe(true);
    expect(p.ask).toBeNull();
  });
});
