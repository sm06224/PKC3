/**
 * 🔴 **表の升の入力欄を、塊の差し替えを跨いで生かす**(#745)。
 *
 * ## 何が起きていたか(実測 2026-09-06)
 *
 * > 5 列 3 行の表を上から埋める。A1 を押して打ち `Enter`、続けて A2 を押すと
 * > 欄が開く ── ところが数十ミリ秒後、その欄が**黙って消えて表に戻る**
 * > (打ちかけの字ごと)。焦点は本文の外へ落ちるので、打った字はどこにも入らない。
 *
 * 実測(同じ tick で「確定 → 隣を押す」を撃った):
 *
 * | 経過 | 欄 | 打ちかけの字 |
 * |---|---|---|
 * | +50ms | 生きている | 残っている |
 * | **+150ms** | **消えた** | **消えた** |
 *
 * 経路は 1 本:確定 → `SET_CSV_CELL` → `REQUEST_BODY_REWRITE` → worker を往復 →
 * `BODY_REWRITTEN` → 本文が変わるので `applyBlocks` が**その表の塊を差し替える** ──
 * 開いている `<input>` はその塊の中に居るので、一緒に捨てられる。
 *
 * ## 🔑 直し方 ── 開き直す(留めるのではなく)
 *
 * ⚠ **塊を留める(`pin`)道は採らない。** 留めると、さっき確定した升の新しい字が
 *   **欄を閉じるまで画面に出ない**(打ったのに古い字のまま見える)── いちばん
 *   気づけない嘘になる。
 * 🔑 だから**新しい塊を当ててから、同じ升の欄を開き直す** ── 画面は最新で、
 *   打ちかけの字と caret はそのまま戻る。
 *
 * ⚠ **開く仕掛けを 2 本にしない**(§7)── ここは `element.click()` を撃つだけで、
 *   欄を組むのは `binder.ts` の `edit-cell` **1 か所のまま**である。
 *   ⚠ 開き方を別に書くと、「押して開いた欄」と「開き直した欄」で
 *   確定の作法がずれる(= どちらかだけ本文に届かない形が生まれる)。
 */

/** 開いている升の欄の居場所と、打ちかけの中身。 */
export interface OpenCell {
  /** 原文の行番号(`data-pkc-cell-line`)。 */
  readonly line: string;
  /** 列番号(`data-pkc-cell-col`)。 */
  readonly col: string;
  /** 打ちかけの字(**確定前**)。 */
  readonly value: string;
  readonly start: number;
  readonly end: number;
  /**
   * 🔴 **控えたときの升の字**(`data-pkc-cell-raw`)。
   * ⚠ 開き直す先が**同じ升かどうか**を見分けるために要る ── 行番号だけでは
   *   足りない(本文に 1 行入ると番号が全部ずれ、**1 つ上の升**が同じ番号を持つ)。
   */
  readonly raw: string;
}

/** 🔴 **確定させないための印**(下の docstring)。 */
export const HOLD_ATTR = 'data-pkc-cell-hold';

const INPUT = '[data-pkc-field="cell-input"]';

/**
 * その升を名指しする選択子。
 *
 * ⚠ **「属性値だから安全」ではない**(着地前レビュー 記録 6)── 属性値に引用符は入りうる。
 * 🔑 ここが安全なのは**焼く側が数字しか出さない**からである:
 *   `markdown-render.ts` と `csv-table.ts` の 2 か所とも `${数値}` で組み、
 *   読み手は `html: false` なので user が生の `<td>` を書いても字として escape される。
 *   ⚠ 守り手が**別の file に居る**ので、そちらを変えるときはここも見ること。
 */
function cellSelector(line: string, col: string): string {
  return `[data-pkc-action="edit-cell"][data-pkc-cell-line="${line}"][data-pkc-cell-col="${col}"]`;
}

/**
 * 🔴 **いま開いている升の欄を控え、確定しないように印を付ける**。開いていなければ `null`。
 *
 * ⚠ **副作用がある**(名前は「控える」だが、印も付ける)── 塊が差し替わると
 *   欄は壊れ、そのとき `blur` が飛んで `commit()` が走る。それを止めないと 3 つ壊れる
 *   (どれも 2026-09-06 に実測した):
 *
 * 1. 🔴 **`Escape` が効かなくなる** ── 打ちかけの字が本文に入ってしまうので、
 *    `Escape` でいったん消えても**数百ミリ秒後にひとりでに戻ってくる**
 *    (マニュアルの「押す前の字に戻ります」が嘘になる)
 * 2. 🔴 **書込が輪になる** ── 確定 → 書き戻し → 欄が壊れる → また確定 …
 *    打ち続けている間ずっと disk へ書き、**日本語の変換が毎回途切れる**
 * 3. 🔴 **行がずれた回に、別の升へ書く** ── 行番号は掴んだ時点のものなので、
 *    本文に 1 行入ると**1 つ上の升**を指す
 *
 * 🔑 **開き直すのだから、ここで確定させる理由はもう無い**(打ちかけの字は
 *   欄ごと戻る)。⚠ 開き直せなかった回は打ちかけの字が落ちるが、
 *   **古い行番号で別の升へ書くよりは安全**である
 *   (CLAUDE.md「衝突は、検出するより起こらなくするほうが強い」)。
 * ⚠ **`host` の中だけ**を見る ── 別の面(添付の説明・小窓)の欄を掴まない。
 */
export function captureCellInput(host: HTMLElement): OpenCell | null {
  const input = host.querySelector<HTMLInputElement>(INPUT);
  if (input === null) return null;
  const cell = input.closest<HTMLElement>('[data-pkc-action="edit-cell"]');
  if (cell === null) return null;
  const line = cell.getAttribute('data-pkc-cell-line');
  const col = cell.getAttribute('data-pkc-cell-col');
  if (line === null || col === null) return null;
  // 🔴 確定させない(この印は `binder.ts` の `commit()` が見る)
  input.setAttribute(HOLD_ATTR, '');
  return {
    line,
    col,
    raw: cell.getAttribute('data-pkc-cell-raw') ?? '',
    value: input.value,
    start: input.selectionStart ?? input.value.length,
    end: input.selectionEnd ?? input.value.length,
  };
}

/**
 * 控えた升の欄を開き直す。
 *
 * ⚠ **同じ升が新しい塊に無ければ、何もしない** ── 行が消えた / 列が減った本文が
 *   届いたときに、**別の升へ打ちかけの字を移さない**(それはデータの取り違えである)。
 * ⚠ 見分けは**行番号だけでは足りない**(行がずれると別の升が同じ番号を持つ)ので、
 *   **升の字も突き合わせる**。
 * ⚠ 既に欄が開いているなら何もしない(塊が差し替わらなかった回)。
 */
export function reopenCellInput(host: HTMLElement, keep: OpenCell): void {
  /**
   * 🔴 **印は 1 回の描き直しの間だけ有効**(着地前レビュー W-1)。
   *
   * ⚠ 塊が差し替わらなかった回(= 表と関係ない書き戻し)は**同じ欄が生き残る**ので、
   *   印を消さないと**そのまま残る** ── `commit()` は印を見て黙って帰るので、
   *   user が `Enter` を押しても**何も起きず、打った字が本文に入らない**。
   *   ⚠ #748 が直した「押せるのに書けない」と同じ顔で、今度は**字が消える側**である。
   * 🔑 だから**まず消す**(早期 return より前)── 付ける側と消す側を同じ file に置く。
   */
  host.querySelector<HTMLInputElement>(INPUT)?.removeAttribute(HOLD_ATTR);
  if (host.querySelector(INPUT) !== null) return;
  const cell = host.querySelector<HTMLElement>(cellSelector(keep.line, keep.col));
  if (cell === null) return;
  /**
   * 🔴 **同じ升であることを、字で確かめる**(動線レビュー D3)。
   * ⚠ 行番号は**掴んだ時点のもの**なので、本文に 1 行入ると番号が全部ずれ、
   *   その番号を持つのは**さっきまで 1 つ上だった升**である ── そこへ開き直すと
   *   打った字が別の行に入る(画面は「打っている升」に見えるので気づけない)。
   * 🔑 一致しなければ**開かない** ── 打ちかけの字は落ちるが、別の升は汚さない。
   */
  if ((cell.getAttribute('data-pkc-cell-raw') ?? '') !== keep.raw) return;
  // 🔑 開くのは `binder.ts` の `edit-cell` ── ここは押すだけ(§7)
  cell.click();
  const input = host.querySelector<HTMLInputElement>(INPUT);
  if (input === null) return;
  /**
   * ⚠ **この 1 行は殺せない**(実測 2026-09-06)── 欄が壊されるとき `blur` が
   *   打ちかけの字を確定していた頃は、本文を往復して**同じ字が戻ってきた**ため。
   * 🔑 いまは確定させない({@link captureCellInput} の印)ので、**この行が唯一の道**
   *   である ── 落とすと打ちかけの字がそのまま消える。
   */
  input.value = keep.value;
  /**
   * 🔴 **字を打つ位置を戻す。落とすと、打ちかけの字が次の 1 打で全部消える**
   *   (着地前レビュー A-1 が実測で示した ── 私は「殺せない」と書いていたが誤り)。
   *
   * ⚠ 欄を開くと `binder.ts` が `select()` で**全部選ぶ**。戻さないとその全選択が
   *   残るので、次に打った 1 字が**打ちかけの字を丸ごと置き換える**。
   *   実測:`いう` の間に caret を置いて `X` を打つと `いXう` → 落とすと **`X`**。
   */
  input.setSelectionRange(keep.start, keep.end);
  /** ⚠ `focus` は `binder.ts` が既に撃っている ── ここは念のためで、no-op である。 */
  input.focus();
}

/** 隣の升を名指しするだけの座標(`data-pkc-cell-*` の生の字)。 */
export interface CellMove {
  readonly line: string;
  readonly col: string;
}

/**
 * 🔴 **確定したあと、隣の升の欄を開き直す予約**(#750 I1。user 裁定 2026-09-06)。
 *
 * ## なぜ「予約」が要るか
 *
 * `Tab` / `Enter` で確定すると `SET_CSV_CELL` → worker を往復 → `BODY_REWRITTEN` →
 * `applyBlocks` が**表の塊ごと差し替える**。⚠ つまり**隣の升は、いま画面に在る物とは
 * 別の要素になる** ── その場で `click()` しても、数十ミリ秒後に捨てられる
 * (#745 で直したのと同じ経路である)。
 * 🔑 だから**差し替えた後に開く**:ここに預けておき、`detail.ts` の描き直しが
 *   {@link takeCellMove} で受け取って開く。
 *
 * ⚠ **1 回の描き直しでだけ有効**(`take` は読んだら捨てる)── 残しておくと、
 *   無関係な描き直しで**押していない升が突然開く**。
 * 🔑 **取り消しは「升を開いたとき」1 か所だけ**(`binder.ts` の `edit-cell` が
 *   `requestCellMove(null)` を撃つ)── user が自分で別の升を押した回に、
 *   後から届いた書き戻しで**預けていた升**が開くのを止める。
 * ⚠ **`Escape` には置いていない。** 置きかけたが、外しても何も壊れなかった ──
 *   予約を撃つのは確定の瞬間だけで、そのとき欄は閉じている。次に鍵を押せるのは
 *   **升を開いた後**で、開いた時点で上の 1 か所が既に消している(到達しない)。
 *   🔑 CLAUDE.md「『これが無いと壊れる』と書く前に、外して壊れることを見る」。
 */
let pendingMove: CellMove | null = null;

export function requestCellMove(move: CellMove | null): void {
  pendingMove = move;
}

export function takeCellMove(): CellMove | null {
  const m = pendingMove;
  pendingMove = null;
  return m;
}

/**
 * その升の欄を開く。開けたら `true`。
 * ⚠ 開くのは `binder.ts` の `edit-cell` ── ここは押すだけ(§7。{@link reopenCellInput} と同じ)。
 */
export function openCellAt(host: HTMLElement, move: CellMove): boolean {
  const cell = host.querySelector<HTMLElement>(cellSelector(move.line, move.col));
  if (cell === null) return false;
  cell.click();
  return host.querySelector(INPUT) !== null;
}

/**
 * 🔴 **隣の升を、画面に焼かれた印から引く**(#750 I1)。
 *
 * ⚠ **行番号と列番号の計算で出さない** ── 押せない升(見出しの区切りの行、
 *   原文にその升が無い行)には印が焼かれないので、計算で出すと
 *   **押しても何も起きない升**へ移ってしまう(#750 I4 がまさにその形)。
 * 🔑 だから**同じ表の中の「印の在る升」だけ**を読み、その中で隣を選ぶ。
 *
 * - `right` / `left` … 画面の並び順で次 / 前(行の端では次 / 前の行へ回る)
 * - `down` … **同じ列**の、行番号がいちばん近い下の升(無ければ `null`)
 *
 * ⚠ 探す範囲は**その表の塊の中だけ** ── 本文に表が 2 つ在るとき、
 *   1 つ目の右端から 2 つ目へ飛び移らない。
 */
export function neighborCell(from: HTMLElement, dir: 'right' | 'left' | 'down'): CellMove | null {
  const block = from.closest<HTMLElement>('.pkc-md-block');
  if (block === null) return null;
  const cells = [...block.querySelectorAll<HTMLElement>('[data-pkc-action="edit-cell"]')];
  const at = cells.indexOf(from);
  if (at < 0) return null;
  const coord = (el: HTMLElement): CellMove | null => {
    const line = el.getAttribute('data-pkc-cell-line');
    const col = el.getAttribute('data-pkc-cell-col');
    return line === null || col === null ? null : { line, col };
  };
  if (dir !== 'down') {
    const next = cells[at + (dir === 'right' ? 1 : -1)];
    return next === undefined ? null : coord(next);
  }
  const here = coord(from);
  if (here === null) return null;
  const line = Number(here.line);
  if (!Number.isFinite(line)) return null;
  let best: { el: HTMLElement; line: number } | null = null;
  for (const el of cells) {
    if (el.getAttribute('data-pkc-cell-col') !== here.col) continue;
    const n = Number(el.getAttribute('data-pkc-cell-line'));
    if (!Number.isFinite(n) || n <= line) continue;
    if (best === null || n < best.line) best = { el, line: n };
  }
  return best === null ? null : coord(best.el);
}
