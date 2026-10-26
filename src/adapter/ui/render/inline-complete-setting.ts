/**
 * **打ちながら出る補完の候補を出すか**の保存(#1449 `/` / #1450 `@`)。
 *
 * ⚠ **既定は入**(入で配る機能の**逃げ道**を足すだけ。何も選んでいない人の見え方は変えない)。
 * ⚠ **flag ではない**(正規設定)── 開放先は user で、畳む予定も無い(flags は最大 15 枠)。
 * ⚠ **container に入れない** ── ノートのデータではなく、この端末(この人)の入力の好みである。
 * ⚠ 保存の値は `0`(切)だけを書く側で意味づける ── 鍵が無い / 読めない端末は「入」。
 *   🔴 `?.` で読まない ── `storage` が `null` のとき `?.` は例外を投げず `undefined` を返すので、
 *   `catch` の控えへ 1 度も入らない(CLAUDE.md §7。`tests/adapter/store-fallback.test.ts` が見張る)。
 */

const KEY = 'pkc3.inline-complete';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // 使えない環境でも落ちない
  }
}

export class InlineCompleteStore {
  /** 保存が読めない環境の控え(この session では効いている)。既定は「入」。 */
  private fallback = true;

  /** 🔴 直近の書き込みが失敗したか(容量不足など)。真の間は読みも控えを返す。 */
  private saveFailed = false;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /** ⚠ **読むたびに保存を見る**(別のタブの変更に追随する。他の入切と同じ理由)。 */
  enabled(): boolean {
    // 🔴 保存が無い環境では控えを読む(`?.` では `catch` に入らない)
    if (this.storage === null || this.saveFailed) return this.fallback;
    try {
      return this.storage.getItem(KEY) !== '0';
    } catch {
      return this.fallback;
    }
  }

  setEnabled(on: boolean): void {
    this.fallback = on;
    this.saveFailed = false;
    try {
      this.storage?.setItem(KEY, on ? '1' : '0');
    } catch {
      // 🔴 書けなかった ── 次に書けるまで、読みは控え(書いた値)を返す(戻らない)
      this.saveFailed = true;
    }
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く。 */
export const appInlineComplete = new InlineCompleteStore();
