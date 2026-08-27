/**
 * 🔴 **写真を縮めるかどうかを決める**(#412)。
 *
 * ## なぜ要るか
 *
 * user 報告(PKC2 時代):「**写真をそのまま添付すると原寸で入る**」。
 * いまの携帯は 1 枚 4000×3000 / 5〜12MB が普通なので、**数枚で数十 MB** になる。
 * ⚠ PKC3 は wasm-sqlite + IDB Blob に置くので、**器の空きを直に食う**
 * (`storeAsset` は空きが足りなければ**投げる**)。
 *
 * PKC2 は「**縮めますか**」と聞いていた ── その動線を戻す。
 *
 * ## 🔑 決めるのはここ、実際に縮めるのはワーカー
 *
 * ⚠ 縮める処理(復号 → 再符号化)は**重い**ので、メインでは回さない
 * (user 指示 2026-08-03「基本的に重い処理はワーカーにしてください」)。
 * ここは**判断だけ**の純関数 ── DOM も canvas も持たない。
 *
 * ## ⚠ 勝手に縮めない
 *
 * 🔴 **写真は user のものである。** 縮めるのは**不可逆**(元の画素は戻らない)なので、
 * **必ず聞く**。⚠ 「小さくなるからいいだろう」で黙って落とさない。
 * 🔑 だから**縮めてから、本当の数字を見せて聞く**(見積もりで嘘をつかない)──
 * 断られたら縮めたほうを**その場で捨てる**(2026-07-27 の不可侵指示:
 * 生成物はライフサイクル終端で即破棄)。
 */
import { humanBytes } from '../human-bytes';

/** 縮める相手にする形式。⚠ **これ以外は触らない**(SVG は画素ではない / GIF は動く)。 */
export const SHRINKABLE: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/**
 * 🔴 **これ未満は聞かない**(1.5MB)。
 *
 * ⚠ 小さい画像で毎回聞くと、**確認が邪魔なだけの機構**になる
 * (PKC2 の「毎回聞く」は user に嫌われた形である)。
 * 🔑 携帯の写真は 2MB を超えるので、この線なら**写真だけ**に当たる。
 */
export const SHRINK_MIN_BYTES = 1_500_000;

/**
 * 🔴 **長辺の目安**(2048px)。
 *
 * ⚠ 画面で見るぶんには 2048 で足りる(4K の縦でも 2160)。
 * ⚠ **これ以下の画像は縮めない** ── 既に十分小さいものを再符号化すると、
 *   画質だけ落ちて大きさが変わらないことがある。
 */
export const SHRINK_MAX_EDGE = 2048;

/** 再符号化の品質(JPEG / WebP)。⚠ 0.82 は「拡大しなければ差が分からない」線。 */
export const SHRINK_QUALITY = 0.82;

/**
 * 🔴 **縮めた結果がこれだけ小さくならないなら、採らない**(元の 85%)。
 *
 * ⚠ 再符号化は**大きくなることがある**(PNG のスクショを JPEG にすると増える等)。
 * 🔑 「縮めますか」と聞いておいて**増えている**のは、いちばん質の悪い裏切りである。
 */
export const SHRINK_MIN_GAIN = 0.85;

/** 縮めた後の狙い。 */
export interface ShrinkPlan {
  readonly width: number;
  readonly height: number;
  readonly quality: number;
  /** 再符号化の形式。⚠ **PNG は JPEG にしない**(透過が落ちる)。 */
  readonly mime: string;
}

/**
 * 縮める狙いを決める。⚠ **縮めないときは `null`**。
 *
 * @param mime 添付の MIME
 * @param bytes いまの大きさ
 * @param width / height いまの画素数(`0` = 読めなかった)
 */
export function shrinkPlan(
  mime: string,
  bytes: number,
  width: number,
  height: number,
): ShrinkPlan | null {
  if (!SHRINKABLE.has(mime)) return null;
  if (bytes < SHRINK_MIN_BYTES) return null;
  // ⚠ 画素が読めなかったものは触らない(壊れた画像を再符号化して**壊し直す**)
  if (width <= 0 || height <= 0) return null;
  const edge = Math.max(width, height);
  if (edge <= SHRINK_MAX_EDGE) return null;
  const scale = SHRINK_MAX_EDGE / edge;
  return {
    // ⚠ **1px を下回らせない**(極端に細長い画像で 0 になる)
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: SHRINK_QUALITY,
    // 🔑 **形式は変えない** ── PNG の透過を黙って落とさない
    mime,
  };
}

/**
 * 縮めた結果を**採るか**。⚠ 十分小さくなっていなければ捨てる。
 *
 * 🔑 呼び側はこれが `false` なら**元のまま**取り込む(聞きもしない)。
 */
export function worthShrinking(before: number, after: number): boolean {
  return after < before * SHRINK_MIN_GAIN;
}

/**
 * 聞く文言。⚠ **本当の数字で書く**(見積もりを見せない)。
 *
 * 🔑 user が見るのは「どれだけ小さくなるか」と「どれだけ粗くなるか」の 2 つなので、
 *   **画素数と大きさを両方**出す。
 */
export function shrinkQuestion(
  before: { width: number; height: number; bytes: number },
  after: { width: number; height: number; bytes: number },
): string {
  return (
    `大きな画像です(${before.width}×${before.height} / ${humanBytes(before.bytes)})。\n` +
    `${after.width}×${after.height} / ${humanBytes(after.bytes)} に縮めて取り込みますか?\n` +
    '⚠ 縮めると元の細かさは戻りません。そのままでよければ「いいえ」を選んでください。'
  );
}
