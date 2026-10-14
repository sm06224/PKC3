/**
 * 前回の `entryMetas` と今回の `entryMetas` を並べて、**違いが作成・更新の時刻だけ**かを見る(#1087)。
 *
 * ## なぜ要るか
 *
 * 保存の ack(`ENTRY_STAMPED`)は `entryMetas` を**必ず新しい Map** に差し替える ── 変わるのは
 * 1 件の更新日時だけなのに、参照が変わるので、一覧の指紋・日付の指紋・種類の札の数を
 * **全件(5,000 件で各 1〜3 ms)作り直していた**。「参照が違う」を「中身が違う」と読まない。
 *
 * ## ⚠ 守ること
 *
 * - 見るのは**参照が違う組だけ**(reducer は 1 件を差し替えるので、残りは同じ object)。
 *   全件の中身を比べ直さない ── それでは指紋を作るのと同じ重さに戻る。
 * - **1 つでも「時刻以外」が違えば `null`**(呼び側は従来どおり全件を作り直す)。
 *   題名・種類・並び・状態・日付・アーカイブ・本文の字数のどれか、件数、lid の並びが違うとき。
 * - 返す組の**時刻が実際に違うか**は見ない(同じ内容の別 object は「組」に入る)。
 *   日付の字が変わるかは、呼び側が組の中身で決める。
 */
import type { EntryMeta } from '@core/model/entry-meta';

export function stampChanges(
  prev: ReadonlyMap<string, EntryMeta>,
  next: ReadonlyMap<string, EntryMeta>,
): Array<readonly [EntryMeta, EntryMeta]> | null {
  if (prev.size !== next.size) return null;
  const out: Array<readonly [EntryMeta, EntryMeta]> = [];
  const a = prev.values();
  const b = next.values();
  for (;;) {
    const x = a.next();
    const y = b.next();
    if (x.done === true || y.done === true) break;
    const p = x.value;
    const q = y.value;
    if (p === q) continue;
    if (
      p.lid !== q.lid ||
      p.title !== q.title ||
      p.archetype !== q.archetype ||
      p.entryOrder !== q.entryOrder ||
      p.status !== q.status ||
      p.date !== q.date ||
      p.archived !== q.archived ||
      p.bodyChars !== q.bodyChars
    )
      return null;
    out.push([p, q]);
  }
  return out;
}
