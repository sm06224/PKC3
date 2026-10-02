/**
 * **PDF を PKC の画面で開くか**の保存(#275 段①)。
 *
 * 裁定(Gemini、#275):**設定で選んだ人だけ**。既定は**切**(いまのブラウザ内蔵の表示のまま)。
 * 入にすると、添付の PDF の「別のウィンドウで見る」が PKC の画面(字を選んでノートへ引ける窓)になる。
 *
 * ⚠ **flag ではない**(正規設定)── 開放先は user で、畳む予定も無い(flags は最大 15 枠)。
 * ⚠ **container に入れない** ── ノートのデータではなく、この端末の読み方である。
 * ⚠ 既定が**切**なので、保存の値は `1`(入)だけを書く側で意味づける ── 鍵が無い / 読めない端末は「切」。
 *   🔴 そのとき `?.` で読まない ── `storage` が `null` のとき `?.` は例外を投げず `undefined` を返すので、
 *   `catch` の控えへ 1 度も入らない(CLAUDE.md §7。`tests/adapter/store-fallback.test.ts` が見張る)。
 */

const KEY = 'pkc3.pdf-reader';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // 使えない環境でも落ちない
  }
}

export class PdfReaderStore {
  /** 保存が読めない環境の控え(この session では効いている)。既定は「切」。 */
  private fallback = false;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /** ⚠ **読むたびに保存を見る**(別のタブの変更に追随する。他の入切と同じ理由)。 */
  enabled(): boolean {
    // 🔴 保存が無い環境では控えを読む(`?.` では `catch` に入らない)
    if (this.storage === null) return this.fallback;
    try {
      return this.storage.getItem(KEY) === '1';
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
export const appPdfReader = new PdfReaderStore();
