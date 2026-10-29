/**
 * 🔴 **旧い版が端末(localStorage)に残したピン留めを、一度だけコレクションへ取り込んで移す**(#1377)。
 *
 * - この器の分だけ取り込み(他の器の分は、その器を開いたときに)、取り込んだ分は端末の記憶から消す ── 二重に持たない。
 * - ⚠ 1 件でも書けなかったら端末の記憶は**消さない**(次の起動でやり直す)。書けた分は残っても害は無い(付け直しは順を変えない)。
 * - 他の器の分・読めない物は触らない。
 */
import { legacyPinLids, legacyPinsWithout } from '@features/relation/note-pins';

/** 旧い版が端末に残したピン留めの鍵。 */
export const LEGACY_NOTE_PINS_KEY = 'pkc3.note-pins';

/**
 * @param put この器へ 1 件ピンを書く(失敗は throw)
 * @param has すでにこの器にピンが在るか(在れば書かない)
 * @returns 移した件数(書く物が無ければ 0)。書けなかったら throw せず `-1`(端末の記憶は残してある)
 */
export async function migrateLegacyNotePins(
  cid: string,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  put: (lid: string) => Promise<void>,
  has: (lid: string) => boolean,
): Promise<number> {
  try {
    const raw = storage.getItem(LEGACY_NOTE_PINS_KEY);
    const legacy = legacyPinLids(raw, cid);
    if (legacy.length === 0) return 0;
    let moved = 0;
    for (const lid of legacy) {
      if (has(lid)) continue;
      await put(lid);
      moved += 1;
    }
    const rest = legacyPinsWithout(raw, cid);
    if (rest === null) storage.removeItem(LEGACY_NOTE_PINS_KEY);
    else storage.setItem(LEGACY_NOTE_PINS_KEY, rest);
    return moved;
  } catch {
    return -1;
  }
}
