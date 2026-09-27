/** @vitest-environment happy-dom */
/**
 * 🔴 **章の別ウィンドウ(読むだけ)の器**(#1044 段4)── `adapter/platform/chapter-window.ts`。
 *
 * 守る主張(設計 doc §10.2):
 * 1. 🔴 押して書く口は窓に残らない(⧉ は取り除き、送れない口は属性を外す)
 * 2. 🔴 送れる口(ノート・添付・図)だけが残り、押すと開いた側へ渡る
 * 3. 章の外を指すページ内リンクは押せない字になる / 外のリンクは別のタブで開く
 * 4. Esc で窓が閉じる / 組んだ印が刻まれる(F5 で白くなったかをこれで見分ける)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CHAPTER_BODY_FIELD,
  CHAPTER_BUILT_ATTR,
  CHAPTER_HEAD_FIELD,
  CHAPTER_NOTE_FIELD,
  CHAPTER_ORPHAN_FIELD,
  CHAPTER_WINDOW_ACTIONS,
  CHAPTER_WINDOW_TEXT,
  chapterWindowBuilt,
  chapterWindowName,
  chapterWindowTouchable,
  grabChapterWindow,
  markChapterWindowOrphaned,
  paintChapterWindow,
  wireChapterWindow,
} from '../../src/adapter/platform/chapter-window';

/** 別の document を持つ偽の窓(開いた側の `document` とは別物)。 */
function fakeWindow(): Window & { closed: boolean } {
  const doc = document.implementation.createHTMLDocument('');
  const win = {
    document: doc,
    closed: false,
    focus: vi.fn(),
    close(): void {
      win.closed = true;
    },
  };
  return win as unknown as Window & { closed: boolean };
}

/** 開いた側の `document` で塊を作る(製品と同じ作法)。 */
function blocks(html: string): Node[] {
  const t = document.createElement('template');
  t.innerHTML = html;
  return Array.from(t.content.childNodes);
}

function paint(win: Window, html: string): HTMLElement | null {
  return paintChapterWindow(win, {
    title: 'ノート › 章',
    noteTitle: 'ノート',
    key: 'k1',
    content: { kind: 'chapter', blocks: blocks(html), jumpRef: 'entry:n1#h/sho' },
  });
}

describe('窓を組む', () => {
  it('🔴 題名・頭の帯・本文の器が出て、組んだ印が刻まれる', () => {
    const win = fakeWindow();
    const host = paint(win, '<h2 id="sho">章</h2><p>中身</p>');
    const doc = win.document;
    expect(doc.title).toBe('ノート › 章');
    expect(doc.querySelector(`[data-pkc-field="${CHAPTER_HEAD_FIELD}"] strong`)?.textContent).toBe('ノート');
    expect(host?.getAttribute('data-pkc-field')).toBe(CHAPTER_BODY_FIELD);
    expect(host?.ownerDocument, '器が窓の document に入っていない').toBe(doc);
    expect(host?.querySelector('p')?.textContent).toBe('中身');
    expect(chapterWindowBuilt(win), '組んだ印が無い(F5 を見分けられない)').toBe(true);
    expect(doc.body.getAttribute(CHAPTER_BUILT_ATTR)).toBe('k1');
    // ⚠ 本文の CSS が入っている(器の class が本文の規則に当たる)
    expect(doc.head.querySelector('style')?.textContent ?? '').toContain('pkc-md-rendered');
  });

  it('🔴 組み直すと中身は入れ替わり、積み上がらない', () => {
    const win = fakeWindow();
    paint(win, '<p>古い</p>');
    paint(win, '<p>新しい</p>');
    const doc = win.document;
    expect(doc.querySelectorAll(`[data-pkc-field="${CHAPTER_BODY_FIELD}"]`)).toHaveLength(1);
    expect(doc.body.textContent).not.toContain('古い');
    expect(doc.head.querySelectorAll('style'), 'style が積もる').toHaveLength(1);
  });

  it('⚠ 章の代わりの一文(開いています / 見つかりません / もうありません)', () => {
    for (const kind of ['loading', 'missing', 'gone'] as const) {
      const win = fakeWindow();
      const host = paintChapterWindow(win, { title: 't', noteTitle: 'n', key: 'k', content: { kind } });
      expect(host).toBeNull();
      expect(win.document.querySelector(`[data-pkc-field="${CHAPTER_NOTE_FIELD}"]`)?.textContent).toBe(
        CHAPTER_WINDOW_TEXT[kind],
      );
      // ⚠ 飛ぶ先の無い「元のウィンドウで開く」を出さない
      expect(win.document.querySelector('[data-pkc-action]')).toBeNull();
    }
  });

  it('🔴 「元のウィンドウで開く」はノートへのリンクと同じ口で、その章を指す', () => {
    const win = fakeWindow();
    paint(win, '<p>x</p>');
    const jump = win.document.querySelector(`[data-pkc-field="${CHAPTER_HEAD_FIELD}"] button`);
    expect(jump?.getAttribute('data-pkc-action')).toBe('navigate-entry-ref');
    expect(jump?.getAttribute('data-pkc-entry-ref')).toBe('entry:n1#h/sho');
    expect(jump?.textContent).toBe(CHAPTER_WINDOW_TEXT.jump);
  });
});

describe('🔴 読むだけ ── 押して書く口を残さない', () => {
  it('🔴 ⧉ は取り除き、送れない口は属性だけ外す(字は残す)', () => {
    const win = fakeWindow();
    const host = paint(
      win,
      '<pre><button data-pkc-action="copy-md-block">⧉</button><code>c</code></pre>' +
        '<p><input type="checkbox" data-pkc-action="toggle-task"> 買う</p>' +
        '<table><tr><td data-pkc-action="edit-cell">A1</td></tr></table>' +
        '<p><a data-pkc-action="filter-by-tag" href="#">#タグ</a></p>',
    )!;
    expect(host.querySelector('[data-pkc-action="copy-md-block"]'), '⧉ が残っている').toBeNull();
    for (const a of Array.from(host.querySelectorAll('[data-pkc-action]'))) {
      expect(CHAPTER_WINDOW_ACTIONS.has(a.getAttribute('data-pkc-action') ?? ''), '送れない口が残っている').toBe(true);
    }
    // ⚠ 空振り防止 ── 字は残っている(属性だけ外した)
    expect(host.textContent).toContain('A1');
    expect(host.textContent).toContain('#タグ');
  });

  it('🔴 送れる口(ノート・添付・図)は残る', () => {
    const win = fakeWindow();
    const host = paint(
      win,
      '<p><a data-pkc-action="navigate-entry-ref" data-pkc-entry-ref="entry:n2" href="#">別</a>' +
        '<a data-pkc-action="download-asset" data-pkc-asset-key="k">添付</a></p>',
    )!;
    expect(host.querySelector('[data-pkc-action="navigate-entry-ref"]')).not.toBeNull();
    expect(host.querySelector('[data-pkc-action="download-asset"]')).not.toBeNull();
  });

  it('⚠ 送れる口の一覧は、本文を書き換える口を 1 つも持たない', () => {
    for (const w of ['toggle-task', 'edit-cell', 'shape-cell', 'edit-code-block', 'filter-by-tag', 'copy-md-block']) {
      expect(CHAPTER_WINDOW_ACTIONS.has(w), `${w} が送れる口に入っている`).toBe(false);
    }
  });

  it('🔴 章の外を指すページ内リンクは押せない字になり、章の中の物は残る', () => {
    const win = fakeWindow();
    const host = paint(
      win,
      '<h2 id="in">中</h2><p><a href="#in">中へ</a> <a href="#out">外へ</a></p>',
    )!;
    const [inner, outer] = Array.from(host.querySelectorAll('p a'));
    expect(inner?.getAttribute('href')).toBe('#in');
    expect(outer?.hasAttribute('href'), '章の外への飛び先が押せるまま').toBe(false);
    expect(outer?.textContent, '字まで消えた').toBe('外へ');
    expect((outer as HTMLElement).title).toBe(CHAPTER_WINDOW_TEXT.offChapter);
  });

  it('⚠ 外のリンクは別のタブで開く(この窓ごと外へ移らない)', () => {
    const win = fakeWindow();
    const host = paint(win, '<p><a href="https://example.com/">外</a></p>')!;
    const a = host.querySelector('a')!;
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel') ?? '').toContain('noopener');
  });
});

describe('押し所の配線', () => {
  it('🔴 送れる口を押すと開いた側へ渡り、送れない口は渡らない', () => {
    const win = fakeWindow();
    paint(win, '<p><a data-pkc-action="navigate-entry-ref" data-pkc-entry-ref="entry:n2" href="#">別</a></p>');
    const onAction = vi.fn();
    wireChapterWindow(win, onAction);
    // ⚠ 2 度配線しても 1 回しか渡らない(組み直すたびに呼ばれる)
    wireChapterWindow(win, onAction);
    const link = win.document.querySelector<HTMLElement>('[data-pkc-action="navigate-entry-ref"]')!;
    link.click();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]![0]).toBe(link);
    // 対照群 ── 属性を足しても、一覧に無い口は渡らない
    const bad = win.document.createElement('button');
    bad.setAttribute('data-pkc-action', 'toggle-task');
    win.document.body.append(bad);
    bad.click();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('🔴 Esc で窓が閉じる', () => {
    const win = fakeWindow();
    paint(win, '<p>x</p>');
    wireChapterWindow(win, vi.fn());
    win.document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(win.closed).toBe(true);
  });

  it('⚠ 元のウィンドウが閉じたら、頭の下に一文が出る(1 回だけ)', () => {
    const win = fakeWindow();
    paint(win, '<p>x</p>');
    markChapterWindowOrphaned(win);
    markChapterWindowOrphaned(win);
    const lines = win.document.querySelectorAll(`[data-pkc-field="${CHAPTER_ORPHAN_FIELD}"]`);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toBe(CHAPTER_WINDOW_TEXT.orphan);
  });

  it('🔴 元のウィンドウが閉じたら、押し所は消す(受け手が居ないので、押しても何も起きない)', () => {
    const win = fakeWindow();
    paint(win, '<p><a data-pkc-action="navigate-entry-ref" data-pkc-entry-ref="entry:n2" href="#">別</a></p>');
    // ⚠ 空振り防止 ── 押し所が在る(頭の「元のウィンドウで開く」と本文のリンク)
    expect(win.document.querySelectorAll('[data-pkc-action]').length).toBe(2);
    markChapterWindowOrphaned(win);
    expect(win.document.querySelectorAll('[data-pkc-action]'), '押し所が残っている').toHaveLength(0);
    expect(win.document.body.textContent, 'リンクの字まで消えた').toContain('別');
  });

  it('🔴 組み直したら「もう新しくならない」の一文は消える(読み直した元のウィンドウが追従を再開した)', () => {
    const win = fakeWindow();
    paint(win, '<p>x</p>');
    markChapterWindowOrphaned(win);
    paint(win, '<p>y</p>');
    expect(win.document.querySelector(`[data-pkc-field="${CHAPTER_ORPHAN_FIELD}"]`), '一文が残って嘘になった').toBeNull();
  });

  it('🔴 窓へ落とす操作は止める(落とした URL へ窓ごと移らない)', () => {
    const win = fakeWindow();
    paint(win, '<p>x</p>');
    wireChapterWindow(win, vi.fn());
    for (const type of ['dragover', 'drop']) {
      const ev = new Event(type, { cancelable: true });
      win.document.dispatchEvent(ev);
      expect(ev.defaultPrevented, `${type} を止めていない`).toBe(true);
    }
  });

  it('⚠ 触れない窓(別のページへ移った)を、触れないと判定する', () => {
    const win = fakeWindow();
    expect(chapterWindowTouchable(win)).toBe(true);
    Object.defineProperty(win, 'document', {
      get() {
        throw new DOMException('cross-origin', 'SecurityError');
      },
    });
    expect(chapterWindowTouchable(win)).toBe(false);
  });
});

describe('窓の名前と掴み方', () => {
  it('🔴 同じ章は同じ名前、違う章(何番目が違う)は違う名前', () => {
    const a = chapterWindowName('n1', { text: '決定', ordinal: 0 });
    expect(chapterWindowName('n1', { text: '決定', ordinal: 0 })).toBe(a);
    expect(chapterWindowName('n1', { text: '決定', ordinal: 1 })).not.toBe(a);
    expect(chapterWindowName('n2', { text: '決定', ordinal: 0 })).not.toBe(a);
    expect(a).toMatch(/^pkc3-chapter-[A-Za-z0-9_-]+$/);
  });

  it('🔴 空の URL で開く(about:blank を渡すと、同じ名前の窓の中身が消える)', () => {
    const open = vi.fn(() => null);
    expect(grabChapterWindow('pkc3-chapter-x', open)).toBeNull();
    expect(open).toHaveBeenCalledWith('', 'pkc3-chapter-x', expect.stringContaining('popup'));
  });
});
