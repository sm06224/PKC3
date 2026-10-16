/**
 * 編集の仕方の保存(Issue #104 第 2 弾)。意味論は `features/editor-mode.ts`。
 *
 * ⚠ 1 鍵だけ(`pkc3.theme` / `pkc3.page-format` と同じ作法)。
 * ⚠ **container に入れない** ── ノートのデータではなくこの端末の書き方である。
 * ⚠ 読めない環境(プライベートモード等)でも落ちない ── 既定(live)に落ちる。
 */
import { DEFAULT_EDITOR_MODE, isEditorMode, type EditorMode } from '@features/editor-mode';

const KEY = 'pkc3.editor-mode';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class EditorModeStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback: EditorMode = DEFAULT_EDITOR_MODE;

  /** 🔴 直近の書き込みが失敗したか(容量不足など)。真の間は読みも控えを返す。 */
  private saveFailed = false;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /**
   * ⚠ **読むたびに保存を見る**(`external-images.ts` の「constructor で 1 回」と
   * わざと違う)。読みは編集の入りにしか起きない一方、書き手が複数
   * (設定 UI / smoke・bench の仕込み)── 読み捨てにすると外からの書込が
   * 再読込まで効かない。例外時だけ控えに落ちる。
   */
  getMode(): EditorMode {
    try {
      if (this.storage === null || this.saveFailed) return this.fallback;
      const v = this.storage.getItem(KEY);
      if (v !== null && v !== undefined && isEditorMode(v)) return v;
      return DEFAULT_EDITOR_MODE;
    } catch {
      return this.fallback;
    }
  }

  /** @returns 実際に変わったか(呼び手はいまのところ使わない ── 描き直さない)。 */
  setMode(mode: string): boolean {
    if (!isEditorMode(mode) || mode === this.getMode()) return false;
    this.fallback = mode;
    this.saveFailed = false;
    try {
      this.storage?.setItem(KEY, mode);
    } catch {
      // 🔴 書けなかった ── 次に書けるまで、読みは控え(書いた値)を返す(戻らない)
      this.saveFailed = true;
      // 保存できないだけ ── この session では効いている(fallback が持つ)
    }
    return true;
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く(`appFlags` と同じ規律)。 */
export const appEditorMode = new EditorModeStore();
