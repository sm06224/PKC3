/**
 * 別窓へ落とされた file / link で、**窓ごと移るのを止める**(#1087)。
 *
 * 🔴 何が起きていたか:ブラウザの既定は、窓へ落とした file / link の URL へ
 *   **その窓ごと移る**こと。窓の中身(読んでいた章・一覧・図)が消え、移った先のページは
 *   この窓を開いた元のウィンドウを `opener` として持つ。
 * 🔑 止めるのは「**誰も受け取らなかった落とし**」だけ ── 内側の処理が既に
 *   `preventDefault` した落としには触れない(窓の中に落とし先を持つ窓を壊さない)。
 *   ⚠ 内側の処理が先に受けられるよう、listener は document に付ける(capture にしない)。
 * ⚠ F5 で document が替わるので、組み直すたびに呼んでよい(同じ document には 2 度付けない)。
 */
export function blockWindowDrop(doc: Document): void {
  if (guarded.has(doc)) return;
  guarded.add(doc);
  for (const type of ['dragover', 'drop'] as const) {
    doc.addEventListener(type, (ev) => {
      if (!ev.defaultPrevented) ev.preventDefault();
    });
  }
}

/** 配線済みの document。 */
const guarded = new WeakSet<Document>();
