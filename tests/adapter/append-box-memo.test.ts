/** @vitest-environment happy-dom */
/**
 * 🔴 **追記欄は、本文が同じ字なら見出しを拾い直さない**(#1087)。
 *
 * 追記欄は状態が動くたびに描き直す。直す前は、そのたびに本文全体を走査して追記先の見出しを拾っていた
 * (`listAppendTargets` ── 本文を行に割り、frontmatter を読み、行ごとに正規表現を当てる)。
 *
 * ## 守る主張
 * 1. 同じ本文のまま何度描き直しても、見出しの走査は増えない
 * 2. 本文が変われば拾い直し、追記先の一覧も変わる(古い見出しが残らない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { AppendBoxRenderer } from '../../src/adapter/ui/render/append-box';

const scanSpy = vi.fn();
vi.mock('../../src/features/markdown/append-target', async (orig) => {
  const real = await orig<typeof import('../../src/features/markdown/append-target')>();
  return {
    ...real,
    listAppendTargets: (...a: Parameters<typeof real.listAppendTargets>) => {
      scanSpy(...a);
      return real.listAppendTargets(...a);
    },
  };
});

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

beforeEach(() => {
  document.body.textContent = '';
  scanSpy.mockClear();
});

function setup(body: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const box = new AppendBoxRenderer(regions.append);
  d.onState((s) => box.render(s));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  const options = (): string[] =>
    [...root.querySelectorAll<HTMLOptionElement>('[data-pkc-field="append-target"] option')].map(
      (o) => o.textContent ?? '',
    );
  return { root, d, box, options };
}

describe('追記欄の見出しの走査(#1087)', () => {
  it('🔴 同じ本文で何度描き直しても、見出しを拾い直さない', () => {
    const s = setup('# 一章\n本文\n## 二節\n');
    expect(s.options(), '前提: 追記先に見出しが並んでいない').toEqual(expect.arrayContaining(['末尾']));
    expect(s.options().some((t) => t.includes('二節')), '前提: 見出しが拾えていない').toBe(true);
    scanSpy.mockClear();
    for (let i = 0; i < 5; i++) s.box.render(s.d.getState());
    expect(scanSpy).toHaveBeenCalledTimes(0);
  });

  it('🔴 本文が変われば拾い直し、古い見出しは残らない', () => {
    const s = setup('# 一章\n## 二節\n');
    scanSpy.mockClear();
    const st = s.d.getState();
    s.box.render({ ...st, openBody: { ...st.openBody!, body: '# 一章\n## 三節\n' } });
    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(s.options().some((t) => t.includes('三節'))).toBe(true);
    expect(s.options().some((t) => t.includes('二節'))).toBe(false);
  });
});
