/**
 * 🔴 **マニュアル本文の「→「名前」」を、押せる字にするための解決規則**(#779 段⑧、
 * user 裁定 2026-09-08「押せる + 戻る道も付ける」)。
 *
 * ## なぜ要るか(user の物語)
 *
 * 本文を読んでいて「→「設定」」に出会っても、**そこへは行けなかった** ──
 * いったん画面のいちばん上の目次まで戻って、探し直すことになる。
 * 本文の参照は **142 か所**あるので、そのたびに読んでいた場所を失っていた。
 *
 * ## 🔴 `#設定` のような書き方は使えない
 *
 * ヘルプの面は `hidden` で**ノートの面と同じ document に常駐する**ので、
 * `#slug` は**先に作られた本文面(= user のノート)の見出し**に当たる
 * (`help.ts` 冒頭 / `tests/adapter/help-pane.test.ts` が 0 件を守っている)。
 * 🔑 だから**目次の行と同じ仕組み**にする ── 器の中の見出しを数え上げて、
 * 字で突き合わせて `scrollIntoView` する。構文解析も id も要らない。
 *
 * ## 🔴 `→「…」` は 2 つの意味で使われている(実測 2026-09-08)
 *
 * | 何を意味するか | 例 |
 * |---|---|
 * | **その節を見よ**(参照) | `(→「設定」)` |
 * | **これを押して、次にこれ**(操作の道順) | `**表の右上の「▾」→「本文を CSV の表に書き換える」**` |
 *
 * ⚠ 丸括弧の有無では**分けられない**(実測:括弧の外にも本物の参照が 27 種在る)。
 * 🔑 だから**器で分けず、行き先で分ける** ── 「その名前の見出しがちょうど 1 つ在る」
 * ときだけ押せる字にする。⚠ 操作の道順が指す名前(「本文を CSV の表に書き換える」
 * 「操作を探す」「貼り付けたとき、何が届いて…」)は**どれも見出しではない**ので、
 * 自然に素の字のまま残る(実測で確かめた)。
 *
 * ⚠ **押しても何も起きない字を作らない** ── 解決しない参照は**押せる形にしない**。
 * それが `resolveManualRef` が `null` を返す意味である。
 *
 * ⚠ **pure module**。DOM も `document` も知らない(拾って当てるのは `help.ts`)。
 */

/** 本文の中で見つけた参照 1 件。`start`〜`end` は**名前だけ**の範囲(鉤括弧は含まない)。 */
export interface ManualRefHit {
  readonly name: string;
  /** `「` の直後(名前の先頭)。 */
  readonly start: number;
  /** `」` の直前(名前の直後)。 */
  readonly end: number;
}

/**
 * `→「名前」` を拾う。⚠ **1 本のテキスト**に対して使う(DOM のテキスト節点 1 つ)。
 *
 * ⚠ `→` と `「` の間の空白は許す(全角も ── `u` 付きの `\s` が U+3000 を拾う)。
 * 🔴 **入れ子の鉤括弧を 1 段だけ許す**(2026-09-08、実測で直した)。
 *   ⚠ 1 稿目は `[^」]` だったので `→「付箋を自由に置ける「板」」` の名前が
 *   **`付箋を自由に置ける「板` で切れて**いた ── 見出しの字と揃わないうえ、
 *   画面に出る押し所の字も**閉じ括弧の無い形**になる。
 *   ⚠ 2 段以上は許さない(本文に無いし、許すと行を跨いで食い合う)。
 */
export function findManualRefs(text: string): ManualRefHit[] {
  const out: ManualRefHit[] = [];
  // ⚠ 全角の空白は書かない(`no-irregular-whitespace`)── `u` 付きの `\s` が U+3000 も拾う
  const re = /→\s*「((?:[^「」]|「[^「」]*」){1,60})」/gu;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const name = m[1]!;
    const start = m.index + m[0].length - name.length - 1;
    out.push({ name, start, end: start + name.length });
  }
  return out;
}

/**
 * 記法の印を落として比べる形にする。⚠ `manual-doc.ts` の `label` と同じ向き
 * ── ⚠ こちらは**描いた字**(`textContent`)にも当てるので、印はもう落ちている
 * ことが多いが、原文に当てる検査(`docs-parity`)と**同じ規則で比べる**ために要る。
 */
export function refKey(s: string): string {
  return s.replace(/[*`_]/gu, '').trim();
}

/**
 * 参照の名前 → 行き先の見出し。⚠ **ちょうど 1 つに決まるときだけ**返す。
 *
 * 🔑 規則は 2 段:
 * 1. **字がそのまま同じ**見出しが 1 つ在れば、それ(実測 37 種)
 * 2. 無ければ、**その名前を含む**見出しがちょうど 1 つのときだけ、それ(実測 17 種)
 *
 * ⚠ 2 段目が要るのは、参照が**節の名前を短く書く**ためである
 *   (`→「組み込みアプリ」` → 見出しは `🔴 組み込みアプリは別のウィンドウで開きます`)。
 * ⚠ 含む先が **2 つ以上**なら `null`(`→「予定」` は 6 つの見出しに当たる)──
 *   どちらへ送るか決められないものを、勝手に決めない。
 */
export function resolveManualRef(
  name: string,
  headings: readonly string[],
): string | null {
  const key = refKey(name);
  if (key === '') return null;
  const exact = headings.filter((h) => refKey(h) === key);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  const near = headings.filter((h) => refKey(h).includes(key));
  return near.length === 1 ? near[0]! : null;
}
