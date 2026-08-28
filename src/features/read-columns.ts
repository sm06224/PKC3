/**
 * 🔴 **読む面の段組み**(#505 段①。user 指示 2026-08-28)。
 *
 * > 「**ウルトラワイドモニター用に閲覧時にセンターペインを任意分割して、
 * > 複数ドキュメントを開いたり、一つの縦に長いドキュメントを分割ウィンドウ全体で
 * > スクロールしながら見るオプションが欲しい**」
 *
 * ここは後半 ──「**1 つの長い文書が、分割した枠全体へ流れる**」(新聞の段組み)。
 * ⚠ 前半(枠ごとに別のノート)は段②で、状態の作り替えが要る別物である。
 *
 * ## 📏 実測してから決めた(2560×900)
 *
 * | | 1 段(いま) | 段組み |
 * |---|---|---|
 * | 使っている幅 | 672 / 1695px(**40%**) | 1679px(**99%**) |
 * | 全部読むための送り | **縦に 2896px** | **横に 4270px**(縦は 0) |
 *
 * ## 🔑 なぜ「段数」だけを選ばせ、幅は選ばせないか
 *
 * 段の幅は **器 ÷ 段数**で決まるので、段数を選べば幅は決まる。⚠ 逆に幅を選ばせると、
 * 器の広さによって段数が勝手に変わり、**同じ設定でも画面ごとに見え方が変わる**。
 *
 * 🔴 **表と図は段の幅まで縮む**(実測: 12 列の表が 1679px → 816px、見出しが 4 行に
 *   折り返す / mermaid が 1399px → 816px に焼き直る)。⚠ これは避けられなかった ──
 *   `column-span: all` で全幅へ逃がす案は**実測で壊れた**(段が 41 本・横 35359px に
 *   膨れ、縦にも溢れる。固定高の横送り multicol では spanner が流れを分断するため)。
 *   🔑 だから **user が段数で取引する**形にしてある(段を減らせば表は広くなる)。
 *
 * ## 🔴 狭い画面では「段を減らす」ではなく「段組みごと止める」
 *
 * ⚠ ここは **CSS に任せて 1 度外した**(実測 2026-08-28)。`columns: <最小幅> <段数>`
 *   は器が狭ければ段数を 1 へ落とすが、🔴 **横送りは残る** ── ノート PC(1100px)で
 *   開いたら、いきなり**横スクロールで 1 段ずつめくる**画面になっていた。
 *   それは #505 の言う「1 枠へ畳む」ではない。
 * 🔑 だから `columnsFit()` で**2 段置けるかを自分で数え**、置けなければ
 *   段組みを丸ごと切って**ふつうの縦送りへ戻す**。
 *
 * ⚠ **pure module**。browser API を使わない(保存と DOM は adapter 側)。
 */

import { DEFAULT_TEXT_SCALE, textScaleSpec } from './text-scale';

/** 段組み 1 つ。⚠ **値の正本はこの表 1 枚**(`app.css` に段数を書かない)。 */
export interface ReadColumnsSpec {
  readonly id: ReadColumns;
  /** 設定画面に出す字。 */
  readonly label: string;
  /** `column-count` に入る値。 */
  readonly count: number;
}

export type ReadColumns = '1' | '2' | '3' | '4';

/**
 * ⚠ **既定は 1 段 = 現行そのまま**(`text-scale.ts` と同じ作法)── 選ばなければ
 *   見え方は 1 バイトも変わらない(user 指示 2026-08-28「見え方を勝手に変えない」)。
 */
export const READ_COLUMN_CHOICES: readonly ReadColumnsSpec[] = [
  { id: '1', label: '1 段(既定)', count: 1 },
  { id: '2', label: '2 段', count: 2 },
  { id: '3', label: '3 段', count: 3 },
  { id: '4', label: '4 段', count: 4 },
] as const;

export const DEFAULT_READ_COLUMNS: ReadColumns = '1';

/**
 * 🔴 **1 段の下限 ── 本文が標準(13px)のときの px**。
 *   これを 2 段ぶん置けない器では、**段組みそのものを止める**。
 *
 * ⚠ 読み幅の上限(`--read-w` の既定 42rem = 672px)とは**別物**である ──
 *   あちらは「広がりすぎない」上限、こちらは「狭まりすぎない」下限。
 * 🔑 448px は本文 13px で**全角 約 34 文字** ── 日本語の可読幅 35〜50 文字
 *   (`app.css` の読み幅の節)の下端である。これより狭い段は作らせない。
 *
 * 🔴 **これは固定値ではなく「標準のときの値」である**(#509。user 指示 2026-08-28
 *   「ここにユーザーによるフォントサイズ変更やブラウザの拡大率変更などが載って
 *   くれば、ユーザーは好みで見ることができるようになるはず」)。
 *   ⚠ 固定 px のままだと、**文字を大きくしても段は狭いまま**で、
 *   同じ 448px に入る字数が減る ── 特大(17px)では **26 文字**しか入らず、
 *   「大きくして読みやすくした」つもりが**読みにくくなる**向きだった。
 *   🔑 いまは `readColumnMinPx()` が本文の大きさを掛ける。
 */
export const READ_COLUMN_MIN_PX = 448;

/**
 * 🔴 **上の 448px が「全角 約 34 文字」になる本文の大きさ(px)**。
 *
 * ⚠ **13 を直に書かない** ── `text-scale.ts` の既定(標準)から引く。
 *   2 か所に同じ数字を置くと、片方だけ動いたときに**下限が静かにずれる**
 *   (CLAUDE.md §7)。⚠ CSS 側のリテラルとの一致は
 *   `tests/features/read-columns.test.ts` が突合する。
 */
export const READ_COLUMN_BASE_FONT_PX = Number.parseFloat(
  textScaleSpec(DEFAULT_TEXT_SCALE).size,
);

/**
 * 🔴 **その文字の大きさでの、1 段の下限(px)**(#509)。
 *
 * 🔑 意味は「**全角 約 34 文字ぶん**」であって px ではない ── だから本文が
 *   大きくなれば下限も一緒に大きくなる。実測(2026-08-28、実ブラウザ):
 *   本文の器の `font-size` は text-scale とぴったり一致し(12 / 13 / 15 / 17)、
 *   その器の `1em` も同じ値になる ── だから CSS 側は `1em` を掛ければよい。
 *
 * ⚠ **ブラウザの拡大率はここに載せなくてよい** ── 拡大は CSS px ごと拡大するので、
 *   下限も本文も**同じ比**で大きくなり、器だけが CSS px で狭くなる
 *   (= 拡大したら段が減る、という素直な振る舞いになる)。
 *
 * @param fontPx 本文の器の `font-size`(px)。⚠ 採寸できない環境では標準へ落ちる
 */
export function readColumnMinPx(fontPx: number): number {
  if (!Number.isFinite(fontPx) || fontPx <= 0) return READ_COLUMN_MIN_PX;
  return (READ_COLUMN_MIN_PX / READ_COLUMN_BASE_FONT_PX) * fontPx;
}

/** 段と段のすき間(px)。⚠ `--s5`(1rem = 16px)と同じ。 */
export const READ_COLUMN_GAP_PX = 16;

/**
 * 🔴 **その器で、その段数が成り立つか**(#505「狭い画面で壊れない」)。
 *
 * ⚠ **CSS に任せてはいけない**(実測 2026-08-28)。`columns: <最小幅> <段数>` は
 *   狭いと段数を 1 へ落とすが、**横送りは残る** ── ノート PC で開くと、
 *   いきなり**横スクロールで 1 段ずつめくる**画面になる。それは「畳む」ではない。
 * 🔑 だから**2 段置けないなら段組みごと止める**(= ふつうの縦送りに戻す)。
 *
 * 🔴 **文字の大きさを必ず渡す**(#509)。⚠ 既定値を持たせない ── 渡し忘れても
 *   tsc が黙る形にすると、**大きくしたのに畳む境目だけ標準のまま**という
 *   いちばん気づけない壊れ方になる(CLAUDE.md「待ちの口は optional にしない」)。
 *
 * @param paneWidth 本文の器の幅(px)
 * @param count 選ばれている段数
 * @param fontPx 本文の器の `font-size`(px)
 */
export function columnsFit(paneWidth: number, count: number, fontPx: number): boolean {
  if (count <= 1) return false;
  // ⚠ 判定は**常に 2 段ぶん**で行う ── 3 段を選んでいても、2 段置けるなら
  //   段組みは成り立つ(CSS が 2 段へ落とす)。3 段ぶんで判定すると、
  //   2 段で読めるはずの器が丸ごと縦送りへ落ちる
  return paneWidth >= readColumnMinPx(fontPx) * 2 + READ_COLUMN_GAP_PX;
}

/**
 * 🔴 **その器で、実際に何段になるか**(#526。user 報告 2026-08-28
 * 「**段組表示設定の 2〜4 のどの数字を選んでもレンダリングは変わらなかった
 * それはバグ?**」)。
 *
 * ## 答え ── バグではない。**器の幅で頭打ちになる**
 *
 * CSS は `columns: <1 段の下限> <段数>` なので、ブラウザは**入る数だけ**作る。
 * 実測(標準の文字・すき間 16px):
 *
 * ```
 * 器の幅 |  2 段を選ぶ |  3 段 |  4 段  ← 実際に組まれた段数
 * -------+-------------+-------+-------
 *    875 |           1 |     1 |     1
 *    928 |           2 |     2 |     2   🔴 3 つとも同じ
 *   1200 |           2 |     2 |     2   🔴 3 つとも同じ
 *   1391 |           2 |     3 |     3
 *   1856 |           2 |     3 |     4
 * ```
 *
 * 🔴 **器が 928〜1390px のあいだは 2/3/4 が全部 2 段**になる ── ごく普通の幅である。
 *
 * ⚠ **実装はこれを知っていた** ── `columnsFit` の注記が「3 段を選んでいても、
 *   2 段置けるなら段組みは成り立つ(**CSS が 2 段へ落とす**)」と書いている。
 *   落ちることは織り込み済みで、**user に言わないことだけが決まっていなかった**。
 *
 * ⚠ **pure**。ここは「何段になるか」を答えるだけで、出すかどうかは呼び側が決める。
 *
 * @param paneWidth 本文の器の幅(px)
 * @param count 選ばれている段数
 * @param fontPx 本文の器の `font-size`(px)
 * @returns 実際に組まれる段数。**1 なら段組みは掛かっていない**
 */
export function effectiveColumns(paneWidth: number, count: number, fontPx: number): number {
  if (count <= 1) return 1;
  /**
   * ⚠ **`columnsFit` を呼んでいた稿があったが、外した**(変異試験 S2 が SURVIVED)。
   * 🔑 下の式は `2 * 下限 + すき間` を下回ると**自然に 1 を返す** ── つまり
   *   `columnsFit` と**同じ境目**であり、呼ぶのは no-op だった。
   * ⚠ 「同じ境目である」ことは test が pin する(片方だけ動いたら落ちる)。
   */
  const min = readColumnMinPx(fontPx);
  const fits = Math.floor((paneWidth + READ_COLUMN_GAP_PX) / (min + READ_COLUMN_GAP_PX));
  return Math.max(1, Math.min(count, fits));
}

/**
 * 🔴 **その段数が出るのに要る器の幅(px)**(#526)。
 *
 * 🔑 `effectiveColumns` の**逆**である ── あちらは「幅から段数」、こちらは
 *   「段数から幅」。⚠ 2 か所に別々の式を書かない(§7)ので、**同じ 2 つの数**
 *   (1 段の下限・すき間)だけから組む。
 *
 * ⚠ user に見せる数字なので**切り上げて渡す**のは呼び側の仕事にする
 *   (ここは実数を返す ── 丸めを 2 か所でやらない)。
 */
export function minWidthForColumns(count: number, fontPx: number): number {
  const n = Math.max(1, count);
  return readColumnMinPx(fontPx) * n + READ_COLUMN_GAP_PX * (n - 1);
}

/**
 * 🔴 **順ぐりに次の段数へ**(#522。user 指示 2026-08-28
 * 「**段組表示を表示変更導線をセンターペインもしくはショートカット、
 * コンテキストメニューに用意したいくらいには気に入った**」)。
 *
 * 🔑 表の**並び順**をそのまま使う ── 別の順番を書くと、設定画面の並びと
 *   近道の順番が食い違う(CLAUDE.md §7)。
 */
export function nextReadColumns(current: ReadColumns): ReadColumns {
  const i = READ_COLUMN_CHOICES.findIndex((c) => c.id === current);
  return READ_COLUMN_CHOICES[(i + 1) % READ_COLUMN_CHOICES.length]!.id;
}

export function isReadColumns(v: unknown): v is ReadColumns {
  return typeof v === 'string' && READ_COLUMN_CHOICES.some((c) => c.id === v);
}

/** 表から 1 つ引く。⚠ 知らない id は既定へ落ちる(呼び側で分岐させない)。 */
export function readColumnsSpec(id: ReadColumns): ReadColumnsSpec {
  return READ_COLUMN_CHOICES.find((c) => c.id === id) ?? READ_COLUMN_CHOICES[0]!;
}

/**
 * 🔴 **縦のホイールを横送りへ読み替える量**。
 *
 * ⚠ **これが無いと機能ごと死ぬ**(実測)。段組みにすると送りが横になるが、
 *   縦のホイールでは **1px も動かない**(横ホイールを持つマウスは少数):
 *
 * | 操作 | 送り位置 |
 * |---|---|
 * | 縦のホイール | 1727 → **1727** |
 * | 横のホイール | 1727 → **2327** |
 *
 * 🔑 不可侵指示 2026-08-03「**マウスだけで完結し、キーボードは近道**」に
 *   正面から当たるので、読み替えは**機能の一部**である(付け足しではない)。
 *
 * ⚠ 倍率は 1 倍 ── 縦に回した分をそのまま横へ渡す。**加速しない**
 *   (OS 側で既に加速されているので、ここで掛けると効きすぎる)。
 */
export const WHEEL_TO_INLINE = 1;

/**
 * ホイールの動きを、横送りの増分へ畳む。
 *
 * ⚠ **横成分があるときは触らない** ── 横ホイールやトラックパッドの横払いは
 *   ブラウザがそのまま横送りにするので、足すと**倍の速さで飛ぶ**。
 * ⚠ 段組みでないときは呼ばない(呼び側の責務 ── ここは純関数)。
 *
 * @returns 横へ送る px(0 なら既定の動作に任せる)
 */
export function wheelToInline(deltaX: number, deltaY: number): number {
  if (deltaX !== 0) return 0;
  return deltaY * WHEEL_TO_INLINE;
}
