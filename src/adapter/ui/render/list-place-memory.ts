/**
 * 🔴 **左の一覧で開いていたフォルダと、押していた種類の札を、この端末に憶える**(依頼 277。Gemini 回答 = A)。
 *
 * 読み込み直すと、開いていたフォルダも種類の絞りも最初の状態に戻っていた(並び順は 82-3 で憶える)。
 * 効かせるのは state(`scopeLid` / `kindFilter`)で、ここは**憶えるだけ**
 * (`EntrySortStore` と同じ作り ── 起動で 1 度だけ state へ写す。`list-place-effects.ts`)。
 *
 * ⚠ **コレクション(container)ごと**に憶える ── フォルダの lid は別のコレクションでは別のノートを指す
 *   (偶然の衝突を持ち越さない。`SYS_BOOTED` が cid 違いで捨てるのと同じ向き)。
 * ⚠ **container に入れない** ── ノートのデータではなく、この端末の見え方である。
 * ⚠ **設定ファイルの持ち出しには乗せない**(`settings-file.ts` の `SKIPPED_KEYS` に why つき)。
 * ⚠ 値は JSON(`{c, s, k}`)。**壊れた値は「憶えていない」**(`null`)。
 * ⚠ 読めない環境でも落ちない ── `storage === null` を先に見る(`?.` では `catch` に入らない)。
 */
const KEY = 'pkc3.list-place';
/** 憶える札の数の上限(壊れた値・巨大な値で重くしない)。 */
const MAX_KINDS = 32;

export interface RememberedPlace {
  /** どのコレクションの記憶か。 */
  readonly cid: string;
  /** 開いていたフォルダ(`null` = ルート)。 */
  readonly scope: string | null;
  /** 押していた種類の札。 */
  readonly kinds: readonly string[];
}

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function parse(raw: string | null): RememberedPlace | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    const c = o['c'];
    if (typeof c !== 'string' || c === '') return null;
    const s = o['s'];
    if (s !== null && typeof s !== 'string') return null;
    const k = o['k'];
    if (!Array.isArray(k) || k.length > MAX_KINDS || !k.every((x) => typeof x === 'string')) return null;
    return { cid: c, scope: s, kinds: k as string[] };
  } catch {
    return null;
  }
}

export class ListPlaceStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback: RememberedPlace | null = null;

  /** 🔴 直近の書き込みが失敗したか(容量不足など)。真の間は読みも控えを返す。 */
  private saveFailed = false;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  get(): RememberedPlace | null {
    try {
      if (this.storage === null || this.saveFailed) return this.fallback;
      return parse(this.storage.getItem(KEY));
    } catch {
      return this.fallback;
    }
  }

  set(place: RememberedPlace): void {
    this.fallback = place;
    this.saveFailed = false;
    try {
      this.storage?.setItem(KEY, JSON.stringify({ c: place.cid, s: place.scope, k: place.kinds }));
    } catch {
      // 🔴 書けなかった ── 次に書けるまで、読みは控え(書いた値)を返す(戻らない)
      this.saveFailed = true;
    }
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く。 */
export const appListPlace = new ListPlaceStore();
