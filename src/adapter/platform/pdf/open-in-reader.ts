/**
 * 添付の PDF の「別のウィンドウで見る」を、**設定で選んだ人だけ** PKC の画面で読む窓へ振る(#275 段①)。
 *
 * 🔑 ここは**振り分けの判断**(`main.ts` は原文を読む test しか持てないので、判断を書かない。§2)。
 *   戻り値 `false` = 選んでいない → 呼び側は**今までどおり**ブラウザ内蔵の表示の窓(`openAssetWindow`)を開く。
 * ⚠ 切のとき **何も借りない・何も開かない**(借りてから捨てる形にしない)。
 */
import type { PdfLent, PdfReaderHost } from './pdf-window';

export interface OpenInPdfReaderDeps {
  /** 設定(読むたびに引く ── 切り替えは次の押しから効く)。 */
  readonly enabled: () => boolean;
  /** 窓の管理(使うときまで作らない)。 */
  readonly host: () => PdfReaderHost;
  /** 添付を貸す(`blobs.lendObjectUrl`)。 */
  readonly lend: (assetKey: string) => Promise<PdfLent | null>;
  /** 失敗を user へ言う。 */
  readonly fail: (message: string) => void;
  /** 状態の行へ 1 行。 */
  readonly note: (text: string) => void;
}

/** @returns 引き受けたら `true`(呼び側はもう何もしない)/ 選んでいなければ `false`。 */
export async function openInPdfReader(
  deps: OpenInPdfReaderDeps,
  args: { kind: string; assetKey: string; name: string; lid: string | null },
): Promise<boolean> {
  if (args.kind !== 'pdf' || !deps.enabled()) return false;
  const host = deps.host();
  const open = host.openTokenFor(args.assetKey);
  if (open !== null) {
    // ⚠ 同じ添付の窓が生きていれば、2 枚目を開かず前へ出すよう頼む
    host.focus(open);
    deps.note(`「${args.name}」はもう開いています`);
    return true;
  }
  /**
   * 🔴 **貸している最中の 2 回目の押しも、窓を 2 枚にしない**(#275 着地後レビュー)。
   * ⚠ 上の `openTokenFor` は**開いた窓**しか見ない ── 下の `await deps.lend` の間はまだ窓が無く、
   *   続けて押した 2 回目も `null` を見て 2 枚目を借りて開いていた。貸す**前**に印を付ける。
   */
  if (!host.markLending(args.assetKey)) {
    deps.note(`「${args.name}」はもう開いています`);
    return true;
  }
  try {
    const lent = await deps.lend(args.assetKey);
    if (!lent) {
      deps.fail(`添付が見つかりません: ${args.name}`);
      return true;
    }
    host.open({ assetKey: args.assetKey, name: args.name, lid: args.lid, lent });
    return true;
  } finally {
    // 開けた回は `open` が「生きている」窓として控えるので、印はここで外してよい
    host.unmarkLending(args.assetKey);
  }
}
