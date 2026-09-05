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
import {
  SNIPPET_MARK_CLOSE,
  SNIPPET_MARK_OPEN,
  type SearchDetailRow,
} from '../../src/features/filter/search-snippet';

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

/**
 * 🔴 **探す面のための検索 `searchDetail`**(#680)── 題名 + 抜粋 + 関連度。
 *
 * ⚠ ここは**実測の pin** である(2026-09-05)。trigram の `snippet()` が日本語で読める
 *   抜粋を返すこと、`bm25()` が「同じ語が 2 回出る本文を先に」並べることは、
 *   仕様書ではなく**この worker で測って**確かめた ── tokenizer や同梱 sqlite を
 *   変えたら、ここが先に鳴る。
 */
describe('探す面の検索 searchDetail(#680)', () => {
  const CID3 = 'c3';
  const putIn = (lid: string, title: string, body: string, archived = false) =>
    call({
      op: 'upsertEntry',
      cid: CID3,
      entry: {
        lid,
        title,
        archetype: 'text',
        // ⚠ 並びの対照群 ── 関連度の並び(a → b → e)と**逆向き**の entry_order を与える。
        //    そうしないと「rank で並べた」と「entry_order で並べた」が同じ答えになり、
        //    ORDER BY を落とす変異が生き延びる(CLAUDE.md §1「救い手が変わっただけ」)
        entryOrder: 1000 - lid.charCodeAt(0),
        status: null,
        date: null,
        archived,
        body,
      },
      checkpoint: false,
      keepLatest: 10,
    } as StorageRequest);
  const detail = async (query: string, cid = CID3) =>
    (await call({ op: 'searchDetail', cid, query } as StorageRequest)) as {
      rows: SearchDetailRow[];
      truncated: boolean;
    };
  const marked = (word: string) => `${SNIPPET_MARK_OPEN}${word}${SNIPPET_MARK_CLOSE}`;

  beforeAll(async () => {
    await call({ op: 'openContainer', cid: CID3, title: 't3' } as StorageRequest);
    // a: 2 回 / b: 1 回(⚠ a と**同じ長さ**)/ e: 1 回だが長い / t: 題名だけ / z: ゴミ箱の中
    await putIn('a', '会議メモ', '全文検索の話。全文検索の話。今日は晴れ。');
    await putIn('b', '買い物', '全文検索の話。りんごの話だ。今日は晴れ。');
    await putIn('e', '長文', 'あ'.repeat(300) + '全文検索' + 'い'.repeat(300));
    await putIn('t', '全文検索の題名', '本文には別の話しか無い。');
    await putIn('z', '捨てた', '全文検索の話。ごみばこ固有語。', true);
  }, 30_000);

  it('🔴 日本語 3 字以上で、当たった語を印で囲んだ抜粋が返る(実測 pin)', async () => {
    const { rows } = await detail('全文検索');
    const a = rows.find((r) => r.lid === 'a');
    expect(a, '本文が当たったのに行が無い').toBeDefined();
    expect(a!.title).toBe('会議メモ');
    expect(a!.snippet, '抜粋が空').not.toBe('');
    expect(a!.snippet, '当たった語が印で囲まれていない').toContain(marked('全文検索'));
    // ⚠ 抜粋は 1 行の窓 ── 本文を丸ごと返していない(600 字の本文でも短い)
    const e = rows.find((r) => r.lid === 'e')!;
    expect([...e.snippet].length, '抜粋が本文丸ごと').toBeLessThan(80);
    expect(e.snippet).toContain(marked('全文検索'));
    for (const r of rows) expect(r.snippet, `${r.lid} の抜粋が空`).not.toBe('');
  });

  /**
   * 🔴 **実測**(2026-09-05): bm25 は**長さで割る**。1 稿目の fixture は a の本文が b の
   * 約 2 倍の長さで、2 回出る a(-4.05)が 1 回の b(-4.07)に**負けた**。
   * ⚠ だから主張を「同じ長さなら 2 回のほうが先」に絞る ── 「2 回出れば先」は
   *   成り立たない条件だった(CLAUDE.md §1「主張そのものが成り立たない」)。
   * ⚠ 題名だけの当たり(t)は**いちばん上**に来た(-4.55)── 題名の列が短いので
   *   同じ 1 回でも重く出る。位置は pin しない(索引全体の題名の平均長に依る)。
   */
  it('🔴 同じ長さなら、同じ語が 2 回出る本文が先に来る(関連度順 ── 実測 pin)', async () => {
    const { rows } = await detail('全文検索');
    const at = (lid: string) => rows.findIndex((r) => r.lid === lid);
    expect(at('a'), '前提: a が無い').toBeGreaterThanOrEqual(0);
    expect(at('a'), '2 回出る本文が 1 回の本文より後ろ').toBeLessThan(at('b'));
    expect(at('b'), '短い本文が長い本文より後ろ').toBeLessThan(at('e'));
    // 🔑 rank は bm25 の値(小さいほど良い)── entry_order ではない
    expect(rows[0]!.rank, 'rank が入っていない').toBeLessThan(0);
  });

  it('🔴 題名だけが当たっても行に出る(抜粋は本文の頭 ── 印は無い)', async () => {
    const { rows } = await detail('全文検索');
    const t = rows.find((r) => r.lid === 't');
    expect(t, '題名だけの当たりが落ちた').toBeDefined();
    expect(t!.snippet).not.toContain(SNIPPET_MARK_OPEN);
    expect(t!.snippet).toContain('本文には別の話');
  });

  it('🔴 2 字(LIKE 側)でも同じ顔の抜粋が返る ── 並びは entry_order', async () => {
    const { rows } = await detail('晴れ');
    // ⚠ entry_order は b(902)→ a(903)── lid の順でも関連度でもなく entry_order
    expect(rows.map((r) => r.lid), 'LIKE 側の並びが entry_order でない').toEqual(['b', 'a']);
    expect(rows[0]!.snippet, 'LIKE 側の抜粋に印が無い').toContain(marked('晴れ'));
    expect(rows[0]!.rank, 'LIKE 側は関連度を持たない').toBe(0);
  });

  it('🔴 ゴミ箱の中は返さない(行を押すと開くので、一覧に無い物を出さない)', async () => {
    // ⚠ 前提: z は入っていて索引にも居る(`searchEntries` はゴミ箱を弾かない)
    expect((await call({ op: 'searchEntries', cid: CID3, query: 'ごみばこ固有語' } as StorageRequest)) as object)
      .toMatchObject({ lids: ['z'] });
    const { rows } = await detail('全文検索');
    expect(rows.map((r) => r.lid), 'ゴミ箱の中が探す面に出た').not.toContain('z');
    expect((await detail('ごみばこ固有語')).rows, 'ゴミ箱の中が探す面に出た(LIKE 側)').toEqual([]);
  });

  it('上限で切ったことを言う(searchEntries と同じ作法)── FTS 側と LIKE 側の両方', async () => {
    const over = await detail('あふれる', 'c2');
    expect(over.rows).toHaveLength(200);
    expect(over.truncated).toBe(true);
    expect((await detail('ちょうど', 'c2')).truncated).toBe(false);
    /**
     * ⚠ **LIKE 側(2 字)も別に通す** ── 分岐は 2 本なので、走らせた記録も 2 本
     *   (CLAUDE.md §2)。1 稿目は FTS 側だけで、LIKE 側の `limit + 1` を落とす変異が
     *   生き延びた(変異試験 M5)。
     */
    const overLike = await detail('あふ', 'c2');
    expect(overLike.rows, '前提: 2 字が LIKE 側で 200 件当たる').toHaveLength(200);
    expect(overLike.truncated, 'LIKE 側で切ったのに言っていない').toBe(true);
    expect((await detail('ちょ', 'c2')).truncated).toBe(false);
  });

  it('空は 0 件 / FTS の演算子を打っても壊れない', async () => {
    expect((await detail('  ')).rows).toEqual([]);
    await expect(detail('AND OR "x*')).resolves.toBeTruthy();
  });

  it('🔴 本物の store-port を通しても行がそのまま届く', async () => {
    const client: StoreClientLike = {
      request: (req) => call(req as StorageRequest) as never,
      terminate: () => {},
    };
    const port = createStorePort(client, CID3);
    const r = await port.searchDetail!('全文検索');
    expect(r.rows.find((x) => x.lid === 'a')?.snippet, 'store-port が抜粋を落とした').toContain(
      marked('全文検索'),
    );
    expect(r.truncated).toBe(false);
  });
});
