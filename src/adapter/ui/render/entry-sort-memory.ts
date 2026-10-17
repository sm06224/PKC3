/**
 * 🔴 **一覧の並び順と向きを、この端末に憶える**(依頼 82-3。Gemini 回答 = 推薦どおり B)。
 *
 * 「更新が新しい順」を使う人が、開くたびに選び直していた。効かせるのは state
 * (`AppState.entrySort` / `entrySortDesc`)で、ここは**憶えるだけ**
 * (`FilerFlattenStore` と同じ作り ── 起動で 1 度だけ state へ写す。`entry-sort-effects.ts`)。
 *
 * ⚠ **container に入れない** ── ノートのデータではなく、この端末の見え方である。
 * ⚠ **設定ファイルの持ち出しには乗せない**(`settings-file.ts` の `SKIPPED_KEYS` に why つき)。
 *   最後に選んだ並びは「その端末でその場で選んだ事実」で、別の端末の一覧の並びを勝手に変える。
 * ⚠ 値は `<並び>:<a|d>`(a = 昇順 / d = 降順)。**壊れた値・知らない並びは「憶えていない」**
 *   (版が変わって消えた並びで、一覧が並べられなくならないように)。
 * ⚠ 読めない環境でも落ちない ── `storage === null` を先に見る(`?.` では `catch` に入らない)。
 */
import { isEntrySort, type EntrySort } from '@features/filter/entry-sort';

const KEY = 'pkc3.entry-sort';

export interface RememberedSort {
  readonly sort: EntrySort;
  readonly desc: boolean;
}

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function parse(raw: string | null): RememberedSort | null {
  if (raw === null) return null;
  const m = /^([a-z]+):([ad])$/.exec(raw);
  if (m === null) return null;
  const sort = m[1]!;
  if (!isEntrySort(sort)) return null;
  return { sort, desc: m[2] === 'd' };
}

export class EntrySortStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback: RememberedSort | null = null;

  /** 🔴 直近の書き込みが失敗したか(容量不足など)。真の間は読みも控えを返す。 */
  private saveFailed = false;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  get(): RememberedSort | null {
    try {
      if (this.storage === null || this.saveFailed) return this.fallback;
      return parse(this.storage.getItem(KEY));
    } catch {
      return this.fallback;
    }
  }

  set(sort: EntrySort, desc: boolean): void {
    this.fallback = { sort, desc };
    this.saveFailed = false;
    try {
      this.storage?.setItem(KEY, `${sort}:${desc ? 'd' : 'a'}`);
    } catch {
      // 🔴 書けなかった ── 次に書けるまで、読みは控え(書いた値)を返す(戻らない)
      this.saveFailed = true;
    }
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く。 */
export const appEntrySort = new EntrySortStore();
