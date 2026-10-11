/**
 * 🔴 **波形の上のドラッグ = 切り出しの範囲を決める**(#1232)。
 *
 * ## 既存の流れに乗る(別のアプリを作らない)
 *
 * ドラッグで決まる範囲は、ボタン「ここを始まりにする」「ここを終わりにする」と**同じ印**
 * (`SET_CAPTURE_TRIM_MARK` の `start` / `end`)に入る。そのあと「この範囲で切り出す」を押すのも同じ。
 * ⚠ 印の持ち主は state(`captureTrim`)── ここは**ポインタの動きを ms に直して撃つだけ**。
 *
 * ## 動き
 *
 * | 操作 | 起きること |
 * |---|---|
 * | 動かさずに離す(`WAVE_DRAG_MIN_PX` 未満) | **その位置へ再生を移す**(再生機が同じ行に居るとき) |
 * | ドラッグして離す | 小さいほうが始まり・大きいほうが終わり。**始まり → 終わり**の順に撃つ |
 * | ドラッグ中 | 画面の重ね描きと時刻だけ動かす(state は触らない ── 押している最中に一覧を組み直さない) |
 *
 * 🔑 前の印が新しい範囲と交差していても、最後に両方が揃う(reducer が**逆転を残さない**:
 *   `SET_CAPTURE_TRIM_MARK`)。⚠ 撃つ順(始まり → 終わり)は結果に効かない ── 逆順に入れ替える変異が
 *   生き延びたので、「順番が大事」とは書かない(どちらの順でも最後は同じ範囲になる)。
 * ⚠ 指 1 本でも動く(`touch-action: none` は CSS 側)。キーボードの道は既存のボタンのまま。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { elapsedText } from '@features/elapsed-text';
import { dragRange, msToFrac, waveXToMs, WAVE_DRAG_MIN_PX } from '@features/audio/waveform';

const STRIP = '[data-pkc-region="capture-wave"]';

/** 重ね描き(範囲)の位置を割合で置く。⚠ 描画器(`captures.ts`)と同じ 1 本 ── 別に書かない。 */
export function placeRange(
  strip: HTMLElement,
  startMs: number | null,
  endMs: number | null,
  durationMs: number,
): void {
  const range = strip.querySelector<HTMLElement>('[data-pkc-field="capture-wave-range"]');
  if (!range) return;
  if (startMs === null && endMs === null) {
    range.hidden = true;
    return;
  }
  // 片方だけのときは、その位置に細い線を立てる(幅 0)
  const a = msToFrac(startMs ?? endMs!, durationMs);
  const b = msToFrac(endMs ?? startMs!, durationMs);
  range.hidden = false;
  range.style.left = `${(a * 100).toFixed(3)}%`;
  range.style.width = `${((b - a) * 100).toFixed(3)}%`;
}

export function bindWaveDrag(root: HTMLElement, dispatcher: Dispatcher): () => void {
  /** ドラッグ中か。⚠ 2 本目の指・別のポインタの押下は無視する(1 本のドラッグに 2 つ目を混ぜない)。 */
  let active = false;
  /** ⚠ 一覧が作り直されて帯が消えると pointerup が届かない ── 繋がっていない帯の「ドラッグ中」は無かったことにする。 */
  let activeStrip: HTMLElement | null = null;
  const onDown = (ev: PointerEvent): void => {
    if (active && activeStrip?.isConnected === true) return;
    if (ev.button !== undefined && ev.button !== 0) return;
    const strip = (ev.target as Element | null)?.closest?.(STRIP) as HTMLElement | null;
    if (!strip || !root.contains(strip)) return;
    const duration = Number(strip.getAttribute('data-pkc-duration-ms'));
    if (!(duration > 0)) return;
    const rectOf = (): { left: number; width: number } => {
      const r = strip.getBoundingClientRect();
      return { left: r.left, width: r.width };
    };
    const msAt = (x: number): number => {
      const r = rectOf();
      return waveXToMs(x, r.left, r.width, duration);
    };
    const trimmable = strip.getAttribute('data-pkc-trimmable') === '1' && !dispatcher.getState().captureTrimBusy;
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    const id = ev.pointerId;
    const ms0 = msAt(x0);
    let dragging = false;
    let ms1 = ms0;
    const label = strip.querySelector<HTMLElement>('[data-pkc-field="capture-wave-label"]');
    try {
      strip.setPointerCapture?.(ev.pointerId);
    } catch {
      // 触れない相手(合成イベント)でも、帯の上の動きは取れる
    }
    ev.preventDefault();
    active = true;
    activeStrip = strip;

    const onMove = (m: PointerEvent): void => {
      // ⚠ 別のポインタ(2 本目の指)の動きは、このドラッグのものではない
      if (m.pointerId !== id) return;
      /**
       * 🔑 **縦に動き出したらやめる**(指で縦にスクロールしたいだけの人を、範囲選びに巻き込まない)。
       * ⚠ 横より縦が大きい動きが `WAVE_DRAG_MIN_PX` に達した時点で、まだドラッグでなければ取りやめる。
       */
      if (!dragging && Math.abs(m.clientY - y0) >= WAVE_DRAG_MIN_PX && Math.abs(m.clientY - y0) > Math.abs(m.clientX - x0)) {
        finish(m, false);
        return;
      }
      if (!dragging && Math.abs(m.clientX - x0) >= WAVE_DRAG_MIN_PX) dragging = true;
      if (!dragging || !trimmable) return;
      ms1 = msAt(m.clientX);
      const { startMs, endMs } = dragRange(ms0, ms1);
      placeRange(strip, startMs, endMs, duration);
      if (label) {
        label.hidden = false;
        label.textContent = `${elapsedText(startMs)}〜${elapsedText(endMs)}`;
      }
    };
    const finish = (u: PointerEvent, commit: boolean): void => {
      active = false;
      strip.removeEventListener('pointermove', onMove);
      strip.removeEventListener('pointerup', onUp);
      strip.removeEventListener('pointercancel', onCancel);
      try {
        strip.releasePointerCapture?.(u.pointerId);
      } catch {
        // 掴んでいなければ何もしない
      }
      if (label) label.hidden = true;
      if (!commit) {
        // 取りやめ: 重ね描きを state の印へ戻す(描画器が次の同期で置き直す)
        const t = dispatcher.getState().captureTrim;
        placeRange(strip, t?.startMs ?? null, t?.endMs ?? null, duration);
        return;
      }
      if (dragging && trimmable) {
        const { startMs, endMs } = dragRange(ms0, msAt(u.clientX));
        dispatcher.dispatch({ type: 'SET_CAPTURE_TRIM_MARK', edge: 'start', ms: startMs });
        dispatcher.dispatch({ type: 'SET_CAPTURE_TRIM_MARK', edge: 'end', ms: endMs });
        return;
      }
      if (!dragging) {
        // 押しただけ: その位置から再生する
        const media = strip
          .closest('[data-pkc-capture]')
          ?.querySelector<HTMLMediaElement>('[data-pkc-field="capture-media"]');
        if (media) media.currentTime = ms0 / 1000;
      }
    };
    const onUp = (u: PointerEvent): void => {
      if (u.pointerId === id) finish(u, true);
    };
    const onCancel = (u: PointerEvent): void => {
      if (u.pointerId === id) finish(u, false);
    };
    strip.addEventListener('pointermove', onMove);
    strip.addEventListener('pointerup', onUp);
    strip.addEventListener('pointercancel', onCancel);
  };
  /**
   * 🔴 **波形の上の click は、ここで止める**(実ブラウザ smoke が拾った)。
   *
   * ⚠ 波形は `data-pkc-action` を持たない「何も無い所」に見えるので、そのまま click が上がると
   *   **「一覧の何も無い所を押したら、開いているノートを閉じる」**(#1032)が働き、
   *   波形を押した / ドラッグした瞬間に**中央のノートが閉じる**(切り出しが済んでも戻らない)。
   * 🔑 押し所の扱いは pointer 側が済ませているので、click は捕まえて捨てる(capture で、`onClick` より前)。
   */
  const onClick = (ev: MouseEvent): void => {
    if ((ev.target as Element | null)?.closest?.(STRIP)) ev.stopPropagation();
  };
  root.addEventListener('pointerdown', onDown);
  root.addEventListener('click', onClick, true);
  return () => {
    root.removeEventListener('pointerdown', onDown);
    root.removeEventListener('click', onClick, true);
  };
}
