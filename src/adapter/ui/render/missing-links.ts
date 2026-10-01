/**
 * 🔴 **リンク先のノートが無い内部リンクを、点線で見せるか**(#1174 段①)。
 *
 * ## ⚠ なぜ既定を「入」にするか(`phone-links` と逆)
 *
 * 電話番号は「いま読めている数字が色つきの押せる字に変わる」ので既定を切にした
 * (見え方が変わるのを user に委ねる)。こちらは**下線の種類を点線にするだけ**で、
 * 字の色も形も変えない ── そして印が出るのは**押すと必ず「見つかりません」になる
 * リンクだけ**である。提案者(#1174)との合意で「入」を既定にし、**切れる設定**を
 * 置くことで、見え方を変えたくない人の逃げ道を残した。
 *
 * ⚠ **flag ではない**(正規設定)── 開放先は user で、畳む予定も無い。
 * ⚠ **container に入れない** ── ノートのデータではなく、この端末の読み方である。
 * ⚠ 保存の値は `0`(切)だけを書く側で意味づける ── 鍵が無い / 読めない端末は「入」。
 */

const KEY = 'pkc3.missing-links';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class MissingLinksStore {
  /** 保存が読めない環境の控え(この session では効いている)。既定は「入」。 */
  private fallback = true;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /** ⚠ **読むたびに保存を見る**(`PhoneLinksStore` と同じ理由 ── 書き手が複数)。 */
  enabled(): boolean {
    // 🔴 **保存が無い環境では控えを読む**(`?.` では `catch` に入らない)
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
export const appMissingLinks = new MissingLinksStore();
