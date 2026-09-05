/**
 * 本文の全文検索(#181)。**worker の実物を node で動かして**確かめる
 * (`storage-worker.test.ts` と同じ手法 ── `:memory:` へ落ちる)。
 *
 * 🔴 ここで守る主張は 4 つ:
 * 1. **日本語の本文が引ける**(3 文字以上 = trigram の実測下限)
 * 2. **2 文字でも引ける**(LIKE へ落ちる ── 落ちないと「短い語が無い」に見える)
 * 3. **題名だけでなく本文が対象**(いまの絞り込みとの差そのもの)
 * 4. **既に在る entry も引ける**(索引を後から足したので、rebuild が効いていないと
 *    「入れたばかりの 1 件だけ引ける」という**いちばん気づきにくい**壊れ方をする)
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { StorageRequest } from '../../src/adapter/platform/storage/protocol';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import type { StoreClientLike } from '../../src/adapter/platform/storage/store-proxy';
import { createStorePort } from '../../src/adapter/platform/storage/store-port';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Handle = (req: StorageRequest) => Promise<unknown>;

/**
 * worker を node で起こす。⚠ **実績のあるハーネスと同じ形にする**
 * (`storage-worker.test.ts`)── worker は `self.onmessage` に代入する作りなので、
 * `addEventListener` を差しても**呼ばれず、初期化が永久に返らない**(実際に踏んだ)。
 */
const pending = new Map<number, (resp: any) => void>();
let seq = 0;
const workerSelf: { onmessage: ((ev: { data: any }) => void) | null } = { onmessage: null };

const call: Handle = (req) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (resp) => (resp.ok ? resolve(resp.result) : reject(new Error(resp.error))));
    workerSelf.onmessage!({ data: { id, req } });
  });

const CID = 'c1';

const put = (lid: string, title: string, body: string) =>
  call({
    op: 'upsertEntry',
    cid: CID,
    entry: {
      lid,
      title,
      archetype: 'text',
      entryOrder: Number(lid.replace(/\D/g, '')) || 1,
      status: null,
      date: null,
      archived: false,
      body,
    },
    checkpoint: false,
    keepLatest: 10,
  } as StorageRequest);

const search = async (query: string) =>
  (await call({ op: 'searchEntries', cid: CID, query } as StorageRequest)) as {
    lids: string[];
    truncated: boolean;
  };

describe('全文検索(#181)', () => {
  beforeAll(async () => {
    (globalThis as any).self = workerSelf;
    (globalThis as any).postMessage = (msg: any) => {
      const cb = pending.get(msg.id);
      pending.delete(msg.id);
      cb?.(msg);
    };
    await import('../../src/adapter/platform/storage/storage-worker');
    await call({ op: 'init', dbName: 'search-test' } as StorageRequest);
    await call({ op: 'openContainer', cid: CID, title: 't' } as StorageRequest);
    await put('n1', '会議メモ', '来週の全文検索の設計について話した\n');
    await put('n2', '買い物', 'りんごとみかんを買う\n');
    await put('n3', 'Notes', 'alpha beta gamma\n');
  }, 30_000);

  it('🔴 日本語の**本文**が引ける(題名に無い語で当たる)', async () => {
    const r = await search('全文検索');
    expect(r.lids, '本文の語で引けない = 題名検索のまま').toEqual(['n1']);
  });

  it('3 文字の日本語が引ける(trigram の実測下限)', async () => {
    expect((await search('りんご')).lids).toEqual(['n2']);
  });

  it('🔴 2 文字でも引ける(LIKE へ落ちる ── 落ちないと短い語が「無い」に見える)', async () => {
    const r = await search('会議');
    expect(r.lids, '2 文字で 0 件 = trigram の下限に落ちたまま').toEqual(['n1']);
  });

  it('ASCII も引ける', async () => {
    expect((await search('gamma')).lids).toEqual(['n3']);
  });

  it('題名でも引ける(本文と題名の両方が対象)', async () => {
    expect((await search('買い物')).lids).toEqual(['n2']);
  });

  it('空の問い合わせは 0 件を返す(絞り込み無しは呼び側の責任)', async () => {
    expect((await search('   ')).lids).toEqual([]);
  });

  it('当たらない語は 0 件', async () => {
    expect((await search('存在しない語句')).lids).toEqual([]);
  });

  it('並びは entry_order(関連度順にしない)', async () => {
    await put('n0', 'ゼロ番', 'りんごの話\n'); // entry_order は lid の数字 = 0
    const r = await search('りんご');
    expect(r.lids, '並びが entry_order でない').toEqual(['n0', 'n2']);
  });

  it('FTS の演算子を打っても壊れない(丸ごと 1 句として引く)', async () => {
    // ⚠ 引用しないと FTS5 の構文エラーで throw する
    await expect(search('AND OR "x*')).resolves.toBeTruthy();
  });

  it('LIKE のワイルドカードが素通りしない', async () => {
    // `%%` は「何でも当たる」ではなく **リテラルの %%** として扱う
    expect((await search('%%')).lids).toEqual([]);
  });

  it('🔴 更新すると索引も追従する(trigger が効いている)', async () => {
    await put('n3', 'Notes', 'delta epsilon\n');
    expect((await search('gamma')).lids, '古い本文が索引に残っている').toEqual([]);
    expect((await search('epsilon')).lids).toEqual(['n3']);
  });

  it('🔴 削除すると索引からも消える', async () => {
    await call({ op: 'deleteEntry', cid: CID, lid: 'n2' } as StorageRequest);
    expect((await search('みかん')).lids).toEqual([]);
  });

  /**
   * 🔴 **上の test は JOIN に救われている**(2026-08-15 の変異試験で判明)。
   * 削除 trigger を落としても、`entries` から行が消えれば JOIN が索引の残骸を
   * 落とすので緑のままだった ── **検査が別の機構に満たされていた**(§1)。
   *
   * 実害は **rowid の再利用**で出る: SQLite は削除した rowid を次の INSERT が
   * 拾う。索引に残骸が居ると、**新しいノートの rowid に古い本文がぶら下がる** ──
   * 「書いていない語で自分のノートが当たる」という、user から見て一番不気味な形。
   */
  it('🔴 消した行の rowid を新しいノートが拾っても、古い本文で当たらない', async () => {
    // いちばん新しい行(= 最大 rowid)を消してから作ると、その rowid が再利用される
    await put('n9', '最後の行', 'ばななの記録\n');
    expect((await search('ばなな')).lids).toEqual(['n9']);
    await call({ op: 'deleteEntry', cid: CID, lid: 'n9' } as StorageRequest);
    await put('n8', '新しい行', 'ぶどうの記録\n');
    expect((await search('ぶどう')).lids, '新しい本文が引けない').toEqual(['n8']);
    expect(
      (await search('ばなな')).lids,
      '消したはずの本文で当たる(索引に残骸が残っている)',
    ).toEqual([]);
  });
});

/**
 * 🔴 **上限(200 件)で切ったことが、配線を通って主スレッドまで届く**(#680)。
 *
 * ⚠ ここは今まで **0 件の次元**だった ── fixture が 3〜5 件しか無いので `truncated` は
 *   常に `false` で、worker の `limit + 1` も、store-port が `.lids` だけ返して
 *   **`truncated` を捨てていた**ことも、どの test も見ていなかった。
 * 🔑 2 段で見る:① worker が 201 件で `true` / 200 件で `false` を返す
 *   ② **本物の `createStorePort`** を通しても `truncated` が落ちない
 *   (fake の client は worker へ**そのまま流す通り道** ── 封筒を組ませない、§7)。
 */
describe('上限で切ったことを言う(#680)', () => {
  const CID2 = 'c2';
  /** `n` 件、全部に同じ語を持たせる。⚠ 題名ではなく**本文**に置く(FTS の経路を通す)。 */
  const entries = (n: number, word: string): EntryUpsert[] =>
    Array.from({ length: n }, (_, i) => ({
      lid: `m${i}`,
      title: `メモ ${i}`,
      archetype: 'text',
      body: `${word} について ${i} 番目\n`,
      entryOrder: i,
      status: null,
      date: null,
      archived: false,
    }));
  const client: StoreClientLike = {
    request: (req) => call(req as StorageRequest) as never,
    terminate: () => {},
  };

  beforeAll(async () => {
    await call({ op: 'openContainer', cid: CID2, title: 't2' } as StorageRequest);
    // 200 件は「切れない」語、201 件は「切れる」語 ── 同じ DB に両方置く
    await call({ op: 'bulkUpsertEntries', cid: CID2, entries: entries(200, 'ちょうど') } as StorageRequest);
    await call({
      op: 'bulkUpsertEntries',
      cid: CID2,
      entries: entries(201, 'あふれる').map((e) => ({ ...e, lid: `o${e.lid}` })),
    } as StorageRequest);
  }, 30_000);

  it('🔴 201 件当たると truncated: true、200 件は false(worker)', async () => {
    const over = (await call({ op: 'searchEntries', cid: CID2, query: 'あふれる' } as StorageRequest)) as {
      lids: string[];
      truncated: boolean;
    };
    expect(over.lids, '上限で切っていない').toHaveLength(200);
    expect(over.truncated, '切ったのに言っていない').toBe(true);
    const exact = (await call({ op: 'searchEntries', cid: CID2, query: 'ちょうど' } as StorageRequest)) as {
      lids: string[];
      truncated: boolean;
    };
    expect(exact.lids, '前提が崩れた(200 件が入っていない)').toHaveLength(200);
    expect(exact.truncated, 'ちょうど 200 件で「切った」と言っている').toBe(false);
  });

  it('🔴 本物の store-port を通しても truncated が落ちない', async () => {
    const port = createStorePort(client, CID2);
    const over = await port.searchEntries!('あふれる');
    expect(over.truncated, 'store-port が truncated を捨てている(直す前の形)').toBe(true);
    expect(over.lids).toHaveLength(200);
    // ⚠ 対照群 ── 切れていないときに `true` を捏造していない
    expect((await port.searchEntries!('ちょうど')).truncated).toBe(false);
  });
});
