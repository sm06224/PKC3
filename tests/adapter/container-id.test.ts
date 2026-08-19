/**
 * コンテナ id の採番(#260)。
 *
 * 🔴 直す前は `main.ts` が `'default'` という**全インストール共通の定数**を
 * 渡していた。`pkc://<cid>/entry/<lid>` の「自分のコンテナか」は**文字列の
 * 等値**で決まる(`features/link/permalink.ts`)ので、**他人の PKC3 が書いた
 * 参照**が「自分のもの」と判定されていた。
 *
 * 🔑 守る主張は 3 つ:
 * 1. **新しい端末は自分だけの id を持つ**(`'default'` を名乗らない)
 * 2. **既に在るものは採番し直さない** ── cid は全テーブルの区画鍵
 *    (`WHERE cid = ?`)なので、振り直すと**既存データがまるごと見えなくなる**
 * 3. **綴りが 2 つの外部制約を満たす** ── permalink の token 規則と、
 *    asset の key 空間(`':'` 禁止)
 *
 * ⚠ **DB の状態ごとに worker を建て直す**(`init` は冪等なので、1 つの
 *   instance では「まっさらな DB」と「既に在る DB」を両方は試せない)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';
import {
  formatPortablePkcReference,
  parsePortablePkcReference,
} from '../../src/features/link/permalink';

type Op = StorageRequest['op'];
type Request = <O extends Op>(req: Extract<StorageRequest, { op: O }>) => Promise<ResultMap[O]>;

let dbSeq = 0;

/** まっさらな :memory: DB を持つ worker を 1 本建てる(node に OPFS は無い)。 */
async function freshWorker(): Promise<Request> {
  const pending = new Map<number, (resp: StorageResponse) => void>();
  let seq = 0;
  const workerSelf: {
    onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
  } = { onmessage: null };
  const g = globalThis as unknown as Record<string, unknown>;
  g['self'] = workerSelf;
  g['postMessage'] = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  const request: Request = (req) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (resp) =>
        resp.ok ? resolve(resp.result as never) : reject(new Error(resp.error)),
      );
      workerSelf.onmessage!({ data: { id, req } });
    });
  // ⚠ module registry を捨ててから import する ── 捨てないと前の test の
  //   worker(= 前の DB)がそのまま返ってきて、「まっさら」の前提が崩れる
  vi.resetModules();
  await import('../../src/adapter/platform/storage/storage-worker');
  const init = await request({ op: 'init', dbName: `unit-cid-${++dbSeq}` });
  expect(init.vfs, 'node に OPFS は無い ── memory fallback が前提').toBe('memory');
  return request;
}

let request: Request;
beforeEach(async () => {
  request = await freshWorker();
}, 30_000);

describe('コンテナ id の採番(#260)', () => {
  it('🔴 まっさらな端末は、自分だけの id を採番する', async () => {
    const first = await request({ op: 'resolveContainer', title: 'PKC3' });
    expect(first.created, '既に在るものを返した(まっさらの前提が崩れている)').toBe(true);
    expect(first.cid, '全インストール共通の既定値を名乗っている').not.toBe('default');
    expect(first.cid).toMatch(/^c-[0-9a-f]{32}$/);
  });

  it('🔴 2 回目は採番し直さない(同じ id が返る)', async () => {
    const first = await request({ op: 'resolveContainer', title: 'PKC3' });
    const second = await request({ op: 'resolveContainer', title: 'PKC3' });
    expect(second.cid, '起動のたびに別の器を開いている').toBe(first.cid);
    expect(second.created, '既に在るのに作ったと言っている').toBe(false);
  });

  /**
   * 🔴 **移行は「既存はそのまま」**(#260 の推薦)。振り直すと、区画鍵が変わって
   * 既存の entry / relation / revision / asset が**まるごと見えなくなる**。
   */
  it('🔴 既に `default` で使っている端末は、そのまま `default` を返す', async () => {
    await request({ op: 'openContainer', cid: 'default', title: 'PKC3' });
    await request({
      op: 'upsertEntry',
      cid: 'default',
      entry: {
        lid: 'e1',
        title: '前からあるノート',
        archetype: 'text',
        body: '本文',
        entryOrder: 1,
        status: null,
        date: null,
        archived: false,
      },
      checkpoint: false,
    });

    const resolved = await request({ op: 'resolveContainer', title: 'PKC3' });
    expect(resolved.cid, '既存の器を捨てて採番し直した').toBe('default');
    expect(resolved.created).toBe(false);
    // ⚠ 観測点は「id が同じ」ではなく **中身が見えること**(区画鍵なので)
    const metas = await request({ op: 'listEntryMetas', cid: resolved.cid });
    expect(metas.map((m) => m.lid), '既存のノートが見えなくなっている').toEqual(['e1']);
  });

  /**
   * 🔴 **別の端末は、別の id を持つ** ── #260 の本体はここである。
   *
   * ⚠ 「`'default'` を名乗らない」だけでは足りない(着地前レビューの指摘)。
   *   実害だったのは**全インストール共通の定数だったこと**であって、
   *   その綴りが `default` だったことではない ── 採番から乱数を外して
   *   `c-000…0` に固定する変異は、他のどの assert も殺せない。
   */
  it('🔴 別の端末は、別の id を持つ(全端末共通の定数を作らない)', async () => {
    const mine = await request({ op: 'resolveContainer', title: 'PKC3' });
    // ⚠ **逐次に建てる** ── `freshWorker()` は `globalThis['postMessage']` を
    //    差し替えるので、2 本を同時に飛ばすと応答が別の受け皿へ入る
    const otherRequest = await freshWorker();
    const theirs = await otherRequest({ op: 'resolveContainer', title: 'PKC3' });
    expect(theirs.created, '2 台目がまっさらでない(前提が崩れている)').toBe(true);
    expect(theirs.cid, '全端末が同じ id を名乗っている(#260 が戻っている)').not.toBe(mine.cid);
  });

  /**
   * 🔴 **器が 2 つ在っても、開く先が揺れない**(着地前レビュー ⚠-2)。
   *
   * ⚠ prod では器は 1 つしか作られないので、`ORDER BY` の分岐は**製品コードからは
   *   到達しない**。だが「起動のたびに違う器を開かない」という主張は、
   *   `ORDER BY` を丸ごと落とす変異で壊れる ── 分岐を書いた以上、
   *   1 度は実際に走らせておく(CLAUDE.md §2)。
   */
  it('🔴 器が 2 つ在っても、いちばん古いものを開き続ける', async () => {
    /**
     * ⚠ **`ORDER BY` を消しても同じ答えが返る形にしない**(2 稿捨てた)。
     * 1 稿目は挿入順に、2 稿目は id の昇順に救われた ──
     * `SELECT cid FROM containers` は **cid の被覆索引**で読めるので、
     * 並びを書かなくても**id 昇順**が返ってくる(§1「別の理由で緑」)。
     * 🔑 効くのは**作成時刻だけ** ── 古い側の id を**わざと後ろの綴り**にして、
     *   「時刻で決めている」以外では正解にならない形にする。
     * ⚠ 待ちが要るのは `datetime('now')` が**秒精度**だから(sqlite の時計しか
     *   使えないので、待つ以外に 2 行の時刻を違えられない)。
     */
    await request({ op: 'openContainer', cid: 'zzz-older', title: 'x' });
    await new Promise((r) => setTimeout(r, 1100));
    await request({ op: 'openContainer', cid: 'aaa-newer', title: 'y' });

    const { containers } = await request({ op: 'listContainerIds' });
    expect(
      containers[0]?.createdAt === containers[1]?.createdAt,
      '2 行の作成時刻が同じ(待ちが効いていない ── この test は無意味になる)',
    ).toBe(false);

    const first = await request({ op: 'resolveContainer', title: 'PKC3' });
    expect(first.created, '既に 2 つ在るのに作った').toBe(false);
    expect(first.cid, 'いちばん古い器を開いていない').toBe('zzz-older');
    const again = await request({ op: 'resolveContainer', title: 'PKC3' });
    expect(again.cid, '起動のたびに違う器を開いている').toBe(first.cid);
  });

  /**
   * 🔴 **並びの前提**(着地前レビュー ⚠-2)── `created_at` を埋めることが
   * `ORDER BY created_at` の主張を支えている。⚠ NULL は ASC の先頭に来るので、
   * INSERT から `datetime('now')` が落ちると**順序の主張が黙って壊れる**。
   * 片側(ORDER BY)を pin したら、対称の反対側(INSERT)も pin する。
   */
  it('🔴 採番した器は作成時刻を持つ(並びの前提)', async () => {
    const { cid } = await request({ op: 'resolveContainer', title: 'PKC3' });
    const { containers } = await request({ op: 'listContainerIds' });
    expect(containers.map((c) => c.cid), '一覧に出てこない').toEqual([cid]);
    /**
     * ⚠ **並びの効き目では見えない** ── NULL は ASC の先頭に来るので、
     *   時刻が空でも「先頭に居る」は真になる(それでは空振りである)。
     *   だから**値そのもの**を見る。
     */
    expect(containers[0]?.createdAt, '作成時刻が空(ORDER BY の前提が崩れている)')
      .toEqual(expect.any(String));
  });

  /**
   * ⚠ 綴りの制約は**別の file が持っている** ── ここで正規表現を書き写すと、
   * 向こうが変わったときに気づけない。**本物の formatter に通す**。
   */
  it('🔴 採番した id は permalink の綴りに収まる', async () => {
    const { cid } = await request({ op: 'resolveContainer', title: 'PKC3' });
    const ref = formatPortablePkcReference({ kind: 'entry', containerId: cid, targetId: 'e1' });
    expect(ref, 'permalink の token 規則に収まらない id を採番した').not.toBeNull();
    expect(parsePortablePkcReference(ref!)?.containerId, '往復で崩れる').toBe(cid);
    // ⚠ `asset-blob-store.ts` の `assertCid` ── `':'` は key 空間を混ぜるので禁止
    expect(cid).not.toContain(':');
  });

  /**
   * 🔴 **他人の `pkc://default/...` を「自分のもの」と読まない**(#260 の実害)。
   * ⚠ 判定そのものは `permalink.ts` に在る ── ここは「採番した id を渡すと
   *   食い違う」ことを、**本物の判定関数**で確かめる。
   */
  it('🔴 他人の PKC3 が書いた `default` の参照と食い違う', async () => {
    const { cid } = await request({ op: 'resolveContainer', title: 'PKC3' });
    const foreign = parsePortablePkcReference('pkc://default/entry/e1');
    expect(foreign, '前提が崩れている(参照が読めていない)').not.toBeNull();
    expect(foreign!.containerId === cid, '他人の参照を自分のものと判定した').toBe(false);
  });
});
