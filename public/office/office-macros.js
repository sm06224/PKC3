/**
 * 🔴 **user が書いたマクロを、ウィンドウを閉じても残す判断**(#431 ②)。
 *
 * ## 直している実害
 *
 * LO は「My Macros」を `/instdir/user/basic/**`(MEMFS)へ書く ── `script.xlc` /
 * `dialog.xlc` の目録と `Standard/*.xba` / `*.xdl` の本体である。MEMFS は
 * **ウィンドウを閉じると消える**ので、書いたマクロは次に開くと
 * 「ツール → マクロ → マクロの実行…」の一覧に**並ばない**。
 * 設定 file(`registrymodifications.xcu`)は #159 で localStorage へ退避したが、
 * マクロは何も退避していなかった。
 *
 * ## 置き場は IndexedDB(⚠ localStorage ではない)
 *
 * localStorage は 1MB の割り当てを設定 file と奪い合う(#159 の上限がそれ)。
 * マクロは bytes のまま IndexedDB へ置く ── base64 にしない(ゼロコピーの向き)。
 * 実際に読み書きするのは `host.html`(DB を持っているのはそちら)。
 *
 * ## ⚠ ここは「判断」だけ
 *
 * FS を**引数で受ける**(走査・読み・書き戻し)── DOM も IDB も timer も触らない。
 * 🔑 そうしないと **unit が 1 件も届かない**(`host.html` は bundle されない
 * 生 HTML である ── `office-restart-watch.js` が分かれているのと同じ理由)。
 * ⚠ 素の JS(ES5 相当)で書く ── `host.html` が `<script src>` で読むので
 * bundler を通らない。
 */
(function (root) {
  'use strict';

  /** LO の user マクロ置き場(`UserInstallation=$ORIGIN/..` = `/instdir/user`)。 */
  var DIR = '/instdir/user/basic';
  /**
   * IndexedDB `pkc3-office-pack` の `meta` store に置く key。
   * ⚠ store を足さない ── DB の version は本体(`office-pack-store.ts`)と窓の
   *   両方が `1` で開くので、片方だけ上げると**もう片方が VersionError で開けない**。
   *   `meta` の別 key なら version を触らずに済む(一式の `remove()` は `pack` の
   *   key しか消さないので、一式を入れ直してもマクロは残る = 設定と同じ寿命)。
   * ⚠ 綴りは本体の `office-profile.ts` と同じでなければならない
   *   (初期化のとき本体からも消す)── `tests/adapter/office-macros.test.ts` が pin する。
   */
  var KEY = 'user-basic';
  /** 合計がこれを超えたら退避しない(理由は console に 1 行)。 */
  var MAX_BYTES = 8000000;

  /**
   * `dir` 以下の file を**再帰で**集める(stat だけ。中身は読まない)。
   * 返り値は `{ path, size, mtime }` の配列(path 順)。dir が無ければ `[]`。
   *
   * ⚠ `readdir` は `.` / `..` を含む(emscripten の MEMFS)── 飛ばさないと無限に潜る。
   */
  function scan(FS, dir) {
    var out = [];
    try { FS.stat(dir); } catch (e) { return out; }
    walk(FS, dir, out);
    out.sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });
    return out;
  }
  function walk(FS, dir, out) {
    var names = FS.readdir(dir);
    for (var i = 0; i < names.length; i += 1) {
      var name = names[i];
      if (name === '.' || name === '..') continue;
      var path = dir + '/' + name;
      var st = FS.stat(path);
      if (FS.isDir(st.mode)) {
        walk(FS, path, out);
      } else {
        out.push({ path: path, size: st.size, mtime: +st.mtime });
      }
    }
  }

  /**
   * 「前回と同じ中身か」を見るための印。中身は読まずに **path + size + mtime** で採る
   * (30 秒ごとに全 file を読んで比べるのは無駄 ── `lastSavedProfile` と同じ作法)。
   */
  function signature(entries) {
    var parts = [];
    for (var i = 0; i < entries.length; i += 1) {
      parts.push([entries[i].path, entries[i].size, entries[i].mtime]);
    }
    return JSON.stringify(parts);
  }

  function totalBytes(entries) {
    var n = 0;
    for (var i = 0; i < entries.length; i += 1) n += entries[i].size;
    return n;
  }

  /** 中身を読む。⚠ bytes は `FS.readFile` が返したまま(Uint8Array)── 変換しない。 */
  function read(FS, entries) {
    var files = [];
    for (var i = 0; i < entries.length; i += 1) {
      files.push({ path: entries[i].path, bytes: FS.readFile(entries[i].path) });
    }
    return files;
  }

  /**
   * 退避すべきものを決める。返り値の `kind`:
   *   `same`    … 前回と同じ中身 → 書かない
   *   `too-big` … 上限超 → 書かない(`bytes` を添える。呼び側が理由を 1 行出す)
   *   `empty`   … マクロが 1 つも無い → 記録を消す(user が LO の中で全部消した形)
   *   `save`    … 書く(`files` / `bytes`)
   * どの場合も `signature` を返す ── 呼び側はそれを「前回」として憶える。
   * ⚠ `too-big` でも憶える ── 憶えないと 30 秒ごとに同じ警告が出続ける。
   */
  function plan(FS, dir, lastSignature, maxBytes) {
    var entries = scan(FS, dir);
    var sig = signature(entries);
    if (sig === lastSignature) return { kind: 'same', signature: sig };
    if (entries.length === 0) return { kind: 'empty', signature: sig };
    var bytes = totalBytes(entries);
    if (bytes > maxBytes) return { kind: 'too-big', signature: sig, bytes: bytes };
    return { kind: 'save', signature: sig, bytes: bytes, files: read(FS, entries) };
  }

  /**
   * 退避した file を MEMFS へ書き戻す。書いた数を返す。
   *
   * ⚠ **`dir` の外へは書かない。** 記録は自分が書いたものだが、壊れた記録で
   *   `/instdir/program/…` を上書きされるのは起動ごと壊す側なので、path を検める。
   * ⚠ 親ディレクトリを先に作る ── MEMFS は無いと ENOENT を投げる(#159 のフォントで
   *   踏んだ「親が無いだけで起動ごと落ちる」形)。
   */
  function restore(FS, dir, files) {
    var n = 0;
    if (!Array.isArray(files)) return n;
    for (var i = 0; i < files.length; i += 1) {
      var f = files[i];
      if (!f || typeof f.path !== 'string' || f.bytes == null) continue;
      if (f.path.indexOf(dir + '/') !== 0 || f.path.split('/').indexOf('..') !== -1) continue;
      FS.mkdirTree(f.path.slice(0, f.path.lastIndexOf('/')));
      FS.writeFile(f.path, f.bytes);
      n += 1;
    }
    return n;
  }

  root.PKC3OfficeMacros = {
    DIR: DIR,
    KEY: KEY,
    MAX_BYTES: MAX_BYTES,
    scan: scan,
    signature: signature,
    totalBytes: totalBytes,
    read: read,
    plan: plan,
    restore: restore,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
