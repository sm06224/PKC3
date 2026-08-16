/**
 * 🔴 **保存された bytes を OPFS へ置く**(#205 段 A / 方式監査 #209 の **B2**)。
 *
 * ⚠ **ここは「置く」だけ。** 取り出す側(drain / sweep)は本体の TypeScript
 * (`src/adapter/platform/office/office-stage.ts`)に在る ── **同じ棚**を 2 つの
 * 実装が触るので、棚の名前と file の綴りは `tests/adapter/office-stage.test.ts` が
 * **両方の file を読んで**突き合わせる(CLAUDE.md §7「同じ値が複数の場所にある」)。
 *
 * ## なぜ中継が要るのか(B4 ── 定義の隣に理由を書く)
 *
 * 🔴 **sqlite の `assets` 行を書けるのは writer リースを持つタブだけ**である
 * (OPFS SAHPool は実質単一接続 ── `src/adapter/platform/storage/writer-lease.ts`)。
 * **Office の窓は絶対に書けない。** だから bytes は窓が置き、meta の確定は
 * リース保持タブがやる ── これは「あった方がよい中継」ではなく **2 相コミット**である。
 * ⚠ この理由を消すと、次に読む人が「ただの中継」と読んで消す。
 *
 * ## なぜ OPFS なのか(⚠ 1 度書き直した)
 *
 * 実測(#209、32MiB を書いた直後に窓を閉じる):**`Blob` を境界の向こうへ渡すと
 * 落ちる**(`ERR_SOURCE_DIED_IN_TRANSIT`。IDB Blob は 4/4 と 3/3 で ERR)。
 * `Uint8Array` なら IDB も BroadcastChannel も無事 ── **黙ったコピーこそが安全性の正体**。
 * 🔑 その上で OPFS を選ぶ理由は**常駐メモリの形**だけである:
 *
 * | 経路 | 山の高さ |
 * |---|---|
 * | `FS.readFile` → IDB / BC | MEMFS の実体 + **丸ごとの複製**(構造化複製でもう 1 部) |
 * | **`FS.read` で 1MiB ずつ → OPFS** | MEMFS の実体 + **1MiB** |
 *
 * ⚠ **設計 doc の書きぶりはここで 1 段弱い。** doc は「slice 単位で書けるので平ら」と
 * 書いていたが、`FS.readFile` を使うと**その時点で丸ごと 1 部**できてしまうので、
 * 平らになるのは**読む側も刻んだとき**だけである。だからここは `FS.readFile` を
 * 使わず、**`FS.read` で刻んで読む**(不可侵指示 2026-07-27「ゼロコピー、生成と
 * ライフサイクル後の速やかな破棄」の当の場所)。
 *
 * 🔑 **覆る条件**: 扱う文書が十分小さいと決まる / Safari の `createWritable` が
 * 使えない → **IDB + `Uint8Array` のほうが単純で同じだけ安全**(技術が 1 つ減る)。
 *
 * ## 置き方 ── `.bin` を先、`.json` を後(これが commit の印)
 *
 * OPFS には rename が無い(`move()` は Chromium 限定)ので、**2 つの file の順序**で
 * 原子性を作る:
 *
 * 1. `<鍵>.bin` … bytes。書き終えて `close()` する
 * 2. `<鍵>.json` … meta。**これが在ることが「完全に置けた」の印**
 *
 * → `.json` が在って `.bin` が無い、は起こらない。`.bin` だけ残ったものは
 * **書きかけの残骸**なので、起動時の掃除が消す(B5)。
 */
(function (root) {
  'use strict';

  /** 🔴 棚の名前。⚠ TypeScript 側の `OFFICE_STAGE_DIR` と**同じ綴り**(test が突合)。 */
  var STAGE_DIR = 'pkc3-office-stage';

  /** meta の版。⚠ 読む側が古い形を見分けられるようにする。 */
  var STAGE_META_VERSION = 1;

  /** 1 回に運ぶ量。⚠ ここが**山の高さ**そのものになる(上の表)。 */
  var CHUNK = 1024 * 1024;

  /**
   * 鍵を作る。⚠ **時刻だけでは足りない** ── 同じミリ秒に 2 つ置くことがあるうえ、
   * 窓は複数枚ありうる。`randomUUID` が在れば使う(host は secure context)。
   */
  function makeKey(deps) {
    var d = deps || {};
    var uuid = d.uuid;
    if (typeof uuid === 'function') return 'o' + uuid().replace(/-/g, '');
    var now = typeof d.now === 'function' ? d.now() : Date.now();
    var n = typeof d.seq === 'function' ? d.seq() : 0;
    return 'o' + now.toString(36) + '-' + String(n);
  }

  /**
   * 🔴 **刻んで読み、刻んで書く。**
   *
   * @param deps.dir    OPFS の棚(`FileSystemDirectoryHandle` 相当。⚠ test が差せる)
   * @param deps.size   全体の大きさ(byte)
   * @param deps.read   `(into, wanted, position) -> 読めた byte 数`。
   *                    ⚠ **`into` は使い回される** ── 呼ばれた側は溜め込まない
   * @param deps.meta   `{ name, path, token, win }`(⚠ bytes は入れない)
   * @param deps.key    鍵(省略時は `makeKey`)
   * @returns `{ key, name, size }`
   */
  async function stageBytes(deps) {
    var dir = deps.dir;
    var size = deps.size;
    if (!dir) throw new Error('stage: 棚が無い');
    if (!(size > 0)) throw new Error('stage: 空は置かない');
    var key = deps.key || makeKey(deps);
    var meta = deps.meta || {};

    var binHandle = await dir.getFileHandle(key + '.bin', { create: true });
    var w = await binHandle.createWritable();
    // ⚠ **1 本だけ確保して使い回す**(刻む意味が消えるので毎回作らない)
    var buf = new Uint8Array(Math.min(CHUNK, size));
    var pos = 0;
    try {
      while (pos < size) {
        var wanted = Math.min(buf.length, size - pos);
        var got = deps.read(buf, wanted, pos);
        // ⚠ **短く返ってきたら諦める** ── 途中まで書いた `.bin` は `.json` を
        //    置かないので、掃除の対象として消える(半端な添付を作らない)
        if (!(got > 0)) throw new Error('stage: 読めなくなった @' + pos);
        // ⚠ `await` してから buf を作り直す(write は同期に複製する規定だが、
        //    待てば実装差に関係なく安全である)
        await w.write(buf.subarray(0, got));
        pos += got;
      }
      await w.close();
    } catch (e) {
      // ⚠ 失敗したら**書きかけを閉じる**。閉じないと OPFS の口が開いたまま残る
      try { await w.abort(); } catch (e2) { /* 既に閉じている */ }
      throw e;
    }

    var record = {
      v: STAGE_META_VERSION,
      key: key,
      name: String(meta.name || 'document'),
      path: String(meta.path || ''),
      size: size,
      at: typeof deps.now === 'function' ? deps.now() : Date.now(),
    };
    // ⚠ token / win は**在るときだけ**入れる(無い field を作らない)
    if (meta.token) record.token = String(meta.token);
    // 🔴 置いた窓の id(#217)。⚠ 引き取る側が `path` で同じ文書を束ねる**前提**である
    //    ── これが無い meta は束ねられない(別の窓の同名文書と潰さないため)
    if (meta.win) record.win = String(meta.win);

    var metaHandle = await dir.getFileHandle(key + '.json', { create: true });
    var mw = await metaHandle.createWritable();
    await mw.write(JSON.stringify(record));
    await mw.close();
    return { key: key, name: record.name, size: size };
  }

  /** OPFS の棚を開く(無ければ作る)。⚠ 無い環境では `null` を返す(落とさない)。 */
  async function openStageDir(storage) {
    var s = storage || (typeof navigator !== 'undefined' ? navigator.storage : null);
    if (!s || typeof s.getDirectory !== 'function') return null;
    var root_ = await s.getDirectory();
    return await root_.getDirectoryHandle(STAGE_DIR, { create: true });
  }

  root.PKC3OfficeStage = {
    STAGE_DIR: STAGE_DIR,
    STAGE_META_VERSION: STAGE_META_VERSION,
    CHUNK: CHUNK,
    makeKey: makeKey,
    stageBytes: stageBytes,
    openStageDir: openStageDir,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
