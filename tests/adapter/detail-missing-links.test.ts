/** @vitest-environment happy-dom */
/**
 * 🔴 **無いノートへのリンクの印は、ゴミ箱の出し入れに追随する**(#1174 段①)。
 *
 * ⚠ 本文の指紋は `entryMetas` を含まない(含めると出し入れのたびに本文を描き直す)ので、
 *   戻したときに印が消えるかは **`render()` の頭の「参照が変わったら印だけ当て直す」**
 *   にかかっている。下の 3 本はその 3 方向(付く / 戻して消える / また付く)と、
 *   **描き直していないこと**(同じ節点)を見る。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { appMissingLinks } from '../../src/adapter/ui/render/missing-links';
import { MISSING_ATTR } from '../../src/adapter/ui/render/link-missing';

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

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const BODY = '[行き先](entry:b)\n\n[別の PKC](pkc://other-cid/entry/zz)';

function base(): AppState {
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a')],
    relations: [],
  }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: BODY }).state;
  return s;
}

const withMetas = (s: AppState, lids: string[]): AppState => ({
  ...s,
  entryMetas: new Map(lids.map((l) => [l, meta(l)])),
});

function link(root: HTMLElement): HTMLElement {
  const el = root.querySelector<HTMLElement>('[data-pkc-entry-ref="entry:b"]');
  expect(el, 'リンクが描かれていない(前提)').not.toBeNull();
  return el!;
}

afterEach(() => appMissingLinks.setEnabled(true));

describe('detail: 無いノートへのリンクの点線(#1174 段①)', () => {
  it('🔴 無いノートへのリンクに付き、戻すと(描き直さずに)消え、また消すと付く', async () => {
    const root = document.createElement('div');
    const detail = new DetailRenderer(buildShell(root).detail);
    const s0 = base();
    detail.render(s0);
    await settle();
    const a = link(root);
    expect(a.hasAttribute(MISSING_ATTR), 'b が無いのに印が付いていない').toBe(true);

    // ゴミ箱から戻した = entryMetas に b が増える(本文の指紋は同じ)
    detail.render(withMetas(s0, ['a', 'b']));
    expect(link(root), '戻しただけで本文が描き直されている').toBe(a);
    expect(a.hasAttribute(MISSING_ATTR), '戻したのに印が残っている').toBe(false);

    // 対照群 ── また b が無くなれば付く(「一度外したら二度と付かない」ではない)
    detail.render(withMetas(s0, ['a']));
    expect(link(root)).toBe(a);
    expect(a.hasAttribute(MISSING_ATTR)).toBe(true);
  });

  it('🔴 別の PKC を指すリンクには付かない(同じ描画の中の対照群)', async () => {
    const root = document.createElement('div');
    const detail = new DetailRenderer(buildShell(root).detail);
    detail.render(base());
    await settle();
    expect(root.querySelectorAll(`[${MISSING_ATTR}]`).length).toBe(1);
  });

  it('🔴 設定が切なら付かない ── 切り替えた直後の描き直しで、前の印も外れる', async () => {
    const root = document.createElement('div');
    const detail = new DetailRenderer(buildShell(root).detail);
    const s0 = base();
    detail.render(s0);
    await settle();
    expect(root.querySelectorAll(`[${MISSING_ATTR}]`).length).toBe(1);

    appMissingLinks.setEnabled(false);
    detail.invalidate();
    detail.render(s0);
    await settle();
    expect(root.querySelectorAll(`[${MISSING_ATTR}]`).length, '切なのに印が残っている').toBe(0);
  });
});
