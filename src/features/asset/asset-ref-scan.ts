/**
 * 添付参照の照合規則 ── **これ 1 つだけ**が正本。
 *
 * 🔴 この module は「同じ判定を 3 か所で別々に書いていた」ことに気づいて生まれた
 * (P6f review H-1)。GC は keep する添付を 1 ノート書出しが**無警告で捨てて**いた。
 * user はそれを見て安心してノートを消す ── 導線としては最悪の壊れ方をする。
 *
 * ## 規則
 * **候補 key が本文のどこかに substring として現れるか**で決める。
 * frontmatter(`attachment.asset_key` / `extra` 内 JSON)も本文の `asset:` 参照も、
 * 参照は必ず key 文字列そのものを含むので、この 1 規則が全参照源を包摂する。
 *
 * ⚠ **誤差は false-keep 側にしか出さない**(無関係な散文が key を偶然含む)。
 * 「key らしき token を抽出して exact 一致」型に書き換えてはいけない ── それは
 * 誤差が**両側**に出る形で、`asset:ast-key.`(文末の句読点)や
 * `asset:ast\-key`(escape 済み)を落とす。実際に落としていた。
 */

/**
 * 照合用の限定 unescape(markdown-it の `unescapeAll` 相当のうち、
 * asset key の字母に効く 2 形だけ): backslash escape(ASCII 記号)と数値実体。
 * 範囲外 code point は空に落とす(照合を広げないだけで安全)。
 */
export function unescapeForScan(s: string): string {
  const fromCode = (n: number): string =>
    Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  return s
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/&#(\d{1,7});/g, (_m, d: string) => fromCode(Number(d)))
    .replace(/&#[xX]([0-9a-fA-F]{1,6});/g, (_m, h: string) => fromCode(parseInt(h, 16)));
}

/**
 * `text` が参照している候補 key を `found` へ入れ、`remaining` から外す。
 *
 * ⚠ **2 回 unescape する** ── `revisions.snapshot` は patch のとき **JSON テキスト**で
 * backslash が二重化している(`asset:ast\-k` → snapshot 上は `ast\\-k`)。
 * 1 パスでは `\-k` までしか戻らず、古い版にしか無い escape 済み参照を落とす。
 * 2 パスは keep 側にしか広がらないので安全。
 *
 * @returns まだ確定していない候補が残っているか(false = 走査を打ち切ってよい)
 */
export function scanAssetRefsInto(
  text: string,
  remaining: Set<string>,
  found: (key: string) => void,
): boolean {
  if (remaining.size === 0) return false;
  const norm =
    text.includes('\\') || text.includes('&#') ? unescapeForScan(unescapeForScan(text)) : null;
  for (const key of remaining) {
    if (key !== '' && (text.includes(key) || (norm !== null && norm.includes(key)))) {
      found(key);
      remaining.delete(key); // 反復中の自要素削除は Set 仕様で安全
    }
  }
  return remaining.size > 0;
}

/**
 * 🔴 **その本文が参照している key を、候補から外さずに数え上げる**(#415)。
 *
 * ⚠ `scanAssetRefsInto` は keep-set 用なので**見つけた key を候補から外す** ──
 *   「どのノートがどれを参照しているか」を数えるには使えない(2 件目以降が
 *   1 件も当たらなくなる)。
 * 🔑 **照合の規則はこの file 1 つ**(冒頭の 🔴)なので、規則を写さずにここへ足す。
 *   ⚠ 別の場所で `text.includes(key)` と書き直すと、escape 済みの参照を
 *   片方だけが落とす ── それが P6f で実際に起きた壊れ方である。
 */
export function assetRefsIn(text: string, keys: Iterable<string>): string[] {
  const norm =
    text.includes('\\') || text.includes('&#') ? unescapeForScan(unescapeForScan(text)) : null;
  const out: string[] = [];
  for (const key of keys) {
    if (key === '') continue;
    if (text.includes(key) || (norm !== null && norm.includes(key))) out.push(key);
  }
  return out;
}
