/**
 * 編集した PDF を、本体へ渡すために **OPFS の棚へ置く**(#275 段②-1b)。
 *
 * Office の窓の保存(`public/office/office-save-stage.js`)と**同じ鎖・同じ置き方**:
 * 窓が棚へ bytes を置き、放送で「置いた」と言い、**書ける本体(writer リースを持つタブ)が棚から読んで
 * 新しい添付を作る**。🔴 sqlite の `assets` 行を書けるのは本体だけで、窓は書けない(2 相コミット)。
 *
 * ## 置き方 ── `.bin` を先、`.json` を後(これが「置き切った」の印)
 * OPFS には rename が無いので、2 つの file の順序で原子性を作る(Office の棚と同じ)。
 * `.json` が在って `.bin` が無い、は起こらない。`.bin` だけ残ったものは書きかけで、本体が猶予の後に掃除する。
 *
 * ⚠ 棚の名前と file の綴りは本体側(`src/adapter/platform/pdf/save-edited.ts` の `PDF_STAGE_DIR`)と
 *   **同じ値** ── `tests/adapter/pdf-edit-stage.test.ts` が両方の file を読んで突き合わせる。
 *   meta の形は Office の棚と同じ(`v` / `key` / `name` / `size` / `at`)で、本体は
 *   `office-stage.ts` の読み手(`listStaged` / `readStaged` / `discardStaged`)をそのまま使う。
 * ⚠ 素の JS(classic script)── `public/` の窓は bundle を通らない。
 */
(function (root) {
  'use strict';

  /** 棚の名前。⚠ 本体の `PDF_STAGE_DIR` と同じ綴り。Office の棚(`pkc3-office-stage`)とは**別** ── 取り違えて Office の保存として取り込まない。 */
  var STAGE_DIR = 'pkc3-pdf-stage';
  /** meta の版。⚠ 読み手(`office-stage.ts` の `OFFICE_STAGE_META_VERSION`)と同じ値。 */
  var META_VERSION = 1;
  /** 1 回に書く量。大きな PDF を 1 度に書かず、刻んで書く(OPFS へ複製する量の山を低くする)。 */
  var CHUNK = 1024 * 1024;

  /** 鍵。同じミリ秒に複数枚の窓が置いても重ならないよう、乱数を使う。 */
  function makeKey() {
    var u = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : null;
    return 'p' + (u !== null ? u.replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2));
  }

  /** 棚を開く(無ければ作る)。無い環境では `null`(落とさない)。 */
  async function openDir(storage) {
    var s = storage || (typeof navigator !== 'undefined' ? navigator.storage : null);
    if (!s || typeof s.getDirectory !== 'function') return null;
    var top = await s.getDirectory();
    return await top.getDirectoryHandle(STAGE_DIR, { create: true });
  }

  /**
   * bytes を置く。@param deps.dir 棚 @param deps.bytes `Uint8Array` @param deps.name 新しい添付の名前
   * @param deps.now 時刻(省略時は `Date.now`。test が差す)
   * @returns `{ key, name, size }`(放送で本体へ渡す物)。失敗したら**書きかけを閉じて**投げる。
   */
  async function stageBytes(deps) {
    var bytes = deps.bytes;
    var size = bytes.byteLength;
    if (!deps.dir) throw new Error('stage: 棚が無い');
    if (!(size > 0)) throw new Error('stage: 空は置かない');
    var key = deps.key || makeKey();
    var bin = await deps.dir.getFileHandle(key + '.bin', { create: true });
    var w = await bin.createWritable();
    try {
      for (var pos = 0; pos < size; pos += CHUNK) {
        await w.write(bytes.subarray(pos, Math.min(size, pos + CHUNK)));
      }
      await w.close();
    } catch (e) {
      // 閉じないと OPFS の口が開いたまま残る
      try {
        await w.abort();
      } catch (e2) {
        /* 既に閉じている */
      }
      throw e;
    }
    var record = { v: META_VERSION, key: key, name: String(deps.name), path: '', size: size, at: typeof deps.now === 'function' ? deps.now() : Date.now() };
    var meta = await deps.dir.getFileHandle(key + '.json', { create: true });
    var mw = await meta.createWritable();
    await mw.write(JSON.stringify(record));
    await mw.close();
    return { key: key, name: record.name, size: size };
  }

  root.PkcPdfEditStage = {
    STAGE_DIR: STAGE_DIR,
    META_VERSION: META_VERSION,
    CHUNK: CHUNK,
    makeKey: makeKey,
    openDir: openDir,
    stageBytes: stageBytes,
  };
})(typeof self !== 'undefined' ? self : this);
