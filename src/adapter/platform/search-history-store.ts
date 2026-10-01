/**
 * 最近探した語の置き場(#1172)。**端末ごと**(localStorage)。
 *
 * 🔴 **アプリのデータに混ぜない** ── `opened-store.ts` と**同じ判断**。container に
 * 入れると書き出しに同乗し、**HTML を渡した相手に、こちらが何を探していたかが並ぶ**。
 *
 * 🔴 **保存できない端末でも、その session の中では効く**(#278 段② の教訓)。
 * ⚠ `?.` で書くと **`null` は例外を投げない**ので `catch` の控えが**死んだ枝**になる
 * ── だから `storage === null` を**先に**見る(CLAUDE.md §7)。
 *
 * ⚠ **溢れても黙って捨てる**(書けなかったことを user へ言う物ではない)── ただし
 *   **その session の控えには積む**。
 * ⚠ **読むたびに保存を引く** ── 別のタブが積んだ語も、次に欄を開いたとき候補に出る。
 */
import { pushSearchTerm, SEARCH_HISTORY_MAX } from '@features/history/search-log';

const KEY = 'pkc3.search-history';

/** 保存の口。⚠ test は偽物を渡して**書込の中身**まで観測する。 */
export interface SearchHistoryStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const browserStorage: SearchHistoryStorage | null = ((): SearchHistoryStorage | null => {
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
        /* 溢れただけ。控えには積んである */
      }
    },
    remove: (k) => {
      try {
        localStorage.removeItem(k);
      } catch {
        /* 消せないだけ */
      }
    },
  };
})();

/** 読めた形かを検める。⚠ 壊れた JSON で画面ごと落とさない。 */
function parse(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const t of v) {
    if (typeof t === 'string' && t !== '' && !out.includes(t)) out.push(t);
  }
  return out.slice(0, SEARCH_HISTORY_MAX);
}

/**
 * 端末の「最近探した語」を持つ。
 * ⚠ **アプリ全体で 1 個**にする(`appSearchHistory`)── 2 個作ると、片方が古い一覧を
 *   書き戻して**記録が巻き戻る**。
 */
export class SearchHistoryStore {
  /** 🔴 保存が無い端末の控え ── この session の中だけ効く。 */
  private fallback: string[] = [];

  constructor(private readonly storage: SearchHistoryStorage | null = browserStorage) {
    if (storage !== null) this.fallback = parse(storage.get(KEY));
  }

  /** 新しい順。 */
  list(): readonly string[] {
    // ⚠ **`?.` で書かない**(上の戒め)── `null` のときは控えを返す
    if (this.storage === null) return this.fallback;
    return parse(this.storage.get(KEY));
  }

  /** 探した語を憶える。**新しい順**の一覧を返す。⚠ 変わらないとき(短すぎ・先頭と同じ)は書かない。 */
  push(term: string): readonly string[] {
    const now = this.list();
    const next = pushSearchTerm(now, term);
    if (next.length === now.length && next.every((t, i) => t === now[i])) return now;
    this.fallback = [...next];
    if (this.storage !== null) this.storage.set(KEY, JSON.stringify(next));
    return next;
  }

  /** 🔴 user が消す口(「検索した語の記録を消す」)。 */
  clear(): void {
    this.fallback = [];
    if (this.storage !== null) this.storage.remove(KEY);
  }
}

/** アプリ全体で 1 個(上の注記)。 */
export const appSearchHistory = new SearchHistoryStore();
