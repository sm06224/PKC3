/**
 * Office の「挿入 → 画像」に並べる添付を**選ぶ**(#146 裁定 A)。
 *
 * 🔑 裁定(2026-10-01):**開いているノートに付いている添付(画像)が並び、選べばすぐ文書に入る。
 * ウィンドウを閉じれば消える。** 並べ方の仕組み(箱の中の `/home/web_user` へ置く)は
 * `public/office/office-images.js`、ここは**何を何枚置くか**だけを決める(純粋な関数)。
 *
 * ## 🔴 常駐メモリの上限(不可侵指示 2026-07-27「ゼロコピー・速やかな破棄」)
 *
 * 置いた file は窓の MEMFS(= JS heap)に載り、窓を閉じるまで残る。⚠ 1 窓は既に約 750MB
 * 常駐する(`office-window.ts` の実測)。そこへ添付を**無制限に**足せば、画像を何十枚も貼った
 * ノートで常駐が跳ねる ── だから**合計の上限**を 1 つ置く。
 *
 * ⚠ **超えたら大きい順に置かない**(小さい画像を多く残すほうが、「挿入」で選べる物が多い)。
 * 置かなかった件数は呼び側が user へ 1 度だけ言う(黙って減らさない)。
 *
 * ⚠ **pure module**。browser API も storage も触らない。
 */

import { humanBytes } from '../human-bytes';

/**
 * 合計の上限(byte)。🔑 **64 MB**:窓の常駐(約 750MB)の約 1/12 で、写真 10 枚前後が入る大きさ。
 * ⚠ 規律ではなく**出発点**(予算は手違いの検出であって、サイズを守らせる規律ではない ──
 * 足りなければ引き上げてよい)。
 */
export const OFFICE_IMAGE_BUDGET_BYTES = 64 * 1024 * 1024;

/** 並べてよい画像の MIME(Qt のダイアログの「すべての画像」で選べる物)。 */
const IMAGE_EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
};

/** 拡張子の判定(`.jpeg` も `.jpg` と同じ物として数える)。 */
const KNOWN_EXTS: readonly string[] = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp',
];

/** `image/png; charset=…` のような付き物を落として小文字にする。 */
function bareMime(mime: string): string {
  return mime.split(';')[0]!.trim().toLowerCase();
}

/** 並べてよい画像か。⚠ `image/*` 全部ではない(`image/tiff` などは Qt の一覧でも選べない)。 */
export function isOfficeImageMime(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(IMAGE_EXT_BY_MIME, bareMime(mime));
}

export interface OfficeImageCandidate {
  /** 添付の key(bytes を読む鍵)。 */
  readonly key: string;
  /** 元の file 名。 */
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}

/**
 * 置く名前。⚠ **元の名前のまま**が原則 ── 拡張子が無い(または画像の拡張子でない)ときだけ、
 * MIME から足す。Qt の一覧は「すべての画像」の拡張子でしか絞らないので、
 * 拡張子が無い名前は**置いても一覧に出ない**。
 */
export function officeImageFileName(c: Pick<OfficeImageCandidate, 'name' | 'mime' | 'key'>): string {
  const name = c.name.trim() === '' ? `image-${c.key.slice(0, 8)}` : c.name;
  const lower = name.toLowerCase();
  if (KNOWN_EXTS.some((e) => lower.endsWith(e))) return name;
  return name + (IMAGE_EXT_BY_MIME[bareMime(c.mime)] ?? '');
}

export interface OfficeImagePick {
  /** 置く物(**元の並びのまま**)。 */
  readonly picked: readonly OfficeImageCandidate[];
  /** 置かなかった件数(画像でない物は**数えない** ── 並べる対象ではない)。 */
  readonly skipped: number;
}

/**
 * 並べる画像を選ぶ。
 *
 * - 画像(`isOfficeImageMime`)だけ
 * - 合計が `budget` を超えるなら、**大きい物から外す**(同じ大きさなら後ろから)
 * - 0 件なら `picked` も空(呼び側は何も渡さない)
 */
export function pickOfficeImages(
  candidates: readonly OfficeImageCandidate[],
  budget: number = OFFICE_IMAGE_BUDGET_BYTES,
): OfficeImagePick {
  const images = candidates.filter((c) => isOfficeImageMime(c.mime) && c.size > 0);
  let total = images.reduce((n, c) => n + c.size, 0);
  if (total <= budget) return { picked: images, skipped: 0 };
  // 大きい順(同じなら後ろ=添え字の大きい側を先に外す)
  const order = images
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.size - a.c.size || b.i - a.i);
  const dropped = new Set<number>();
  for (const { c, i } of order) {
    if (total <= budget) break;
    dropped.add(i);
    total -= c.size;
  }
  return {
    picked: images.filter((_c, i) => !dropped.has(i)),
    skipped: dropped.size,
  };
}

/**
 * 並べなかった物を言う 1 行。⚠ どちらも 0 件なら空(言わない)。
 * 字は `ui-terms.ts` の使わない語を避ける(置いていない = 「並べていません」)。
 *
 * @param over 上限を超えて外した件数
 * @param unread 選んだのに読めなかった件数(別の理由なので**文を分ける** ── 上限の話に混ぜない)
 */
export function skippedImagesNotice(over: number, unread = 0): string {
  const parts: string[] = [];
  if (over > 0) {
    // ⚠ 大きさの綴りは `human-bytes.ts` の 1 本だけ(自前で `MB` を書かない)
    parts.push(
      `「挿入 → 画像」に並べる添付は合計 ${humanBytes(OFFICE_IMAGE_BUDGET_BYTES)} までです。大きい順に ${over} 件は並べていません`,
    );
  }
  if (unread > 0) parts.push(`読めなかった添付が ${unread} 件あり、並べていません`);
  return parts.join('。');
}
