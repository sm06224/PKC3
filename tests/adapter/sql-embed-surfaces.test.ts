/** @vitest-environment happy-dom */
/**
 * 🔴 **本文に埋め込んだ SQL(` ```sql embed `)の答えを出す面 / 出さない面**(#1223)。
 *
 * 決まっていること:答えを描くのは**読む面と 2 列の下見だけ**。1 画面編集・添付の説明・章の別
 * ウィンドウ・クリップボードは**原文のコード枠のまま**(表を出さない)。
 *
 * ⚠ 「出る」だけ見ると、**全部の面で出す**実装でも通る ── 出さない面を**同じ本文・同じ道具で**
 *   対にして見る(出る面で引く口が呼ばれ、出さない面では 1 度も呼ばれない)。
 * ⚠ 面は `markdown を描く所` を数え上げた 5 つ(`container-id-render.test.ts` の表)と同じ並び:
 *   ①読む面 ②2 列の下見 ③1 画面編集 ④添付の説明 ⑤章の別ウィンドウ(+ クリップボードは
 *   `tests/features/sql-embed.test.ts`)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { MarkdownClient } from '../../src/adapter/platform/render/markdown-client';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import {
  CHAPTER_BODY_FIELD,
} from '../../src/adapter/platform/chapter-window';
import { ChapterWindows } from '../../src/adapter/ui/chapter-windows';
import {
  setSqlEmbedRunner,
  type SqlEmbedRunner,
} from '../../src/adapter/ui/render/sql-embed-hydrate';
import { SQL_EMBED_ATTR } from '../../src/features/markdown/sql-embed';

const SQL = 'SELECT 7 AS answer';
const BODY = '# 見出し\n\n前の文\n\n```sql embed\n' + SQL + '\n```\n\n後の文\n';

const meta = (lid: string, archetype = 'text'): EntryMeta => ({
  lid,
  title: 't-' + lid,
  archetype,
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

function viewing(body: string, archetype = 'text'): AppState {
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a', archetype)],
    relations: [],
  }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  return reduce(s, { type: 'BODY_LOADED', lid: 'a', body }).state;
}
const editing = (body: string): AppState => reduce(viewing(body), { type: 'START_EDIT' }).state;

const setLive = (on: boolean): void => localStorage.setItem('pkc3.editor-mode', on ? 'live' : 'split');

// ── 観測器(見えるのを手で起こす)
const watchers: FakeIO[] = [];
class FakeIO {
  targets = new Set<Element>();
  constructor(private readonly cb: (e: Array<{ isIntersecting: boolean; target: Element }>) => void) {
    watchers.push(this);
  }
  observe(el: Element): void {
    this.targets.add(el);
  }
  unobserve(el: Element): void {
    this.targets.delete(el);
  }
  disconnect(): void {
    this.targets.clear();
  }
  see(): void {
    this.cb([...this.targets].map((target) => ({ isIntersecting: true, target })));
  }
}
const seeAll = (): void => {
  for (const w of watchers) w.see();
};

const ran = vi.fn();
const runner: SqlEmbedRunner = async (sql, limits) => {
  ran(sql, limits);
  return { columns: ['answer'], rows: [[7]], truncated: false, ms: 0 };
};

let root: HTMLElement;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const detailRenderer = (): DetailRenderer =>
  new DetailRenderer(buildShell(root).detail, null, new MarkdownClient());

beforeEach(() => {
  watchers.length = 0;
  ran.mockClear();
  document.body.textContent = '';
  root = document.createElement('div');
  document.body.append(root);
  vi.stubGlobal('IntersectionObserver', FakeIO);
  setSqlEmbedRunner(runner);
});
afterEach(() => {
  setSqlEmbedRunner(null);
  vi.unstubAllGlobals();
  localStorage.removeItem('pkc3.editor-mode');
});

/** 出さない面の共通の約束: 器は在るが空 / 原文のコード枠は読める / 引く口は 1 度も呼ばれない。 */
async function expectOriginalOnly(scope: Element, face: string): Promise<void> {
  const host = scope.querySelector(`[${SQL_EMBED_ATTR}]`);
  expect(host, `${face}: 器が無い(前提が崩れている ── 描く側が置いていない)`).not.toBeNull();
  seeAll();
  await settle();
  await settle();
  expect(ran, `${face}: 答えを描かない面なのに引いた`).not.toHaveBeenCalled();
  expect(host!.querySelector('table'), `${face}: 表が出た`).toBeNull();
  expect(host!.childElementCount, `${face}: 器に何かが入った`).toBe(0);
  expect(scope.querySelector('pre code.language-sql')!.textContent, `${face}: 原文が読めない`).toContain(
    SQL,
  );
}

describe('① 読む面 ── 答えが出る', () => {
  it('🔴 見えたら引いて、コード枠の下に表が出る(原文のコード枠も残る)', async () => {
    const detail = detailRenderer();
    detail.render(viewing(BODY));
    await settle();
    const body = root.querySelector('[data-pkc-field="detail-body"]')!;
    expect(ran, '見えていないのに引いた').not.toHaveBeenCalled();
    seeAll();
    await vi.waitFor(() => expect(body.querySelector(`[${SQL_EMBED_ATTR}] td`)?.textContent).toBe('7'));
    expect(ran).toHaveBeenCalledTimes(1);
    expect(body.querySelector('pre code.language-sql')!.textContent).toContain(SQL);
    // 答えはコード枠の中(下)に居る ── 枠から離れた所に出ない
    const block = body.querySelector('.pkc-md-block[data-pkc-md-block-kind="code"]')!;
    expect(block.querySelector(`[${SQL_EMBED_ATTR}] table`)).not.toBeNull();
  });

  it('🔴 対照群: 素の ` ```sql ` は引かず、器も無い', async () => {
    const detail = detailRenderer();
    detail.render(viewing('```sql\n' + SQL + '\n```\n'));
    await settle();
    seeAll();
    await settle();
    expect(ran).not.toHaveBeenCalled();
    expect(root.querySelector(`[${SQL_EMBED_ATTR}]`)).toBeNull();
  });

  it('🔴 同じ本文を描き直しても引き直さない', async () => {
    const detail = detailRenderer();
    const s = viewing(BODY);
    detail.render(s);
    await settle();
    seeAll();
    await vi.waitFor(() => expect(root.querySelector(`[${SQL_EMBED_ATTR}] td`)).not.toBeNull());
    detail.invalidate();
    detail.render(s);
    await settle();
    seeAll();
    await settle();
    expect(ran, '同じ本文なのに引き直した').toHaveBeenCalledTimes(1);
  });
});

describe('① 読む面 ── 手放す', () => {
  it('🔴 別のノートへ移ると、前のノートの器の観測を手放す(観測器に死んだ節点を持たせない)', async () => {
    const detail = detailRenderer();
    const s = viewing(BODY);
    detail.render(s);
    await settle();
    expect(watchers, '観測器が作られていない(前提)').toHaveLength(1);
    expect(watchers[0]!.targets.size, '器を観測していない(前提)').toBe(1);
    // 別のノート(器の無い本文)を選ぶ
    let other = reduce(s, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('a'), meta('b')],
      relations: [],
    }).state;
    other = reduce(other, { type: 'SELECT_ENTRY', lid: 'b' }).state;
    other = reduce(other, { type: 'BODY_LOADED', lid: 'b', body: '器の無い本文\n' }).state;
    detail.render(other);
    await settle();
    expect(watchers[0]!.targets.size, '別のノートへ移ったのに観測が残っている').toBe(0);
    seeAll();
    await settle();
    expect(ran, '手放した後に引いた').not.toHaveBeenCalled();
  });
});

describe('① 読む面 ── 開くたびに 1 回引く', () => {
  it('🔴 別のノートを開いたら、本文が同じでも(答えの控えを持ち越さず)開いたときに 1 回引く', async () => {
    const detail = detailRenderer();
    const a = viewing(BODY);
    detail.render(a);
    await settle();
    seeAll();
    await vi.waitFor(() => expect(root.querySelector(`[${SQL_EMBED_ATTR}] td`)).not.toBeNull());
    expect(ran).toHaveBeenCalledTimes(1);
    // 別のノート(本文は同じ字)を開く
    let b = reduce(a, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('a'), meta('b')],
      relations: [],
    }).state;
    b = reduce(b, { type: 'SELECT_ENTRY', lid: 'b' }).state;
    b = reduce(b, { type: 'BODY_LOADED', lid: 'b', body: BODY }).state;
    detail.render(b);
    await settle();
    seeAll();
    await vi.waitFor(() => expect(ran, '別のノートを開いたのに引いていない').toHaveBeenCalledTimes(2));
  });
});

describe('② 2 列の下見 ── 答えが出る', () => {
  it('🔴 書いている最中の下見にも、保存済みの本文を相手にした答えが出る', async () => {
    setLive(false);
    const detail = detailRenderer();
    detail.render(editing(BODY));
    await settle();
    const preview = root.querySelector('[data-pkc-region="editor-preview"]')!;
    expect(preview, '下見が無い').not.toBeNull();
    seeAll();
    await vi.waitFor(() =>
      expect(preview.querySelector(`[${SQL_EMBED_ATTR}] td`)?.textContent).toBe('7'),
    );
    expect(ran).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **下見の答えには「保存したときの結果」を添え、読む面には添えない**(#1254 §1)。
   * 下見は編集に入った時点の保存済みの本文で引くので、打っている最中の SQL の答えではない。
   * ⚠ 対照群は**同じ renderer の読む面** ── 「どの面でも出る」「どの面でも出ない」を別々に殺す。
   */
  it('🔴 下見の答えにだけ「保存したときの結果」が在る(読む面には無い)', async () => {
    setLive(false);
    const detail = detailRenderer();
    detail.render(editing(BODY));
    await settle();
    const preview = root.querySelector('[data-pkc-region="editor-preview"]')!;
    seeAll();
    await vi.waitFor(() =>
      expect(preview.querySelector(`[${SQL_EMBED_ATTR}] td`)?.textContent).toBe('7'),
    );
    const saved = preview.querySelectorAll('[data-pkc-field="sql-embed-saved"]');
    expect(saved, '下見の答えに添え書きが無い').toHaveLength(1);
    expect(saved[0]!.textContent).toBe('保存したときの結果');
    // 答えの表の下(同じ器の中)に居る
    expect(saved[0]!.closest(`[${SQL_EMBED_ATTR}]`)!.querySelector('table')).not.toBeNull();

    // 対照群: 読む面(保存済みを見ている)には添えない
    document.body.textContent = '';
    root = document.createElement('div');
    document.body.append(root);
    const reading = detailRenderer();
    reading.render(viewing(BODY));
    await settle();
    seeAll();
    await vi.waitFor(() => expect(root.querySelector(`[${SQL_EMBED_ATTR}] td`)?.textContent).toBe('7'));
    expect(
      root.querySelector('[data-pkc-field="sql-embed-saved"]'),
      '読む面に「保存したときの結果」が出た',
    ).toBeNull();
  });
});

describe('③ 1 画面編集 ── 原文のコード枠のまま', () => {
  it('🔴 器は在るが空で、引かない', async () => {
    setLive(true);
    const detail = detailRenderer();
    detail.render(editing(BODY));
    await settle();
    const pane = root.querySelector('[data-pkc-region="editor-live"]')!;
    expect(pane, '1 画面編集の面が無い').not.toBeNull();
    // ⚠ 退避先(原文の入力欄)に落ちているときは主題を見ていない
    expect(pane.querySelector('textarea')).toBeNull();
    await expectOriginalOnly(pane, '1 画面編集');
  });
});

describe('④ 添付の説明 ── 原文のコード枠のまま', () => {
  it('🔴 器は在るが空で、引かない', async () => {
    const body =
      '---\nattachment.name: a.bin\nattachment.mime: application/octet-stream\n---\n' + BODY;
    const detail = detailRenderer();
    detail.render(viewing(body, 'attachment'));
    await settle();
    const desc = root.querySelector('.pkc-md-rendered[data-pkc-field="detail-body"]');
    expect(desc, '説明の面が無い').not.toBeNull();
    await expectOriginalOnly(desc!, '添付の説明');
  });
});

describe('⑤ 章の別ウィンドウ ── 原文のコード枠のまま', () => {
  const CHAPTER_BODY = '# 一\n\nいち\n\n## 二\n\n```sql embed\n' + SQL + '\n```\n';

  function fakeWindow(): Window {
    return {
      document: document.implementation.createHTMLDocument(''),
      closed: false,
      focus: vi.fn(),
      close(): void {},
      addEventListener(): void {},
      removeEventListener(): void {},
    } as unknown as Window;
  }

  it('🔴 窓の中に器は在るが空で、引かない', async () => {
    vi.useFakeTimers();
    try {
      const win = fakeWindow();
      let state = viewing(CHAPTER_BODY);
      const cw = new ChapterWindows({
        getState: () => state,
        getBody: async () => CHAPTER_BODY,
        render: async (t, o) => renderMarkdown(t, o),
        allowExternalImages: () => false,
        lend: async (key) => ({ url: `blob:${key}`, dispose: () => undefined }),
        getBlob: async () => null,
        runAction: vi.fn(),
        fail: () => undefined,
        open: () => win,
        // ⚠ `hydrateFigures` を差さない ── 本物(図・グラフ・数式)が章の窓で何をするかを見る
      });
      state = { ...state };
      expect(cw.open('a', 2)).toBe(true);
      await vi.advanceTimersByTimeAsync(400);
      const host = win.document.querySelector(`[data-pkc-field="${CHAPTER_BODY_FIELD}"]`)!;
      expect(host, '章の窓の本文が無い').not.toBeNull();
      expect(host.querySelector(`[${SQL_EMBED_ATTR}]`), '器が無い(前提が崩れている)').not.toBeNull();
      seeAll();
      await vi.advanceTimersByTimeAsync(100);
      expect(ran, '章の窓で引いた').not.toHaveBeenCalled();
      expect(host.querySelector(`[${SQL_EMBED_ATTR}] table`)).toBeNull();
      expect(host.querySelector('pre code.language-sql')!.textContent).toContain(SQL);
    } finally {
      vi.useRealTimers();
    }
  });
});
