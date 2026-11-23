/**
 * SQL 画面の並び(木の出し入れ・境目の割合)の**保存**(#1442 段②)。意味論は `features/query/sql-layout.ts`。
 *
 * ⚠ 1 鍵だけ(`pkc3.pane-sizes` / `pkc3.app-group-folded` と同じ作法)。
 * ⚠ **container に入れない** ── ノートのデータではなく、この端末の見え方である。
 * 🔴 **`?.` で読まない**(#278 段② の教訓)── `storage` が `null` のとき `?.` は例外を投げずに
 *   `undefined` を返すので `catch` へ入らず、控え(`fallback`)が**死んだ枝**になる。先に `null` を見る。
 */
import {
  decodeSqlLayout,
  encodeSqlLayout,
  type SqlLayout,
} from '@features/query/sql-layout';

export const SQL_LAYOUT_KEY = 'pkc3.sql-layout';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class SqlLayoutStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback: SqlLayout = { tree: null, split: null };

  /** 🔴 直近の書き込みが失敗したか(容量不足など)。真の間は読みも控えを返す。 */
  private saveFailed = false;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /** ⚠ 読むたびに保存を見る(書き手が複数 ── UI と smoke の仕込み)。 */
  get(): SqlLayout {
    if (this.storage === null || this.saveFailed) return this.fallback;
    try {
      return decodeSqlLayout(this.storage.getItem(SQL_LAYOUT_KEY));
    } catch {
      return this.fallback;
    }
  }

  setTree(open: boolean): SqlLayout {
    return this.write({ ...this.get(), tree: open });
  }

  setSplit(pct: number): SqlLayout {
    return this.write({ ...this.get(), split: pct });
  }

  /** 境目のダブルクリック ── 覚えた割合を忘れて既定へ戻す(片道にしない)。 */
  resetSplit(): SqlLayout {
    return this.write({ ...this.get(), split: null });
  }

  /** ⚠ 書く口は 1 つ ── 控えの更新を書き手ごとに繰り返さない。 */
  private write(next: SqlLayout): SqlLayout {
    this.fallback = next;
    this.saveFailed = false;
    try {
      this.storage?.setItem(SQL_LAYOUT_KEY, encodeSqlLayout(next));
    } catch {
      // 🔴 書けなかった ── 次に書けるまで、読みは控え(書いた値)を返す(戻らない)
      this.saveFailed = true;
    }
    return next;
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く。 */
export const appSqlLayout = new SqlLayoutStore();
