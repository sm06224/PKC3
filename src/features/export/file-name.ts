/**
 * 書き出すファイルの**名前の規則**(P8 段⑦)。
 *
 * 🔑 **1 か所に寄せる**。かつて `export-archive.ts` の中に閉じていたが、図の書き出し
 * (`.svg`)が 2 人目の利用者になった ── 同じ規則が 2 か所に生えると、片方だけが
 * 「制御文字を落とす」「サロゲートペアを割らない」を持つ状態になり、**題名によって
 * 片方でだけファイルが壊れる**(検証の規律「同じ判定が 2 か所に生えたら規則を寄せる」)。
 */

/**
 * Windows が**装置名として予約している**名前(P8 段⑬ review L-2)。
 * ⚠ 判定は「最初の `.` より前」に掛かるので、`CON.pkc3.zip` も弾かれる ──
 * 拡張子を付けているから安全、ではない。⚠ 大文字小文字を区別しない。
 */
const RESERVED = new Set(
  [
    'CON',
    'PRN',
    'AUX',
    'NUL',
    ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
  ].map((n) => n.toLowerCase()),
);

/** ファイル名に使えない文字を落とす(OS 差を避けて保守的に)。 */
export function safeName(title: string): string {
  // ⚠ 制御文字は**正規表現に書かない**(no-control-regex。文字クラスに直接
  // 埋めると読み手が範囲を誤りやすく、実際ファイル中に生バイトが入っていた)
  const cleaned = [...title]
    .map((ch) => (ch.codePointAt(0)! < 0x20 || ch === '\u007f' ? '-' : ch))
    .join('');
  const s = cleaned.replace(/[\\/:*?"<>| ]+/g, '-').replace(/^[-.\s]+|[-.\s]+$/g, '');
  // ⚠ 空にしない ── 「.pkc3.zip」だけのファイル名は OS によっては隠しファイル
  // ⚠ `slice` は**サロゲートペアを割る**(絵文字や一部の漢字が壊れる)──
  // 制御文字処理でわざわざ [...] を使ったのに、最後で落とすと意味がない
  const cut = [...s].slice(0, 60).join('') || 'pkc3';
  // ⚠ 予約名は**切り詰めた後**に見る ── 61 文字目以降を落として初めて `CON` に
  //    なることがある。逃がし方は接尾辞 1 つ(中身は変えない)
  return RESERVED.has(cut.toLowerCase()) ? `${cut}-file` : cut;
}

/**
 * 図 1 枚の書き出し名。⚠ 図に名前は無いので**何枚目か**で区別する
 * (1 始まり ── 「図0」は user の数え方ではない)。
 */
export function diagramFileName(title: string, index: number): string {
  return `${safeName(title)}-図${index + 1}.svg`;
}
