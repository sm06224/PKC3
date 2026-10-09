/**
 * **同じ面に戻ったら、同じ場所に戻る**(P8 段⑫)。
 *
 * > user 指示 2026-08-03「**サイドバーも同じ、スクロールが発生するすべての画面が
 * > 対象だよ**」
 *
 * 🔴 実測(直す前に測った)で飛んでいたのはここ:
 * ```
 * 一覧: 追記で再描画      ✓ 保つ      ← 行を再利用しているので元から平気
 * 一覧: 別の行を選ぶ      ✓ 保つ
 * 一覧: 題名を変える      ✓ 保つ
 * 一覧: 絞り込み → 戻す   ✗ 飛ぶ (250 → 0)
 * フォルダ: 絞り込み      ✗ 飛ぶ (250 → 0)
 * ```
 * 絞り込むと中身が縮んで `scrollTop` が **0 に丸められ**、戻しても 0 のまま。
 * 「同じ器を別の面(一覧 / フォルダ / アプリ)で使い回している」ぶんも同じで、
 * タブを行き来すると前の面の位置が残る。
 *
 * 🔑 だから **「面」ごとに位置を覚える**。面 = `mode` × 「絞り込み中かどうか」。
 * ⚠ 絞り込んだ結果は**先頭から**が正しい(探しているのだから)。戻したときに
 * 元の位置へ帰る、が欲しい振る舞い。
 *
 * 🔴 **位置は scroll イベントで覚える。描き直しの中で `scrollTop` を読まない**(#1467 段 3-e)。
 * ⚠ 1 稿目は「① 書き換える前に `park()` で `scrollTop` を読む → 描画 → ② `use()` で戻す」の 2 手だった。
 *   ところが `scrollTop` を読むと**直前の描き直しが汚した文書全体のスタイルと配置を、その場で払う**
 *   (強制レイアウト)── 長いノート(20,000 行)の追記 1 回で、左の列の描き直しの前の `park()` が
 *   **277 ms**を払っていた(trace、1.5 万要素)。読まずに済む形にする:
 *   ブラウザは位置が動くたびに `scroll` イベントを出す(user の操作も、縮んで丸められた分も)ので、
 *   そのときの `scrollTop` を**いまの面の鍵**で覚える(イベントの中で読む `scrollTop` は配置が
 *   済んだ後の値なので、強制レイアウトにならない)。
 * ⚠ 縮んで丸められた分の `scroll` は**描き直しの後に届く**(イベントは非同期)── その時点の鍵は
 *   `use()` が切り替えた**新しい面**なので、前の面の位置は上書きされない。これが 1 稿目の
 *   「書き換える前に退避する」と同じ意味を、読まずに実現している。
 * ⚠ **ただし `use()` の `scrollTop = …`(書き込み)も、読みと同じく配置を強いる**(着地前レビューの実測:
 *   2 万要素を汚した直後の読み 33 ms / 同じ値の書き込み 33 ms / 別の値 40 ms)。強制レイアウトは
 *   「汚してから最初に配置を要る人」が**文書全体ぶんを 1 回**払う ── 読み手を 1 人外しても、同じ task の
 *   中に次の読み手(書き手)が居れば、支払いはそこへ**移るだけ**である。実測(段 3-e、20,000 行の追記 1 回)
 *   でも wall は 2,581 → 2,565〜2,730 ms で動かず、5,000 行で 603 → 478〜496 ms だった。
 *   🔑 この形の価値は「読み手を 1 人減らした」こと(task の中の読み手が 0 になった時点で初めて
 *   配置が frame の末尾に 1 回だけになる)── ms の主張はしない。残りの読み手は trace で数える(#1467)。
 * 使い方は 1 手:
 * ```
 * …描画…
 * use(newKey);     // 中身を入れ**終わってから**、その面の位置へ戻す(鍵も切り替える)
 * ```
 * ⚠ `use()` が `scrollTop` を書くのは**次の frame の頭**(段 3-g)── 同じ task で読み直しても
 *   まだ動いていない。test は frame を 1 つ待ってから見る。`use()` の後に誰かが位置を動かした
 *   (`scroll` が届いた)なら、frame の頭では**書かない**(後から動かした人が勝つ)。
 * ⚠ `use()` を描画の前にすると、まだ `scrollHeight` が足りないので指した位置が丸められる
 * (段⑪ でも同じ罠を踏んだ)。
 */

/** 覚えておく面の数。⚠ 無制限に持つと、面が増えるたびに伸びる辞書になる。 */
const CAP = 8;

/** frame の頭に 1 回(test の node 環境には無いので setTimeout へ落とす ── `quick-toc.ts` と同じ形)。 */
const requestFrame: (cb: () => void) => number =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 0) as unknown as number;

export class ScrollMemory {
  private readonly el: HTMLElement;
  private readonly seen = new Map<string, number>();
  private key: string | null = null;

  constructor(el: HTMLElement) {
    this.el = el;
    // 🔑 位置が動いた(user が送った / 縮んで丸められた / use() が戻した)たびに、いまの面の鍵で覚える
    el.addEventListener('scroll', () => this.remember(), { passive: true });
  }

  /** いまの位置を、いまの面の鍵で覚える(`scroll` イベントの中でだけ読む ── 強制レイアウトにならない)。 */
  private remember(): void {
    if (this.key === null) return;
    if (this.frame !== null) this.moved = true; // `use()` の後に誰かが動かした ── frame の頭で上書きしない
    this.seen.set(this.key, this.el.scrollTop);
    if (this.seen.size > CAP) {
      const oldest = this.seen.keys().next().value; // Map は挿入順
      if (oldest !== undefined && oldest !== this.key) this.seen.delete(oldest);
    }
  }

  /**
   * 中身を入れ**終わってから**、その面の位置へ戻す(鍵も切り替える)。
   * ⚠ **鍵が同じでも戻す** ── 同じ面を描き直しただけのときこそ位置が飛ぶ
   * (ログのように 400ms ごとに作り直す面がある)。鍵が同じなら最後の `scroll` が
   * 覚えた値なので、戻しても何も動かない。
   */
  use(key: string): void {
    this.key = key;
    /**
     * 🔴 **書くのは frame の頭(requestAnimationFrame)で**(#1467 段 3-g)── `scrollTop = …` も
     *   読みと同じく配置を強いる(段 3-e のレビューの実測)。描き直しの task の中で書くと、
     *   直前の描き直しが汚した文書全体をここで払う(trace: 20,000 行の追記 1 回で 267 ms)。
     *   frame の頭なら、その配置は frame 自身が 1 回払う分と同じ物になる(二重に払わない)。
     * 🔴 **`use()` の後に `scroll` が届いたら、書かない**(着地前レビューが実ブラウザで示した穴)──
     *   同じ task で `use()` の**後**に誰かが位置を動かす経路が在る(お知らせを開く / 目次から飛ぶ /
     *   検索の当たりへ飛ぶ = `scrollIntoView`、user がホイールを回した分)。その `scroll` は
     *   次の frame の**scroll steps = rAF より前**に届く(chromium / headless_shell の両方で実測)ので、
     *   届いていたら「後から動かした人」の意図を勝たせる(frame の頭で古い値を上書きしない)。
     * ⚠ 値は `use()` の時点で決める(`seen` を frame で読まない)── 同じ frame に 2 度来たら後の鍵の値を 1 回。
     * ⚠ 知っている穴: 同じ task の中で「中身を空にする → **配置を強いる読み** → 入れ直す」と、
     *   丸めの `scroll@0` が rAF より前に届く版(headless_shell。フル chromium は後に届く)では
     *   戻しを捨てて先頭になる。描き直しの task に配置を強いる読みを置かないこと自体が
     *   この一連(#1467)の目的なので、読みを置かない側で守る。
     */
    this.pending = this.seen.get(key) ?? 0;
    this.moved = false;
    if (this.frame !== null) return;
    this.frame = requestFrame(() => {
      this.frame = null;
      if (!this.moved) this.el.scrollTop = this.pending;
    });
  }

  /** frame で書く位置(`use()` が決める)と、その予約。`moved` = 予約の後に `scroll` が届いた(書かない)。 */
  private pending = 0;
  private frame: number | null = null;
  private moved = false;

  /** いま覚えている位置(test の観測点)。 */
  peek(key: string): number | undefined {
    return this.seen.get(key);
  }
}
