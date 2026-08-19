/**
 * asset bytes の置き場 = IndexedDB の Blob record(設計 doc §4.2)。
 *
 * bytes を sqlite(WASM リニアメモリ)に通さないための独立層:
 * - IDB の Blob 値は structured clone で JS heap の外に置かれ、ブラウザがディスクへ
 *   退避できる(PKC2 実測: base64 200MB 読出 +293MB 常駐 vs Blob ±0)
 * - sqlite 側には assets 表の meta 行(mime / size / hash)だけを書く(storage worker)
 * - 表示は ObjectURL 経由。**URL の revoke は貸した側の責務**(メモリ 2 原則)
 *
 * main thread で動く(IDB は worker 不要)。sqlite worker とは独立。
 */
const DB_NAME = 'pkc3-assets';
const STORE = 'blobs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE))
        req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb open failed'));
  });
}

/**
 * 1 トランザクションを回す。
 *
 * 🔴 **書きは `oncomplete` まで待つ**(P8 段㉔)。IDB の request success は
 * **commit の前**に起きるので、`onsuccess` で resolve すると
 * 「書けた」と言った直後に tx が abort しうる ── quota で実際に起きる。
 *
 * 直す前の壊れ方: 空きが少ない状態で大きな `.pkc2.zip` を取り込むと、
 * `putBlob` は次々 resolve して meta 行と entry 行が sqlite に確定し、
 * IDB 側だけが commit 時に `QuotaExceededError` で abort する。取込は
 * 「取込完了: N 件」と成功を名乗り、一覧には添付ノートが並ぶ。開くと
 * 「asset が見つかりません」しか出ず、参照は生きているので整理でも回収されない
 * ── **中身の無い添付ノートが恒久的に残る**。
 * ⚠ 取込側は「bytes を先に、参照を後に」と書いている ── その順序が買うはずの
 * 保証が、ここで成立していなかった。
 *
 * ⚠ 読みは `onsuccess` のままでよい(値はそこで確定していて、commit を待つと
 * 1 往復ぶん遅くなるだけ)。
 *
 * ## 🔴 ⚠ `oncomplete` は「tx が commit した」証拠であって、**`Blob` 値の bytes が
 * 耐久化した証拠ではない**(#211。#209 段 0 の実測)
 *
 * `Blob` は「後で bytes を出す」**借用証書**で、発行した realm が生きている間しか
 * 換金できない。32MiB を書いた**直後に発行元の窓を閉じる**と、こうなる:
 *
 * | 書いたもの | chrome | headless_shell |
 * |---|---|---|
 * | IDB **Blob**(`tx.oncomplete` を待った) | **ERR 4/4** | **ERR 3/3** |
 * | IDB **Uint8Array** | ok 4/4 | ok 3/3 |
 * | OPFS(`close()` を待った) | ok 4/4 | ok 3/3 |
 *
 * 正体は `ERR_SOURCE_DIED_IN_TRANSIT` / `NotReadableError`。
 * ⚠ **256,000 B 以下は IPC に同梱されるので落ちない** ── **サイズで挙動が変わる**ので、
 * 小さい添付でいくら試しても再現しない。
 *
 * 🔑 **いま実害が無いのは、渡している `Blob` が全部「このタブが作った物」だから**である
 * (`attach.ts` の `File` / その場で作った `Blob`)。⚠ **別 realm(Office の窓 / worker /
 * iframe)が作った `Blob` を `put` する経路が 1 本でも生えたら、そこから落ちる。**
 * だから `office-stage.ts` は OPFS から `arrayBuffer()` で読んで **`Uint8Array` に
 * 落としてから** `new Blob([bytes])` している ── **「1 コピー減らせる」と最適化して
 * 直接 `File` を渡すと、ここで静かに壊れる**(`tests/adapter/office-stage.test.ts` が pin)。
 */
function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    const fail = (e: unknown): void =>
      reject(e instanceof Error ? e : new Error('idb request failed'));
    if (mode === 'readonly') {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => fail(req.error);
      return;
    }
    // 書きは **commit を待つ**。⚠ `req.onsuccess` では早すぎる
    let result: T;
    req.onsuccess = () => {
      result = req.result;
    };
    t.oncomplete = () => resolve(result);
    t.onerror = () => fail(t.error);
    t.onabort = () => fail(t.error ?? new Error('idb transaction aborted'));
  });
}

/**
 * joiner が ':' のため、cid に ':' が入ると `a:b` の key 空間が cid `a` の
 * prefix 範囲と交差し、**GC(listKeys → delete)が他コンテナの bytes を消す**
 * (review F3)。cid を作る側の規約に頼らず、ここで構造的に拒否する。
 */
function assertCid(cid: string): void {
  if (cid.includes(':')) throw new Error(`invalid cid (":" は使えない): ${cid}`);
}

/**
 * 🔴 **key を器と中身へ割り戻す**(#260)。⚠ 割るのは**最初の `:`** ──
 * `assertCid` が cid 側に `:` を禁じているので、これで一意に戻せる
 * (asset key 側に `:` が入っても壊れない)。
 * @returns 接頭辞を持たない key は `null`(知らない形は触らない)
 */
export function splitStoreKey(storeKey: string): { cid: string; assetKey: string } | null {
  const at = storeKey.indexOf(':');
  if (at <= 0) return null;
  return { cid: storeKey.slice(0, at), assetKey: storeKey.slice(at + 1) };
}

const key = (cid: string, assetKey: string): string => {
  assertCid(cid);
  return `${cid}:${assetKey}`;
};

export class AssetBlobStore {
  private db: IDBDatabase | null = null;

  private async need(): Promise<IDBDatabase> {
    if (!this.db) this.db = await openDb();
    return this.db;
  }

  /** Blob をそのまま格納(base64 経由禁止 ── bytes を heap に通さない)。 */
  async put(cid: string, assetKey: string, blob: Blob): Promise<void> {
    const k = key(cid, assetKey); // assert は IDB を触る前に
    await tx(await this.need(), 'readwrite', (s) => s.put(blob, k));
  }

  async get(cid: string, assetKey: string): Promise<Blob | null> {
    const k = key(cid, assetKey);
    const v = await tx(await this.need(), 'readonly', (s) => s.get(k));
    return v instanceof Blob ? v : null;
  }

  async delete(cid: string, assetKey: string): Promise<void> {
    const k = key(cid, assetKey);
    await tx(await this.need(), 'readwrite', (s) => s.delete(k));
  }

  /** cid 配下の asset key 一覧(GC の候補集めに使う。Blob 値は読まない)。 */
  async listKeys(cid: string): Promise<string[]> {
    assertCid(cid);
    const prefix = `${cid}:`;
    // 上界は「':' の次の code unit ';'」の exclusive bound ── `cid:` で始まる
    // key を全部含む(U+FFFF 始まりの asset key も漏らさない。review F3)
    const keys = await tx<IDBValidKey[]>(await this.need(), 'readonly', (s) =>
      s.getAllKeys(IDBKeyRange.bound(prefix, `${cid};`, false, true)),
    );
    return keys
      .filter((k): k is string => typeof k === 'string')
      .map((k) => k.slice(prefix.length));
  }

  /**
   * 🔴 **どの器のものでもない残骸**を拾う(#260)。
   *
   * key は `${cid}:${assetKey}` なので、`listKeys` は**自分の接頭辞しか見ない**。
   * cid が固定値だった頃はそれで足りたが、端末ごとに採番するようになると
   * **もう存在しない器の bytes** が誰の候補にも載らなくなる ── 実際に起きるのは
   * OPFS を取れず `:memory:` に落ちた回で、その回の器は次の起動には残らない。
   *
   * ⚠ **消してよいかの判定はここでしない。** ここは「全部の key を、器と中身に
   *   割って返す」だけ ── 生きている器の一覧と突き合わせるのは呼び側である
   *   (§7「誤差の向きを決めて、両側に使い回さない」── 拾うのは広く、
   *   消すのは狭く)。
   * ⚠ 割るのは **最初の `:`**。`assertCid` が cid 側に `:` を禁じているので、
   *   これで一意に戻せる(asset key 側に `:` が入っても壊れない)。
   */
  async listAll(): Promise<Array<{ storeKey: string; cid: string; assetKey: string }>> {
    const keys = await tx<IDBValidKey[]>(await this.need(), 'readonly', (s) => s.getAllKeys());
    const out: Array<{ storeKey: string; cid: string; assetKey: string }> = [];
    for (const k of keys) {
      if (typeof k !== 'string') continue;
      const split = splitStoreKey(k);
      if (split === null) continue; // 接頭辞の無い key は触らない(知らない形は消さない)
      out.push({ storeKey: k, ...split });
    }
    return out;
  }

  /** `listAll` が返した key をそのまま消す。⚠ 器の綴りを組み立て直さない。 */
  async deleteStoreKey(storeKey: string): Promise<void> {
    await tx(await this.need(), 'readwrite', (s) => s.delete(storeKey));
  }

  /**
   * 表示用 ObjectURL の貸出。返る dispose を **表示の寿命の終わりに必ず呼ぶ**
   * (revoke は所有者の責務 ── メモリ 2 原則)。
   */
  async lendObjectUrl(
    cid: string,
    assetKey: string,
  ): Promise<{ url: string; dispose: () => void } | null> {
    const blob = await this.get(cid, assetKey);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    return { url, dispose: () => URL.revokeObjectURL(url) };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
