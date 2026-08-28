/**
 * 決めた大きさの**保存**と**画面への適用**(#497)。意味論は `features/pane-size.ts`。
 *
 * ⚠ 1 鍵だけ(`pkc3.panes` / `pkc3.theme` と同じ作法)。
 * ⚠ **container に入れない** ── ノートのデータではなく、この端末の見え方である
 *   (だから「正規の設定」側であって、フラグではない)。
 * ⚠ 読めない環境(プライベートモード等)でも落ちない ── 既定の幅に落ちる。
 */
import {
  decodePaneSizes,
  encodePaneSizes,
  paneSizeCss,
  paneSizeVar,
  roundPaneSize,
  SIZED_PANES,
  type PaneSizes,
  type SizedPaneId,
} from '@features/pane-size';

const KEY = 'pkc3.pane-sizes';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class PaneSizeStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback: PaneSizes = {};

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /** ⚠ 読むたびに保存を見る(書き手が複数 ── UI と smoke の仕込み)。 */
  get(): PaneSizes {
    try {
      return decodePaneSizes(this.storage?.getItem(KEY) ?? null);
    } catch {
      return this.fallback;
    }
  }

  set(id: SizedPaneId, px: number): PaneSizes {
    const next: PaneSizes = { ...this.get(), [id]: roundPaneSize(id, px) };
    this.fallback = next;
    try {
      this.storage?.setItem(KEY, encodePaneSizes(next));
    } catch {
      // 保存できないだけ ── この session では効いている
    }
    return next;
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く(`appPanes` と同じ規律)。 */
export const appPaneSizes = new PaneSizeStore();

/**
 * 🔴 **決めた大きさを画面へ写す**(器 1 か所)。CSS 変数を `shell` に置き、
 * grid の列と追記欄の高さがそれを読む。
 *
 * ⚠ **触っていない面は変数を消す** ── 空文字を置くと `var(x, 既定)` の既定が
 *   効かなくなる版があるので、`removeProperty` で本当に消す。
 *   (「既定へ戻す」が効かないと、user は元の見た目に戻せない)
 */
export function applyPaneSizes(root: HTMLElement, sizes: PaneSizes): void {
  for (const id of SIZED_PANES) setPaneSizeVar(root, id, sizes[id] ?? null);
}

/**
 * 1 面ぶんだけ書く。🔑 **掴んでいる最中はこちらを呼ぶ** ── 毎フレーム保存を
 * 読み直さないため(保存は指を離したときに 1 回だけ)。
 */
export function setPaneSizeVar(root: HTMLElement, id: SizedPaneId, px: number | null): void {
  const shell = root.querySelector<HTMLElement>('[data-pkc-region="shell"]');
  if (!shell) return;
  if (px === null) shell.style.removeProperty(paneSizeVar(id));
  else shell.style.setProperty(paneSizeVar(id), paneSizeCss(id, px));
}

/**
 * いまその面が何 px か。🔑 **保存ではなく実測を返す** ── 触っていない面は保存が
 * 無い(既定の `18vw` 等)ので、掴んだ瞬間の基準は**画面から採る**しかない。
 * ⚠ ここを保存だけで書くと、初回のドラッグが必ず 0 から始まって**跳ねる**。
 */
export function measuredPaneSize(root: HTMLElement, id: SizedPaneId): number {
  const el =
    id === 'append'
      ? root.querySelector<HTMLElement>('[data-pkc-field="append-input"]')
      : root.querySelector<HTMLElement>(`[data-pkc-region="${id}"]`);
  if (!el) return 0;
  const box = el.getBoundingClientRect();
  return id === 'append' ? box.height : box.width;
}
