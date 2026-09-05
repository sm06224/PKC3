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
  /**
   * 🔴 **その操作の説明**(#587 改善 C-1)。⚠ 空なら**付けない**。
   *
   * ⚠ 直す前は情報ペインの 11 個だけが説明を持ち、**右クリックの 9 個は 9 個とも空**
   *   だった ── 同じ字・同じ操作なのに、片方だけ黙っていた。
   * 🔑 字も説明も出所は `features/entry-actions.ts` の 1 か所である(§7)。
   */
  readonly hint?: string;
  /**
   * 🔴 **近道の字**(#587 改善 C 案 2)。⚠ 空なら**付けない**。
   *
   * 項目の**右に薄く**出す(CSS の `::after` が `data-pkc-shortcut` を描く)──
   * `textContent` は項目の字のまま(字を読む検査・読み上げを汚さない)。
   * 🔑 字の組み立ては `features/entry-actions.ts` の `menuShortcutFor` 1 か所。
   */
  readonly shortcut?: string;
}

/** 近道の字を持つ属性(`data-pkc-shortcut`)。⚠ CSS と unit はこの名前で見る。 */
export const MENU_SHORTCUT_ATTR = 'data-pkc-shortcut';

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
 * @param carry 押した物の身元(全ボタンへ属性として写す)。{@link OpenMenu} の説明を読む
 */
/** 説明の欄の印(`data-pkc-field`)。⚠ smoke / unit はこの印で見る。 */
export const MENU_HINT_FIELD = 'context-menu-hint';

export function openContextMenu(
  root: HTMLElement,
  at: { x: number; y: number },
  items: readonly MenuItem[],
  restoreTo: Element | null,
  carry: Readonly<Record<string, string>> = {},
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
    /**
     * 🔴 **説明は `title`(tooltip)ではなく、下の欄へ出す**(#587 C-1 → C-3。
     *   user 裁定 2026-08-30「一度推奨で入れて、使用感をテストしたい」)。
     * ⚠ C-1 の tooltip は「乗せて 1 秒待つと灰色の箱が**下の項目に重なる**」うえ、
     *   マウスを持たない人(キーだけ / 触る画面)には**1 文字も届かなかった**。
     * ⚠ 空なら属性を付けない ── 「説明が在る / 無い」を数える検査が全件在ると読まないように。
     * 🔑 戻すときは `data-pkc-hint` を `title` に戻し、下の `withHint` の塊と CSS を外す(1 組)。
     */
    if (it.hint !== undefined && it.hint !== '') b.setAttribute('data-pkc-hint', it.hint);
    // 🔴 近道は右に薄く(#587 C 案 2)。⚠ 空なら付けない ── 属性の有無を数える検査を汚さない
    if (it.shortcut !== undefined && it.shortcut !== '') b.setAttribute(MENU_SHORTCUT_ATTR, it.shortcut);
    /**
     * 🔴 **押した物の身元をボタンへ写す**(#426 段②)。
     *
     * ⚠ **メニューの器は root の直下に出る**ので、押したボタンは
     * **押した物の中に居ない** ── `target.closest(...)` で辿る受け手は
     * その時点で**必ず外す**。行の 6 つが無事だったのは、たまたま
     * 「無ければ選んでいるノート」という逃げ道を持っていたからで、
     * ⚠ **見出しにはその逃げ道が無い**(「選んでいる見出し」という状態は無い)。
     * 🔑 だから開くときに写す ── 受け手は**自分の属性**を読めばよい。
     */
    for (const [k, v] of Object.entries(carry)) b.setAttribute(k, v);
    el.append(b);
  }
  root.append(el);

  /**
   * 🔴 **指している項目の説明を、メニューのいちばん下の欄に出す**(#587 C-3)。
   *
   * ⚠ 出るのは**説明を 1 つでも持つメニュー**だけ(見出し・本文のメニューは持たないので、
   *   いままでどおり何も足さない)。
   * 🔑 指す手は 3 つ ── **マウスを乗せる**(`mouseover`)、**キーで焦点を移す**
   *   (`focusin`)、**指で触れる**(`pointerdown`)。どれも同じ 1 本(`show`)へ落とす。
   *   乗せた手が外れたら(`mouseleave`)、焦点の項目へ戻す。
   * 🔴 **`pointerdown` は指の端末のためである**(#632 段②)── 指には `:hover` が無く、
   *   `mouseover` が来るかはブラウザ任せなので、**触れた瞬間に説明が出ない**ことがある
   *   (欄は空のまま = 押す前に読めない)。⚠ 「乗せたときだけ出る物は、触る端末では
   *   一度も出ない」という user 裁定 ⑤ と**同じ形の穴**である。
   * ⚠ 欄の高さは CSS が **2 行ぶん固定**で取る ── 指す項目で高さが変わると、メニューが
   *   上下に踊って次の項目を押し損ねる。
   */
  const withHint = items.some((it) => it.hint !== undefined && it.hint !== '');
  if (withHint) {
    el.setAttribute('data-pkc-with-hint', '');
    const hintBox = root.ownerDocument.createElement('div');
    hintBox.setAttribute('data-pkc-field', MENU_HINT_FIELD);
    hintBox.setAttribute('aria-live', 'polite');
    el.append(hintBox);
    const show = (btn: Element | null): void => {
      hintBox.textContent = btn?.getAttribute('data-pkc-hint') ?? '';
    };
    const buttonOf = (t: EventTarget | null): Element | null =>
      t instanceof Element ? t.closest('button[data-pkc-action]') : null;
    el.addEventListener('mouseover', (ev) => {
      const b = buttonOf(ev.target);
      if (b !== null) show(b);
    });
    el.addEventListener('focusin', (ev) => {
      const b = buttonOf(ev.target);
      if (b !== null) show(b);
    });
    // ⚠ **触れた瞬間に出す**(指の端末)── `mouseover` の合成は当てにしない
    el.addEventListener('pointerdown', (ev) => {
      const b = buttonOf(ev.target);
      if (b !== null) show(b);
    });
    el.addEventListener('mouseleave', () => {
      const active = root.ownerDocument.activeElement;
      show(active !== null && el.contains(active) ? buttonOf(active) : null);
    });
  }

  /**
   * ⚠ **画面からはみ出させない** ── はみ出すと下の項目に手が届かない。
   * 🔑 載せてから測る(`getBoundingClientRect`)── 中身の数で高さが変わるので、
   *   出す前には決められない。
   *
   * 🔴 **測るのは、器が最終の姿になってから**(#587 C-3 の着地後レビュー)。
   * ⚠ 直す前はこの採寸が**説明欄を足す前**に走っていたので、clamp が使った寸法が
   *   実際より **192px 狭く・約 44px 低かった** ── `data-pkc-with-hint` が
   *   `min-width` を 10rem(160px)から **22rem(352px)** へ広げ(`app.css:466-469`)、
   *   欄そのものが 44px 積むためである。
   * ⚠ 帰結は「**画面の右下で右クリックすると、足した説明欄が画面の外に出る**」──
   *   user から見ると「出るときと出ないときがある」機能になっていた。
   * 🔑 この注記(「載せてから測る」)は**そのとき既に在った** ── 破ったのは実装の側である。
   *   だから直しは「順番を戻す」1 つで、見え方は 1px も変えない。
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
  // 🔑 開いた直後の欄は、この `focus()` が同期で出す `focusin` が先頭の説明で埋める
  //    (明示の呼びは no-op だった ── 変異試験 H4 が SURVIVED で教えた。2 か所に書かない)
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
