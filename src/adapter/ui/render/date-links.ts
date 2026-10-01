/**
 * 🔴 **本文の `@2026-10-15` を、押せる字にするか**(#1169)。
 *
 * ## ⚠ 既定は「入」である(電話番号の `phone-links` と逆)
 *
 * 押せる字になるのは **`@` で始まる日付だけ**で、書き手が**日付のつもりで書いた**字である
 * (電話番号のように、ただの数字が勝手に押せる字になるわけではない)。見た目は
 * **点線の下線だけ**(字の色は変えない)── 読んでいる最中の本文を、色で割らない。
 * 🔴 それでも**見え方は変わる**ので、**切れる**ようにしてある(「変更は user に委ねる」)。
 *
 * ⚠ **flag ではない**(正規設定)── 開放先は user で、畳む予定も無い
 * (`phone-links` と同じ扱い。flag の 15 枠は使わない)。
 * ⚠ **container に入れない** ── ノートのデータではなく、この端末の読み方である。
 */

const KEY = 'pkc3.date-links';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class DateLinksStore {
  /** 保存が読めない環境の控え(この session では効いている)。⚠ 既定は入。 */
  private fallback = true;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /**
   * ⚠ **読むたびに保存を見る**(`PhoneLinksStore` と同じ理由 ── 書き手が複数)。
   * 🔴 **切にした人だけが `'0'` を書く** ── 何も書いていない人は入である
   *   (`=== '1'` で読むと、**既定が切に化ける**)。
   */
  enabled(): boolean {
    // 🔴 **保存が無い環境では控えを読む**(`?.` は `null` で例外を投げず、控えへ入らない)
    if (this.storage === null) return this.fallback;
    try {
      return this.storage.getItem(KEY) !== '0';
    } catch {
      return this.fallback;
    }
  }

  setEnabled(on: boolean): void {
    this.fallback = on;
    try {
      this.storage?.setItem(KEY, on ? '1' : '0');
    } catch {
      // 保存できないだけ ── この session では効いている(控えが持つ)
    }
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く。 */
export const appDateLinks = new DateLinksStore();
