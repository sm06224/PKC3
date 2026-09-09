/**
 * 🔴 **本文の素の電話番号を、押せる字にするか**(#278 段②)。
 *
 * ## ⚠ なぜ既定を「切」にするか
 *
 * 🔴 **本文の見え方が変わる**からである(user 指示 2026-08-28
 * 「正直変更はユーザーに委ねて欲しい」)。入れると、いま読めている数字が
 * **色の付いた押せる字**になる ── 頼んでいない人には「勝手に変わった」に見える。
 *
 * ⚠ そして**押し間違いが起きうる**:電話の画面では、本文を指でなぞろうとして
 * 触れただけで**発信の確認**が出る。だから「掛けたい人」だけが入れる形にする。
 *
 * ⚠ **flag ではない**(正規設定)── 開放先は user で、畳む予定も無い
 * (`alarm` / `open-in-edit` と同じ扱い。flag の 15 枠は使わない)。
 * ⚠ **container に入れない** ── ノートのデータではなく、この端末の読み方である。
 *
 * 🔑 拾う判定そのものは `features/contact/phone-link.ts` が 1 か所で持つ。
 */

const KEY = 'pkc3.phone-links';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class PhoneLinksStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback = false;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /** ⚠ **読むたびに保存を見る**(`OpenInEditStore` と同じ理由 ── 書き手が複数)。 */
  enabled(): boolean {
    // 🔴 **保存が無い環境では控えを読む**(下の注記)
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
export const appPhoneLinks = new PhoneLinksStore();
