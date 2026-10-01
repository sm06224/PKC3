/**
 * 🔴 **リンク先のノートが無い内部リンクの印**(#1174 段①)。
 *
 * ⚠ 期待値の HTML は**実物の `renderMarkdown` から採る**(手で `data-pkc-entry-ref` を
 *   書くと、焼く側の綴りが変わった日に両方そのままで緑になる ── CLAUDE.md §7「両端が
 *   相手を模した stub」)。
 */
import { describe, expect, it } from 'vitest';
import {
  applyMissingLinks,
  clearMissingLinks,
  MISSING_ATTR,
  MISSING_LINK_TITLE,
} from '../../src/adapter/ui/render/link-missing';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { BANNED_TERMS } from '../../src/features/ui-terms';

const SELF = 'cid-self';

function hostOf(md: string): HTMLElement {
  const host = document.createElement('div');
  host.className = 'pkc-md-rendered';
  host.innerHTML = renderMarkdown(md, { currentContainerId: SELF });
  return host;
}

const BODY = [
  '[在る](entry:here)',
  '[無い](entry:gone)',
  '[同じ PKC の携帯参照](pkc://' + SELF + '/entry/gone2)',
  '[別の PKC](pkc://other-cid/entry/far)',
  '@[card](entry:gone3)',
  '[外](https://example.com)',
].join('\n\n');

const has = (lid: string): boolean => lid === 'here';

function marked(host: HTMLElement): string[] {
  return [...host.querySelectorAll(`[${MISSING_ATTR}]`)].map(
    (e) => e.getAttribute('data-pkc-entry-ref') ?? e.getAttribute('data-pkc-card-target') ?? '?',
  );
}

describe('applyMissingLinks', () => {
  it('🔴 前提: 実物の描画が 3 種の内部リンクを焼いている(空振り防止)', () => {
    const host = hostOf(BODY);
    expect(host.querySelectorAll('a[data-pkc-entry-ref]').length).toBe(3); // entry: ×2 + pkc://自分 ×1
    expect(host.querySelectorAll('[data-pkc-card-target]').length).toBe(1);
  });

  it('無いノートへのリンクだけに印と言葉が付く(在る・外は付かない)', () => {
    const host = hostOf(BODY);
    applyMissingLinks(host, has, SELF);
    expect(marked(host).sort()).toEqual(['entry:gone', 'entry:gone2', 'entry:gone3']);
    const gone = host.querySelector(`[data-pkc-entry-ref="entry:gone"]`)!;
    expect(gone.getAttribute('title')).toBe(MISSING_LINK_TITLE);
    const here = host.querySelector(`[data-pkc-entry-ref="entry:here"]`)!;
    expect(here.hasAttribute(MISSING_ATTR)).toBe(false);
    expect(here.hasAttribute('title')).toBe(false);
    const ext = host.querySelector('a[href^="https://example.com"]')!;
    expect(ext.hasAttribute(MISSING_ATTR)).toBe(false);
  });

  it('🔴 別の PKC を指すリンクには触らない(印も title も付けない)', () => {
    const host = hostOf(BODY);
    const before = host.innerHTML;
    applyMissingLinks(host, has, SELF);
    // 別の PKC の携帯参照は札になり、`data-pkc-entry-ref` を持たない
    const far = [...host.querySelectorAll('a')].find((a) => (a.getAttribute('href') ?? '').includes('other-cid'))!;
    expect(far, '別の PKC のリンクが描かれていない(前提)').toBeTruthy();
    expect(far.hasAttribute(MISSING_ATTR)).toBe(false);
    // 描画が付けた title(別の PKC を指す、の説明)も、こちらの言葉に差し替わっていない
    expect(far.getAttribute('title')).not.toBe(MISSING_LINK_TITLE);
    const farHtml = (h: string): string => /<a[^>]*other-cid[^>]*>/.exec(h)![0];
    expect(farHtml(host.innerHTML)).toBe(farHtml(before));
  });

  it('🔴 foreign の card(@[card](pkc://他/entry/…))にも付けない ── 対照群: 自分の card には付く', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<span data-pkc-card-target="pkc://other-cid/entry/zz" data-pkc-action="navigate-card-ref">a</span>' +
      '<span data-pkc-card-target="pkc://' + SELF + '/entry/zz" data-pkc-action="navigate-card-ref">b</span>';
    applyMissingLinks(host, () => false, SELF);
    const [far, mine] = [...host.querySelectorAll('span')];
    expect(far!.hasAttribute(MISSING_ATTR)).toBe(false);
    expect(mine!.hasAttribute(MISSING_ATTR)).toBe(true);
  });

  it('🔴 戻したら(has が真になったら)印も言葉も消える ── 描き直さずに', () => {
    const host = hostOf(BODY);
    applyMissingLinks(host, has, SELF);
    const node = host.querySelector(`[data-pkc-entry-ref="entry:gone"]`)!;
    expect(node.hasAttribute(MISSING_ATTR)).toBe(true);
    applyMissingLinks(host, (l) => l === 'here' || l === 'gone', SELF);
    expect(host.querySelector(`[data-pkc-entry-ref="entry:gone"]`)).toBe(node); // 同じ節点
    expect(node.hasAttribute(MISSING_ATTR)).toBe(false);
    expect(node.hasAttribute('title')).toBe(false);
    // 他の無いリンクはそのまま
    expect(host.querySelector(`[data-pkc-entry-ref="entry:gone2"]`)!.hasAttribute(MISSING_ATTR)).toBe(true);
  });

  it('冪等: 2 回当てても同じ(title が重ならない)', () => {
    const host = hostOf(BODY);
    applyMissingLinks(host, has, SELF);
    const once = host.innerHTML;
    applyMissingLinks(host, has, SELF);
    expect(host.innerHTML).toBe(once);
  });

  it('user が付けた title は潰さず、戻したときも消さない', () => {
    const host = document.createElement('div');
    host.innerHTML = '<a data-pkc-entry-ref="entry:x" title="私のメモ">x</a>';
    const a = host.querySelector('a')!;
    applyMissingLinks(host, () => false);
    expect(a.getAttribute('title')).toBe('私のメモ');
    expect(a.hasAttribute(MISSING_ATTR)).toBe(true);
    applyMissingLinks(host, () => true);
    expect(a.getAttribute('title')).toBe('私のメモ');
    expect(a.hasAttribute(MISSING_ATTR)).toBe(false);
  });

  it('clearMissingLinks は付けた印を全部外す(設定を切ったとき)', () => {
    const host = hostOf(BODY);
    applyMissingLinks(host, has, SELF);
    expect(marked(host).length).toBeGreaterThan(0);
    clearMissingLinks(host);
    expect(marked(host)).toEqual([]);
    expect(
      [...host.querySelectorAll('[title]')].filter((e) => e.getAttribute('title') === MISSING_LINK_TITLE),
    ).toEqual([]);
  });

  it('言葉は画面の言葉で、使わない語を含まない', () => {
    for (const b of BANNED_TERMS) {
      expect(b.pattern().test(MISSING_LINK_TITLE), `使わない語「${b.banned}」`).toBe(false);
    }
    expect(MISSING_LINK_TITLE).toContain('見つかりません');
    expect(MISSING_LINK_TITLE).toContain('ゴミ箱');
  });
});
