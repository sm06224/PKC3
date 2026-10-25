/**
 * 🔴 **長大なノートの「画面の外を描かない」印と、飛んだ後の合わせ直し**(#1467、裁定 21 = A)。
 *
 * 印 `data-pkc-long-note` を**読む面の本文の器**(`detail-body`)と**ライブエディタの器**(`editor-live`)に付けると、
 * CSS(`app.css`)が直下の塊に `content-visibility: auto` を掛ける。判定は
 * `features/markdown/long-note.ts` の 1 本 ── **5,000 行以下のノートには印を付けない**。
 * ⚠ ライブエディタ(`editor-live`)にも付ける(依頼 28 = B を測り直して覆した。根拠は `detail.ts` の注記)。
 *
 * ⚠ 画面の外の塊は**見積もりの高さ**(`contain-intrinsic-block-size: auto …`)で並ぶ。描かれて初めて実寸になる
 *   (`auto` で憶える)ので、**離れた塊へ飛ぶと、飛び先の周りが描かれた瞬間に位置がずれる**。
 *   飛ぶ口(目次・探す・追記・添付の使用箇所)は {@link settleJump} で 1 度だけ合わせ直す。
 */
import { isLongNote } from '@features/markdown/long-note';

export const LONG_NOTE_ATTR = 'data-pkc-long-note';

/** 本文の長さに合わせて印を付ける / 外す(冪等)。 */
export function syncLongNote(host: HTMLElement, body: string): void {
  if (isLongNote(body)) {
    if (!host.hasAttribute(LONG_NOTE_ATTR)) host.setAttribute(LONG_NOTE_ATTR, '');
  } else if (host.hasAttribute(LONG_NOTE_ATTR)) {
    host.removeAttribute(LONG_NOTE_ATTR);
  }
}

const STOP_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

/**
 * 飛んだ後、**次の描画の後に 1 度だけ**同じ飛び方をやり直す。
 *
 * @param el 飛び先(印の付いた器の中にいるときだけ働く ── それ以外は何もしない)
 * @param go 飛ぶ処理。⚠ **冪等であること**(`scrollIntoView` / 「目的の位置へ寄せる」)。
 *   合っていれば動かさないので、ずれていなければ無害。
 * ⚠ user が自分で動かしたら手を離す(wheel / touch / key / pointer)。⚠ 期限つき。
 */
export function settleJump(el: Element, go: () => void): void {
  if (el.closest(`[${LONG_NOTE_ATTR}]`) === null) return;
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  if (win === null || typeof win.requestAnimationFrame !== 'function') return;
  let done = false;
  let frame = 0;
  const stop = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    for (const t of STOP_EVENTS) doc.removeEventListener(t, stop, true);
  };
  const timer = setTimeout(stop, 1500);
  for (const t of STOP_EVENTS) doc.addEventListener(t, stop, true);
  // 1 フレーム目: 飛び先の周りが描かれて実寸になる。2 フレーム目: 配置が落ち着いた後で 1 度だけ合わせる
  const tick = (): void => {
    if (done) return;
    if (++frame < 2) {
      win.requestAnimationFrame(tick);
      return;
    }
    if (el.isConnected) go();
    stop();
  };
  win.requestAnimationFrame(tick);
}
