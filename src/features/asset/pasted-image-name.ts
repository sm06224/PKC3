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

/** 2 桁に揃える(`1` → `01`)。 */
const two = (n: number): string => String(n).padStart(2, '0');

/**
 * `スクリーンショット-2026-08-18-0432.png` の形。
 * ⚠ 秒まで入れる ── 同じ分に 2 枚貼ることは普通に起きる(名前が衝突しても
 * 中身が同じなら content addressing が 1 件に畳むが、**別の絵は別の名前**であるべき)。
 */
export function pastedImageName(file: { readonly type: string }, at: Date): string {
  const ext = EXT[file.type.toLowerCase()] ?? 'png';
  const stamp =
    `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}` +
    `-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  return `スクリーンショット-${stamp}.${ext}`;
}
