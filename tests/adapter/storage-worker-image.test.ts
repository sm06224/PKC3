/**
 * 🔴 **DB 画像の出し入れ**(#400 段③ ── 可搬単一 HTML の永続経路)。
 *
 * `file://` では OPFS が取れない(opaque origin)ので、永続は
 * 「**画像を丸ごと器へ書く**」しかない。ここはその**両端**を実物の sqlite で見る。
 *
 * ## ⚠ この file が守っているいちばん大事なこと
 *
 * **素の PKC3 の経路が 1 バイトも変わっていないこと。** `memory` / `image` を
 * 渡さない `init` は、いままでどおり OPFS を試して落ちる(node に OPFS は無い)──
 * `fallbackReason` が載ることがその観測点である。
 * ⚠ これが無いと、可搬のために足した分岐が**全 user の起動経路を静かに変えても**
 * 誰も気づけない(#297 が起きたのはまさにこの関数である)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';

type Op = StorageRequest['op'];

/** 1 個の worker 実体。⚠ `init` は冪等なので、形を変えるたびに**作り直す**。 */
interface Worker {
  request<O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]>;
  close(): Promise<void>;
}

/**
 * 🔴 **生きている worker は常に 1 本**(ハーネスの欠陥を 1 度踏んで分かった)。
 *
 * ⚠ worker の中の `postMessage(...)` は **呼ぶたびに global を引く**ので、
 *   2 本目を建てた瞬間に **1 本目の返事が 2 本目の受け皿へ落ちる** ──
 *   1 本目への依頼は永久に resolve せず、後始末が時間切れで死ぬ。
 * 🔑 だから `spawn()` は**前の 1 本を畳んでから**建てる。
 */
let live: Worker | null = null;

async function spawn(): Promise<Worker> {
  if (live) {
    await live.close().catch(() => undefined);
    live = null;
  }
  vi.resetModules();
  const pending = new Map<number, (resp: StorageResponse) => void>();
  let seq = 0;
  const workerSelf: {
    onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
  } = { onmessage: null };
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const send = <O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (resp) =>
        resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error)),
      );
      workerSelf.onmessage!({ data: { id, req } });
    });
  const w: Worker = {
    request: send,
    close: async () => {
      await send({ op: 'close' });
    },
  };
  live = w;
  return w;
}

afterEach(async () => {
  if (live) await live.close().catch(() => undefined);
  live = null;
});

/** 復元したことが**行として**見える最小の中身。 */
async function seed(w: Worker, body: string): Promise<void> {
  await w.request({ op: 'openContainer', cid: 'c1', title: 'unit' });
  await w.request({
    op: 'upsertEntry',
    cid: 'c1',
    entry: {
      lid: 'e1',
      title: '題',
      archetype: 'text',
      body,
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
    },
    checkpoint: false,
  });
}

describe('#400 段③ ── 素の経路は変わらない(対照群)', () => {
  it('memory を頼まなければ OPFS を試す ── 落ちた理由が載る', async () => {
    const w = await spawn();
    const init = await w.request({ op: 'init', dbName: 'plain' });
    // node に OPFS は無いので必ず落ちる。⚠ **落ちたことが載る**のが観測点で、
    // 「memory になった」だけでは `memory: true` と見分けが付かない
    expect(init.vfs).toBe('memory');
    expect(init.fallbackReason).toBeTruthy();
    expect(init.restoredBytes).toBeUndefined();
  }, 30_000);

  it('memory を頼んだら「落ちた理由」を名乗らない', async () => {
    const w = await spawn();
    const init = await w.request({ op: 'init', dbName: 'portable', memory: true });
    expect(init.vfs).toBe('memory');
    // 🔴 選んだ形を事故として告げない ── 状態行に `⚠ SecurityError …` が出てしまう
    expect(init.fallbackReason).toBeUndefined();
  }, 30_000);
});

describe('#400 段③ ── 画像の出し入れ', () => {
  it('書いた中身が、別の worker で画像から読み直せる', async () => {
    const a = await spawn();
    await a.request({ op: 'init', dbName: 'p1', memory: true });
    await seed(a, '一行目\n二行目\n');
    const { image } = await a.request({ op: 'exportImage' });
    // 空振り防止: 画像が本当に出ている(0 バイトなら以降の主張は全部無意味)
    expect(image.byteLength).toBeGreaterThan(1000);

    const b = await spawn();
    const init = await b.request({ op: 'init', dbName: 'p1', memory: true, image });
    // 🔴 **「読めた」だけでは足りない** ── 空の器でも schema を当てれば同じ形になる。
    //   当てた量が載っていることを見る
    expect(init.restoredBytes).toBe(image.byteLength);
    expect(await b.request({ op: 'getBody', cid: 'c1', lid: 'e1' })).toBe('一行目\n二行目\n');
  }, 60_000);

  it('🔴 復元した DB は**書ける**(領域を伸ばせる)', async () => {
    const a = await spawn();
    await a.request({ op: 'init', dbName: 'p2', memory: true });
    await seed(a, 'もと\n');
    const { image } = await a.request({ op: 'exportImage' });

    const b = await spawn();
    await b.request({ op: 'init', dbName: 'p2', memory: true, image });
    /**
     * ⚠ `RESIZEABLE` を落とすと、**画像より 1 バイトも大きくできない DB** になる。
     * 開けるし読めるので、**書くまで気づけない** ── だからここで書く。
     * 🔑 1 行では足りない(余白に収まる)ので、**画像より確実に大きくする**。
     */
    const big = 'あ'.repeat(20_000);
    await b.request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: {
        lid: 'e2',
        title: '大きい',
        archetype: 'text',
        body: big,
        entryOrder: 2,
        status: null,
        date: null,
        archived: false,
      },
      checkpoint: false,
    });
    expect(await b.request({ op: 'getBody', cid: 'c1', lid: 'e2' })).toBe(big);
    // もとの行も生きている(書けたが壊れた、を排除する)
    expect(await b.request({ op: 'getBody', cid: 'c1', lid: 'e1' })).toBe('もと\n');
  }, 60_000);

  it('壊れた画像は黙って捨てず、断る', async () => {
    const w = await spawn();
    const junk = new Uint8Array(4096).fill(0x41);
    await expect(
      w.request({ op: 'init', dbName: 'p3', memory: true, image: junk }),
    ).rejects.toThrow(/DB 画像を読み込めませんでした/);
  }, 30_000);

  it('🔴 memory を頼まずに画像を渡したら断る(OPFS の DB を memory に化けさせない)', async () => {
    const w = await spawn();
    /**
     * ⚠ **node に OPFS は無い**ので、「開いた後の `vfs`」で判定する門は
     *   この環境では 1 度も通らない(CLAUDE.md §2「経路が一度も通っていない」)。
     * 🔑 だから製品側の門は**頼まれた形**で断る ── それはどこでも同じように鳴る。
     * ⚠ もしここが `SQLITE_NOTADB` で落ちたら、それは**門が消えて中身まで
     *   進んでいる**合図である(文言で見分ける)。
     */
    await expect(
      w.request({ op: 'init', dbName: 'p4', image: new Uint8Array([1, 2, 3]) }),
    ).rejects.toThrow(/memory: true と一緒に/);
  }, 30_000);

  it('init していない worker は画像を出さない', async () => {
    const w = await spawn();
    await expect(w.request({ op: 'exportImage' })).rejects.toThrow(/:memory:/);
  }, 30_000);
});
