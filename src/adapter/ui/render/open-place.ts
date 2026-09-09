/**
 * 「別の窓 / この画面」の**保存**(#826)。
 *
 * 意味論(どちらが既定か・名前)は `features/open-place.ts`。ここが持つのは
 * 保存だけである(`prose-align.ts` / `page-format.ts` と同じ分け方)。
 *
 * ⚠ **`prose-align.ts` と 1 点だけ違う** ── あちらは「いまの値」を DOM の属性から
 *   読む(見え方のトークンなので DOM が正本)。こちらは **DOM に出ない設定**なので、
 *   正本は保存である。⚠ だから読み口は `currentOpenPlace()` 1 つで、
 *   「当てる」に相当するものが無い。
 * ⚠ 読めない環境(プライベートモード等で投げる)でも**落ちない**(既定に落ちる)。
 */
import { DEFAULT_OPEN_PLACE, isOpenPlace, type OpenPlace } from '@features/open-place';

/** ⚠ 1 鍵だけ(`pkc3.prose-align` と同じ作法)。 */
export const OPEN_PLACE_KEY = 'pkc3.open-place';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // 使えない環境でも落ちない
  }
}

/** いまの開き場所 ── **保存されていれば それ、無ければ別の窓**。 */
export function currentOpenPlace(): OpenPlace {
  try {
    const v = readStorage()?.getItem(OPEN_PLACE_KEY);
    return v !== null && v !== undefined && isOpenPlace(v) ? v : DEFAULT_OPEN_PLACE;
  } catch {
    return DEFAULT_OPEN_PLACE;
  }
}

/** user が選んだ ── **保存する**。⚠ 起動時には呼ばない(選んでいないのに固定しない)。 */
export function chooseOpenPlace(place: OpenPlace): void {
  try {
    readStorage()?.setItem(OPEN_PLACE_KEY, place);
  } catch {
    // 保存できないだけ ── この session では効いている
  }
}
