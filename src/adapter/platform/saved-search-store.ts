/**
 * 保存した検索の置き場(#1038 C1)。**端末ごと**(localStorage)。
 *
 * 🔴 **アプリのデータに混ぜない** ── `search-history-store.ts` と**同じ判断**。container に入れると
 * 書き出し・バックアップに同乗し、**渡した相手に、こちらが何を探していたかが並ぶ**。
 * 設定ファイルにも載せない(`settings-file.ts` の `SKIPPED_KEYS`)。設計は
 * `docs/development/saved-search-design-2026-10.md`。
 *
 * 🔴 **保存できない端末でも、その session の中では効く**(#278 段② の教訓)。
 * ⚠ `?.` で書くと **`null` は例外を投げない**ので `catch` の控えが死んだ枝になる ──
 *   だから `storage === null` を**先に**見る(CLAUDE.md §7)。
 * ⚠ **溢れても黙って捨てる**(書けなかったことを user へ言う物ではない)── ただし
 *   **その session の控えには積む**。
 * 🔑 一覧は**メモリに持つ**(状態が動くたびに描く帯が、毎回 JSON を読まないため)。別のタブが
 *   書いたときは `refresh()`(`storage` イベントで呼ぶ)で読み直す。
 */
import {
  addSavedSearch,
  parseSavedSearches,
  removeSavedSearch,
  renameSavedSearch,
  type AddResult,
  type SavedSearch,
} from '@features/history/saved-search';

const KEY = 'pkc3.saved-searches';

/** 保存の口。⚠ test は偽物を渡して**書込の中身**まで観測する。 */
export interface SavedSearchStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const browserStorage: SavedSearchStorage | null = ((): SavedSearchStorage | null => {
  try {
    // ⚠ 触れるかどうかまで見る(存在するのに投げる端末が在る)
    localStorage.getItem(KEY);
  } catch {
    return null;
  }
  return {
    get: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* 溢れただけ。控え(メモリ)には積んである */
      }
    },
  };
})();

/** 端末の「保存した検索」を持つ。⚠ アプリ全体で 1 個(`appSavedSearches`)。 */
export class SavedSearchStore {
  private items: SavedSearch[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage: SavedSearchStorage | null = browserStorage,
    private readonly makeId: () => string = defaultId,
  ) {
    this.refresh(false);
  }

  /** 新しい順。 */
  list(): readonly SavedSearch[] {
    return this.items;
  }

  /** 保存を読み直す(別のタブが書いたとき)。変わったときだけ知らせる。 */
  refresh(notify = true): void {
    // ⚠ **`?.` で書かない**(上の戒め)── `null` のときはメモリの控えをそのまま使う
    if (this.storage === null) return;
    const next = parseSavedSearches(this.storage.get(KEY));
    if (JSON.stringify(next) === JSON.stringify(this.items)) return;
    this.items = next;
    if (notify) this.emit();
  }

  /** 変わったときに呼ぶ。解除の関数を返す。 */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  add(query: string, kinds: readonly string[], kindLabel: (archetype: string) => string): AddResult {
    const r = addSavedSearch(this.items, query, kinds, this.makeId(), kindLabel);
    if (r.kind === 'added') this.commit(r.list);
    return r;
  }

  rename(id: string, name: string): void {
    this.commit(renameSavedSearch(this.items, id, name));
  }

  remove(id: string): void {
    this.commit(removeSavedSearch(this.items, id));
  }

  private commit(next: SavedSearch[]): void {
    if (JSON.stringify(next) === JSON.stringify(this.items)) return;
    this.items = next;
    if (this.storage !== null) {
      try {
        this.storage.set(KEY, JSON.stringify(next));
      } catch {
        /* 書けなかっただけ。控え(メモリ)には積んである */
      }
    }
    this.emit();
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb();
  }
}

function defaultId(): string {
  return `ss-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** アプリ全体で 1 個(上の注記)。 */
export const appSavedSearches = new SavedSearchStore();

// 別のタブが書いたら読み直す(`storage` イベントは書いたタブ以外にだけ届く)
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY || e.key === null) appSavedSearches.refresh();
  });
}
