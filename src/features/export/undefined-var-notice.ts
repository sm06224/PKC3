/**
 * Word / PowerPoint で書き出したとき、前書きに無い名前の `{{vars.x}}` が**字のまま残る**ことを数えて言う(#1163 依頼 281 = A)。
 *
 * 🔑 画面と閲覧用 HTML は点線と警告の色で出す(`pkc-variable-undefined`)が、Word / PowerPoint には色の印が無いので、
 *   書き出した人が気づけない ── 配ってから気づく前に、書き出した時点で知らせる。
 * ⚠ **言うだけ**。本文は字のまま(書いた原文を勝手に変えない)。
 */
export function undefinedVarNotice(n: number): string | null {
  if (n <= 0) return null;
  return `名前の無い変数が ${n} 件、字のまま残っています(前書きの vars に名前を書くと値が入ります)`;
}
