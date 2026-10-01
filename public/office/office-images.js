/**
 * 🔴 **「挿入 → 画像」の一覧に、そのノートの添付(画像)を並べる**(#146 裁定 A)。
 *
 * ## なぜこれで並ぶのか(2026-08-30 の実測)
 *
 * 「挿入 → 画像」は **Qt のファイルダイアログ**で、見ているのは emscripten の仮想
 * ファイルシステムである。初期位置は `/home/web_user`(実測)── そこへ png を置けば
 * 一覧に出る。**ダイアログの差し替え口は無いし、要らない**。要るのは
 * 「PKC がそのノートの添付を、箱の中へ置くこと」だけである。
 *
 * ## 🔴 置いた file を「保存」と取り違えない
 *
 * `office-save-watch.js` は `/work` と `/home/web_user` の**直下**で起きた
 * `close` / `rename` を「保存」として PKC へ返す。LO が画像を**読み終えて閉じた**だけでも
 * `close` は来る ── 置いた file をそのまま放っておくと、**画像を 1 枚挿すたびに
 * 「保存された」と PKC へ流れて新しい添付ノートが増える**。
 * 🔑 直しは**開いた文書と同じ作法**(`setBaseline`)── 置いた直後の大きさと mtime を
 * 控え、`office-save-watch.js` の「起動時と同じなら保存ではない」に任せる。
 * ⚠ 新しい除外の仕組みは作らない(判定が 2 か所になる)。user が同じ名前で
 * 上書き保存すれば大きさか mtime が動くので、**本物の保存は今までどおり拾われる**。
 *
 * ## 片づけは要らない
 *
 * 置き先は MEMFS(窓の JS heap)で、窓を閉じれば FS ごと消える。⚠ 窓は `noopener` の
 * 別 process なので、閉じた瞬間に丸ごと還る(`office-window.ts` の実測 99%)。
 * 🔑 だから**消す処理を書かない** ── 書くと「閉じる前に消す」という別の仕事が増える。
 *
 * ⚠ **ここは「判断」と FS への書き込みだけ。** `FS` は呼び側が渡す ── DOM も放送も触らない。
 * `host.html` は bundle されず unit が届かないので、判断はここへ出して
 * `tests/adapter/office-images.test.ts` が**実 file を読んで**当てる。
 * ⚠ 素の JS(ES5 相当)で書く ── `<script src>` で読むので bundler を通らない。
 */
(function (root) {
  'use strict';

  /** Qt のファイルダイアログの初期位置(2026-08-30 の実測)。⚠ `office-save-watch.js` の見張りの 1 つ。 */
  var IMAGE_DIR = '/home/web_user';

  /**
   * 置く名前を決める。⚠ **元の名前のまま**が原則で、変えるのは次の 3 つだけ:
   * - 区切り(`/` `\`)より前を落とす(置き先の外へ出さない)
   * - 空 / `.` / `..` / 先頭が `.` の名前は `_` を前に付ける
   *   (先頭 `.` は `office-save-watch.js` が「LO の持ち物」として読み飛ばす名前でもある)
   * - 既に置いた名前と重なるなら ` (2)` ` (3)` を拡張子の前へ付ける
   *   ⚠ **黙って上書きしない** ── 貼った画像は同じ名前が何枚も在りうる
   *
   * @param taken 置き済みの名前の表(`Object.create(null)`)。⚠ 呼び側が 1 回の置き込みの間持ち回る
   */
  function placedName(raw, taken) {
    var s = String(raw == null ? '' : raw);
    var cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    if (cut >= 0) s = s.slice(cut + 1);
    if (s === '' || s === '.' || s === '..') s = '_' + s;
    else if (s.charAt(0) === '.') s = '_' + s;
    var dot = s.lastIndexOf('.');
    var stem = dot > 0 ? s.slice(0, dot) : s;
    var ext = dot > 0 ? s.slice(dot) : '';
    var name = s;
    var n = 1;
    while (taken[name]) {
      n += 1;
      name = stem + ' (' + n + ')' + ext;
    }
    taken[name] = true;
    return name;
  }

  /**
   * 画像を `/home/web_user` へ置く。
   *
   * @param FS emscripten の FS(`mkdirTree` / `writeFile` / `stat` を使う)
   * @param images `[{name, bytes}]`(`bytes` は ArrayBuffer か Uint8Array)
   * @returns 置けたものの `[{path, size, mtimeMs}]`。⚠ **1 枚のしくじりで全部を止めない**
   *   (読めない 1 枚のために、残りの画像まで並ばなくなる)
   */
  function placeImages(FS, images) {
    var placed = [];
    if (!images || !images.length) return placed;
    try { FS.mkdirTree(IMAGE_DIR); } catch (e) { /* 既に在る */ }
    var taken = Object.create(null);
    for (var i = 0; i < images.length; i += 1) {
      var img = images[i];
      if (!img || !img.bytes) continue;
      var path = IMAGE_DIR + '/' + placedName(img.name, taken);
      try {
        FS.writeFile(path, img.bytes instanceof Uint8Array ? img.bytes : new Uint8Array(img.bytes));
        // ⚠ `mtime` は **Date**(MEMFS の `getattr` が `new Date(...)` を返す ── 保存の見張りと同じ読み方)
        var st = FS.stat(path);
        placed.push({ path: path, size: st.size, mtimeMs: st.mtime.getTime() });
      } catch (e) {
        console.warn('image skipped: ' + path, e);
      }
    }
    return placed;
  }

  /**
   * 置いた file を「開いただけ」の側へ載せる(= 保存として返させない)。
   * ⚠ **見張りを積んだ後ではなく、積む時に呼ぶ**(`armSaveWatch` の baseline と同じ場所)。
   *
   * @param watch `office-save-watch.js` の `createSaveWatch()` の戻り値
   */
  function seedBaseline(watch, placed) {
    if (!watch || !placed) return;
    for (var i = 0; i < placed.length; i += 1) {
      watch.setBaseline(placed[i].path, placed[i].size, placed[i].mtimeMs);
    }
  }

  root.PKC3OfficeImages = {
    IMAGE_DIR: IMAGE_DIR,
    placedName: placedName,
    placeImages: placeImages,
    seedBaseline: seedBaseline,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
