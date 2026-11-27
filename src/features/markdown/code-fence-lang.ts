/**
 * 🔴 **コードブロック(囲みコード)の原文を直す小さな規則**(リッチ編集の改善。純関数)。
 * 画面(`row-swap.ts` の「言語」の選択・「下に段落を追加」)はここを呼ぶだけで、字の組み替えを持たない。
 */

/** 言語の選択肢(「なし」は空の字)。現在の言語が一覧に無いときは画面側が足す。 */
export const CODE_LANG_CHOICES: readonly string[] = ['', 'ts', 'js', 'python', 'sql', 'json', 'html', 'mermaid', '3d'];

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/;

/** 原文の 1 行目が囲みコードの開きなら、その言語(情報の最初の語。無ければ `''`)。開きでなければ `null`。 */
export function codeFenceLang(text: string): string | null {
  const first = text.split('\n', 1)[0] ?? '';
  const m = FENCE_OPEN.exec(first);
  if (m === null) return null;
  // ⚠ バッククォートの囲みの情報にバッククォートは入らない(CommonMark)── 開きではなく行内のコード
  if (m[2]!.startsWith('`') && m[3]!.includes('`')) return null;
  return m[3]!.trim().split(/\s+/)[0] ?? '';
}

/** 1 行目の言語を差し替える(情報の 2 語目以降は残す)。開きでなければ `null`。 */
export function setCodeFenceLang(text: string, lang: string): string | null {
  if (codeFenceLang(text) === null) return null;
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  const rest = nl < 0 ? '' : text.slice(nl);
  const m = FENCE_OPEN.exec(first)!;
  const info = m[3]!.trim();
  const words = info === '' ? [] : info.split(/\s+/);
  words.shift();
  const next = [lang, ...words].filter((w) => w !== '').join(' ');
  return `${m[1]!}${m[2]!}${next}${rest}`;
}

/** 開きの囲みが閉じていなければ、末尾に閉じを足す(閉じていれば何もしない)。開きでなければそのまま。 */
export function closeCodeFence(text: string): string {
  if (codeFenceLang(text) === null) return text;
  const lines = text.split('\n');
  const m = FENCE_OPEN.exec(lines[0] ?? '')!;
  const mark = m[2]!;
  const close = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${String(mark.length)},}\\s*$`);
  for (let i = 1; i < lines.length; i += 1) if (close.test(lines[i]!)) return text;
  return `${text}${text.endsWith('\n') ? '' : '\n'}${mark}`;
}
