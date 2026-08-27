/**
 * 🔴 **右クリックで、その行にできることを出す**(#426 段①)。
 *
 * ## なぜ要るか
 *
 * PKC3 の操作は**帯とボタン**に在り、**押す物の上には出ない** ── だから
 * 「この行に何ができるか」は**別の場所(情報ペイン)を見て探す**ことになる。
 * PKC2 は右クリックを**既定 ON** で持っており(559 行)、user に届いていた。
 *
 * ## 🔴 実行の口を新しく作らない(CLAUDE.md §7)
 *
 * ⚠ ここが組むのは **`data-pkc-action` を持つただのボタン**である。
 * 押されたら **root の委譲(`binder.ts`)がそのまま拾う** ── メニュー用の
 * 実行経路を別に書くと、**片方だけ直る**日が来る。
 * 🔑 だからこの file に「押されたら何をするか」は **1 行も無い**。
 *
 * ## ⚠ 置き換えの作法(CLAUDE.md §10)
 *
 * ブラウザ既定のメニューを奪うので、**奪ったぶんの代わり**が要る:
 * - **本文の選択範囲 / リンク / 図の上では奪わない**(コピー・画像を保存が消えると実害)
 * - **触った瞬間に閉じる**(`Escape` / 外を押す / スクロール)
 * - **閉じたら焦点を返す** ── `window.confirm` を自前に替えたときに落ちた性質と同じ型
 */

/** メニューの器。⚠ 1 枚だけ ── 2 枚目を作らない(重なると閉じ忘れる)。 */
const REGION = 'context-menu';

export interface MenuItem {
  readonly action: string;
  readonly label: string;
}

export interface OpenMenu {
  /** 閉じる。⚠ **焦点を返す**(開く前に居た所へ)。 */
  readonly close: () => void;
  readonly el: HTMLElement;
}

/**
 * メニューを 1 枚出す。
 *
 * @param root 器(ここへ載せる ── `document.body` ではない。面の外へ出さない)
 * @param at 画面上の座標(右クリックした場所)
 * @param items 出す物。⚠ **空なら開かない**(空の箱を出さない)
 * @param restoreTo 閉じたときに焦点を返す先
 */
export function openContextMenu(
  root: HTMLElement,
  at: { x: number; y: number },
  items: readonly MenuItem[],
  restoreTo: Element | null,
): OpenMenu | null {
  if (items.length === 0) return null;
  closeContextMenu(root);

  const el = root.ownerDocument.createElement('div');
  el.setAttribute('data-pkc-region', REGION);
  el.setAttribute('role', 'menu');
  for (const it of items) {
    const b = root.ownerDocument.createElement('button');
    b.setAttribute('data-pkc-action', it.action);
    b.setAttribute('role', 'menuitem');
    b.type = 'button';
    b.textContent = it.label;
    el.append(b);
  }
  root.append(el);

  /**
   * ⚠ **画面からはみ出させない** ── はみ出すと下の項目に手が届かない。
   * 🔑 載せてから測る(`getBoundingClientRect`)── 中身の数で高さが変わるので、
   *   出す前には決められない。
   */
  const view = root.ownerDocument.defaultView;
  const vw = view?.innerWidth ?? 0;
  const vh = view?.innerHeight ?? 0;
  const box = el.getBoundingClientRect();
  const x = vw > 0 ? Math.max(0, Math.min(at.x, vw - box.width)) : at.x;
  const y = vh > 0 ? Math.max(0, Math.min(at.y, vh - box.height)) : at.y;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;

  // ⚠ 焦点を先頭へ ── 鍵だけで使う人が、開いた直後に何もできないのを防ぐ
  const first = el.querySelector('button');
  if (first instanceof HTMLElement) first.focus();

  const close = (): void => {
    el.remove();
    // 🔑 **焦点を返す**(開く前に居た所へ)── 返さないと、閉じた後に鍵が死ぬ
    if (restoreTo instanceof HTMLElement && restoreTo.isConnected) restoreTo.focus();
  };
  return { close, el };
}

/** 出ているメニューを畳む(出ていなければ何もしない)。 */
export function closeContextMenu(root: HTMLElement): void {
  root.querySelector(`[data-pkc-region="${REGION}"]`)?.remove();
}

/** 出ているか。⚠ test と binder が同じ問いに 2 つの答えを持たないため。 */
export function contextMenuOpen(root: HTMLElement): boolean {
  return root.querySelector(`[data-pkc-region="${REGION}"]`) !== null;
}
