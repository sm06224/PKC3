/**
 * 貼付の読み取り元の設定(user 指示 2026-08-25)。
 *
 * > 「**無言でHTMLペーストを取得する以外のスイッチ経路を用意するなど、
 * > 実用とデバッグを兼用する工夫をしなさい / そのために設定やフラグはあるんだから!**」
 *
 * 意味論(どの順で読むか)は `features/markdown/paste-source.ts` に在る。
 * ここが持つのは**保存だけ**である。
 *
 * ⚠ **flag ではない**(flag 枠 15 とは別。user 指示 2026-07-30「正規設定と分離」)──
 *   これは user の判断であり、消さない。⚠ 診断の側(`paste.inspect`)が flag である。
 * ⚠ **container にも入れない** ── ノートのデータではなく**この端末の判断**である。
 * ⚠ 読めない環境(プライベートモード等で投げる)でも**落ちない** ── 既定に落ちる。
 */
import {
  DEFAULT_PASTE_SOURCE,
  isPasteSource,
  type PasteSource,
} from '@features/markdown/paste-source';

/** ⚠ 1 鍵だけ(`theme.ts` / `external-images.ts` と同じ作法)。 */
const KEY = 'pkc3.paste-source';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export class PasteSourceStore {
  private value: PasteSource;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {
    this.value = this.read();
  }

  private read(): PasteSource {
    try {
      const v = this.storage?.getItem(KEY);
      return v !== null && v !== undefined && isPasteSource(v) ? v : DEFAULT_PASTE_SOURCE;
    } catch {
      return DEFAULT_PASTE_SOURCE;
    }
  }

  get(): PasteSource {
    return this.value;
  }

  /** @returns 実際に変わったか(呼び側が描き直しの要否に使う)。 */
  set(next: PasteSource): boolean {
    if (next === this.value) return false;
    this.value = next;
    try {
      this.storage?.setItem(KEY, next);
    } catch {
      // ⚠ 保存できなくても**この session では効かせる**(黙って戻さない)
    }
    return true;
  }
}

/** アプリ全体で 1 つ(`appExternalImages` と同じ作法)。 */
export const appPasteSource = new PasteSourceStore();
