/**
 * 「アプリをどこに出すか」の**保存**(#884 段①)。
 *
 * 意味論(どちらが既定か・名前・窓の指定の組み方)は `features/launcher/open-target.ts`。
 * ここが持つのは保存だけである(`open-place.ts` と同じ分け方)。
 *
 * ⚠ **DOM に出ない設定**なので、正本は保存である(読み口は 1 つ、当てるものは無い)。
 * ⚠ 読めない環境(私用ウィンドウ / Cookie を全部止めている)でも**落ちない** ──
 *   既定に落ちる。🔴 そのとき `?.` で読まない ── `storage` が `null` のとき
 *   `?.` は**例外を投げずに `undefined` を返す**ので、`catch` の控えへ 1 度も入らない
 *   (CLAUDE.md §7。`tests/adapter/store-fallback.test.ts` が同じ形を見張っている)。
 */
import {
  DEFAULT_APP_OPEN_TARGET,
  isAppOpenTarget,
  type AppOpenTarget,
} from '@features/launcher/open-target';

/** ⚠ 1 鍵だけ(`pkc3.open-place` と同じ作法)。 */
export const APP_OPEN_TARGET_KEY = 'pkc3.app-open-target';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // 使えない環境でも落ちない
  }
}

/** いまの出し先 ── **保存されていれば それ、無ければブラウザのタブ**。 */
export function currentAppOpenTarget(): AppOpenTarget {
  try {
    const s = readStorage();
    if (s === null) return DEFAULT_APP_OPEN_TARGET;
    const v = s.getItem(APP_OPEN_TARGET_KEY);
    return v !== null && isAppOpenTarget(v) ? v : DEFAULT_APP_OPEN_TARGET;
  } catch {
    return DEFAULT_APP_OPEN_TARGET;
  }
}

/** user が選んだ ── **保存する**。⚠ 起動時には呼ばない(選んでいないのに固定しない)。 */
export function chooseAppOpenTarget(target: AppOpenTarget): void {
  try {
    readStorage()?.setItem(APP_OPEN_TARGET_KEY, target);
  } catch {
    // 保存できないだけ ── この session では効いている
  }
}
