/**
 * topbar の役割メニューを閉じる規律(P7b 段⑨b)。
 *
 * 🔑 開閉そのものは `<details>` に任せる(JS で状態を持たない)。ここが足すのは
 * **閉じ方**だけ ── 素の `<details>` は外側を押しても Escape でも閉じないので、
 * 開きっぱなしのパネルが本文を覆う。
 *
 * ⚠ **項目を押したら閉じる**のが肝。押した結果(書出しの進捗・注意の面)が
 * メニューの下に隠れると、「押したのに何も起きていない」ように見える。
 *
 * ⚠ `pointerdown` で見る ── `click` だと、押した瞬間に閉じる前の座標で
 * 別の要素が反応する順序になりうる。
 */

/** 開いている役割メニューを全部閉じる。 */
export function closeMenus(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLDetailsElement>('details[data-pkc-menu][open]')) {
    el.open = false;
  }
}

/**
 * 外側クリック / Escape / 項目のクリックで閉じる。
 * @returns 外すための関数(test / 再構築で解除できるようにする)
 */
export function installMenuDismiss(root: HTMLElement): () => void {
  const onPointerDown = (ev: Event): void => {
    const target = ev.target;
    if (!(target instanceof Node)) return;
    for (const el of root.querySelectorAll<HTMLDetailsElement>(
      'details[data-pkc-menu][open]',
    )) {
      // ⚠ `summary` 自身の押下は `<details>` の既定動作(トグル)に任せる ──
      // ここで閉じると「開いた直後に閉じる」で永久に開かない
      if (el.contains(target)) continue;
      el.open = false;
    }
  };
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') closeMenus(root);
  };
  const onClick = (ev: Event): void => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    // 項目(= メニューの中の action)を押したら閉じる
    if (target.closest('[data-pkc-menu-items] [data-pkc-action]')) closeMenus(root);
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown);
  root.addEventListener('click', onClick);
  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown);
    root.removeEventListener('click', onClick);
  };
}
