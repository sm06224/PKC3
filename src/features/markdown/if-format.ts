/**
 * 🔴 **`:::if{format=…}` の「どの形式か」の読み方は、この 1 か所**(#1163 依頼 282 = A)。
 *
 * 直す前は `format=pdf` / 大文字の `format=DOCX` / 並べた `format=docx,html` が、どの形式でも**黙って出なかった**。
 * - 大文字・小文字は区別しない(`DOCX` = `docx`)
 * - カンマで並べて複数の形式を指せる(`docx,html`。空白を入れるなら `"docx, html"` と引用符で囲む)
 * - `pdf` は「印刷のとき」で、画面の `html` と同じに出す(PDF は画面の印刷で作るため)
 * ⚠ 読む場所は 4 つ(描画 / 目次 / タグの走査 / ノート間リンクの走査)── どれも同じ関数を通す。
 *   片方だけ直すと、画面に出ない囲みの中のタグやリンクが索引にだけ入る(2026-08-29 に踏んだ食い違い)。
 */

/** 属性の文字列(`format=docx,html` や `format="docx, html"` を含む)から、`format` の値を取り出す。 */
export function ifFormatOf(attrs: string): string | undefined {
  const m = /\bformat\s*=\s*(?:"([^"]*)"|([A-Za-z0-9_,-]+))/.exec(attrs);
  if (m === null) return undefined;
  return m[1] ?? m[2];
}

/** 値を「形式の名前の一覧」へ(小文字・`pdf` は `html` に寄せる)。空なら空の一覧。 */
export function ifFormatList(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== '')
    .map((t) => (t === 'pdf' ? 'html' : t));
}

/**
 * この囲みが、`target`(`html` / `docx` / `pptx`)の描きで出るか。
 * ⚠ `format` を書いていない / 空の値 は、いつも出る(今までどおり)。
 */
export function ifFormatMatches(raw: string | undefined, target: string): boolean {
  if (raw === undefined) return true;
  const list = ifFormatList(raw);
  if (list.length === 0) return true;
  return list.includes(target.toLowerCase());
}
