/**
 * ファイルを user に渡す(P8 段⑦)。
 *
 * 🔑 **1 か所に寄せる**。この 8 行は `main.ts` に 2 回書かれていて、図の書き出しが
 * 3 人目になるところだった。⚠ ここには**timing の規則**が埋まっている ──
 * `click()` の直後に `revokeObjectURL` すると**ダウンロードが中断されうる**ので
 * 1 秒待つ。3 か所に散らすと、そのうち 1 か所だけが規則を落とす。
 *
 * ⚠ ObjectURL は**必ず**捨てる(生成物のライフサイクル終端での即破棄 ──
 * user 指示 2026-07-27、不可侵)。「終端」がここでは「ブラウザが読み終えた頃」。
 */

/** click 後に URL を手放すまでの猶予。短くすると DL が中断する。 */
const RELEASE_DELAY_MS = 1000;

/**
 * 既にある URL を落とさせる(貸し出した ObjectURL の返し方は呼び側が持つ)。
 * @param release URL の寿命終端で呼ぶ後始末。
 */
export function downloadUrl(name: string, url: string, release: () => void): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  try {
    document.body.append(a);
    a.click();
  } finally {
    // 🔴 **`finally` で片付ける**(P8 段⑬ review L-1)。`click()` が投げると、
    //    かつては `<a>` が body に残り、**URL が永久に解放されなかった** ──
    //    即破棄規律(2026-07-27 不可侵)に穴が開く。失敗しても寿命は終わらせる
    a.remove();
    setTimeout(release, RELEASE_DELAY_MS);
  }
}

/** Blob を落とさせる(URL の生成と破棄はここが持つ)。 */
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  downloadUrl(name, url, () => URL.revokeObjectURL(url));
}
