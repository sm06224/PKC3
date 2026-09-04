/**
 * 🔴 **長押しで印を足す**(#687 D-1。user 裁定 2026-09-04)。
 *
 * ## なぜ要るか
 *
 * 2 ペインの行に印を足す口は **Ctrl / ⌘ クリック**と **Space** の 2 つで、
 * どちらも**キーボードが要る**(`binder.ts` の `dual-row`)。スマホには無い ──
 * 指だけの端末では、印は**常に 1 件**(素のクリック = `set`)しか付けられず、
 * 「3 件を選んで右へ移す」という 2 ペインの本来の使い方が**丸ごと落ちる**。
 * 🔑 だから**長押し = Ctrl クリック**(`toggle`)にする。OS のファイラ
 * (Android / iOS の「ファイル」)が例外なくこの形で複数選択に入る。
 *
 * ## 何を受けて、何を捨てるか
 *
 * | 何 | どうする | なぜ |
 * |---|---|---|
 * | `pointerdown`(**指 / ペン**、主ボタン) | 時計を掛ける | マウスは Ctrl クリックが在るので**受けない**(長押しは右クリックの慣習) |
 * | `pointermove` が **10px** を超えた | 取り消す | 指は震えるので 0px にしない / スクロールし始めたら長押しではない |
 * | `pointerup` / `pointercancel` | 取り消す | 500ms 前に離したら**ただのタップ**(`click` が `set` を撃つ) |
 * | 500ms 経った | 発火(`toggle`)+ 700ms の**消費窓** | 直後に来る `click` を捨てる ── 捨てないと `set` で印が 1 件に戻る |
 *
 * ⚠ **`touch-action` は書かない**(CSS 側の注意)── 書くと一覧のスクロールが死ぬ。
 *   代わりに `pointermove` の距離で「スクロールし始めた」を見る。
 * ⚠ **ブラウザの長押し(`contextmenu` / `dragstart`)との取り合い**は、この file
 *   では判定だけを出し、`binder.ts` が `preventDefault` する(受け口は 1 か所)。
 *   ⚠ 実機で Android の drag が 500ms より先に始まるかは**ここでは決まらない**
 *   (`hasTouch` の smoke と cowork の実機で確かめる)。
 *
 * ## ⚠ `Date.now()` と `setTimeout` を直に使う
 *
 * test は `vi.useFakeTimers()` で両方を進める ── 差し替え口を作ると、
 * 製品と test で**別の時計**を読む形になる(`binder.ts` の `maybeEnterFolder` も
 * `Date.now()` を直に読んでいる ── 同じ作法)。
 */

/** 押し続ける時間。⚠ Android / iOS の長押し既定(500ms 前後)に揃える。 */
export const LONG_PRESS_MS = 500;
/** これより動いたら長押しではない(指の震えは許し、スクロールは許さない)。 */
export const LONG_PRESS_SLOP_PX = 10;
/**
 * 発火の後、`click` を捨てる時間。
 * ⚠ 離した瞬間に来る `click` だけを捨てたいが、指を離すまでの時間は user しだい
 *   なので、**発火からの窓**で見る(700ms 押し続けて離しても捨てる)。
 */
export const LONG_PRESS_CONSUME_MS = 700;
/** 受ける行。⚠ 2 ペインの行だけ(左の列は印の面ではない ── #240 段② の規律)。 */
export const LONG_PRESS_TARGET = '[data-pkc-action="dual-row"]';

export interface LongPress {
  /** 配線を解く(`bindActions` の teardown から呼ぶ)。 */
  dispose(): void;
  /**
   * 発火の直後に来た `click` か。⚠ 真なら `binder` はその `click` を
   * **`set` にも「2 回押した」にも数えない**(印が 1 件に戻る / フォルダへ入る、を止める)。
   */
  swallowsClick(): boolean;
  /**
   * その行で長押しを**待っている**、または**発火した直後**か。
   * 🔑 `contextmenu` の門 ── Android は長押しで OS のメニューを出すので、
   *    印を足した行にメニューが重なるのを止める。
   */
  holds(el: Element): boolean;
  /**
   * その行で**指の**長押しを待っている最中か(ペン・マウスは含まない)。
   * 🔑 `dragstart` の門 ── 指で押さえている間に drag が始まると、印を足す
   *    つもりの指が行を運び出す。
   */
  pendingTouch(el: Element): boolean;
}

interface Pending {
  readonly el: HTMLElement;
  readonly x: number;
  readonly y: number;
  readonly touch: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * 長押しを root で受ける(委譲 ── 行は描画のたびに作り直されるので、行に付けない)。
 *
 * @param onLongPress 発火したときに呼ぶ(行の要素を渡す ── 側と lid は呼び手が辿る)
 */
export function installLongPress(
  root: HTMLElement,
  onLongPress: (row: HTMLElement) => void,
): LongPress {
  let pending: Pending | null = null;
  /** 直近の発火(行と、`click` を捨てる期限)。 */
  let fired: { readonly el: HTMLElement; readonly until: number } | null = null;

  const cancel = (): void => {
    if (pending === null) return;
    clearTimeout(pending.timer);
    pending = null;
  };
  const onDown = (ev: PointerEvent): void => {
    /**
     * ⚠ **マウスは受けない** ── マウスには Ctrl クリックが在り、押し続けるのは
     *   drag の始まりである。`pointerType` が空(古い実装)なら指として扱う。
     * ⚠ 主ボタンだけ(ペンの側面ボタンは既に「右クリック」の意味を持つ)。
     */
    if (ev.pointerType === 'mouse' || ev.button !== 0) return;
    const row = (ev.target as Element | null)?.closest<HTMLElement>(LONG_PRESS_TARGET) ?? null;
    cancel();
    if (row === null || !root.contains(row)) return;
    const el = row;
    const touch = ev.pointerType === 'touch';
    pending = {
      el,
      x: ev.clientX,
      y: ev.clientY,
      touch,
      timer: setTimeout(() => {
        pending = null;
        fired = { el, until: Date.now() + LONG_PRESS_CONSUME_MS };
        /**
         * 🔑 **指に返事をする**(OS のファイラと同じ)── 画面の印は指の下に隠れて
         *   いることが多いので、震えが「入った」の合図になる。無い端末では何もしない。
         */
        (navigator as { vibrate?: (pattern: number) => boolean }).vibrate?.(10);
        onLongPress(el);
      }, LONG_PRESS_MS),
    };
  };
  const onMove = (ev: PointerEvent): void => {
    if (pending === null) return;
    if (Math.hypot(ev.clientX - pending.x, ev.clientY - pending.y) > LONG_PRESS_SLOP_PX) cancel();
  };
  const onUp = (): void => cancel();

  root.addEventListener('pointerdown', onDown);
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerup', onUp);
  root.addEventListener('pointercancel', onUp);

  const firedNow = (el: Element | null): boolean =>
    fired !== null && (el === null || fired.el === el) && Date.now() < fired.until;
  return {
    dispose: () => {
      cancel();
      fired = null;
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerup', onUp);
      root.removeEventListener('pointercancel', onUp);
    },
    swallowsClick: () => firedNow(null),
    holds: (el) => pending?.el === el || firedNow(el),
    pendingTouch: (el) => pending !== null && pending.touch && pending.el === el,
  };
}
