/**
 * 🔴 **横に並べた枠を憶える**(#505 段②。「憶える(次に開いても同じ)」)。
 *
 * ⚠ **container には入れない** ── #505 本文が名指ししている:
 * 「🔴 **憶える** ── ⚠ **ノートごとではなく画面の設定**(#497 と同じ扱い)」。
 * 別の端末で開いたときに、その画面の広さと関係のない枠数が復活しないためである。
 * 🔑 だから `pkc3.read-columns` と同じく **localStorage**(端末の設定)。
 *
 * ⚠ **読めない環境で落ちない** ── private window / 保存を切った browser では
 * `localStorage` へ触るだけで例外が飛ぶ。起動を止めない。
 */
import { parseSplitLids, serializeSplitLids } from '@features/split-frames';

const KEY = 'pkc3.split-lids';

function storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 憶えている並び。⚠ 読めなければ空(= 並べない)。 */
export function loadSplitLids(): readonly string[] {
  try {
    return parseSplitLids(storage()?.getItem(KEY) ?? null);
  } catch {
    return [];
  }
}

/** 並びを憶える。⚠ 空でも書く(「全部外した」を憶えるため)。 */
export function saveSplitLids(lids: readonly string[]): void {
  try {
    storage()?.setItem(KEY, serializeSplitLids(lids));
  } catch {
    // 憶えられないだけ ── その回は並べたまま使える
  }
}
