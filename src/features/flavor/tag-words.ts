/**
 * 🔴 **「井桁の並びか」を決める、ただ 1 つの述語**(#637。着地前レビュー A / B)。
 *
 * ⚠ **なぜ独立した file なのか**:これを読む側は 2 つあり、互いに import できない ──
 *   `flavor/tags.ts` は `markdown/frontmatter.ts` を import しているので、
 *   frontmatter が tags を import すると輪になる。だから**どちらにも属さない所**に置く。
 *
 * ## 直す前(1 稿目)に起きていたこと ── 規則が 2 本あった
 *
 * 1 稿目は `splitTags`(欄の側)と `isTagHashRun`(frontmatter の側)に
 * **別々の判定**を書いていた。実測すると同じ字が場所によって違う個数になった:
 *
 * | 打った / 書いた字 | 欄 | `tags:` の行 |
 * |---|---|---|
 * | `#買い物 #家事 #` | 2 個 | **0 個** |
 * | `#買い物 #` | 1 個 | **0 個** |
 *
 * 🔑 だから**述語を 1 つにする**(§7)── 読む側が増えても、規則は増やさない。
 */

/** 語に割る(半角空白・タブ・全角空白。⚠ `\s` は環境で揺れるので使わない)。 */
function words(raw: string): string[] {
  const v = raw.trim();
  // 🔑 角括弧は外して中を見る ── `[#買い物, #家事]` も同じ規則で通す
  const inner = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1) : v;
  return inner.split(/[ \t\u3000]+/u).filter((w) => w !== '');
}

/** 井桁の後ろに字がある語か(`#買い物` = 真 / `#` = 偽)。 */
const tagged = (w: string): boolean => w.startsWith('#') && w.length >= 2;

/**
 * 🔴 **裸の `#` は「ここから先はメモ」の印**(2 稿目。1 稿目の実測で判明)。
 *
 * ⚠ 1 稿目は「全部の語に井桁」を要求したので、**打ち損じた 1 文字で全部が壊れた**:
 *
 * | 打った字 | 1 稿目 | 2 稿目 |
 * |---|---|---|
 * | `#買い物 #家事 #`(末尾に打ち損じ) | **1 個「買い物 #家事 #」** | 2 個 |
 * | `#買い物 #家事 # あとで足す`(メモ付き) | **1 個(丸ごと名前)** | 2 個 + メモは落ちる |
 *
 * 🔑 **位置で見分ける** ── 先頭の裸の `#` は「この行はメモ」(だから `null`)、
 *   途中の裸の `#` は「そこから先はメモ」(だから手前だけ返す)。YAML の注釈と同じ読み。
 */
export function hashRunWords(raw: string): readonly string[] | null {
  const ws = words(raw);
  /**
   * ⚠ **先頭の語だけを別に検める必要は無い**(変異試験 N1 が SURVIVED で教えた)──
   *   下の `head.every(tagged)` は `ws[0]` も含むので、消しても結果が 1 つも変わらない。
   *   先頭が裸の `#` の場合は `cut === 0` になり、`head` が空になって `null` に落ちる。
   */
  const cut = ws.indexOf('#');
  const head = cut >= 0 ? ws.slice(0, cut) : ws;
  return head.length > 0 && head.every(tagged) ? head : null;
}

/**
 * 🔴 **「タグらしく書いてある」か**(frontmatter が注釈として刈るかを決める)。
 *
 * ⚠ `hashRunWords` より**弱い** ── 先頭が `#買い物` なら真である。
 *   これは「井桁を 1 つ打ち損じた」形(`tags: #買い物 家事`)を、
 *   **欄と同じ結果**へ落とすためにある:欄は「買い物 家事」という 1 つの名前にする。
 *   ここで刈ってしまうと `tags:` の行だけ **0 個**になり、
 *   マニュアルが「4 か所すべてで同じ」と書いた約束が破れる(着地前レビュー B)。
 * ⚠ **逆に、先頭が裸の `#` なら偽** ── `tags: # 買うものは後で` は注釈のままである。
 */
export function looksHashTagged(raw: string): boolean {
  const ws = words(raw);
  if (ws.length === 0) return false;
  if (tagged(ws[0]!)) return true;
  /**
   * ⚠ **壊れた形も「タグらしい」に数える**(`買い物 #家事`)── 数えないと、
   *   YAML の注釈規則が ` #家事` を刈って **`tags:` の行だけ 1 個**になり、
   *   欄(2 個)と食い違う。`tests/features/tags.test.ts` の一致表がこれを留める。
   */
  return strandedHashWords(raw) !== null;
}

/**
 * 🔴 **このアプリ自身が壊して作った名前を、読むときだけ繋ぎ直す**(#637 の着地前レビュー A)。
 *
 * ⚠ 直す前の打つ欄は、打った字を丸ごと 1 つの名前にしていた ── しかも先頭の井桁は
 *   `normalizeTag` が落とすので、保存された原文は
 *   **`tags: ["買い物 #家事"]`**(先頭だけ井桁が無い)という形になる(実測)。
 *   ⚠ `,` を含まないので quote すら付かないことがあり、**見つけにくい**。
 * 🔑 つまり「**先頭は素、以降が全部 `#語`**」は、user が意図して書ける形ではなく
 *   **こちらが作った壊れ方の指紋**である。だから読むときに繋ぎ直してよい。
 *
 * ⚠ **意図した空白入りの名前は割らない** ── `請求 済` も `買い物 家事` も
 *   2 語目に井桁が無いので `null`(`bulk-tag.test.ts` が pin している形)。
 * ⚠ 唯一の取り違えは **`読書 #2` のように「素の語 + 井桁つきの語」を意図して
 *   1 つの名前にしていた場合**である ── そのときは 2 つに割れる。
 */
export function strandedHashWords(raw: string): readonly string[] | null {
  const ws = words(raw);
  // ⚠ 先頭が**裸の `#`** なら、それは壊れた名前ではなく**注釈の印**である
  //    (`tags: # #買い物` を 1 つのタグにしない ── 2 稿目で test が捕まえた)
  if (ws.length < 2 || ws[0] === '#' || tagged(ws[0]!)) return null;
  return ws.slice(1).every(tagged) ? ws : null;
}
