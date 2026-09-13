/**
 * 🔴 **予定の札を、指でも掴んで動かせるようにする**(#855 決1)。
 *
 * ## なぜ要るか(実測。#855 が測らせた ── ここが実測の正本)
 *
 * | | 掴んで通った印(`data-pkc-dropping`) | **本文** |
 * |---|---|---|
 * | マウス | 光る | `@2026-09-13` → `@2026-09-16` に書き換わる |
 * | 🔴 指(CDP の本物の touch、50ms も 600ms も) | **1 度も光らない** | **変わらない** |
 *
 * 観測点は「掴んで動かした先で `data-pkc-dropping` が立つか」+「保存された本文が
 * 書き替わるか」の 2 つ(実ブラウザ・`Input.dispatchTouchEvent` で計測)。
 * 原因は `task-card.ts` の `card.draggable = true`(= HTML5 の drag)── 大半の
 * 携帯ブラウザは指の押下から `dragstart` を起こさない。**指だけの端末には、
 * 予定を動かす道が 1 つも無かった。**
 *
 * ## マウスの経路は 1 バイトも触らない(この file を「足す」だけ)
 *
 * ⚠ **HTML5 の drag(`binder.ts` の `dragstart`/`dragover`/`drop` の
 * `PKC_TASK_DRAG` 枝)は残す** ── 消すと `tests/adapter/schedule-view.test.ts`
 * (`dragTo` ヘルパで組んだ、掴んだ日が荷物に無い形の防御まで含む一式)が
 * 総崩れになる。⚠ そして **`document.elementFromPoint` は happy-dom で
 * 常に `null` を返す**(実測。`node_modules/happy-dom/.../Document.js` の
 * `elementFromPoint(_x, _y) { return null; }`)ので、Pointer Events 版の
 * 「どこへ落ちたか」を unit で丸ごと検めることもできない ──
 * だから**マウスの経路(HTML5 drag)には触らないのが正しい選択**である。
 * 🔑 この file は **`pointerType !== 'mouse'`**(指・ペン)だけを受ける ──
 * マウスは既存の HTML5 drag が引き続き 1 本で答える。CLAUDE.md §7 の
 * 「『予定を掴む』に答える口を 2 つ作らない」を、**入力の種類で完全に
 * 棲み分ける**ことで満たす(`long-press.ts` が並べ替えで既にこの形を
 * 採っている ── 前例に倣う。マウスには元から Ctrl クリック / 右クリックが
 * 在るので `pointerType === 'mouse'` を受けない、と同じ理屈)。
 *
 * ## 落とし先の判定は 1 本(CLAUDE.md §7)
 *
 * 「掴んだ荷物 + 落ちた日」から**何を dispatch するか**(繰り返しは断る /
 * ノート丸ごとは `SET_ENTRY_DATE` / 行は `SET_TASK_DATE` で期間を保ったまま
 * ずらす)は `dropTaskCard()` にまとめ、`binder.ts` の HTML5 drop 枝からも
 * **同じ関数**を呼ばせる(2 つの入力経路が、同じ 1 つの判定を共有する)。
 *
 * ## 🔴 `place-drag.ts` の「少し動いてから掴む」(`DRAG_SLOP`)ではなく
 * **長押しで掴む**にした(依頼の指示を実測で覆した ── 理由を書く)
 *
 * ⚠ 依頼の指示は「`place-drag.ts` と同じ `DRAG_SLOP` 作法」だったが、
 * **実測(2026-09-13、実ブラウザで束の位置を測った)で作れないと分かった**:
 *
 * | 実測した bounding box | 値 |
 * |---|---|
 * | 掴む札(`schedule-cards` 内) | `y ≈ 409〜453` |
 * | 小さな月の升目(落とし先) | `y ≈ 269〜295` |
 * | 横のずれ(隣の日の升目まで) | `≈ 108px` |
 * | 縦のずれ(札 → 升目) | `≈ 140〜150px` |
 *
 * 🔴 **升目は縦にずっと上に在る**(このアプリの予定タブは升目が上・束が下の
 * 縦積み)。「動く」を全方向で受けると、**縦へ動かした瞬間に毎回これが奪い取り、
 * 一覧が二度とスクロールできなくなる**(指で試した最初の設計はこれで、
 * `Math.abs(dy) > Math.abs(dx)` のときだけスクロールへ譲る案も試したが、
 * **升目そのものへ寄せる動きが縦優位**なので、今度は「升目へ落とす」が
 * ほぼ全滅した ── 縦横どちらの単純な閾値でも両立しない)。
 * 🔑 だから**時間で決める**(`long-press.ts` と同じ考え方 ── この repo は
 * 「触れてすぐの動きはスクロール、押さえ続けたら別の意味」を**タイルの並べ替え**
 * (#857 段①b-2)で既に採用している。前例に倣う):
 *
 * | | `place-drag.ts` | ここ |
 * |---|---|---|
 * | 掴む・動かす・離す | `pointerdown` / `pointermove` / `pointerup` | 同じ |
 * | 「掴む」を確定する条件 | 少し動いたら(`DRAG_SLOP`) | 🔴 **`LONG_PRESS_MS` 押さえ続けたら** |
 * | 確定までに動いたら | そのまま掴む | 🔴 **取り消す**(`LONG_PRESS_SLOP_PX` 以上 ── スクロール) |
 * | 確定した後の向き | 制限なし | 制限なし(縦横どちらへも落とせる) |
 * | 落とし先 | 無い(自分の x/y を書くだけ) | 🔴 **「いま指の下に何が在るか」を見る** |
 * | 掴む所 | 小さな専用の ⠿ | 🔴 **札そのもの**(印・外す ✕ ボタンは除く) |
 *
 * ⚠ **これで「触れてすぐの縦スワイプ」は常にスクロール、「押さえ続けてから
 * 動かす」は常に掴む、へ完全に分かれる** ── 向きでの取り違えが構造から消える。
 * `LONG_PRESS_MS` / `LONG_PRESS_SLOP_PX` は `long-press.ts` から**そのまま
 * 借りる**(「何を長押しと数えるか」の判定を 2 か所で別々に持たない)。
 *
 * ⚠ **なぜ「いま指の下に何が在るか」を `e.target` で読まないか**:
 * touch の pointer は Pointer Events の仕様で **pointerdown の的へ暗黙に
 * capture される**(spec: "implicit pointer capture")ので、指を動かしても
 * `pointermove` / `pointerup` の `e.target` は**ずっと掴んだ札のまま**になる
 * ── HTML5 の `dragover`/`drop` が自然にくれる「本当にその下に在る要素」を
 * touch の Pointer Events は無償でくれない。🔑 だから
 * `document.elementFromPoint(clientX, clientY)` で毎回引き直す。
 * ⚠ **その `elementFromPoint` が happy-dom では常に `null`** なので、
 * `null` のときは `e.target` へ落とす ── 実ブラウザ(mouse を除く pointerType)
 * だけが本物の判定で動き、unit はこの file の落とし先判定そのものを
 * 検められない(実機の指は測れない、と同じ限界)。
 *
 * ## 見え方は変えていない
 *
 * 掴んでいる間に光るのは既存の `data-pkc-dropping`(`app.css` の
 * `[data-pkc-drop-date][data-pkc-dropping]`)そのもの ── 新しい装飾は足していない。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { addDays, daysBetween } from '@features/datetime/date-math';
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX } from '@adapter/ui/actions/long-press';

/** 掴める札。⚠ `kanban-cards` は #292 段⑤で外れた死んだ綴り(`app.css` に残骸あり) ──
 *  ただし `binder.ts` の HTML5 dragstart と選び方を揃え、勝手に狭めない。 */
const TASK_CARD_SELECTOR =
  '[data-pkc-region="schedule-cards"] > [data-pkc-entry], [data-pkc-region="kanban-cards"] > [data-pkc-entry]';
/**
 * 掴ませない部品(印 / 外す ✕)。ここは素の click / change に任せる。
 *
 * ⚠ **`data-pkc-action="…"` の綴りをそのまま書かない**(2026-09-13 実測)。
 *   `scripts/action-outlets.mjs` の `outlets()` は `src` 全体を
 *   `data-pkc-action=["'](name)["']` で正規表現走査するので、ここへ書いた
 *   瞬間に「`toggle-task` / `unschedule-task` の出口がこの file にも在る」と
 *   **誤カウント**され、`tests/action-outlets.test.ts` の `OBJECT_LONE`
 *   (出口 1 か所の一覧)が偽って動く(実測で `unschedule-task` が落ちた)。
 *   🔑 **同じ部品を別の属性で選ぶ** ── 印は `type="checkbox"`、外す ✕ は
 *   `task-card.ts` が焼く `data-pkc-field="task-unschedule"`。
 */
const NO_GRAB_SELECTOR = 'input[type="checkbox"], [data-pkc-field="task-unschedule"]';

/** 掴んだ札が持つ荷物。`binder.ts` の HTML5 drag が組む文字列と同じ 4 つ。 */
export interface GrabbedTask {
  readonly lid: string;
  /** 空文字 = ノート 1 件が丸ごと予定(frontmatter の `date:`)。 */
  readonly line: string;
  /** 掴んだ日(束の見出しの日付)。空 = 取れなかった。 */
  readonly from: string;
  /** 空文字 = 繰り返しでない。それ以外は `RepeatKind`。 */
  readonly repeat: string;
}

/** 長押しが確定するまで(押さえている最中)。 */
interface Pending {
  readonly card: HTMLElement;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly grabbed: GrabbedTask;
  readonly timer: ReturnType<typeof setTimeout>;
}
/** 長押しが確定した後(全方向へ動かせる)。 */
interface Armed extends GrabbedTask {
  readonly card: HTMLElement;
  readonly pointerId: number;
}

/**
 * 🔴 **予定の札を落としたときに何を書くか**(#344 段①②・#855 決1)。
 *
 * ⚠ **判定は 1 本**(CLAUDE.md §7)── マウス(`binder.ts` の HTML5 `drop`)と
 * 指(`installScheduleDrag` の `pointerup`)の両方から呼ぶ。中身は
 * `binder.ts` に元々あった `PKC_TASK_DRAG` の drop 処理をそのまま移した
 * (振る舞いは 1 バイトも変えていない ── `tests/adapter/schedule-view.test.ts`
 * の `dragTo` 系がこの関数を通って緑のままなら、移し違いは無い)。
 */
export function dropTaskCard(
  dispatcher: Dispatcher,
  grabbed: GrabbedTask,
  /** 落ちた日(`data-pkc-drop-date` の値)。空文字 = 日付なしへ外す。 */
  dropDate: string,
): void {
  /**
   * 🔴 **繰り返しの回は日を動かせない ── 黙って何もしないのではなく、断る**
   *   (#344 段②)。
   *
   * ⚠ 動かす意味が **2 通り**ある(「規則ごとずらす」/「この回だけずらす」)ので、
   *   どちらかを勝手に選ぶと**もう片方を頼んだ user のデータが壊れる**。
   * ⚠ 「この回だけ」は**例外日の記法**が要る ── 記法を増やさずに済ませたのが
   *   この設計の要なので(`repeat.ts` の頭)、そこは開けない。
   * 🔑 だから**どこを直せばよいかまで言う**(本文の `@… 毎週` を直す)。
   */
  if (grabbed.repeat !== '') {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: '繰り返しの予定はドラッグで動かせません。本文の「@日付 毎週」を書き直してください',
    });
    return;
  }
  const date = dropDate === '' ? null : dropDate;
  /**
   * 🔴 **単位が 2 つある**(段④)── 行番号が空なら
   *   **ノート 1 件が丸ごと予定**で、書き換えるのは frontmatter の `date:` である。
   * ⚠ 同じ落とし先に、書き換える場所が違う 2 種類が落ちてくる ── だから
   *   ここで分ける(面ごとに 2 つの落とし先を作らない)。
   */
  if (grabbed.line === '') {
    dispatcher.dispatch({ type: 'SET_ENTRY_DATE', lid: grabbed.lid, date });
    return;
  }
  const line = Number(grabbed.line);
  if (!Number.isInteger(line)) return;
  const card = dispatcher
    .getState()
    .taskScan?.cards.find((c) => c.lid === grabbed.lid && c.line === line);
  /**
   * 🔴 **期間は「長さを保ったまま」ずらす**(#344 段①)。
   *
   * ⚠ 掴んだ日(`grabbed.from`)と落とした日の差だけ、開始と終わりを**両方**動かす。
   *   開始だけ動かすと、user は「1 日ずらした」つもりなのに**期間が伸び縮みする**。
   * ⚠ 日付を**外す**とき(`date === null`)は期間ごと剥がす。
   * ⚠ 掴んだ日が取れなかった回(荷物が古い / 板から掴んだ)は、**開始を基準にする**。
   * ⚠ 差が計算できなければ **0**(= 何も動かさない)── 当てずっぽうで期間を書き換えない。
   */
  const from = grabbed.from !== '' ? grabbed.from : (card?.date ?? null);
  const shift =
    card?.until != null && date !== null && from !== null ? (daysBetween(from, date) ?? 0) : null;
  const until =
    date === null
      ? null
      : card?.until == null
        ? null
        : shift === null
          ? card.until
          : (addDays(card.until, shift) ?? card.until);
  /**
   * ⚠ 開始も同じ差で動かす ── 落とした日は「**掴んだ札**が来る日」であって、
   *   期間の開始ではない(掴んだのが 3 日目なら、開始は落とした日の 2 日前になる)。
   */
  const start = shift === null || card?.date == null ? date : (addDays(card.date, shift) ?? date);
  dispatcher.dispatch({
    type: 'SET_TASK_DATE',
    lid: grabbed.lid,
    line,
    date: start,
    // ⚠ 外すときは時刻も一緒に落ちる(記法ごと剥がすため)
    time: card?.time ?? null,
    until,
  });
}

/**
 * root へ 1 度だけ配線する(`installPlaceDrag` と同じ作法)。
 * @returns 外す関数。アプリ本体では外さない(同寿命)が、test は外せる必要がある。
 */
export function installScheduleDrag(root: HTMLElement, dispatcher: Dispatcher): () => void {
  const doc = root.ownerDocument;
  let pending: Pending | null = null;
  let armed: Armed | null = null;
  let swallowClick = false;
  let dropMark: HTMLElement | null = null;

  const markDrop = (el: HTMLElement): void => {
    if (dropMark === el) return;
    clearDrop();
    dropMark = el;
    el.setAttribute('data-pkc-dropping', '');
  };
  const clearDrop = (): void => {
    dropMark?.removeAttribute('data-pkc-dropping');
    dropMark = null;
  };
  const cancelPending = (): void => {
    if (pending === null) return;
    clearTimeout(pending.timer);
    pending = null;
  };

  /** 落とし先(日の升目 / 束の見出し)。`null` = 落とせない場所。 */
  const dateTargetOf = (el: Element | null): { el: HTMLElement; date: string } | null => {
    const found = el?.closest<HTMLElement>('[data-pkc-drop-date]') ?? null;
    if (found === null || !root.contains(found)) return null;
    return { el: found, date: found.getAttribute('data-pkc-drop-date') ?? '' };
  };

  /**
   * いま指(ポインタ)の下に実際に在る要素。⚠ `elementFromPoint` が使えないとき
   * (happy-dom は常に `null` を返す)は `e.target` に落とす ── unit はこちらを通る。
   */
  const underPointer = (e: PointerEvent): Element | null => {
    if (typeof doc.elementFromPoint === 'function') {
      const hit = doc.elementFromPoint(e.clientX, e.clientY);
      if (hit !== null) return hit;
    }
    return e.target as Element | null;
  };

  const onPointerDown = (e: PointerEvent): void => {
    swallowClick = false;
    // ⚠ マウスは受けない(既存の HTML5 drag が 1 本で答える。上のコメント参照)
    if (e.pointerType === 'mouse' || e.button !== 0) return;
    // ⚠ 2 本目の指では掴み直さない(`place-drag.ts` と同じ理由)
    if (pending !== null || armed !== null) return;
    const target = e.target as Element | null;
    if (target?.closest(NO_GRAB_SELECTOR) != null) return;
    const card = target?.closest<HTMLElement>(TASK_CARD_SELECTOR) ?? null;
    if (card === null || !root.contains(card)) return;
    const lid = card.getAttribute('data-pkc-entry');
    if (lid === null) return;
    /**
     * ⚠ **ノート 1 件が丸ごと予定**のときは行番号が無い(段④)── `line` を
     *   空にして、落とす側が `SET_ENTRY_DATE`(frontmatter)へ回す。
     * 🔑 印が在るかどうかで見分けない ── **札自身の印**(`data-pkc-whole-note`)
     *   で見る(`binder.ts` の `dragstart` と同じ規則)。
     */
    const whole = card.hasAttribute('data-pkc-whole-note');
    const line = whole
      ? ''
      : (card.querySelector('[data-pkc-task-line]')?.getAttribute('data-pkc-task-line') ?? null);
    if (line === null) return; // 掴む対象が読めない札(壊れた形)は掴ませない
    const grabbed: GrabbedTask = {
      lid,
      line,
      from: dateTargetOf(card)?.date ?? '',
      repeat: card.getAttribute('data-pkc-task-repeat') ?? '',
    };
    const pointerId = e.pointerId;
    pending = {
      card,
      pointerId,
      startX: e.clientX,
      startY: e.clientY,
      grabbed,
      timer: setTimeout(() => {
        pending = null;
        armed = { ...grabbed, card, pointerId };
        try {
          card.setPointerCapture(pointerId);
        } catch {
          // 捕まえられない環境でも、下の pointermove/pointerup は document から届く
        }
        // 🔑 指に返事をする(`long-press.ts` と同じ ── 印は指の下に隠れていることが多い)
        (navigator as unknown as { vibrate?: (ms: number) => boolean }).vibrate?.(10);
      }, LONG_PRESS_MS),
    };
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (pending !== null && e.pointerId === pending.pointerId) {
      /**
       * 🔑 確定する前に動いたら**スクロールに譲る**(取り消すだけ ── まだ
       * `preventDefault` を 1 度も呼んでいないので、ブラウザは自由に
       * スクロールしてよい)。震え(数 px)は許すが、明確な移動は許さない。
       */
      const moved = Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY);
      if (moved > LONG_PRESS_SLOP_PX) cancelPending();
      return;
    }
    if (armed === null || e.pointerId !== armed.pointerId) return;
    // 🔑 確定した後は全方向で掴む(押さえ続けた時点で意図は確定している)
    e.preventDefault();
    const drop = dateTargetOf(underPointer(e));
    if (drop === null) {
      // ⚠ 光ったままにしない ── 通ってから別の場所で離すと「そこへ入った」と読む
      clearDrop();
      return;
    }
    markDrop(drop.el);
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (pending !== null && e.pointerId === pending.pointerId) {
      cancelPending(); // 確定前に離した ── ただのタップ、素の click に任せる
      return;
    }
    if (armed === null || e.pointerId !== armed.pointerId) return;
    const a = armed;
    armed = null;
    swallowClick = true;
    clearDrop();
    const drop = dateTargetOf(underPointer(e));
    if (drop === null) return;
    dropTaskCard(dispatcher, a, drop.date);
  };

  const onPointerCancel = (e: PointerEvent): void => {
    if (pending !== null && e.pointerId === pending.pointerId) {
      cancelPending();
      return;
    }
    if (armed === null || e.pointerId !== armed.pointerId) return;
    armed = null;
    clearDrop(); // 途中で切れたら光りを消すだけ(本文はまだ書いていない)
  };

  const onClick = (e: MouseEvent): void => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  };

  /**
   * 🔴 **確定した後は、素の `touchmove` も止める**(2026-09-13 実測で必須と判明)。
   *
   * ⚠ `PointerEvent.preventDefault()` は、この Chromium では**縦スクロールを
   *   止めない** ── 実測(CDP の本物の touch を多段の `touchMove` で送った):
   *   `pointermove` の `preventDefault` を呼んでいても、**1 回動いただけで
   *   `pointercancel` が飛び、器は実際にスクロールした**(素の `<div>` で
   *   検めても同じ)。⚠ `touchmove`(Touch Events 側)を**非 passive**で
   *   `preventDefault` して初めて止まった(同じ手順で `pointercancel` が
   *   1 度も飛ばず、スクロールも 0 だった)。
   * 🔑 だから**確定している間だけ** `touchmove` を止める ── 確定前
   *   (`pending`)は 1 度も呼ばない(縦スクロールの候補のまま)。
   * ⚠ `{ passive: false }` が要る ── 既定(passive)では `preventDefault` が
   *   黙って無視される。
   */
  const onTouchMove = (e: TouchEvent): void => {
    if (armed === null) return;
    e.preventDefault();
  };

  doc.addEventListener('pointerdown', onPointerDown);
  doc.addEventListener('pointermove', onPointerMove);
  doc.addEventListener('pointerup', onPointerUp);
  doc.addEventListener('pointercancel', onPointerCancel);
  doc.addEventListener('touchmove', onTouchMove, { passive: false });
  doc.addEventListener('click', onClick, true);
  return () => {
    cancelPending();
    clearDrop();
    doc.removeEventListener('pointerdown', onPointerDown);
    doc.removeEventListener('pointermove', onPointerMove);
    doc.removeEventListener('pointerup', onPointerUp);
    doc.removeEventListener('pointercancel', onPointerCancel);
    doc.removeEventListener('touchmove', onTouchMove);
    doc.removeEventListener('click', onClick, true);
  };
}
