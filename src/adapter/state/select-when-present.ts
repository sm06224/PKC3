/**
 * **取り込んだノートを画面に出す**(2026-08-05、user 報告
 * 「開いたら何も起きずに終わる」)。
 *
 * 取込は書いたあと `reload()` を呼び、その先で `SYS_BOOTED` が飛ぶ。ところが
 * `reloadSnapshot` は **phase が ready でないとき早く返る**(待つと gate を
 * 握ったまま固まりうるため)。つまり「取込が終わった時点で entry が一覧に居るか」は
 * 保証されない ── ここで素朴に `SELECT_ENTRY` を投げると、
 * reducer の `entryMetas.has(lid)` に弾かれて**黙って何も起きない**。
 *
 * だから「**居たら選ぶ、まだなら来るまで待つ**」を 1 か所に閉じる。
 *
 * ⚠ **待ち続けない**。boot が済んだ(= ready)のに居ないなら、その entry は
 * 本当に無い ── 購読を切る。切らないと listener が漏れる
 * (`docs` の stale listener 規律と同じ向き)。
 */
import type { Dispatcher } from './dispatcher';

/**
 * `lid` が一覧に現れた時点で選ぶ。既に居ればその場で選ぶ。
 *
 * @returns 購読を切る関数(既にその場で選べたときは何もしない関数)
 */
export function selectWhenPresent(dispatcher: Dispatcher, lid: string): () => void {
  const pick = (): void => {
    dispatcher.dispatch({ type: 'SELECT_ENTRY', lid });
  };
  if (dispatcher.getState().entryMetas.has(lid)) {
    pick();
    return () => {};
  }
  let off: (() => void) | null = null;
  const stop = (): void => {
    off?.();
    off = null;
  };
  off = dispatcher.onState((s) => {
    if (s.entryMetas.has(lid)) {
      stop();
      pick();
      return;
    }
    // ⚠ boot が済んだのに居ない = 本当に無い。ここで切らないと永久に残る
    if (s.phase === 'ready') stop();
  });
  return stop;
}
