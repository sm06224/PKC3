/**
 * 貼り付けた画像に名前を付ける(#250。user 指示 2026-08-18)。
 *
 * ⚠ **クリップボードの画像に名前は無い。** 付けないと一覧で「(名前なし)」が並び、
 * あとから探せない ── **貼った日時**を名前にする。
 *
 * ⚠ **拡張子は mime から引く**(名前から引くのは逆向き)。知らない型は `png` に倒す
 * ── スクショはほぼ png で、拡張子が無いと書き出しで種類を失う。
 * ⚠ `features/` 層なので **`Date` を作らない**(呼び側が渡す ── 純関数のまま保つ)。
 */
const EXT: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
};

/**
 * 🔴 **本物の名前を持つ file はその名前を使う**(#1087)。
 * ⚠ 使わないのは、名前が空のとき と、ブラウザがクリップボードの画像に付ける既定の名前
 *   (`image.png` / `image.jpg` など、`image` + 拡張子)のとき ── 後者は貼った日時の名前のほうが探せる。
 */
export function pastedFileName(
  file: { readonly type: string; readonly name?: string },
  at: Date,
): string {
  const real = (file.name ?? '').trim();
  if (real === '' || /^image\.[A-Za-z0-9]{1,5}$/i.test(real)) return pastedImageName(file, at);
  return real;
}

/** 2 桁に揃える(`1` → `01`)。 */
const two = (n: number): string => String(n).padStart(2, '0');

/**
 * `2026-08-18-043215` の形(**時分秒**の 6 桁)。
 * 🔑 **収録の名前もこれを使う**(#413)── 一覧に並ぶ物の日時の形を 2 つにしない
 *   (CLAUDE.md §7「同じ値・同じ判定が複数の場所にある」)。
 */
export function assetStamp(at: Date): string {
  return (
    `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}` +
    `-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`
  );
}

/**
 * `スクリーンショット-2026-08-18-043215.png` の形(時刻は **時分秒**の 6 桁)。
 * ⚠ 秒まで入れる ── 同じ分に 2 枚貼ることは普通に起きる(名前が衝突しても
 * 中身が同じなら content addressing が 1 件に畳むが、**別の絵は別の名前**であるべき)。
 *
 * ⚠ `prefix` は**どこから来た画像か**を名乗る(#251)。クリップボードの生画像は
 * スクショだが、**貼り付けた HTML の中に居た画像**(`data:` / `blob:`)は違う ──
 * 一覧に「スクリーンショット」が並ぶと、あとから探すときに嘘の手がかりになる。
 * ⚠ 拡張子の対応表は**この 1 か所**のまま(名前ごとに表を増やさない)。
 */
export function pastedImageName(
  file: { readonly type: string },
  at: Date,
  prefix = 'スクリーンショット',
): string {
  const ext = EXT[file.type.toLowerCase()] ?? 'png';
  return `${prefix}-${assetStamp(at)}.${ext}`;
}

/**
 * 1 回の貼り付け・取り込みの中で、**名前が重ならないようにする**(同じ秒に貼った複数枚は
 * 時刻の名前が同じになる)。重なったら拡張子の前に `-2`、`-3` を付ける。
 * ⚠ 呼び側は**1 回の貼り付けごとに作る**(別の回と名前を揃える必要は無い)。
 */
export function createNameDeduper(): (name: string) => string {
  const used = new Set<string>();
  return (name) => {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let out = name;
    for (let n = 2; used.has(out); n++) out = `${stem}-${n}${ext}`;
    used.add(out);
    return out;
  };
}
