/**
 * 畳んだグループの**保存**(#857 段④)。意味論は `features/launcher/group-fold.ts`。
 *
 * ⚠ 1 鍵だけ(`pkc3.pane-sizes` / `pkc3.theme` と同じ作法)。
 * ⚠ **container に入れない** ── ノートのデータではなく、この端末の見え方である。
 * 🔴 **`?.` で読まない**(#278 段② の教訓)── `storage` が `null` のとき
 *   `?.` は例外を投げずに `undefined` を返すので `catch` へ入らず、
 *   控え(`fallback`)が**死んだ枝**になる。先に `null` を見る。
 */
import {
  decodeFolded,
  encodeFolded,
  toggleAllFolded,
  toggleFolded,
  type FoldedGroups,
} from '@features/launcher/group-fold';

const KEY = 'pkc3.app-group-folded';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class GroupFoldStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback: FoldedGroups = [];

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /** ⚠ 読むたびに保存を見る(書き手が複数 ── UI と smoke の仕込み)。 */
  get(): FoldedGroups {
    // 🔴 `null` は例外にならない ── 先に見る(上の docstring)
    if (this.storage === null) return this.fallback;
    try {
      return decodeFolded(this.storage.getItem(KEY));
    } catch {
      return this.fallback;
    }
  }

  toggle(name: string): FoldedGroups {
    return this.write(toggleFolded(this.get(), name));
  }

  /** すべて畳む / すべて開く。⚠ 渡された名前(= いま画面に出ている群)だけを動かす。 */
  toggleAll(names: readonly string[]): FoldedGroups {
    return this.write(toggleAllFolded(this.get(), names));
  }

  /** ⚠ 書く口は 1 つ ── 控えの更新を書き手ごとに繰り返さない(片方だけ忘れる形を作らない)。 */
  private write(next: FoldedGroups): FoldedGroups {
    this.fallback = next;
    try {
      this.storage?.setItem(KEY, encodeFolded(next));
    } catch {
      // 保存できないだけ ── この session では効いている
    }
    return next;
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く(`appPanes` と同じ規律)。 */
export const appGroupFold = new GroupFoldStore();
