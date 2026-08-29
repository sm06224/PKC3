/** @vitest-environment happy-dom */
/**
 * 🔴 **本文の中に書いたタグを、どの見出しで付いたかと一緒に出す**(#550)。
 *
 * > user 要望 2026-08-29:「**ユーザーがどの見出しや記事でタグがついたのか
 * > わかりやすくすべき**」
 *
 * ## ⚠ ここが「札の隣で嘘をつく」場所だった
 *
 * 上の「タグ」の行は **frontmatter だけ**を出すので、本文に `#買い物` と書いて
 * **札が出ているノート**でも、右の列は「**無し**」と言っていた
 * (2026-08-29 の着地後レビューで確定)。
 *
 * ## 🔴 守る主張
 *
 * 1. 本文に書いたタグが**別の行**に出る(文書タグと混ぜない ── user 要件)
 * 2. 🔴 **どの見出しの下に書いたか**が出る
 * 3. 🔴 **0 件なら行ごと畳む**(`<dt>` も一緒に ── 見出しだけ残さない)
 * 4. ⚠ **「外す」は出さない** ── 外す口は frontmatter しか触らないので、
 *    付けると「0 件に外しました」という嘘の帯が出る
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { appPanes, applyPaneVisibility } from '../../src/adapter/ui/render/pane-visibility';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

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
});

function setup(body: string | null): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const inspector = new InspectorRenderer(regions.inspector);
  d.onState((s) => inspector.render(s));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  if (body !== null) d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  return root;
}

const chips = (root: HTMLElement): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('[data-pkc-field="inspector-body-tag"]'),
];
const row = (root: HTMLElement): HTMLElement =>
  root.querySelector<HTMLElement>('[data-pkc-field="inspector-body-tags"]')!;
const docChips = (root: HTMLElement): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('[data-pkc-field="inspector-tag"]'),
];

describe('本文の中のタグを情報ペインに出す(#550)', () => {
  const BODY = ['# 買い物メモ', '', '#買い物 #家事', '', '## 週末', '', '#週末', '', '本文'].join(
    '\n',
  );

  it('🔴 本文に書いたタグが出る(札の隣で「無し」と言わない)', () => {
    const root = setup(BODY);
    expect(
      chips(root).map((c) => c.getAttribute('data-pkc-tag')),
      '本文のタグが 1 つも出ていない',
    ).toEqual(['買い物', '家事', '週末']);
  });

  it('🔴 どの見出しの下に書いたかが出る(user 要件の当のもの)', () => {
    const root = setup(BODY);
    const where = chips(root).map(
      (c) => c.querySelector('[data-pkc-field="inspector-body-tag-where"]')?.textContent,
    );
    expect(where, '書いた場所が出ていない').toEqual([
      '(買い物メモ)',
      '(買い物メモ)',
      '(買い物メモ › 週末)',
    ]);
  });

  it('⚠ 見出しの外に書いたものは「見出しの外」と言う(空欄にしない)', () => {
    const root = setup('#買い物\n\n# 章\n');
    expect(
      chips(root)[0]?.querySelector('[data-pkc-field="inspector-body-tag-where"]')?.textContent,
      '場所が採れなかったのか見出しが無いのかが読めない',
    ).toBe('(見出しの外)');
  });

  it('⚠ 同じタグを何度書いても、場所は畳んで 1 つの札に出す', () => {
    const root = setup('# 章\n\n#請求\n\n#請求\n');
    expect(chips(root)).toHaveLength(1);
    expect(
      chips(root)[0]?.querySelector('[data-pkc-field="inspector-body-tag-where"]')?.textContent,
    ).toBe('(章)');
  });

  it('🔴 1 つも無ければ行ごと畳む(見出しだけ残さない)', () => {
    const root = setup('# 章\n\nただの本文\n');
    const dd = row(root);
    expect(dd.hidden, '空の行が出ている').toBe(true);
    expect((dd.previousElementSibling as HTMLElement).hidden, '見出しだけ残っている').toBe(true);
  });

  it('⚠ 本文が読めていないときも出さない(知らないことを「無し」と言わない)', () => {
    const root = setup(null);
    expect(row(root).hidden, '本文を読んでいないのに行が出ている').toBe(true);
  });

  it('🔴 「外す」は付けない(外す口は frontmatter しか触らないので嘘になる)', () => {
    const root = setup(BODY);
    for (const c of chips(root)) {
      expect(
        c.querySelector('[data-pkc-action="untag-entry"]'),
        '本文のタグに「外す」が付いている(押すと「0 件に外しました」と嘘が出る)',
      ).toBeNull();
    }
  });

  it('🔑 押すとそのタグで探せる(名前は押せる)', () => {
    const root = setup(BODY);
    const find = chips(root)[0]?.querySelector<HTMLElement>(
      '[data-pkc-action="filter-by-tag"]',
    );
    expect(find, '名前が押せない').not.toBeNull();
    expect(find?.getAttribute('data-pkc-tag')).toBe('買い物');
  });

  it('🔴 対照群: 文書タグ(frontmatter)は今までどおり別の行に出る', () => {
    const root = setup('---\ntags: [設計]\n---\n\n# 章\n\n#買い物\n');
    expect(
      docChips(root).map((c) => c.getAttribute('data-pkc-tag')),
      '文書タグの行が壊れている',
    ).toEqual(['設計']);
    expect(
      chips(root).map((c) => c.getAttribute('data-pkc-tag')),
      '本文のタグの行が壊れている',
    ).toEqual(['買い物']);
  });
});

/**
 * 🔴 **押した結果が見える所を開く**(2026-08-29 の動線レビュー)。
 *
 * ⚠ 左の列を畳んでいると、絞り込みは効いているのに**画面が 1 ドットも動かない** ──
 *   user から見れば**無言の dead click** である。
 */
describe('タグの札を押したときに、結果が見える(#550)', () => {
  function withBinder(hidden: readonly ('sidebar' | 'inspector' | 'append')[]): {
    root: HTMLElement;
    d: Dispatcher;
  } {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const inspector = new InspectorRenderer(regions.inspector);
    d.onState((s) => inspector.render(s));
    bindActions(root, d);
    applyPaneVisibility(root, appPanes.setHidden(hidden));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '# 章\n\n#買い物\n' });
    return { root, d };
  }

  it('🔴 左の列を畳んでいたら、押したときに開く(無言の dead click を作らない)', () => {
    const { root, d } = withBinder(['sidebar']);
    // ⚠ **前提** ── 本当に畳んでいる(前提が崩れると、この検査は何も見ていない)
    expect(appPanes.getHidden(), '前提が崩れている(畳めていない)').toContain('sidebar');
    chips(root)[0]!
      .querySelector<HTMLElement>('[data-pkc-action="filter-by-tag"]')!
      .click();
    expect(appPanes.getHidden(), '押しても左の列が畳まれたまま(結果が見えない)').not.toContain(
      'sidebar',
    );
    // ⚠ 絞り込み自体も効いている(開くだけになっていない)
    expect(d.getState().filterQuery).toBe('買い物');
    appPanes.setHidden([]);
  });

  it('⚠ 対照群: 開いているときは勝手に畳まない', () => {
    const { root } = withBinder([]);
    chips(root)[0]!
      .querySelector<HTMLElement>('[data-pkc-action="filter-by-tag"]')!
      .click();
    expect(appPanes.getHidden(), '開いていたのに触った').toEqual([]);
  });
});

/**
 * 🔴 **見えている字と、起きることを一致させる**(2026-08-29 の動線レビュー)。
 *
 * ⚠ 押すと**その語で一覧を絞る**(題名と本文を見る)ので、「が付いたノートを探す」は
 *   嘘になる ── タグの無いノートも混ざる。
 */
describe('札の説明が実態と合っている(#550)', () => {
  it('🔴 「が付いたノートを探す」と言わない(実際は語で絞る)', () => {
    const html = renderMarkdown('#買い物\n', { interactiveTags: true });
    expect(html, '起きないことを書いている').not.toContain('が付いたノートを探す');
    expect(html, '説明が無い').toContain('を含むノートを探します');
  });

  it('🔑 情報ペインと同じ字である(呼び名を 2 つ作らない)', () => {
    const root = setup('# 章\n\n#買い物\n');
    const inspectorTitle = chips(root)[0]!
      .querySelector<HTMLElement>('[data-pkc-action="filter-by-tag"]')!
      .getAttribute('title');
    const html = renderMarkdown('#買い物\n', { interactiveTags: true });
    expect(inspectorTitle, '情報ペイン側の字が違う').toBe('「買い物」を含むノートを探します');
    expect(html, '本文の札と情報ペインで字が違う').toContain(inspectorTitle!);
  });
});
