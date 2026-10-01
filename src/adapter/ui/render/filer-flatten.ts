/**
 * 🔴 **「中まで全部出す」を憶える**(#813 段②。🟣 Gemini 裁定 2026-10-01 の C)。
 *
 * 左の列の「フォルダ」の表で、いま居る場所の**配下を階層をまたいで全部**平らに出すか。
 * 効かせるのは state(`AppState.filerFlatten`)で、ここは**この端末に憶えるだけ**
 * (`DualPrefsStore` の下見と同じ作り ── 起動で 1 度だけ state へ写す)。
 *
 * ⚠ **既定は切**(いままでどおり直下だけ)── 何も選んでいない人の見え方を変えない。
 * ⚠ **flag ではない**(正規設定の仲間) ── 開放先は user で、畳む予定も無い。
 *   設定画面にも出さない(押し口はフォルダの面の帯だけ)。
 * ⚠ **container に入れない** ── ノートのデータではなく、この端末の見え方である。
 * ⚠ 保存の値は `1`(入)だけを書く側で意味づける ── 鍵が無い / 読めない端末は「切」。
 */

const KEY = 'pkc3.filer-flatten';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class FilerFlattenStore {
  /** 保存が読めない環境の控え(この session では効いている)。既定は「切」。 */
  private fallback = false;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /** ⚠ **読むたびに保存を見る**(書き手が複数 ── UI と smoke の仕込み)。 */
  enabled(): boolean {
    // 🔴 **保存が無い環境では控えを読む**(`?.` では `catch` に入らない)
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
export const appFilerFlatten = new FilerFlattenStore();
