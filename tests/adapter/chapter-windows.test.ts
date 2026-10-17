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
import { HTML_SANDBOX_BLOCKED_MSG_TYPE } from '../../src/features/markdown/external-images';
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

/** 別の document を持つ偽の窓。⚠ `message` の受け手を付け外しできる(html の囲みの高さ合わせ)。 */
function fakeWindow(): Window & {
  closed: boolean;
  listeners: () => number;
  emit: (data: unknown, source: unknown) => void;
} {
  const target = new EventTarget();
  let n = 0;
  const win = {
    document: document.implementation.createHTMLDocument(''),
    closed: false,
    focus: vi.fn(),
    close(): void {
      win.closed = true;
    },
    addEventListener(type: string, fn: EventListener): void {
      if (type === 'message') n++;
      target.addEventListener(type, fn);
    },
    removeEventListener(type: string, fn: EventListener): void {
      if (type === 'message') n--;
      target.removeEventListener(type, fn);
    },
    listeners: (): number => n,
    /** 箱(iframe)からの message を窓へ届ける。 */
    emit(data: unknown, source: unknown): void {
      target.dispatchEvent(Object.assign(new Event('message'), { data, source }));
    },
  };
  return win as unknown as Window & {
    closed: boolean;
    listeners: () => number;
    emit: (data: unknown, source: unknown) => void;
  };
}

function setup(
  opts: {
    body?: string;
    open?: 'null';
    blob?: Blob | null;
    externalImages?: boolean;
    /** 真 = 添付の bytes が無い(`lend` が `null` を返す)。 */
    lendNull?: boolean;
  } = {},
) {
  let state = booted(opts.body ?? BODY);
  const win = fakeWindow();
  const failed: string[] = [];
  const disposed: string[] = [];
  const figureDisposed: number[] = [];
  const getBody = vi.fn(async (lid: string): Promise<string | null> => (lid === '' ? null : (opts.body ?? BODY)));
  let renderGate: Promise<void> | null = null;
  const cw = new ChapterWindows({
    getState: () => state,
    getBody,
    render: async (t, o) => {
      if (renderGate !== null) await renderGate;
      return renderMarkdown(t, o);
    },
    allowExternalImages: () => opts.externalImages ?? false,
    lend: async (key) =>
      opts.lendNull === true ? null : { url: `blob:${key}`, dispose: () => disposed.push(key) },
    getBlob: async () => opts.blob ?? null,
    runAction: vi.fn(),
    fail: (m) => failed.push(m),
    open: opts.open === 'null' ? () => null : () => win,
    // ⚠ 図の後始末が呼ばれたかを数える(1 回の後付けで 1 つの scope)
    hydrateFigures: () => [{ dispose: () => figureDisposed.push(1), prune: () => 0 }],
  });
  return {
    cw,
    win,
    failed,
    disposed,
    figureDisposed,
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

  it('🔴 bytes が無い添付画像には「見つからない」の印が付く(消えたように見えない。#1087 A5)', async () => {
    const r = setup({ lendNull: true });
    r.cw.open('n1', LINE_TWO);
    await flush();
    const img = r.host()!.querySelector<HTMLImageElement>('img[data-pkc-asset-key]');
    expect(img, '前提が崩れている(画像が章に無い)').not.toBeNull();
    expect(img!.hasAttribute('data-pkc-asset-missing'), '印が付いていない').toBe(true);
    expect(img!.hasAttribute('src')).toBe(false);
  });

  it('🔴 読めない画像(HEIC・壊れた画像)は壊れた絵で終わらず、理由の 1 行になる(#1087 A3)', async () => {
    const r = setup();
    r.cw.open('n1', LINE_TWO);
    await flush();
    const img = r.host()!.querySelector<HTMLImageElement>('img[data-pkc-asset-key]')!;
    expect(img.getAttribute('src')).toBe('blob:ast-1');
    img.dispatchEvent(new Event('error'));
    expect(r.host()!.querySelector('img[data-pkc-asset-key]'), '画像が残っている').toBeNull();
    const why = r.host()!.querySelector('[data-pkc-field="attachment-undecodable"]');
    expect(why?.textContent ?? '').toContain('このブラウザでは表示できません');
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

  it('🔴 開いた章より前に同じ字の見出しを足したら「見つかりません」(別の章を黙って出さない)', async () => {
    const r = setup();
    r.cw.open('n1', LINE_TWO);
    await flush();
    const grown = BODY.replace('# 一\n', '# 一\n\n## 二\n\n前に挟んだ\n\n');
    r.state = { ...r.state, openBody: { ...r.state.openBody!, body: grown } };
    r.cw.onState(r.state);
    await flush();
    expect(r.win.document.body.textContent ?? '', '挟んだ方の章を出した').not.toContain('前に挟んだ');
    expect(r.note()).toBe(CHAPTER_WINDOW_TEXT.missing);
  });

  it('🔴 別の章を書き換えても、この章の中身が同じなら組み直さない(画像を借り直さない)', async () => {
    const r = setup();
    r.cw.open('n1', LINE_TWO);
    await flush();
    const before = r.host();
    r.state = { ...r.state, openBody: { ...r.state.openBody!, body: BODY.replace('さんの中身', '三を直した') } };
    r.cw.onState(r.state);
    await flush();
    expect(r.host(), '同じ中身なのに器を作り直した(ちらつく)').toBe(before);
    expect(r.disposed, '同じ中身なのに画像を返して借り直した').toEqual([]);
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

describe('🔴 html の囲みが外の物を止められたら、窓にも理由の行を出す(R7)', () => {
  /** 窓の本文に html の囲み(iframe)を 1 つ置き、その送り主として使う偽の window を返す。 */
  function addBox(r: ReturnType<typeof setup>): { source: object } {
    const source = {};
    const frame = r.win.document.createElement('iframe');
    frame.setAttribute('data-pkc-html-render-id', 'box1');
    Object.defineProperty(frame, 'contentWindow', { value: source });
    r.win.document.body.append(frame);
    return { source };
  }
  const noteOf = (r: ReturnType<typeof setup>): string | null =>
    r.win.document.querySelector('[data-pkc-field="sandbox-blocked-note"]')?.textContent ?? null;
  const BLOCKED = { type: HTML_SANDBOX_BLOCKED_MSG_TYPE, id: 'box1', blocked: 0, kinds: ['script-src-elem'] };

  it('🔴 止められた種別が窓の本文の下に出る / 同じ申告を繰り返しても 1 行 / 画像だけなら出ない', async () => {
    const r = setup();
    r.cw.open('n1', LINE_TWO);
    await flush();
    const { source } = addBox(r);
    expect(noteOf(r), '申告の前から出ている').toBeNull();
    // 画像だけが止まった申告は、同意の帯の話(窓には出さない)
    r.win.emit({ ...BLOCKED, blocked: 2, kinds: ['img-src'] }, source);
    expect(noteOf(r), '画像だけの申告で出た').toBeNull();
    r.win.emit(BLOCKED, source);
    expect(noteOf(r) ?? '').toContain('外部のプログラム');
    expect(noteOf(r) ?? '').toContain('止めました');
    r.win.emit(BLOCKED, source);
    expect(r.win.document.querySelectorAll('[data-pkc-field="sandbox-blocked-note"]').length).toBe(1);
    // 別の種類が増えたら同じ行の字が増える
    r.win.emit({ ...BLOCKED, kinds: ['style-src-elem'] }, source);
    expect(noteOf(r) ?? '').toContain('外部の見た目(CSS)');
    expect(noteOf(r) ?? '').toContain('外部のプログラム');
    // 本文より後ろ(本文の下)に置く
    const body = r.win.document.body;
    const kids = Array.from(body.children);
    expect(kids.indexOf(body.querySelector('[data-pkc-field="sandbox-blocked-note"]')!)).toBeGreaterThan(
      kids.indexOf(r.host()!),
    );
  });

  it('🔴 送り主が囲みでない申告(なりすまし)では出ない', async () => {
    const r = setup();
    r.cw.open('n1', LINE_TWO);
    await flush();
    addBox(r);
    r.win.emit(BLOCKED, {});
    expect(noteOf(r)).toBeNull();
  });

  it('🔴 組み直したら前の申告は消える(囲みも作り直されて申告し直す)', async () => {
    const r = setup();
    r.cw.open('n1', LINE_TWO);
    await flush();
    const { source } = addBox(r);
    r.win.emit(BLOCKED, source);
    expect(noteOf(r)).not.toBeNull();
    r.state = { ...r.state, openBody: { ...r.state.openBody!, body: BODY.replace('にの中身', 'にの新しい中身') } };
    r.cw.onState(r.state);
    await flush();
    expect(noteOf(r), '古い申告の行が残っている').toBeNull();
    // 新しい囲みが申告し直せば、また出る(種別の控えが空に戻っている)
    const again = addBox(r);
    r.win.emit(BLOCKED, again.source);
    expect(noteOf(r)).not.toBeNull();
  });
});

describe('🔴 寿命 ── 閉じる / F5 / 元のウィンドウが閉じる', () => {
  it('🔴 窓を閉じたら借りた添付・図・高さ合わせを返し、台帳から外し、見張りを止める', async () => {
    const r = setup();
    r.cw.open('n1', LINE_TWO);
    await flush();
    // 受け手は 2 つ: 高さ合わせ + html の囲みが止められた理由(R7)
    expect(r.win.listeners(), '前提が崩れている(高さ合わせ / 止められた理由の受け手が付いていない)').toBe(2);
    r.win.closed = true;
    r.cw.tick();
    expect(r.disposed).toEqual(['ast-1']);
    expect(r.figureDisposed, '図の後始末が呼ばれていない(ObjectURL が残る)').toEqual([1]);
    expect(r.win.listeners(), '閉じたのに高さ合わせの受け手が残っている').toBe(0);
    expect(r.cw.size).toBe(0);
    expect(vi.getTimerCount(), '見張りが止まっていない(常駐する)').toBe(0);
  });

  it('🔴 別のページへ移って触れなくなった窓は、見張りから外す(毎秒描き直し続けない)', async () => {
    const r = setup();
    r.cw.open('n1', LINE_TWO);
    await flush();
    Object.defineProperty(r.win, 'document', {
      get() {
        throw new DOMException('cross-origin', 'SecurityError');
      },
    });
    r.getBody.mockClear();
    r.cw.tick();
    await flush();
    expect(r.cw.size, '触れない窓を台帳に残した').toBe(0);
    expect(r.disposed, '借りた添付を返していない').toEqual(['ast-1']);
  });

  it('🔴 開いてから描き終わるまでの間も、Esc で閉じる', async () => {
    const r = setup();
    r.gate(new Promise<void>(() => undefined)); // 描画が返らない
    r.cw.open('n1', LINE_TWO);
    await flush();
    expect(r.host(), '前提が崩れている(もう描けている)').toBeNull();
    r.win.document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(r.win.closed, '描き終わる前は Esc が効かない').toBe(true);
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

describe('🔴 読むだけの形は、後から埋めた所・外の画像にも効く', () => {
  it('🔴 添付から中身を取るコード枠を埋めた後も、⧉ が残らない', async () => {
    const body = ['## 二', '', '```csv', '```'].join('\n');
    const fenceBody = body.replace('```csv\n```', '```csv asset:ast-csv\n```');
    const r = setup({ body: fenceBody, blob: new Blob(['a,b\n1,2\n']) });
    r.cw.open('n1', 0);
    await flush();
    const host = r.host()!;
    // ⚠ 空振り防止 ── 埋める所を通った(表が出ている)
    expect(host.querySelector('[data-pkc-fence-asset-key]'), '前提が崩れている(枠を埋めていない)').toBeNull();
    expect(host.querySelector('table'), '前提が崩れている(添付の表が出ていない)').not.toBeNull();
    expect(host.querySelector('[data-pkc-action="copy-md-block"]'), '埋めた枠に ⧉ が残った').toBeNull();
  });

  it('🔴 外の画像は、本体と同じく同意が無ければ取りに行かない(対照群:同意があれば取りに行く)', async () => {
    const body = ['## 二', '', '![外](https://example.com/x.png)'].join('\n');
    const off = setup({ body });
    off.cw.open('n1', 0);
    await flush();
    const imgOff = off.host()!.querySelector('img');
    expect(imgOff, '前提が崩れている(画像が描かれていない)').not.toBeNull();
    expect(imgOff!.getAttribute('src') ?? '', '同意なしに外の画像を取りに行く').not.toContain('example.com');
    const on = setup({ body, externalImages: true });
    on.cw.open('n1', 0);
    await flush();
    expect(on.host()!.querySelector('img')?.getAttribute('src') ?? '', '対照群:同意があるのに取りに行かない').toContain(
      'example.com',
    );
  });

  it('🔴 図には全文の並びの番号を、本文の器にはノートを焼く(図を保存したときの名前)', async () => {
    const body = ['# 一', '', '```mermaid', 'graph TD; A-->B;', '```', '', '## 二', '', '```mermaid', 'graph TD; C-->D;', '```'].join('\n');
    const r = setup({ body });
    r.cw.open('n1', 6);
    await flush();
    const host = r.host()!;
    const fig = host.querySelector('[data-pkc-mermaid-src]');
    expect(fig?.getAttribute('data-pkc-mermaid-src')).toContain('C-->D');
    expect(fig?.getAttribute('data-pkc-diagram-index'), '全文で 2 つ目の図なのに番号が違う').toBe('1');
    expect(host.getAttribute('data-pkc-chapter-lid')).toBe('n1');
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

describe('🔴 開き直しと配色の追従(#1087)', () => {
  const B1 = ['# 計画', '', '## メモ', '', 'ひとつめ', '', '# 後'].join('\n');
  const B2 = ['# 計画', '', '## メモ', '', 'ひとつめ', '', '## メモ', '', 'ふたつめ', '', '# 後'].join('\n');

  it('🔴 同じ名前の見出しが増えて「見つかりません」になった窓は、見出しを押し直すと章に戻る', async () => {
    const r = setup({ body: B1 });
    expect(r.cw.open('n1', 2)).toBe(true);
    await flush();
    expect(r.host()?.textContent ?? '').toContain('ひとつめ');
    r.state = { ...r.state, openBody: { ...r.state.openBody!, body: B2 } };
    r.cw.onState(r.state);
    await flush();
    // 前提: 画面の案内どおり「見つかりません」になっている(これが無いと空振り)
    expect(r.note(), '前提が崩れている(見つかりません が出ていない)').toBe(CHAPTER_WINDOW_TEXT.missing);
    // 案内: 「元のウィンドウの見出しから開き直してください」
    expect(r.cw.open('n1', 2)).toBe(true);
    await flush();
    expect(r.note(), '押し直しても見つかりませんのまま').toBeNull();
    expect(r.host()?.textContent ?? '').toContain('ひとつめ');
    expect(r.host()?.textContent ?? '', '2 つ目の章が混ざった').not.toContain('ふたつめ');
  });

  it('🔴 本体で配色を替えたら、本文が同じでも開いている章の窓へ届く(見張りの 1 回で)', async () => {
    document.documentElement.style.setProperty('--bg', '#ffffff');
    const r = setup({ body: B1 });
    expect(r.cw.open('n1', 2)).toBe(true);
    await flush();
    const bg = (): string => r.win.document.documentElement.style.getPropertyValue('--bg');
    expect(bg(), '前提: 開いた時の値が写っている').toBe('#ffffff');
    document.documentElement.style.setProperty('--bg', '#000000');
    r.cw.tick();
    expect(bg()).toBe('#000000');
    // 対照群: 替わっていなければ写し直さない(窓側の値を触らない)
    r.win.document.documentElement.style.setProperty('--bg', '#123456');
    r.cw.tick();
    expect(bg(), '替わっていないのに写し直した').toBe('#123456');
    document.documentElement.style.removeProperty('--bg');
  });
});
