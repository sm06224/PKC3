/** @vitest-environment happy-dom */
/**
 * 🔴 **同じ本文を 2 面に描いても、document の `id` が重ならない**(#1087 A7)。
 *
 * ⚠ 見出し・脚注・「原文 / 表示」の切替の `id` は本文の中身から決まる。主の面と、横に留めた枠
 *   (スタック)は同じ document に居るので、同じ(似た)本文を並べると重なっていた:
 *   切替の `<label for>` が別の面のチェックを倒し、`#fn1` が先に出てくる相手へ飛ぶ。
 * 🔑 主の面は今までの `id` のまま(パーマリンク・目次の飛び先が頼る)、主でない面だけ接頭辞を付ける。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as clipboard from '../../src/adapter/platform/clipboard';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { prefixHtmlIds, renderMarkdown } from '../../src/features/markdown/markdown-render';

const meta = (lid: string): EntryMeta => ({
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
});

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const BODY = '# 見出し\n\n脚注つき[^1]です。\n\n```csv\na,b\n1,2\n```\n\n[^1]: 脚注の本文\n';

function state(lids: readonly string[]): AppState {
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: lids.map(meta),
    relations: [],
  }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: lids[0]! }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: lids[0]!, body: BODY }).state;
  for (const l of lids.slice(1)) s = reduce(s, { type: 'PIN_SPLIT_ENTRY', lid: l }).state;
  for (const l of lids) s = reduce(s, { type: 'SPLIT_BODY_LOADED', lid: l, body: BODY }).state;
  return s;
}

interface Surfaces {
  readonly primary: HTMLElement;
  readonly b: HTMLElement;
  readonly c: HTMLElement;
}

async function boot(): Promise<Surfaces> {
  const root = document.createElement('div');
  document.body.append(root);
  const mk = (): HTMLElement => {
    const host = document.createElement('div');
    root.append(host);
    return host;
  };
  const primaryHost = buildShell(root).detail;
  const bHost = mk();
  const cHost = mk();
  const s = state(['a', 'b', 'c']);
  const primary = new DetailRenderer(primaryHost);
  const rb = new DetailRenderer(bHost, null, undefined, null, undefined, undefined, undefined, 'b');
  const rc = new DetailRenderer(cHost, null, undefined, null, undefined, undefined, undefined, 'c');
  primary.render(s);
  rb.render(s);
  rc.render(s);
  await settle();
  await settle();
  return { primary: primaryHost, b: bHost, c: cHost };
}

const idsOf = (root: ParentNode): string[] =>
  [...root.querySelectorAll('[id]')].map((e) => e.getAttribute('id') ?? '');

beforeEach(() => {
  document.body.textContent = '';
});

describe('同じ本文を主の面と留めた枠 2 つに描く(#1087 A7)', () => {
  it('台の前提:切替・見出し・脚注が 3 面とも出ている(出ていないと下は空振り)', async () => {
    const { primary, b, c } = await boot();
    for (const [name, el] of [['主', primary], ['b', b], ['c', c]] as const) {
      expect(el.querySelector('.pkc-render-toggle-input'), `${name}: 切替が無い`).not.toBeNull();
      expect(el.querySelector('h1[id]'), `${name}: 見出しの id が無い`).not.toBeNull();
      expect(el.querySelector('a[href^="#"][href*="fn"]'), `${name}: 脚注リンクが無い`).not.toBeNull();
    }
  });

  it('🔴 document の中で id が 1 つも重ならない', async () => {
    await boot();
    const all = idsOf(document);
    expect(all.length, '台の前提:id が十分に在る').toBeGreaterThanOrEqual(9);
    const dup = all.filter((v, i) => all.indexOf(v) !== i);
    expect(dup, '重なっている id').toEqual([]);
  });

  it('🔴 切替の label を押すと、その面のチェックだけが倒れる', async () => {
    const { primary, b, c } = await boot();
    const box = (el: HTMLElement): HTMLInputElement =>
      el.querySelector<HTMLInputElement>('.pkc-render-toggle-input')!;
    // label の指す先は、同じ面の input であること(document 全体で最初の一致ではない)
    for (const el of [b, c, primary]) {
      const label = el.querySelector<HTMLLabelElement>('label.pkc-render-toggle')!;
      expect(label.control, 'label の指す先が同じ面の input でない').toBe(box(el));
    }
    c.querySelector<HTMLLabelElement>('label.pkc-render-toggle')!.click();
    expect(box(c).checked).toBe(true);
    expect(box(b).checked, '別の枠のチェックが倒れた').toBe(false);
    expect(box(primary).checked, '主の面のチェックが倒れた').toBe(false);
  });

  it('🔴 枠の中の脚注リンクは、その枠の脚注を指す', async () => {
    const { b, c } = await boot();
    for (const el of [b, c]) {
      const a = el.querySelector<HTMLAnchorElement>('a[href^="#"][href*="fn"]')!;
      const target = document.getElementById(a.getAttribute('href')!.slice(1));
      expect(target, '脚注リンクの飛び先が無い').not.toBeNull();
      expect(el.contains(target), '飛び先が別の面に在る').toBe(true);
    }
  });

  it('🔴 主の面の id は今までのまま(接頭辞なし)', async () => {
    const { primary } = await boot();
    const plain = idsOf(document.createRange().createContextualFragment(renderMarkdown(BODY)));
    expect(plain.length, '台の前提').toBeGreaterThan(0);
    expect(idsOf(primary).filter((v) => plain.includes(v)).sort()).toEqual([...plain].sort());
    expect(idsOf(primary).some((v) => v.startsWith('frame-'))).toBe(false);
  });

  it('🔴 枠の見出しのリンクコピーには、接頭辞を付けない(受け手は接頭辞を知らない)', async () => {
    const { primary, b } = await boot();
    const copied: string[] = [];
    vi.spyOn(clipboard, 'copyPlainText').mockImplementation((t: string) => {
      copied.push(t);
      return Promise.resolve(true);
    });
    const btn = (el: HTMLElement): HTMLElement =>
      el.querySelector<HTMLElement>('h1 [data-pkc-field="heading-anchor"]')!;
    btn(primary).click();
    btn(b).click();
    expect(copied, '台の前提:2 回コピーされた').toHaveLength(2);
    expect(b.querySelector('h1[id]')!.id, '台の前提:枠の見出しには接頭辞が付いている').toMatch(/^frame-\d+-/);
    expect(copied[1]!.replace('entry:b#', 'entry:a#'), '枠のリンクが主のリンクと lid 以外で違う').toBe(copied[0]);
    expect(copied[1]).not.toContain('frame-');
  });
});

describe('prefixHtmlIds', () => {
  it('id と、それを指す href / for / aria-* を同じ接頭辞で書き直す。本文の字の中の id="…" には触らない', () => {
    const html =
      '<h1 id="a">x</h1><a href="#a">l</a><input id="t"><label for="t">q</label>' +
      '<p aria-labelledby="a t" aria-describedby="a">y</p><a href="https://e/#a">ext</a>' +
      '<code>id=&quot;a&quot;</code>';
    expect(prefixHtmlIds(html, 'P-')).toBe(
      '<h1 id="P-a">x</h1><a href="#P-a">l</a><input id="P-t"><label for="P-t">q</label>' +
        '<p aria-labelledby="P-a P-t" aria-describedby="P-a">y</p><a href="https://e/#a">ext</a>' +
        '<code>id=&quot;a&quot;</code>',
    );
  });
});
