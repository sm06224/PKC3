/**
 * 🔴 **本文のバッククォートで囲んだ色コード(`` `#3b82f6` ``)の左に、色の見本を出すか**(#1224)。
 *
 * ## ⚠ 既定は「入」である(`date-links` / `relative-days` と同じ)
 *
 * 出るのは**コードの左の小さな四角 1 つ**だけで、本文の字は 1 つも変わらない。
 * 🔴 それでも**見え方は変わる**ので、**切れる**ようにしてある(「変更は user に委ねる」)。
 *
 * ⚠ **flag ではない**(正規設定)── 開放先は user で、畳む予定も無い。
 * ⚠ **container に入れない** ── ノートのデータではなく、この端末の読み方である。
 * ⚠ 見本は**読む面の本文だけ**(書き出した HTML・Word・印刷・別窓・書くときの下見には出ない)。
 *   決めているのは描く側(`markdown-render.ts` の `colorSwatches`)で、ここは設定の入れ物だけを持つ。
 */

const KEY = 'pkc3.color-swatch';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class ColorSwatchStore {
  /** 保存が読めない環境の控え(この session では効いている)。⚠ 既定は入。 */
  private fallback = true;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /**
   * ⚠ **読むたびに保存を見る**(書き手が複数)。
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
export const appColorSwatch = new ColorSwatchStore();
