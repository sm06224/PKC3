/**
 * 手元の一式と、配布元の一式が**別の版**であることに気づく(#134 の配布、user 裁定 2026-08-13)。
 *
 * > 「**通知のみで OK / 文言もまかせた**」
 *
 * ## 🔴 勝手に 77MB を取りに行かない
 *
 * user 裁定 2026-08-10「**実行したい人が手動で設定した際に追加ダウンロード**」は
 * 生きている。ここが取るのは**目録(`pack.json`)だけ**で、数百バイトである。
 * ⚠ 一式そのものは**押した人にだけ**取らせる(`office-pack-panel.ts` の導線)。
 *
 * ## 🔴 「新しい」と言わない ── 版に順序が無い
 *
 * 版は `lo-<sha12>-run<id>` で、**大小を比べられない**(sha は時刻ではない)。
 * ファイルから入れた一式は `version` が **zip の file 名**になるし、#125 より前の
 * 一式は **`unknown`** である。⚠ だから言えるのは「**同じか、違うか**」だけ。
 *
 * 🔑 文言は「**配布元には別の版があります**」にした ── 「新しい版があります」は
 * 言えないことを言っている(手元のほうが新しい場合が実在する:
 * 調査ビルドを手で入れた直後など)。⚠ **言えないことを言わない**。
 *
 * ## ⚠ 黙って諦めてよい唯一の場所
 *
 * 取得に失敗したら**何も言わない**。オフラインは正常な状態であり、
 * 「配布元に届きません」を起動のたびに出すのは害である ──
 * ⚠ ただし**押したときの失敗は別**(あちらは名指しで理由を出す)。
 */

/** 一式の版を突き合わせた結果。⚠ **順序は持たない**(上の注記)。 */
export type PackVersionDiff =
  /** 言うことは無い(同じ / 入っていない / 配布元が読めない)。 */
  | { readonly kind: 'quiet' }
  | { readonly kind: 'differs'; readonly installed: string; readonly available: string };

/**
 * 突き合わせる。⚠ **pure**(browser API を触らない)。
 *
 * ⚠ 「入っていないから配布元と違う」とは言わない ── 入っていない user には
 *   既に「入っていません」+ 設置の導線が出ている。二重に言わない。
 */
export function comparePackVersion(
  installed: string | null,
  available: string | null,
): PackVersionDiff {
  if (installed === null || available === null) return { kind: 'quiet' };
  // ⚠ 空文字は「版が無い」であって「違う」ではない(#125 以前の一式は `unknown`
  //    という**文字列**が入るので、ここへは来ない)
  if (installed === '' || available === '') return { kind: 'quiet' };
  if (installed === available) return { kind: 'quiet' };
  return { kind: 'differs', installed, available };
}

/**
 * 設定の面に出す 1 行。⚠ 出すことが無ければ `null`(器ごと隠す)。
 *
 * 🔑 **次の一歩を書く**(この repo が #111 で踏んだ形 ── 状態だけ言われても
 * user は何をすればいいか分からない)。
 */
export function packUpdateText(diff: PackVersionDiff): string | null {
  if (diff.kind === 'quiet') return null;
  return (
    `配布元には別の版があります ── 手元: ${diff.installed} / 配布元: ${diff.available}。`
    + '「取得して入れる」で入れ直せます。'
  );
}

/**
 * 起動時に 1 度だけ出す短い知らせ。
 * ⚠ 設定の面と**同じ判定**から出す(2 か所で判定を書かない)。
 */
export function packUpdateNotice(diff: PackVersionDiff): string | null {
  if (diff.kind === 'quiet') return null;
  return 'Office のひとそろいは、配布元と別の版です(設定 → Office 表示 から入れ直せます)';
}

export interface PackUpdateCheckDeps {
  /** 手元に入っている版(入っていなければ null)。 */
  readonly installedVersion: () => string | null;
  /** 配布元の目録を読む。⚠ **失敗は黙って `null`**(オフラインは正常)。 */
  readonly fetchAvailable: () => Promise<string | null>;
}

/**
 * 突き合わせて結果を返す。⚠ **一式は取らない**(目録だけ)。
 *
 * 🔑 入っていないときは**配布元へ触りにも行かない** ── 使わない user の起動で
 * 余計な要求を出さない(user 指示「効くのは定常」と同じ向き)。
 */
export async function checkPackUpdate(deps: PackUpdateCheckDeps): Promise<PackVersionDiff> {
  const installed = deps.installedVersion();
  if (installed === null) return { kind: 'quiet' };
  const available = await deps.fetchAvailable().catch(() => null);
  return comparePackVersion(installed, available);
}
