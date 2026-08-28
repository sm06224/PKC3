/**
 * 畳んだペインの保存と適用(#197)。意味論は `features/pane-visibility.ts`。
 *
 * ⚠ 1 鍵だけ(`pkc3.theme` / `pkc3.editor-mode` と同じ作法)。
 * ⚠ **container に入れない** ── ノートのデータではなく、この端末の見え方である。
 * ⚠ 読めない環境(プライベートモード等)でも落ちない ── 全部見えている側に落ちる
 *   (畳まれた状態で復帰できないほうが害が大きい)。
 */
import { fitColumnHeight } from './read-columns';
import {
  decodeHidden,
  encodeHidden,
  togglePane,
  type PaneId,
} from '@features/pane-visibility';

const KEY = 'pkc3.panes';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class PaneVisibilityStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback: PaneId[] = [];

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /** ⚠ 読むたびに保存を見る(書き手が複数 ── UI と smoke の仕込み)。 */
  getHidden(): PaneId[] {
    try {
      return decodeHidden(this.storage?.getItem(KEY) ?? null);
    } catch {
      return this.fallback;
    }
  }

  setHidden(hidden: readonly PaneId[]): PaneId[] {
    const next = decodeHidden(encodeHidden(hidden));
    this.fallback = next;
    try {
      this.storage?.setItem(KEY, encodeHidden(next));
    } catch {
      // 保存できないだけ ── この session では効いている
    }
    return next;
  }

  toggle(id: PaneId): PaneId[] {
    return this.setHidden(togglePane(this.getHidden(), id));
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く(`appFlags` と同じ規律)。 */
export const appPanes = new PaneVisibilityStore();

/**
 * 🔴 **畳んだ状態を画面へ写す**(器 1 か所)。CSS は
 * `[data-pkc-hidden-panes~='sidebar']` で列を落とす。
 *
 * ⚠ **`hidden` を付けない** ── grid の area を消すのは CSS の仕事で、
 * 器に `hidden` を付けると「戻す」ボタン(中央の帯)まで巻き添えを食う設計に
 * 引き寄せられる。ここは属性 1 本に留める。
 * ⚠ 押しボタンの `aria-pressed` も同時に更新する ── 見た目だけ変えて読み上げに
 * 出さないと、畳んだことが読み上げ利用者に届かない。
 */
export function applyPaneVisibility(root: HTMLElement, hidden: readonly PaneId[]): void {
  const shell = root.querySelector<HTMLElement>('[data-pkc-region="shell"]');
  if (!shell) return;
  const value = encodeHidden(hidden);
  if (value === '') shell.removeAttribute('data-pkc-hidden-panes');
  else shell.setAttribute('data-pkc-hidden-panes', value);
  for (const btn of root.querySelectorAll<HTMLElement>('[data-pkc-action="toggle-pane"]')) {
    const id = btn.getAttribute('data-pkc-pane');
    if (id === null) continue;
    btn.setAttribute('aria-pressed', hidden.includes(id as PaneId) ? 'false' : 'true');
  }
  /**
   * 🔴 **畳んだら段組みを採り直す**(#525。2026-08-28)。
   *
   * ⚠ 直す前、**ペインの開閉は段組みの引き金として名指しされていなかった** ──
   *   `installColumnFit()` が見張るのは ①面の `ResizeObserver` ②③④⑤ 各種の
   *   `MutationObserver` で、開閉は**①が偶然拾っていただけ**である
   *   (面の幅が変わるから)。
   * 🔑 同じ file の別の所(`read-columns.ts` の文字の大きさの節)が
   *   「いま救っているのは**設計が効き切っていないという偶然**である」と
   *   自ら書いている ── その形をここでも畳む。
   *
   * ⚠ **体感は変わらない。** 実測した遅れは **1 フレーム(25ms)**で、
   *   観測 4 走とも同じだった ── 買うのは「偶然に頼らない」という規約だけである。
   *   🔑 それでも積む(user 指示「効果が小さいからやらない、を結論にしない」)。
   * ⚠ **呼び元を増やさない** ── 畳む口は 5 か所ある(`binder.ts` の toggle と
   *   フォーカスモード / `pane-resize.ts` の下限割れ 2 か所 / `main.ts` の復元)。
   *   そのどれかに書くと**判定が 5 か所に散る**(CLAUDE.md §7)ので、
   *   **画面へ写す 1 か所**であるここに置く。
   */
  fitColumnHeight(root, root.ownerDocument);
}
