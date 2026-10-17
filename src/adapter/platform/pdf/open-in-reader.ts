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
  /**
   * 🔴 このタブが保存できるタブ(writer リースを持つ)か。⚠ 昇格で変わるので呼ぶたびに読む。
   * 2 つ目以降のタブは編集の結果を保存できない(`save-edited.ts` の `SAVE_NOT_HOLDER`)── 窓を開く前に断る。
   */
  readonly isHolder: () => boolean;
  /** 失敗を user へ言う。 */
  readonly fail: (message: string) => void;
  /** 状態の行へ 1 行。 */
  readonly note: (text: string) => void;
}

/**
 * 窓を開いている最中の知らせ。
 * ⚠ 末尾を `…(…)` の形にしない ── `isProgressNotice`(`status-notice.ts`)が進行中の字と読み、
 *   窓が開いても誰も空にしない欄に残る。
 */
export const OPENING_NOTE = (name: string): string =>
  `「${name}」のウィンドウを開いています。数秒たっても出ないときは、ブラウザのポップアップを許可してください`;

/** 保存できないタブから開こうとしたときの断り(保存時の `SAVE_NOT_HOLDER` と同じ向き)。 */
export const OPEN_NOT_HOLDER =
  'このタブからは PDF を開けません(開いても編集の結果を保存できません)。メインのタブから開いてください';

/** @returns 引き受けたら `true`(呼び側はもう何もしない)/ 選んでいなければ `false`。 */
export async function openInPdfReader(
  deps: OpenInPdfReaderDeps,
  args: { kind: string; assetKey: string; name: string; lid: string | null },
): Promise<boolean> {
  if (args.kind !== 'pdf' || !deps.enabled()) return false;
  // 🔴 窓を開く前に断る: 何も借りない・窓も作らない(開いてから保存で断られる手戻りをさせない)
  if (!deps.isHolder()) {
    deps.fail(OPEN_NOT_HOLDER);
    return true;
  }
  const host = deps.host();
  /**
   * 🔴 **窓が名乗る前の 2 回目の押し**は、「もう開いています」と言わない。ポップアップを止めている人は
   *   窓が出ないまま数秒たつ(名乗らなければ断りが出る)── その間に「開いています」と言うと、
   *   画面に無い窓を指す。前へ出すよう頼んでも、窓はまだ受け取れない。
   */
  if (host.isOpening(args.assetKey)) {
    deps.note(OPENING_NOTE(args.name));
    return true;
  }
  const open = host.openTokenFor(args.assetKey);
  if (open !== null) {
    // ⚠ 同じ添付の窓が生きていれば、2 枚目を開かず前へ出すよう頼む
    host.focus(open);
    // 🔑 前へ出せたか分からない(放送は片道)ので、マニュアルのウィンドウ(`main.ts`)と同じ逃げ道の字を添える
    deps.note(`「${args.name}」はもう開いています(見えないときは、ウィンドウを切り替えてください)`);
    return true;
  }
  /**
   * 🔴 **貸している最中の 2 回目の押しも、窓を 2 枚にしない**(#275 着地後レビュー)。
   * ⚠ 上の `openTokenFor` は**開いた窓**しか見ない ── 下の `await deps.lend` の間はまだ窓が無く、
   *   続けて押した 2 回目も `null` を見て 2 枚目を借りて開いていた。貸す**前**に印を付ける。
   */
  if (!host.markLending(args.assetKey)) {
    // 貸している最中 = まだ窓が無い(上と同じく「開いています」とは言えない)
    deps.note(OPENING_NOTE(args.name));
    return true;
  }
  try {
    const lent = await deps.lend(args.assetKey);
    if (!lent) {
      deps.fail(`添付が見つかりません: 「${args.name}」`);
      return true;
    }
    host.open({ assetKey: args.assetKey, name: args.name, lid: args.lid, lent });
    return true;
  } finally {
    // 開けた回は `open` が「生きている」窓として控えるので、印はここで外してよい
    host.unmarkLending(args.assetKey);
  }
}
