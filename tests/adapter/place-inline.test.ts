/** @vitest-environment happy-dom */
/**
 * 🔴 **板の付箋の上で、開かずに書く**(#529 W5-a「追記」/ W5-b「題名を直す」。Gemini 裁定 2026-10-11 依頼 18、全部 A)。
 *
 * 守る主張(画面で起きること):
 * 1. 付箋の下端に「追記」が出る ── **追記できる型(ノート・ログ)だけ**。フォルダ・添付・消えたノートには出ない。
 *    指で触る端末(`@media (hover: none)`)では最初から見え、マウスでは隠している間は押せない(`pointer-events: none`)
 * 2. 押すと**その付箋のノート**に向けた欄が開く(選んでいるノートではない)。Enter で確定、Shift+Enter は改行、Esc でやめる。
 *    確定は本文の下の追記欄と**同じ 1 本**(`APPEND_TO_ENTRY`)── 結末が来て初めて欄が閉じる
 * 3. 変換中の Enter では確定しない(`isComposing` / Safari の `keyCode` 229)
 * 4. 🔴 別のタブが編集中のノートへは**断って理由を出し、打った字は欄に残す**(Q5 = A)。書けなかった(`APPEND_FAILED`)回も同じ
 * 5. 右クリック「題名を直す」→ その場の欄 → Enter で `RENAME_ENTRY_TITLE`。同じ題名・空は書かない。題名の帯を押すとノートが開くのは変わらない
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { applyPlaceLayout } from '../../src/adapter/ui/render/place-board';
import { PlaceEmbeds, type PlaceEmbedDeps } from '../../src/adapter/ui/render/place-embed';
import { frontmatterLineCount, bodyBelowFrontmatter } from '../../src/features/markdown/frontmatter';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { EDIT_ELSEWHERE_ERROR } from '../../src/features/message/caution-events';
import { blocksFor, decl, mediaBlock, stripComments, withoutMedia } from '../helpers/css-blocks';

const MENU = '[data-pkc-region="context-menu"]';
const INLINE = '[data-pkc-field="place-inline"]';
const INPUT = '[data-pkc-field="place-inline-input"]';

const meta = (lid: string, archetype: string, title = lid): never =>
  ({
    lid,
    title,
    archetype,
    created_at: null,
    updated_at: null,
    entry_order: 1,
    status: null,
    date: null,
    archived: 0,
  }) as never;

/** 板(n1)に、ノート n2・ログ n3・フォルダ n4・添付 n5・存在しない n9 を置く。 */
const BOARD = [
  ':::format{#a .pkc-place entry=n2 x=10 y=20 w=200 h=100}',
  ':::',
  '',
  ':::format{#b .pkc-place entry=n3 x=300 y=20 w=200 h=100}',
  ':::',
  '',
  ':::format{#c .pkc-place entry=n4 x=10 y=200 w=200 h=100}',
  ':::',
  '',
  ':::format{#d .pkc-place entry=n5 x=300 y=200 w=200 h=100}',
  ':::',
  '',
  ':::format{#e .pkc-place entry=n9 x=10 y=400 w=200 h=100}',
  ':::',
  '',
].join('\n');

const METAS = [
  meta('n1', 'text', '板'),
  meta('n2', 'text', '議事録'),
  meta('n3', 'textlog', '日報'),
  meta('n4', 'folder', '資料'),
  meta('n5', 'attachment', '写真'),
];

class QuietIO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', QuietIO);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.textContent = '';
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

function rig(services: Partial<BinderServices> = {}, body: string = BOARD) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  const host = document.createElement('div');
  host.setAttribute('data-pkc-field', 'detail-body');
  host.innerHTML = renderMarkdown(bodyBelowFrontmatter(body), { sourceLineAnchors: true });
  const titles = new Map(METAS.map((m) => [(m as { lid: string }).lid, (m as { title: string }).title]));
  const layout = (): number => applyPlaceLayout(host, (l) => titles.get(l) ?? null, frontmatterLineCount(body));
  layout();
  const region = document.createElement('div');
  region.setAttribute('data-pkc-region', 'detail');
  region.append(host);
  root.append(region);
  document.body.append(root);
  const d = new Dispatcher();
  const events: DomainEvent[] = [];
  d.onEvent((e) => events.push(e));
  bindActions(root, d, { showStatus: () => {}, ...services });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  const embeds = new PlaceEmbeds();
  const deps: PlaceEmbedDeps = {
    selfLid: 'n1',
    excerptOf: () => ({ text: 'x', cut: false }),
    metaOf: (l) => {
      const m = METAS.find((x) => (x as { lid: string }).lid === l) as
        | { title: string; archetype: string }
        | undefined;
      return m === undefined ? undefined : { title: m.title, archetype: m.archetype };
    },
    render: (t) => Promise.resolve(t),
    wanted: () => undefined,
    lender: null,
    figures: () => [],
    viewRoot: null,
    currentContainerId: '',
  };
  embeds.sync(host, deps);
  events.length = 0;
  const sticky = (id: string): HTMLElement => host.querySelector<HTMLElement>(`#${id}`)!;
  const appendBtn = (id: string): HTMLButtonElement | null =>
    sticky(id).querySelector<HTMLButtonElement>(':scope > [data-pkc-field="place-append"]');
  const inline = (): HTMLElement | null => host.querySelector<HTMLElement>(INLINE);
  const input = (): HTMLTextAreaElement | null => host.querySelector<HTMLTextAreaElement>(INPUT);
  const type = (text: string): void => {
    input()!.value = text;
  };
  const key = (k: string, init: KeyboardEventInit & { keyCode?: number } = {}): KeyboardEvent => {
    const { keyCode, ...rest } = init;
    const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...rest });
    if (keyCode !== undefined) Object.defineProperty(ev, 'keyCode', { value: keyCode });
    input()!.dispatchEvent(ev);
    return ev;
  };
  const appends = (): Extract<DomainEvent, { type: 'REQUEST_APPEND' }>[] =>
    events.filter((e): e is Extract<DomainEvent, { type: 'REQUEST_APPEND' }> => e.type === 'REQUEST_APPEND');
  const renames = (): Extract<DomainEvent, { type: 'REQUEST_RENAME' }>[] =>
    events.filter((e): e is Extract<DomainEvent, { type: 'REQUEST_RENAME' }> => e.type === 'REQUEST_RENAME');
  /** 追記が disk に着いた(`store-effects` の ack)。 */
  const settleAppend = (lid: string): void => {
    const st = d.getState();
    d.dispatch({
      type: 'ENTRY_APPENDED',
      lid,
      gen: st.lockGen,
      body: 'x\n足した字\n',
      status: null,
      date: null,
      archived: false,
      inserted: ['足した字'],
    } as never);
  };
  return { root, host, d, events, layout, sticky, appendBtn, inline, input, type, key, appends, renames, settleAppend };
}

const rightClick = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
};
const menuItem = (root: Element, action: string): HTMLButtonElement | null =>
  root.querySelector<HTMLButtonElement>(`${MENU} button[data-pkc-action="${action}"]`);

describe('付箋の下端の「追記」', () => {
  it('🔴 ノート・ログの付箋にだけ出る。フォルダ・添付・消えたノートには出ない(押しても書けない口を出さない)', () => {
    const t = rig();
    expect(t.appendBtn('a'), 'ノートの付箋').not.toBeNull();
    expect(t.appendBtn('b'), 'ログの付箋').not.toBeNull();
    expect(t.appendBtn('c'), 'フォルダ').toBeNull();
    expect(t.appendBtn('d'), '添付').toBeNull();
    expect(t.appendBtn('e'), '消えたノート').toBeNull();
    expect(t.appendBtn('a')!.textContent).toBe('追記');
    // 🔑 追記先はボタン自身が持つ(板のノート n1 でも、選んでいるノートでもない)
    expect(t.appendBtn('a')!.getAttribute('data-pkc-entry')).toBe('n2');
    expect(t.appendBtn('b')!.getAttribute('data-pkc-entry')).toBe('n3');
  });

  it('🔴 2 度同期しても 1 つだけ(冪等)。相手が追記できない型に替われば外れる', () => {
    const t = rig();
    expect(t.sticky('a').querySelectorAll('[data-pkc-field="place-append"]')).toHaveLength(1);
  });

  it('🔴 出方は CSS が担う ── マウスでは乗せたときだけ(隠している間は押せない)・指の端末では最初から', () => {
    const css = stripComments(readFileSync('src/styles/app.css', 'utf-8'));
    const sel = ".pkc-place > [data-pkc-field='place-append']";
    const base = blocksFor(withoutMedia(css), sel);
    expect(base.length, '素の規則が無い').toBeGreaterThan(0);
    const hidden = base.find((b) => /opacity:\s*0/.test(b))!;
    expect(hidden, '隠している間の opacity: 0 が無い').toBeDefined();
    // ⚠ opacity だけだと「見えないのに押せる」(指で触れただけで開く)
    expect(hidden).toMatch(decl('pointer-events', 'none'));
    const shown = blocksFor(
      withoutMedia(css),
      ".pkc-place:hover > [data-pkc-field='place-append']",
    );
    expect(shown.some((b) => decl('opacity', '1').test(b) && decl('pointer-events', 'auto').test(b))).toBe(true);
    // 指の端末(判定は `(hover: none)` 1 つ ── 他の隠し物と同じ)
    const touch = blocksFor(mediaBlock(css, '(hover: none)').body, sel);
    expect(touch.some((b) => decl('opacity', '1').test(b) && decl('pointer-events', 'auto').test(b))).toBe(true);
  });
});

describe('追記の欄', () => {
  it('🔴 押すと、押した付箋の下に欄が開く。焦点は欄に入り、置き場は付箋の直下', () => {
    const t = rig();
    t.appendBtn('a')!.click();
    expect(t.inline()).not.toBeNull();
    expect(t.inline()!.getAttribute('data-pkc-mode')).toBe('append');
    expect(t.inline()!.getAttribute('data-pkc-entry')).toBe('n2');
    expect(document.activeElement).toBe(t.input());
    // 付箋 a は y=20 h=100 ── 欄は 120 に置かれる(付箋を覆わない)
    expect(t.inline()!.style.top).toBe('120px');
    expect(t.inline()!.style.left).toBe('10px');
  });

  it('🔴 欄は同時に 1 つ。別の付箋の「追記」を押すと前の欄は閉じて移る(開き直しても打ちかけは消えない)', () => {
    const t = rig();
    t.appendBtn('a')!.click();
    t.type('途中');
    // 同じ付箋をもう一度押しても作り直さない(打ちかけを消さない)
    t.appendBtn('a')!.click();
    expect(t.input()!.value).toBe('途中');
    t.appendBtn('b')!.click();
    expect(t.host.querySelectorAll(INLINE)).toHaveLength(1);
    expect(t.inline()!.getAttribute('data-pkc-entry')).toBe('n3');
    expect(t.input()!.value).toBe('');
  });

  it('🔴 Enter で追記が撃たれる ── 追記先は付箋のノート(n2)で、選んでいる板(n1)ではない。末尾へ・節の見出しなし(ノート)', async () => {
    const t = rig();
    t.appendBtn('a')!.click();
    t.type('決まったこと');
    t.key('Enter');
    await flush();
    expect(t.appends()).toHaveLength(1);
    const ev = t.appends()[0]!;
    expect(ev.lid).toBe('n2');
    expect(ev.text).toBe('決まったこと');
    expect(ev.target).toBeNull();
    // 本文の下の追記欄と同じ口 ── `writeLock` が立ち、結末が来るまで欄は閉じない
    expect(t.d.getState().writeLock?.lid).toBe('n2');
    expect(t.inline(), '結末の前に欄が閉じた(書けた確証が無い)').not.toBeNull();
    t.settleAppend('n2');
    await flush();
    expect(t.inline(), '書けた後も欄が残っている').toBeNull();
    // 🔴 足したことを言い、戻す道(状態の行の「元に戻す」)が開く ── 知らせの行き先が `lastAppend` のノートと一致する
    expect(t.d.getState().notice).toBe('『議事録』の末尾に追記しました');
    expect(t.d.getState().noticeOpen).toBe('n2');
    expect(t.d.getState().lastAppend?.lid).toBe('n2');
  });

  it('🔴 ログの付箋は日時の見出しつきで足される(本文の下の追記欄と同じ規則)', async () => {
    const t = rig();
    t.appendBtn('b')!.click();
    t.type('今日の記録');
    t.key('Enter');
    await flush();
    const ev = t.appends()[0]!;
    expect(ev.lid).toBe('n3');
    expect(ev.heading, 'ログなのに日時の見出しが付かない').toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('🔴 「追記する」ボタンでも同じ 1 本が撃たれる', async () => {
    const t = rig();
    t.appendBtn('a')!.click();
    t.type('ボタンで');
    t.inline()!.querySelector<HTMLButtonElement>('[data-pkc-action="place-inline-commit"]')!.click();
    await flush();
    expect(t.appends().map((e) => e.text)).toEqual(['ボタンで']);
  });

  it('🔴 Shift+Enter は改行(撃たない)/ Ctrl+Enter は確定 / 空は撃たず理由を言う', async () => {
    const t = rig();
    t.appendBtn('a')!.click();
    t.type('一行目');
    const ev = t.key('Enter', { shiftKey: true });
    await flush();
    expect(ev.defaultPrevented, 'Shift+Enter の既定(改行)を奪った').toBe(false);
    expect(t.appends()).toHaveLength(0);
    t.type('');
    t.key('Enter');
    await flush();
    expect(t.appends(), '空の追記を撃った').toHaveLength(0);
    expect(t.inline()!.querySelector('[data-pkc-field="place-inline-note"]')!.textContent).toContain('足す字');
    t.type('確定');
    t.key('Enter', { ctrlKey: true });
    await flush();
    expect(t.appends()).toHaveLength(1);
  });

  it('🔴 Esc でやめる ── 何も撃たず、欄は閉じ、焦点は「追記」へ戻る', async () => {
    const t = rig();
    t.appendBtn('a')!.click();
    t.type('やめる字');
    t.key('Escape');
    await flush();
    expect(t.inline()).toBeNull();
    expect(t.appends()).toHaveLength(0);
    expect(document.activeElement).toBe(t.appendBtn('a'));
  });

  it('🔴 「やめる」ボタンも同じ', async () => {
    const t = rig();
    t.appendBtn('a')!.click();
    t.type('字');
    t.inline()!.querySelector<HTMLButtonElement>('[data-pkc-action="place-inline-cancel"]')!.click();
    expect(t.inline()).toBeNull();
    expect(t.appends()).toHaveLength(0);
  });

  it('🔴 変換中の Enter では確定しない(isComposing / Safari の keyCode 229)。変換が終われば確定する', async () => {
    const t = rig();
    t.appendBtn('a')!.click();
    t.type('にほんご');
    t.key('Enter', { isComposing: true });
    t.key('Enter', { keyCode: 229 });
    await flush();
    expect(t.appends(), '変換中の Enter で飛んだ').toHaveLength(0);
    t.key('Enter');
    await flush();
    expect(t.appends()).toHaveLength(1);
  });

  it('🔴 板の描き直し(applyPlaceLayout)を跨いで欄と打ちかけが生きる。付箋が動けば欄も追う', () => {
    const t = rig();
    t.appendBtn('a')!.click();
    t.type('打ちかけ');
    const el = t.inline()!;
    // 本文の `y=` を書き換えて描き直す(本物の動かし方 ── 付箋の style を直に触ると、描き直しが元へ戻す)
    t.sticky('a').setAttribute('data-pkc-y', '60');
    t.layout();
    expect(t.inline(), '欄が作り直された').toBe(el);
    expect(t.input()!.value).toBe('打ちかけ');
    expect(el.style.top, '付箋が動いたのに欄が置き直されない').toBe('160px');
  });

  it('🔴 付箋が板から無くなったら欄も閉じる(行き先の無い欄を残さない)', () => {
    const t = rig();
    t.appendBtn('a')!.click();
    t.sticky('a').remove();
    t.layout();
    expect(t.inline()).toBeNull();
  });
});

describe('🔴 別のタブが編集中のノートへは断る(Gemini 裁定 Q5 = A)', () => {
  it('断られたら撃たず、理由を欄と知らせに出し、打った字は欄に残る', async () => {
    const acquire = vi.fn(async () => 'denied' as const);
    const release = vi.fn();
    const t = rig({ acquireEditLock: acquire, releaseEditLock: release });
    t.appendBtn('a')!.click();
    t.type('残す字');
    t.key('Enter');
    await flush();
    expect(acquire).toHaveBeenCalledWith('n2');
    expect(t.appends(), '断られたのに追記を撃った').toHaveLength(0);
    expect(t.inline(), '欄が閉じた(字が消える)').not.toBeNull();
    expect(t.input()!.value).toBe('残す字');
    const note = t.inline()!.querySelector<HTMLElement>('[data-pkc-field="place-inline-note"]')!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe(EDIT_ELSEWHERE_ERROR);
    expect(t.d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);
    // 取れなかった錠は返す相手がいない
    expect(release).not.toHaveBeenCalled();
  });

  it('対照群:取れたら錠を握り続けずに返し、追記が撃たれる(押すたびに握りっぱなしにしない)', async () => {
    const acquire = vi.fn(async () => 'granted' as const);
    const release = vi.fn();
    const t = rig({ acquireEditLock: acquire, releaseEditLock: release });
    t.appendBtn('a')!.click();
    t.type('通る字');
    t.key('Enter');
    await flush();
    expect(release).toHaveBeenCalledWith('n2');
    expect(t.appends()).toHaveLength(1);
  });

  it('このタブが自分で編集中のノートは問い合わせない(取り直して返すと自分の錠を手放す)。断るのは reducer の門', async () => {
    const acquire = vi.fn(async () => 'granted' as const);
    const release = vi.fn();
    const t = rig({ acquireEditLock: acquire, releaseEditLock: release });
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    t.d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: '本文' });
    t.d.dispatch({ type: 'START_EDIT' });
    expect(t.d.getState().phase).toBe('editing');
    t.appendBtn('a')!.click();
    t.type('字');
    t.key('Enter');
    await flush();
    expect(acquire, '自分が握っている錠を問い合わせた').not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(t.appends(), '編集中のノートへ追記が通った').toHaveLength(0);
    expect(t.input()!.value, '字が消えた').toBe('字');
    expect(t.inline()!.querySelector('[data-pkc-field="place-inline-note"]')!.textContent).not.toBe('');
  });

  it('メインのタブと通信できない(unreachable)ときは断らない ── 本体の追記欄も同じ状況では通る', async () => {
    const t = rig({ acquireEditLock: async () => 'unreachable', releaseEditLock: vi.fn() });
    t.appendBtn('a')!.click();
    t.type('字');
    t.key('Enter');
    await flush();
    expect(t.appends()).toHaveLength(1);
  });

  it('書けなかった(APPEND_FAILED)回も、欄は閉じず字を残して理由を言う', async () => {
    const t = rig();
    t.appendBtn('a')!.click();
    t.type('失敗しても残る');
    t.key('Enter');
    await flush();
    const st = t.d.getState();
    t.d.dispatch({ type: 'APPEND_FAILED', lid: 'n2', gen: st.lockGen, error: '保存できませんでした' } as never);
    await flush();
    expect(t.inline()).not.toBeNull();
    expect(t.input()!.value).toBe('失敗しても残る');
    expect(t.inline()!.querySelector('[data-pkc-field="place-inline-note"]')!.textContent).toBe('保存できませんでした');
  });

  it('書込中(writeLock)に重ねて押しても断られ、字は残る(reducer の門をそのまま通る)', async () => {
    const t = rig();
    t.appendBtn('a')!.click();
    t.type('1 回目');
    t.key('Enter');
    await flush();
    t.appendBtn('b')!.click();
    t.type('2 回目');
    t.key('Enter');
    await flush();
    expect(t.appends(), '書込中なのに 2 本目が撃たれた').toHaveLength(1);
    expect(t.input()!.value).toBe('2 回目');
  });
});

describe('付箋の右クリック「題名を直す」', () => {
  it('🔴 ノートが居る付箋にだけ出る(フォルダの付箋にも出る・消えたノートには出ない・板の外の本文には出ない)', () => {
    const t = rig();
    rightClick(t.sticky('a').querySelector('[data-pkc-field="place-card"]')!);
    const item = menuItem(t.root, 'place-rename-open');
    expect(item, '付箋の上で出ない').not.toBeNull();
    expect(item!.textContent).toBe('題名を直す');
    expect(item!.getAttribute('data-pkc-place-lid')).toBe('n2');
    // 変わるのが他の表示にも及ぶことを先に言う(設問 Q3 の ⚠)
    expect(item!.getAttribute('data-pkc-hint')).toContain('一覧');
    rightClick(t.sticky('e').querySelector('[data-pkc-field="place-card"]')!);
    expect(menuItem(t.root, 'place-rename-open'), '消えたノートの付箋に出た').toBeNull();
  });

  it('🔴 押すと欄が付箋の上端に開き、いまの題名が入っている。Enter で改名が撃たれ、欄は閉じる', async () => {
    const t = rig();
    rightClick(t.sticky('a').querySelector('[data-pkc-field="place-card"]')!);
    menuItem(t.root, 'place-rename-open')!.click();
    expect(t.inline()!.getAttribute('data-pkc-mode')).toBe('rename');
    expect(t.input()!.value).toBe('議事録');
    expect(t.inline()!.style.top, '題名の欄は付箋の上端').toBe('20px');
    t.type('朝会の議事録');
    t.key('Enter');
    await flush();
    expect(t.renames().map((e) => [e.lid, e.title])).toEqual([['n2', '朝会の議事録']]);
    expect(t.d.getState().entryMetas.get('n2')!.title).toBe('朝会の議事録');
    expect(t.inline()).toBeNull();
  });

  it('🔴 Shift+Enter でも改行は入らず確定する(題名は 1 行)/ 改行・連続する空白は 1 つの空白に畳む', async () => {
    const t = rig();
    rightClick(t.sticky('a').querySelector('[data-pkc-field="place-card"]')!);
    menuItem(t.root, 'place-rename-open')!.click();
    t.type('二行\n  に   わたる');
    t.key('Enter', { shiftKey: true });
    await flush();
    expect(t.renames().map((e) => e.title)).toEqual(['二行 に わたる']);
  });

  it('Esc でやめる ── 何も撃たない。同じ題名・空は撃たない(空は理由を言って字を残す)', async () => {
    const t = rig();
    rightClick(t.sticky('a').querySelector('[data-pkc-field="place-card"]')!);
    menuItem(t.root, 'place-rename-open')!.click();
    t.type('途中');
    t.key('Escape');
    expect(t.inline()).toBeNull();
    expect(t.renames()).toHaveLength(0);

    rightClick(t.sticky('a').querySelector('[data-pkc-field="place-card"]')!);
    menuItem(t.root, 'place-rename-open')!.click();
    t.key('Enter'); // 題名を変えずに確定
    await flush();
    expect(t.renames(), '同じ題名で撃った').toHaveLength(0);
    expect(t.inline(), '同じ題名なら閉じるだけ').toBeNull();

    rightClick(t.sticky('a').querySelector('[data-pkc-field="place-card"]')!);
    menuItem(t.root, 'place-rename-open')!.click();
    t.type('   ');
    t.key('Enter');
    await flush();
    expect(t.renames()).toHaveLength(0);
    expect(t.inline(), '空で閉じた').not.toBeNull();
  });

  it('🔴 変換中の Enter では確定しない', async () => {
    const t = rig();
    rightClick(t.sticky('a').querySelector('[data-pkc-field="place-card"]')!);
    menuItem(t.root, 'place-rename-open')!.click();
    t.type('かんじ');
    t.key('Enter', { isComposing: true });
    t.key('Enter', { keyCode: 229 });
    await flush();
    expect(t.renames()).toHaveLength(0);
  });

  it('🔴 別のタブが編集中なら改名も断って理由を出し、字は欄に残す(Q5 = A)', async () => {
    const t = rig({ acquireEditLock: async () => 'denied', releaseEditLock: vi.fn() });
    rightClick(t.sticky('a').querySelector('[data-pkc-field="place-card"]')!);
    menuItem(t.root, 'place-rename-open')!.click();
    t.type('新しい題名');
    t.key('Enter');
    await flush();
    expect(t.renames()).toHaveLength(0);
    expect(t.d.getState().entryMetas.get('n2')!.title, '断ったのに題名が変わった').toBe('議事録');
    expect(t.input()!.value).toBe('新しい題名');
    expect(t.inline()!.querySelector('[data-pkc-field="place-inline-note"]')!.textContent).toBe(EDIT_ELSEWHERE_ERROR);
  });

  it('🔴 基本の動線は変わらない ── 題名の帯を押すと、そのノートが開く(欄は開かない)', () => {
    const t = rig();
    const card = t.sticky('a').querySelector<HTMLButtonElement>('[data-pkc-field="place-card"]')!;
    expect(card.getAttribute('data-pkc-action')).toBe('select-entry');
    card.click();
    expect(t.d.getState().selectedLid).toBe('n2');
    expect(t.inline()).toBeNull();
  });
});
