/**
 * 🔴 **例外を画面の字に添えるときの 1 か所**(#1087)。
 *
 * ⚠ `String(e)` は Error を「Error: …」の形にする ── 日本語の知らせの後ろに英語の前置きが付いて出ていた
 *   (「つながりを保存できません: Error: …」)。前置きを付けず、中身(message)だけを返す。
 * 🔑 中身そのものは消さない(何が起きたかの手がかり ── バグ報告に貼られる)。
 */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
