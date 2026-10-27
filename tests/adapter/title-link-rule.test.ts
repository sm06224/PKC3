/** @vitest-environment happy-dom */
/**
 * 🔴 **印の「ある / まだ無い」と、押したときに開くノートは、同じ規則**(#1174 段②。穴 H)。
 *
 * 印(`applyTitleLinks` → `titleNoteIndex`)と、押したとき(`findTodayNote`)が別の規則だと、
 * 「ある」と出ているのに押すと「まだありません」になる。ランダムな一覧(片付け済み・同名・並び)で突き合わせる。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { findTodayNote, titleNoteIndex } from '../../src/features/schedule/today-note';
import { applyTitleLinks } from '../../src/adapter/ui/render/title-links';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function meta(lid: string, title: string, entryOrder: number, archived: boolean): EntryMeta {
  return { lid, title, archetype: 'text', createdAt: null, updatedAt: null, entryOrder, status: null, date: null, archived, bodyChars: null };
}

describe('印と「押したとき開くノート」の規則が同じ', () => {
  it('300 通りの一覧で、題名ごとに 印=まだ無い ⇔ findTodayNote が null / 開く先は一覧の索引と同じ', () => {
    const r = rng(777);
    const titles = ['あ', 'い', 'う', 'え'];
    let missing = 0;
    let found = 0;
    for (let n = 0; n < 300; n++) {
      const metas: EntryMeta[] = [];
      const count = Math.floor(r() * 7);
      for (let i = 0; i < count; i++) {
        metas.push(meta(`m${i}`, titles[Math.floor(r() * titles.length)]!, Math.floor(r() * 5), r() < 0.35));
      }
      const host = document.createElement('div');
      for (const t of titles) {
        const el = document.createElement('span');
        el.className = 'pkc-title-link';
        el.setAttribute('data-pkc-title', t);
        host.append(el);
      }
      applyTitleLinks(host, metas);
      const index = titleNoteIndex(metas);
      for (const el of host.querySelectorAll<HTMLElement>('.pkc-title-link')) {
        const t = el.getAttribute('data-pkc-title')!;
        const opened = findTodayNote(metas, t);
        expect(el.hasAttribute('data-pkc-link-missing'), `${t}: ${JSON.stringify(metas)}`).toBe(opened === null);
        expect(index.get(t)?.lid ?? null, `${t}: 開く先が索引と違う`).toBe(opened?.lid ?? null);
        if (opened === null) missing += 1;
        else found += 1;
      }
    }
    expect(missing, '「まだ無い」を一度も通っていない(空振り)').toBeGreaterThan(50);
    expect(found, '「ある」を一度も通っていない(空振り)').toBeGreaterThan(50);
  });

  it('同名が複数あれば、並びで上(entryOrder が小さい)ほうを開く / 片付け済みは数えない', () => {
    const metas = [meta('b', 'あ', 2, false), meta('a', 'あ', 1, false), meta('z', 'あ', 0, true)];
    expect(findTodayNote(metas, 'あ')?.lid).toBe('a');
    expect(titleNoteIndex(metas).get('あ')?.lid).toBe('a');
  });
});
