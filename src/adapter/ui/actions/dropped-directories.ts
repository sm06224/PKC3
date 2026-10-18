/**
 * 🔴 **窓へ落としたものの中のフォルダを見つける**(台帳 #1852 の束 F1、依頼 172。Gemini 裁定 = 日本語で知らせる)。
 *
 * user の物語: フォルダごと窓へ落とす。ブラウザはフォルダを「大きさ 0 の名前だけの file」として渡すので、
 * そのまま取り込みへ流すと、読めずに英語のエラーが出る(または空の添付ができる)。
 *
 * ⚠ 見分けは `DataTransferItem.webkitGetAsEntry()`(標準化済みの別名つき)── file の大きさや型では決めない。
 * ⚠ 中身を辿らない(まずは「フォルダのままでは取り込めません」と知らせるだけ ── 裁定)。
 * ⚠ 読めない環境(`webkitGetAsEntry` が無い)は空を返す = これまでどおり。
 */
export function droppedDirectoryNames(dt: DataTransfer | null | undefined): string[] {
  const items = dt?.items;
  if (!items) return [];
  const out: string[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (it === undefined || it.kind !== 'file') continue;
    const entry = typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null;
    if (entry?.isDirectory === true) out.push(entry.name);
  }
  return out;
}

/** フォルダを落としたときの断り(取り込みの断りと同じ「理由 → すること」の順)。 */
export function directoryDropMessage(names: readonly string[], itemCount: number): string {
  const first = `「${names[0] ?? ''}」`;
  const head = names.length > 1 ? `${first}ほか ${names.length - 1} 件のフォルダ` : `${first}(フォルダ)`;
  const rest = itemCount > names.length ? 'ほかのファイルも取り込んでいません。' : '';
  return `${head}は、フォルダのままでは取り込めません(中のファイルを選んでください)。${rest}`;
}
