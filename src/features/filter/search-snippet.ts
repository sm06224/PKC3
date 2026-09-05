/**
 * 探す面の 1 行(題名 + 抜粋 + 関連度)の**形と印**(#680)。
 *
 * 🔑 **pure module**。抜粋を作るのは worker(FTS の `snippet()` / LIKE 側はここの
 * `excerptAround`)、読むのは探す面の描画器 ── **印の綴りは両端が同じ 1 か所を読む**
 * (CLAUDE.md §7「両端が相手を模した stub と話すと、綴りの食い違いが両方緑のまま通る」)。
 *
 * ## 印に私用領域の字を使う理由
 *
 * `snippet()` は当たった語を**文字列の前後に置く字**で囲むだけなので、本文に出うる字
 * (`<` / `**`)を使うと本文の字と見分けがつかない。制御文字は使わない(ソースに
 * 生バイトが入る事故 ── `tests/repo-hygiene.test.ts` が止める)ので、**私用領域**
 * (U+E000 / U+E001)を使う。⚠ 描画器は `textContent` で入れ、印の位置にだけ
 * `<mark>` を組む ── HTML を注入しない。
 *
 * ## 実測(2026-09-05、同梱 sqlite の trigram)
 *
 * - `snippet(entries_fts, 1, …, N)` の `N` は **トークン数 = ほぼ文字数**(trigram は
 *   1 文字ごとに 1 トークン)。12 だと「りんごとみかんを買う。<全文検>…」のように
 *   語の途中で切れた。⇒ `SNIPPET_TOKENS = 40`(40 数文字)
 * - `bm25()` は小さい母集団で idf が負になると **1e-6 の床**へ落ちるが、**出現回数の
 *   多い本文が先**という向きは保たれる(2 回出る本文 → 1 回 → 長文 1 回、の順)
 * - 列は `entries_fts(title, body)` の並びで **0 = 題名 / 1 = 本文**
 */

/** 抜粋の中で、当たった語を囲む印(開き / 閉じ)。 */
export const SNIPPET_MARK_OPEN = '\uE000';
export const SNIPPET_MARK_CLOSE = '\uE001';
/** 抜粋が途中から / 途中までであることの印。 */
export const SNIPPET_ELLIPSIS = '…';
/** `snippet()` に渡すトークン数(≒ 文字数)。 */
export const SNIPPET_TOKENS = 40;

/** 探す面の 1 行。⚠ `snippet` には上の印が混ざる ── 描画器が `splitSnippet` で割る。 */
export interface SearchDetailRow {
  lid: string;
  title: string;
  snippet: string;
  /** 関連度。⚠ FTS の `bm25()` は**小さいほど良い**(負の値)。LIKE 側は 0。 */
  rank: number;
}

/**
 * 印の混ざった抜粋を、`{ text, hit }` の並びへ割る。
 * ⚠ 印が閉じていない(`snippet()` が窓の端で切った)形でも落とさない ──
 *   開いたまま終わったら、そこから末尾までを当たりとして扱う。
 */
export function splitSnippet(snippet: string): Array<{ text: string; hit: boolean }> {
  const out: Array<{ text: string; hit: boolean }> = [];
  let hit = false;
  let buf = '';
  for (const ch of snippet) {
    if (ch === SNIPPET_MARK_OPEN || ch === SNIPPET_MARK_CLOSE) {
      if (buf !== '') out.push({ text: buf, hit });
      buf = '';
      hit = ch === SNIPPET_MARK_OPEN;
      continue;
    }
    buf += ch;
  }
  if (buf !== '') out.push({ text: buf, hit });
  return out;
}

/**
 * LIKE 側(3 字未満)の抜粋。FTS の `snippet()` と**同じ顔**にする ── 前後を `width` 字で
 * 切り、当たった語を同じ印で囲む。⚠ 大小は区別しない(LIKE と同じ)。
 * ⚠ 本文に無ければ(題名だけが当たった)先頭を切って返す ── `snippet()` が題名だけの
 *   当たりで本文の頭を返すのと同じ振る舞い。
 * ⚠ 改行は空白へ潰す(1 行に出す)。
 */
export function excerptAround(body: string, needle: string, width = SNIPPET_TOKENS): string {
  const flat = body.replace(/\s+/g, ' ');
  const n = needle.trim();
  const at = n === '' ? -1 : flat.toLowerCase().indexOf(n.toLowerCase());
  if (at < 0) {
    const head = [...flat].slice(0, width).join('');
    return head.length < flat.length ? head + SNIPPET_ELLIPSIS : head;
  }
  // ⚠ 添字は UTF-16 なので、切る幅は code point で数える(絵文字で半分に割らない)
  const before = [...flat.slice(0, at)];
  const after = [...flat.slice(at + n.length)];
  const side = Math.max(0, Math.floor((width - [...n].length) / 2));
  const pre = before.slice(Math.max(0, before.length - side)).join('');
  const post = after.slice(0, side).join('');
  return (
    (before.length > side ? SNIPPET_ELLIPSIS : '') +
    pre +
    SNIPPET_MARK_OPEN +
    flat.slice(at, at + n.length) +
    SNIPPET_MARK_CLOSE +
    post +
    (after.length > side ? SNIPPET_ELLIPSIS : '')
  );
}
