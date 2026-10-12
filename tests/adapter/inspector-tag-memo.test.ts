/** @vitest-environment happy-dom */
/**
 * 🔴 **タグの走査を、本文の字が同じなら繰り返さない**(#1087)。
 *
 * 情報ペインは状態が動くたびに描き直す。「タグ」の行・本文中タグの行・候補の除外・書けるかの判定が、
 * そのたびに本文を `readTags` ×2 / `collectEntryTags`(= `readTags` + `scanBodyTags`)/
 * `frontmatterProblem` で走査し直していた。`imgCount` / `taskCount` / `toc` と同じく、
 * 本文の字を鍵に 1 つ憶える。
 *
 * ## 🔴 守る主張
 * 1. 同じ本文で描き直しても、走査は 1 回で済む
 * 2. 本文が変われば走査し直す(古い札が残らない)
 * 3. 画面に出る物は憶える前と同じ(frontmatter のタグ / 本文中のタグ / 無し / 壊れた frontmatter)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';

/**
 * 走査の回数を数える。namespace の export は差し替えられないので module ごと包む(実体はそのまま呼ぶ)。
 * ⚠ `collectEntryTags` の中の `readTags` / `scanBodyTags` は **他の module の export** なので、ここで数えられる。
 */
const scanSpy = vi.fn();
const readSpy = vi.fn();
const problemSpy = vi.fn();
vi.mock('../../src/features/flavor/body-tags', async (orig) => {
  const real = await orig<typeof import('../../src/features/flavor/body-tags')>();
  return {
    ...real,
    scanBodyTags: (...a: Parameters<typeof real.scanBodyTags>) => {
      scanSpy(...a);
      return real.scanBodyTags(...a);
    },
  };
});
vi.mock('../../src/features/flavor/tags', async (orig) => {
  const real = await orig<typeof import('../../src/features/flavor/tags')>();
  return {
    ...real,
    readTags: (...a: Parameters<typeof real.readTags>) => {
      readSpy(...a);
      return real.readTags(...a);
    },
  };
});
vi.mock('../../src/features/markdown/frontmatter', async (orig) => {
  const real = await orig<typeof import('../../src/features/markdown/frontmatter')>();
  return {
    ...real,
    frontmatterProblem: (...a: Parameters<typeof real.frontmatterProblem>) => {
      problemSpy(...a);
      return real.frontmatterProblem(...a);
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
  readSpy.mockClear();
  problemSpy.mockClear();
});

function setup(body: string | null) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const inspector = new InspectorRenderer(regions.inspector);
  d.onState((s) => inspector.render(s));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  if (body !== null) d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  /** 同じ本文のまま描き直す(保存の ack や選択の変化で、この面は何度も描き直される)。 */
  const rerender = () => inspector.render(d.getState());
  return { root, d, rerender, inspector };
}

const docTags = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('[data-pkc-field="inspector-tag"]')].map(
    (c) => c.getAttribute('data-pkc-tag') ?? '',
  );
const bodyTags = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('[data-pkc-field="inspector-body-tag"]')].map(
    (c) => c.getAttribute('data-pkc-tag') ?? '',
  );
const tagRowText = (root: HTMLElement): string =>
  root.querySelector('[data-pkc-field="inspector-tags"]')?.textContent ?? '';

describe('タグの走査は本文の字が同じなら 1 回(#1087)', () => {
  const BODY = '---\ntags: [買い物]\n---\n# 章\n\n#家事\n';

  /**
   * 本文だけ差し替えた状態で情報ペインを直に描く ── reducer(`BODY_LOADED` もタグを集める)を
   * 通さないので、数えるのは情報ペインの走査だけになる。
   */
  function withBody(s: ReturnType<typeof setup>, body: string) {
    const st = s.d.getState();
    return { ...st, openBody: { ...st.openBody!, body } };
  }

  it('🔴 同じ本文で何度描き直しても、走査は 1 回', () => {
    const s = setup(BODY);
    const other = withBody(s, BODY + '\n#別');
    scanSpy.mockClear();
    readSpy.mockClear();
    problemSpy.mockClear();
    s.inspector.render(other);
    expect(scanSpy.mock.calls.length, '本文中タグの走査が 1 回でない').toBe(1);
    expect(readSpy.mock.calls.length, '文書タグの読みが 1 回でない').toBe(1);
    expect(problemSpy.mock.calls.length, 'frontmatter の検めが 1 回でない').toBe(1);
    s.inspector.render(other);
    s.inspector.render(other);
    s.inspector.render(other);
    expect(scanSpy.mock.calls.length, '描き直しのたびに本文中タグを走査し直している').toBe(1);
    expect(readSpy.mock.calls.length, '描き直しのたびに文書タグを読み直している').toBe(1);
    expect(problemSpy.mock.calls.length, '描き直しのたびに frontmatter を検め直している').toBe(1);
  });

  it('🔴 本文が変われば走査し直す(古い札が残らない)', () => {
    const s = setup(BODY);
    expect(docTags(s.root)).toEqual(['買い物']);
    expect(bodyTags(s.root)).toEqual(['家事']);
    scanSpy.mockClear();
    s.inspector.render(withBody(s, '---\ntags: [仕事]\n---\n#会議\n'));
    expect(scanSpy.mock.calls.length, '本文が変わったのに走査し直していない').toBe(1);
    expect(docTags(s.root), '古い文書タグが残っている').toEqual(['仕事']);
    expect(bodyTags(s.root), '古い本文中タグが残っている').toEqual(['会議']);
  });

  it('⚠ 本文が読めなくなったら手放す(戻ってきたら走査し直す)', () => {
    const s = setup(BODY);
    const back = withBody(s, BODY);
    s.inspector.render({ ...s.d.getState(), openBody: null });
    scanSpy.mockClear();
    s.inspector.render(back);
    expect(scanSpy.mock.calls.length, '手放していない(本文を常駐させている)').toBe(1);
    expect(docTags(s.root)).toEqual(['買い物']);
  });
});

describe('憶えても、画面に出る物は変わらない(#1087)', () => {
  const cases: Array<{
    name: string;
    body: string;
    doc: string[];
    inBody: string[];
    row?: string;
  }> = [
    {
      name: 'frontmatter のタグ',
      body: '---\ntags: [買い物, 家事]\n---\n本文\n',
      doc: ['買い物', '家事'],
      inBody: [],
    },
    {
      name: '本文中のタグ',
      body: '# 章\n\n#請求 #請求\n',
      doc: [],
      inBody: ['請求'],
      row: '無し',
    },
    { name: 'タグ無し', body: 'ただの本文\n', doc: [], inBody: [], row: '無し' },
    {
      name: '両方',
      body: '---\ntags: [仕事]\n---\n#会議\n',
      doc: ['仕事'],
      inBody: ['会議'],
    },
  ];

  for (const c of cases) {
    it(`${c.name}: 初回も描き直しも同じ`, () => {
      const { root, rerender } = setup(c.body);
      const first = root.innerHTML;
      expect(docTags(root)).toEqual(c.doc);
      expect(bodyTags(root)).toEqual(c.inBody);
      if (c.row !== undefined) expect(tagRowText(root)).toContain(c.row);
      rerender();
      expect(root.innerHTML, '描き直しで見た目が変わった').toBe(first);
    });
  }

  it('🔴 閉じを失った frontmatter は「無し」と言わず、打つ欄も畳む(#284 / #494)', () => {
    const { root, rerender } = setup('---\ntags: [買い物]\n本文\n');
    const text = tagRowText(root);
    expect(text, '読めていないのに「無し」と断定している').not.toContain('無し');
    expect(
      root.querySelector<HTMLElement>('[data-pkc-field="tag-add"]')?.hidden,
      '書けない本文に打つ欄が出ている',
    ).toBe(true);
    rerender();
    expect(tagRowText(root)).toBe(text);
  });
});
