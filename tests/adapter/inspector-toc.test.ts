/** @vitest-environment happy-dom */
/**
 * 🔴 **見出しから自動で作る目次**(#493)。
 *
 * > user 報告 2026-08-27:「**自動で見出しから生成された TOC が PKC2 にはあるけど、
 * > PKC3 にはない**」
 *
 * ## ⚠ 「無い」ではなく「手で書かないと出ない」だった
 *
 * 材料は全部在った ── `extractHeadingsFromMarkdown` も、h1〜h3 への id 刻みも。
 * ⚠ しかも `markdown-render.ts` の id を刻む節には「**right-pane の目次が
 * 飛べるように**」と書いてあり、**受け手だけが未実装**だった。
 *
 * ## 🔑 置き場は「好み」ではなく PKC2 の実装が答えを持っていた
 *
 * PKC2 は meta ペイン(= 右の列)に置き、**見出しが 0 件なら丸ごと出さない**
 * (`renderer.ts:9056` / `docs/development/table-of-contents-right-pane.md`)。
 * user が既に知っている絵に揃える。
 *
 * ## 🔴 守る主張
 *
 * 1. 見出しが在れば**その順・その深さ**で並ぶ
 * 2. 🔴 **0 件なら行ごと畳む**(`<dt>` も一緒に ── 見出しだけ残さない)
 * 3. 🔴 押すと**本文のその見出し**へ飛ぶ(別の面の同じ id へ飛ばない)
 * 4. 🔴 飛び先が無い回は**理由を出す**(無言の dead click を作らない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { extractHeadingsFromMarkdown } from '../../src/features/markdown/markdown-toc';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const BODY = ['# 第 1 章', '本文', '## 節 A', 'あ', '### 細目', 'い', '# 第 2 章', 'う'].join('\n');

beforeEach(() => {
  document.body.textContent = '';
});

function setup(body: string | null) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const inspector = new InspectorRenderer(regions.inspector);
  d.onState((s) => inspector.render(s));
  bindActions(root, d);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  if (body !== null) d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  return { root, d };
}

const links = (root: HTMLElement): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('[data-pkc-action="toc-jump"]'),
];
const tocRow = (root: HTMLElement): HTMLElement =>
  root.querySelector<HTMLElement>('[data-pkc-field="inspector-toc"]')!;

describe('目次(#493)', () => {
  it('🔴 見出しがその順・その深さで並ぶ', () => {
    const { root } = setup(BODY);
    expect(
      links(root).map((b) => b.textContent),
      '目次が出ていない',
    ).toEqual(['第 1 章', '節 A', '細目', '第 2 章']);
    expect(
      links(root).map((b) => b.parentElement?.getAttribute('data-pkc-toc-level')),
      '深さが出ていない(字下げできない)',
    ).toEqual(['1', '2', '3', '1']);
  });

  /**
   * 🔑 **印は本文の id と同じ綴りでなければ飛べない。**
   * ⚠ ここで綴りを書き写すと、実装が変わっても test が気づかない ──
   *   **features の 1 か所**から採って突き合わせる。
   */
  it('🔴 押す先の印が、本文に刻まれる id と同じ綴り', () => {
    const { root } = setup(BODY);
    expect(links(root).map((b) => b.getAttribute('data-pkc-toc-slug'))).toEqual(
      extractHeadingsFromMarkdown(BODY).map((h) => h.slug),
    );
  });

  it('🔴 見出しが無いノートでは行ごと畳む(見出しだけ残さない)', () => {
    const { root } = setup('本文だけ\n');
    const dd = tocRow(root);
    expect(dd.hidden, '見出しが無いのに目次の行が出ている').toBe(true);
    expect(
      (dd.previousElementSibling as HTMLElement).hidden,
      '値だけ畳んで「目次」の見出しが残っている',
    ).toBe(true);
  });

  it('本文が読めていないときも出さない', () => {
    const { root } = setup(null);
    expect(tocRow(root).hidden).toBe(true);
  });

  /** ⚠ 直したら戻ること(状態が残らない)── 見出しを足せば出る。 */
  it('🔴 見出しを足せばその場で出る', () => {
    const { root, d } = setup('本文だけ\n');
    expect(tocRow(root).hidden).toBe(true);
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '# 章\n本文\n' });
    expect(tocRow(root).hidden, '足したのに出ない').toBe(false);
    expect(links(root).map((b) => b.textContent)).toEqual(['章']);
  });
});

describe('目次を押すと本文へ飛ぶ(#493)', () => {
  /** 本文の面に、描かれた見出しを置く(実物と同じ id の刻み方)。 */
  function plantBody(root: HTMLElement, slugs: string[]): HTMLElement[] {
    const detail = root.querySelector<HTMLElement>('[data-pkc-region="detail"]')!;
    const made: HTMLElement[] = [];
    for (const s of slugs) {
      const h = document.createElement('h1');
      h.id = s;
      h.scrollIntoView = vi.fn();
      detail.append(h);
      made.push(h);
    }
    return made;
  }

  it('🔴 本文のその見出しへ飛ぶ', () => {
    const { root } = setup(BODY);
    const slugs = extractHeadingsFromMarkdown(BODY).map((h) => h.slug);
    const planted = plantBody(root, slugs);
    links(root)[2]!.click();
    expect(planted[2]!.scrollIntoView, '押した見出しへ飛んでいない').toHaveBeenCalled();
    expect(planted[0]!.scrollIntoView, '別の見出しへ飛んだ').not.toHaveBeenCalled();
  });

  /**
   * 🔴 **別の面の同じ id へ飛ばない**(#493)。
   *
   * ⚠ マニュアルもヘルプも**同じ `makeSlugCounter`** で id を刻むので、
   *   `getElementById` で引くと**本文ではないほう**に当たりうる。
   *   2026-08-08 に「id の重複 0 件」という守れない条件を書いて踏んだ場所である。
   */
  it('🔴 同じ id が別の面にも在るとき、本文のほうへ飛ぶ', () => {
    const { root } = setup(BODY);
    const slug = extractHeadingsFromMarkdown(BODY)[0]!.slug;
    // ⚠ **本文より先に**別の面へ置く(`getElementById` は先頭を返す)
    const other = document.createElement('h1');
    other.id = slug;
    other.scrollIntoView = vi.fn();
    root.querySelector('[data-pkc-region="inspector"]')!.prepend(other);
    const planted = plantBody(root, [slug]);
    links(root)[0]!.click();
    expect(planted[0]!.scrollIntoView, '本文へ飛んでいない').toHaveBeenCalled();
    expect(other.scrollIntoView, '別の面の同じ id へ飛んだ').not.toHaveBeenCalled();
  });

  /**
   * 🔴 **飛び先が無い回は理由を出す**(1 面の編集中は本文が描かれていない)。
   * ⚠ 黙ると「押しても何も起きない」になる(#300 の型)。
   */
  it('🔴 本文が描かれていなければ理由を出す(無言にしない)', () => {
    const { root, d } = setup(BODY);
    links(root)[0]!.click();
    expect(d.getState().error ?? '', '押しても何も起きない').toContain('編集中');
  });
});
