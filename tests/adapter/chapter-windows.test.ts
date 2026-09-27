/** @vitest-environment happy-dom */
/**
 * 🔴 **章の別ウィンドウの判断と追従**(#1044 段4)── `adapter/ui/chapter-windows.ts`。
 *
 * 守る主張(設計 doc §10):
 * 1. 🔴 窓に出るのは**押した見出しの章だけ**で、押して書く口が 1 つも無い
 * 2. 🔴 本文が書き換わったら組み直す(本体で開いていれば本体の本文、無ければ保存先から)
 * 3. 🔴 全文編集の打ちかけは映さない
 * 4. 章を見失ったら「見つかりません」/ ノートが消えたら「もうありません」
 * 5. 🔴 窓を閉じたら借りた添付を返す / F5 で白くなったら組み直す
 * 6. 開けなかったら理由を出し、台帳に残さない
 *
 * ⚠ 描画は**本物**(`renderMarkdown`)を使う ── 章の塊は `data-pkc-source-line` で拾うので、
 *   手組みの HTML では「刻印の付け方が変わった日」に test だけ通る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import {
  CHAPTER_BODY_FIELD,
  CHAPTER_BUILT_ATTR,
  CHAPTER_NOTE_FIELD,
  CHAPTER_ORPHAN_FIELD,
  CHAPTER_WINDOW_ACTIONS,
  CHAPTER_WINDOW_TEXT,
} from '../../src/adapter/platform/chapter-window';
import {
  CHAPTER_HEADING_UNREADABLE,
  CHAPTER_WINDOW_BLOCKED,
  ChapterWindows,
  chapterBlocks,
} from '../../src/adapter/ui/chapter-windows';
import { chapterLinesOf, headingRefAt } from '../../src/features/markdown/append-target';

const BODY = [
  '---',
  'tags: [x]',
  '---',
  '# 一',
  '',
  'いちの中身',
  '',
  '## 二',
  '',
  'にの中身',
  '',
  '- [ ] 買う',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '![絵](asset:ast-1)',
  '',
  '# 三',
  '',
  'さんの中身',
].join('\n');

/** 剥がした本文で「## 二」が居る行。 */
const LINE_TWO = 4;

/** ⚠ **状態が読む形(camel)で組む** ── snake で組むと保存の時刻が常に空になり、
 *  「時刻が変わったら読み直す」を 1 度も通らない(1 稿目で踏んだ)。 */
function meta(lid: string, title: string, updated: string | null = null): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: updated,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

function booted(body: string, updated: string | null = null): AppState {
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('n1', 'ノート', updated), meta('n2', 'ほか')],
    relations: [],
  }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: 'n1', body }).state;
  return s;
}

function fakeWindow(): Window & { closed: boolean } {
  const win = {
    document: document.implementation.createHTMLDocument(''),
    closed: false,
    focus: vi.fn(),
    close(): void {
      win.closed = true;
    },
  };
  return win as unknown as Window & { closed: boolean };
}

function setup(opts: { body?: string; open?: 'null' } = {}) {
  let state = booted(opts.body ?? BODY);
  const win = fakeWindow();
  const failed: string[] = [];
  const disposed: string[] = [];
  const getBody = vi.fn(async (lid: string): Promise<string | null> => (lid === '' ? null : (opts.body ?? BODY)));
  let renderGate: Promise<void> | null = null;
  const cw = new ChapterWindows({
    getState: () => state,
    getBody,
    render: async (t, o) => {
      if (renderGate !== null) await renderGate;
      return renderMarkdown(t, o);
    },
    allowExternalImages: () => false,
    lend: async (key) => ({ url: `blob:${key}`, dispose: () => disposed.push(key) }),
    getBlob: async () => null,
    runAction: vi.fn(),
    fail: (m) => failed.push(m),
    open: opts.open === 'null' ? () => null : () => win,
    hydrateFigures: () => [],
  });
  return {
    cw,
    win,
    failed,
    disposed,
    getBody,
    get state(): AppState {
      return state;
    },
    set state(s: AppState) {
      state = s;
    },
    gate(p: Promise<void> | null): void {
      renderGate = p;
    },
    host: (): HTMLElement | null =>
      win.document.querySelector<HTMLElement>(`[data-pkc-field="${CHAPTER_BODY_FIELD}"]`),
    note: (): string | null =>
      win.document.querySelector(`[data-pkc-field="${CHAPTER_NOTE_FIELD}"]`)?.textContent ?? null,
  };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(400);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('🔴 押した見出しの章だけを、読むだけで出す', () => {
  it('🔴 章の中身だけが出て、前後の章は出ない', async () => {
    const r = setup();
    expect(r.cw.open('n1', LINE_TWO)).toBe(true);
    await flush();
    const text = r.host()?.textContent ?? '';
    expect(text).toContain('にの中身');
    expect(text, '前の章が混ざった').not.toContain('いちの中身');
    expect(text, '次の章が混ざった').not.toContain('さんの中身');
    expect(r.win.document.title).toBe('ノート › 二');
  });

  it('🔴 押して書く口が 1 つも無い(チェック・表のセル・コード枠の ✎・⧉)', async () => {
    const r = setup();
    r.cw.open('n1', LINE_TWO);
    await flush();
    const host = r.host()!;
    // ⚠ 空振り防止 ── 書く口が出うる物(チェック・表・コード枠)が章の中に在る
    expect(host.querySelector('input[type="checkbox"]'), '前提が崩れている(チェックが無い)').not.toBeNull();
    expect(host.querySelector('table'), '前提が崩れている(表が無い)').not.toBeNull();
    expect(host.querySelector('pre'), '前提が崩れている(コード枠が無い)').not.toBeNull();
    for (const el of Array.from(r.win.document.querySelectorAll('[data-pkc-action]'))) {
      expect(
        CHAPTER_WINDOW_ACTIONS.has(el.getAttribute('data-pkc-action') ?? ''),
        `書く口が残っている: ${el.getAttribute('data-pkc-action')}`,
      ).toBe(true);
    }
    const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.disabled, 'チェックが押せる形で出た').toBe(true);
  });

  it('🔴 添付の画像は窓ごとに借り、組み直したら前の分を返す', async () => {
    const r = setup();
    r.cw.open('n1', LINE_TWO);
    await flush();
    const img = r.host()!.querySelector<HTMLImageElement>('img[data-pkc-asset-key]');
    expect(img?.getAttribute('src')).toBe('blob:ast-1');
    expect(r.disposed).toEqual([]);
    // 組み直す(本文が変わった)
    r.state = { ...r.state, openBody: { ...r.state.openBody!, body: BODY.replace('にの中身', 'にの新しい中身') } };
    r.cw.onState(r.state);
    await flush();
    expect(r.disposed, '組み直したのに前の画像を返していない').toEqual(['ast-1']);
  });

  it('⚠ 見出しの無い行で押されたら理由を出し、窓を開かない', () => {
    const r = setup({ body: 'ただの本文\n\n# 後の見出し' });
    expect(r.cw.open('n1', 0)).toBe(false);
    expect(r.failed).toEqual([CHAPTER_HEADING_UNREADABLE]);
    expect(r.cw.size).toBe(0);
  });

  it('🔴 窓が開けなかったら理由を出し、台帳に残さない', () => {
    const r = setup({ open: 'null' });
    expect(r.cw.open('n1', LINE_TWO)).toBe(false);
    expect(r.failed).toEqual([CHAPTER_WINDOW_BLOCKED]);
    expect(r.cw.size).toBe(0);
  });
});

describe('🔴 追従 ── 書き換わったら組み直す', () => {
  it('🔴 本体で開いている本文が変わったら、その本文で組み直す(保存先を読まない)', async () => {
    const r = setup();
    r.cw.open('n1', LINE_TWO);
    await flush();
    r.getBody.mockClear();
    r.state = { ...r.state, openBody: { ...r.state.openBody!, body: BODY.replace('にの中身', 'にを直した') } };
    r.cw.onState(r.state);
    await flush();
    expect(r.host()?.textContent).toContain('にを直した');
    expect(r.getBody, '本体に在る本文を保存先から読み直した').not.toHaveBeenCalled();
  });

  it('🔴 本体で開いていないノートは、保存の時刻が変わったら保存先から読み直す', async () => {
    const r = setup();
    r.cw.open('n1', LINE_TWO);
    await flush();
    // 本体は別のノートへ移った
    r.state = reduce(r.state, { type: 'SELECT_ENTRY', lid: 'n2' }).state;
    r.cw.onState(r.state);
    await flush();
    r.getBody.mockClear();
    r.getBody.mockResolvedValue(BODY.replace('にの中身', '別のタブで直した'));
    // 別のタブが書いた ── 読み直しで保存の時刻が変わる(`SYS_BOOTED`)
    r.state = booted(BODY, '2026-09-27T00:00:00Z');
    r.state = reduce(r.state, { type: 'SELECT_ENTRY', lid: 'n2' }).state;
    r.cw.onState(r.state);
    await flush();
    expect(r.getBody).toHaveBeenCalledWith('n1');
    expect(r.host()?.textContent).toContain('別のタブで直した');
  });

  it('🔴 全文編集の打ちかけは映さない', async () => {
    const r = setup();
    r.cw.open('n1', LINE_TWO);
    await flush();
    r.getBody.mockClear();
    r.state = {
      ...r.state,
      phase: 'editing',
      openBody: { ...r.state.openBody!, body: BODY.replace('にの中身', '打ちかけ') },
    };
    r.cw.onState(r.state);
    await flush();
    expect(r.host()?.textContent, '保存していない打ちかけを窓に出した').not.toContain('打ちかけ');
  });

  it('⚠ 見出しの字が変わったら「見つかりません」、ノートが消えたら「もうありません」', async () => {
    const r = setup();
    r.cw.open('n1', LINE_TWO);
    await flush();
    r.state = { ...r.state, openBody: { ...r.state.openBody!, body: BODY.replace('## 二', '## 弐') } };
    r.cw.onState(r.state);
    await flush();
    expect(r.note()).toBe(CHAPTER_WINDOW_TEXT.missing);
    expect(r.host()).toBeNull();
    const metas = new Map(r.state.entryMetas);
    metas.delete('n1');
    r.state = { ...r.state, entryMetas: metas, openBody: null };
    r.cw.onState(r.state);
    await flush();
    expect(r.note()).toBe(CHAPTER_WINDOW_TEXT.gone);
  });

  it('🔴 遅れて返った古い描画は当てない', async () => {
    const r = setup();
    let release!: () => void;
    r.gate(new Promise<void>((res) => (release = res)));
    r.cw.open('n1', LINE_TWO);
    // 1 本目が止まっている間に、本文が変わって 2 本目が走る
    r.gate(null);
    r.state = { ...r.state, openBody: { ...r.state.openBody!, body: BODY.replace('にの中身', '新しい方') } };
    r.cw.onState(r.state);
    await flush();
    release();
    await flush();
    expect(r.host()?.textContent, '古い描画が新しい中身を上書きした').toContain('新しい方');
  });
});

describe('🔴 寿命 ── 閉じる / F5 / 元のウィンドウが閉じる', () => {
  it('🔴 窓を閉じたら借りた添付を返し、台帳から外し、見張りを止める', async () => {
    const r = setup();
    r.cw.open('n1', LINE_TWO);
    await flush();
    r.win.closed = true;
    r.cw.tick();
    expect(r.disposed).toEqual(['ast-1']);
    expect(r.cw.size).toBe(0);
    expect(vi.getTimerCount(), '見張りが止まっていない(常駐する)').toBe(0);
  });

  it('🔴 F5 で白くなったら、組み直す', async () => {
    const r = setup();
    r.cw.open('n1', LINE_TWO);
    await flush();
    // F5 = 窓の document が新しい白紙に替わる
    (r.win as unknown as { document: Document }).document = document.implementation.createHTMLDocument('');
    expect(r.win.document.body.hasAttribute(CHAPTER_BUILT_ATTR)).toBe(false);
    r.cw.tick();
    await flush();
    expect(r.host()?.textContent, 'F5 の後に組み直していない').toContain('にの中身');
  });

  it('⚠ 元のウィンドウが閉じたら、窓に一文を出す', async () => {
    const r = setup();
    r.cw.open('n1', LINE_TWO);
    await flush();
    r.cw.orphanAll();
    expect(r.win.document.querySelector(`[data-pkc-field="${CHAPTER_ORPHAN_FIELD}"]`)?.textContent).toBe(
      CHAPTER_WINDOW_TEXT.orphan,
    );
  });

  it('🔴 同じ章をもう一度開くと、同じ窓をいまの本文で組み直す', async () => {
    const r = setup();
    r.cw.open('n1', LINE_TWO);
    await flush();
    r.state = { ...r.state, openBody: { ...r.state.openBody!, body: BODY.replace('にの中身', '二度目') } };
    r.cw.open('n1', LINE_TWO);
    await flush();
    expect(r.cw.size).toBe(1);
    expect(r.host()?.textContent).toContain('二度目');
  });
});

describe('脚注', () => {
  it('🔴 章から参照している脚注だけを、元の番号のまま持って行く', () => {
    const body = ['# 一', '', 'あ[^1]', '', '# 二', '', 'い[^2]', '', '[^1]: 一つ目', '[^2]: 二つ目'].join('\n');
    const lines = chapterLinesOf(body, headingRefAt(body, 4)!)!;
    const html = renderMarkdown(body, { sourceLineAnchors: true });
    const box = document.createElement('div');
    box.append(...chapterBlocks(html, lines));
    const items = Array.from(box.querySelectorAll('section.footnotes li'));
    expect(items.map((li) => li.id)).toEqual(['fn2']);
    expect(items[0]?.getAttribute('value'), '番号が 1 に振り直された').toBe('2');
    expect(box.textContent).not.toContain('一つ目');
  });
});
