/**
 * 🔴 **リッチ編集のセルの中の取り消し / やり直し**(v4.0 Phase 1 / PR-06)── 履歴の規則(pure)。
 */
import { describe, expect, it } from 'vitest';
import {
  createRichHistory,
  pushRich,
  redoRich,
  RICH_HISTORY_LIMIT,
  undoRich,
  type RichSnap,
} from '../../../src/features/markdown/rich-history';

const snap = (markdown: string, at = markdown.length): RichSnap => ({ markdown, start: at, end: at });

describe('rich-history', () => {
  it('書式を当てる → 取り消す → やり直す が往復する(選択も戻る)', () => {
    let h = createRichHistory(snap('本文'));
    h = pushRich(h, { markdown: '**本文**', start: 2, end: 4 });
    const u = undoRich(h)!;
    expect(u.snap).toEqual(snap('本文'));
    const r = redoRich(u.history)!;
    expect(r.snap).toEqual({ markdown: '**本文**', start: 2, end: 4 });
    expect(redoRich(r.history)).toBeNull();
  });

  it('先頭まで戻ったら null(呼び側がブロックを跨ぐ取り消しへ譲る)', () => {
    const h = createRichHistory(snap('a'));
    expect(undoRich(h)).toBeNull();
    const h2 = pushRich(h, snap('ab'));
    const u = undoRich(h2)!;
    expect(undoRich(u.history)).toBeNull();
  });

  it('同じ中身は 1 件にしない(選択だけ差し替える ── 空の取り消しを積まない)', () => {
    let h = createRichHistory(snap('a'));
    h = pushRich(h, { markdown: 'a', start: 0, end: 0 });
    expect(h.past).toHaveLength(0);
    expect(h.present.start).toBe(0);
    expect(pushRich(h, { markdown: 'a', start: 0, end: 0 })).toBe(h);
  });

  it('新しく記録したらやり直しの先は捨てる', () => {
    let h = createRichHistory(snap('a'));
    h = pushRich(h, snap('ab'));
    h = undoRich(h)!.history;
    expect(h.future).toHaveLength(1);
    h = pushRich(h, snap('ac'));
    expect(h.future).toHaveLength(0);
    expect(undoRich(h)!.snap.markdown).toBe('a');
  });

  it(`上限(${String(RICH_HISTORY_LIMIT)} 手)を超えたら古い手から捨てる`, () => {
    let h = createRichHistory(snap('0'));
    for (let i = 1; i <= RICH_HISTORY_LIMIT + 20; i += 1) h = pushRich(h, snap(String(i)));
    expect(h.past).toHaveLength(RICH_HISTORY_LIMIT);
    expect(h.past[0]!.markdown).toBe('20');
    let n = 0;
    for (let u = undoRich(h); u !== null; u = undoRich(u.history)) n += 1;
    expect(n).toBe(RICH_HISTORY_LIMIT);
  });
});
