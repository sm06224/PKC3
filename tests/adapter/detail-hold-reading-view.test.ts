/** @vitest-environment happy-dom */
/**
 * 🔴 **編集のあいだ読む面を持ち越し、戻るとき表示を戻すだけにする**(#1467 段 5。
 * 設計 `docs/development/long-note-open-save-2026-10.md` §5-A)。
 *
 * 守るもの:
 *  ① 変更なしの保存・取り消しでは、ワーカー(`markdown.render`)を呼ばず、**同じ節点**が戻る
 *  ② 本文が変わった保存では、持ち越した台帳を土台に**差分**(変わった塊だけ新しい節点)
 *  ③ 描画設定の鍵が違えば作り直す(旗を切り替えた後に古い装飾を残さない)
 *  ④ 編集中、持ち越した器は本文の器として**拾われない**(`BODY_HOST_SELECTOR` が `data-pkc-held` を除く)
 *  ⑤ 捨てる ── 別のノート / 編集のまま別の画面(`releaseHeld`)/ 描き終えていない編集
 *
 * ⚠ 「描き直さない」の検査は `markdown.render` の呼び出し回数と、**節点の同一性(`===`)**の 2 本立て。
 *   回数だけだと、節点を作り直す実装(ワーカー以外で描く)が通ってしまう。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codeOnly } from '../helpers/code-only';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import {
  BODY_HOST_SELECTOR,
  DetailRenderer,
  type AssetLender,
  HELD_ATTR,
  HELD_STYLE,
  PAINTED_ATTR,
} from '../../src/adapter/ui/render/detail';
import { MarkdownClient } from '../../src/adapter/platform/render/markdown-client';
import { columnScroller } from '../../src/adapter/ui/render/read-columns';
import { appCodeCollapse } from '../../src/adapter/ui/render/code-collapse';
import { appDateLinks } from '../../src/adapter/ui/render/date-links';
import { appColorSwatch } from '../../src/adapter/ui/render/color-swatch';
import { appPhoneLinks } from '../../src/adapter/ui/render/phone-links';
import { appInlineCodeCopy } from '../../src/adapter/ui/render/inline-code-copy';
import { appRelativeDays } from '../../src/adapter/ui/render/relative-days';
import { ExternalImagePolicy } from '../../src/adapter/ui/render/external-images';
import { PlaceEmbeds } from '../../src/adapter/ui/render/place-embed';
import { SectionEmbeds } from '../../src/adapter/ui/render/section-embed';
import { SqlEmbedHydrator } from '../../src/adapter/ui/render/sql-embed-hydrate';
import { renderToPng } from '../../src/adapter/ui/render/mermaid-raster';

// 🔑 図を焼く所は差す(`place-embed.test.ts` と同じ手法)── ここで見たいのは**URL の貸し借り**で、絵ではない
vi.mock('../../src/adapter/ui/render/mermaid-raster', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/adapter/ui/render/mermaid-raster')>();
  return {
    cacheKey: real.cacheKey,
    DeviceRenderError: real.DeviceRenderError,
    renderToPng: vi.fn(async () => ({ png: new Blob(['png'], { type: 'image/png' }), cssWidth: 200 })),
    readPalette: () => ({
      bg: '#fff',
      alt: '#eee',
      fg: '#000',
      line: '#666',
      border: '#ccc',
      accent: '#080',
      dark: false,
    }),
  };
});

type Action = Parameters<typeof reduce>[1];

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

const LINES = Array.from({ length: 30 }, (_, i) => `行 ${i}`);
const BODY = LINES.join('\n\n');

const step = (s: AppState, a: Action): AppState => reduce(s, a).state;

function ready(): AppState {
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a'), meta('b')],
    relations: [],
  }).state;
  s = step(s, { type: 'SELECT_ENTRY', lid: 'a' });
  return step(s, { type: 'BODY_LOADED', lid: 'a', body: BODY });
}

async function open(policy?: ExternalImagePolicy) {
  const root = document.createElement('div');
  document.body.append(root);
  const markdown = new MarkdownClient();
  const render = vi.spyOn(markdown, 'render');
  const detail = new DetailRenderer(buildShell(root).detail, null, markdown, null, policy);
  const s0 = ready();
  detail.render(s0);
  await settle();
  return { root, detail, render, s0 };
}

const hostOf = (root: HTMLElement) => root.querySelector<HTMLElement>(BODY_HOST_SELECTOR)!;

async function show(detail: DetailRenderer, s: AppState): Promise<void> {
  detail.render(s);
  await settle();
}

beforeEach(() => {
  document.body.textContent = '';
});
afterEach(() => {
  for (const store of [
    appCodeCollapse,
    appDateLinks,
    appColorSwatch,
    appPhoneLinks,
    appInlineCodeCopy,
    appRelativeDays,
  ])
    store.setEnabled(true);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('detail: 編集のあいだ読む面を持ち越す(#1467 段 5)', () => {
  it('🔴 対照群 ── 最初に開いたときは描く(呼び出し 1 回以上、印が付く)', async () => {
    const { root, render } = await open();
    expect(render.mock.calls.length, '前提: 開いたときに描いていない').toBeGreaterThan(0);
    expect(hostOf(root).getAttribute(PAINTED_ATTR)).toBe('a');
  });

  it('🔴 編集に入ると本文の器は残るが、本文の器としては拾われない', async () => {
    const { root, detail, s0 } = await open();
    const host = hostOf(root);
    const blocks = host.children.length;
    expect(blocks, '前提: 塊が描かれている').toBeGreaterThan(10);
    // 対照群: 読む面のあいだ、段組みの選択子は器を拾う(拾えない選択子なら下の「拾われない」は空振り)
    const beforeEdit = columnScroller(root);
    expect(beforeEdit, '前提: 読む面で段組みの選択子が器を拾えていない').toBe(host);

    await show(detail, step(s0, { type: 'START_EDIT' }));

    expect(detail.holdsReadingView).toBe(true);
    // 節点は同じ物が残っている(作り直していない)
    const held = root.querySelector<HTMLElement>(`[${HELD_ATTR}]`);
    expect(held, '持ち越した器が無い').toBe(host);
    expect(held!.children.length).toBe(blocks);
    // 本文の器を探す口(`BODY_HOST_SELECTOR`。binder / 設定が引く)に掴まれない
    expect(root.querySelector(BODY_HOST_SELECTOR), '本文の器として拾える').toBeNull();
    // 🔑 器の `data-pkc-field` は替えない(替えて戻すと本文の全要素のスタイルが引き直される ── 実測)
    expect(held!.getAttribute('data-pkc-field'), '器の名前を替えている').toBe('detail-body');
    // (編集の面そのもの `editor-live` は段組みの対象になりうる ── 持ち越した側だけが拾われないこと)
    // ⚠ `not.toBe(held)` だけだと、何も拾えない(null)でも通る ── 対照群(下の `beforeEdit`)で
    //    「読む面のときは同じ選択子が器を拾える」ことを見たうえで、編集中は**面の印が読む面でない**ことを見る
    expect(columnScroller(root), '編集中に持ち越した器が段組みの対象になっている').not.toBe(held);
    expect(held!.closest('[data-pkc-detail-mode="view"]'), '持ち越した器が読む面の中に居る(選択子に拾われる)').toBeNull();
    expect(root.querySelector('[data-pkc-detail-mode="editor"]'), '前提: 編集の面の印が無い').not.toBeNull();
    // 描いた印も外れている(目次が「描けた」と読まない)
    expect(held!.hasAttribute(PAINTED_ATTR)).toBe(false);
    // 画面には出さない
    expect(held!.getAttribute('style')).toContain('content-visibility:hidden');
    // 🔑 持ち越しの style は**末尾**に足す ── 保存していた inline の高さ(段組みの `height: Npx`)より後で勝つ
    expect((held!.getAttribute('style') ?? '').endsWith(HELD_STYLE), '持ち越しの style が末尾に無い').toBe(true);
    // 編集の面は在る(押せる)
    expect(root.querySelector('[data-pkc-field="editor-title"]')).not.toBeNull();
  });

  it('🔴 変更なしの保存 ── ワーカーを呼ばず、同じ節点がそのまま戻る', async () => {
    const { root, detail, render, s0 } = await open();
    const host = hostOf(root);
    const firstBlock = host.children[0]!;
    const lastBlock = host.children[host.children.length - 1]!;
    const editing = step(s0, { type: 'START_EDIT' });
    await show(detail, editing);
    const calls = render.mock.calls.length;

    await show(detail, step(editing, { type: 'COMMIT_EDIT' }));

    expect(render.mock.calls.length, '変更なしなのにワーカーへ依頼した').toBe(calls);
    const back = hostOf(root);
    expect(back, '本文の器が作り直されている').toBe(host);
    expect(back.children[0], '塊が作り直されている').toBe(firstBlock);
    expect(back.children[back.children.length - 1]).toBe(lastBlock);
    expect(back.getAttribute(PAINTED_ATTR)).toBe('a');
    expect(back.hasAttribute(HELD_ATTR)).toBe(false);
    expect(back.getAttribute('style') ?? '', '隠れたまま').not.toContain('content-visibility');
    expect(detail.holdsReadingView, '持ち越しが残っている').toBe(false);
    // 編集の面は外れている
    expect(root.querySelector('[data-pkc-field="editor-title"]')).toBeNull();
    // 題名・帯が戻っている
    expect(root.querySelector('[data-pkc-field="detail-title"]')).not.toBeNull();
    expect(root.querySelector('[data-pkc-action="start-edit"]')).not.toBeNull();
  });

  it('🔴 戻るとき、焦点を持つ節点(押した保存ボタンの帯)は編集の面の中で最後に外す(#1467 段 6)', async () => {
    const { root, detail, s0 } = await open();
    const host = hostOf(root);
    const editing = step(s0, { type: 'START_EDIT' });
    await show(detail, editing);
    const region = host.parentElement!;
    const nameOf = (n: Node): string =>
      (n as HTMLElement).getAttribute?.('data-pkc-field') ?? (n as HTMLElement).getAttribute?.('data-pkc-region') ?? n.nodeName;
    const order = (): string[] => Array.from(region.childNodes).filter((n) => n !== host).map(nameOf);
    const faces = order();
    // 前提: 編集の面は帯より後ろに、重い物(本文の編集欄)を持つ。帯が先に並んでいる(= 素直に外すと帯が先に外れる)
    expect(faces.indexOf('detail-toolbar'), '前提: 帯が無い').toBeGreaterThanOrEqual(0);
    expect(faces.indexOf('editor-live'), '前提: 編集欄が無い').toBeGreaterThan(faces.indexOf('detail-toolbar'));
    const commit = region.querySelector<HTMLElement>('[data-pkc-action="commit-edit"]')!;
    commit.focus();
    expect(document.activeElement, '前提: 保存ボタンが焦点を持っていない').toBe(commit);

    const removed: string[] = [];
    const watch = new MutationObserver((records) => {
      for (const r of records) for (const n of Array.from(r.removedNodes)) removed.push(nameOf(n));
    });
    watch.observe(region, { childList: true });
    await show(detail, step(editing, { type: 'COMMIT_EDIT' }));
    watch.disconnect();

    const gone = removed.filter((n) => faces.includes(n));
    expect(gone.length, '前提: 編集の面が外れていない').toBe(faces.length);
    // 焦点を持つ節点を外すとブラウザはその場で配置を払う ── 重い編集欄が居るうちに外すと、その配置が丸ごと払われる
    expect(gone[gone.length - 1], '焦点を持つ帯が最後に外れていない').toBe('detail-toolbar');
    expect(gone.indexOf('editor-live'), '編集欄より後に外している').toBeLessThan(gone.indexOf('detail-toolbar'));
  });

  it('🔴 段組みのとき器に inline の高さが書かれていても、持ち越しの間は 0 にし、戻すと元の値へ戻す', async () => {
    const { root, detail, s0 } = await open();
    const host = hostOf(root);
    // 段組みでは `fitColumnHeight` が器へ高さ(px)と右の詰めを inline で書く
    host.style.height = '568px';
    host.style.paddingRight = '6px';
    const editing = step(s0, { type: 'START_EDIT' });
    await show(detail, editing);
    // ⚠ 疑似 DOM の `.style` は属性の書き換えに追随しないことがあるので、**属性の字**で見る
    const held = host.getAttribute('style') ?? '';
    // 🔑 保存していた inline の高さ(568px)より**後ろ**に足す ── 前に足すと 568px が勝つ
    expect(held.includes('height: 568px') || held.includes('height:568px'), '前提: 段の高さが残っていない').toBe(true);
    expect(held.endsWith(HELD_STYLE), '持ち越しの style が保存済みの style の後ろに無い').toBe(true);
    expect(held, '持ち越しの間も段の高さのまま居座る(編集の面を押し下げる)').toMatch(/height:\s*0(?:px)?\s*;/);
    await show(detail, step(editing, { type: 'COMMIT_EDIT' }));
    const back = host.getAttribute('style') ?? '';
    expect(back, '戻したのに元の高さへ戻っていない').toContain('height: 568px');
    expect(back, '詰めが戻っていない').toContain('padding-right: 6px');
    expect(back, '持ち越しの style が残っている').not.toContain('content-visibility');
    expect(back, '持ち越しの高さ 0 が残っている').not.toMatch(/height:\s*0(?:px)?\s*;/);
  });

  it('🔴 取り消しでも同じ ── ワーカーを呼ばず同じ節点が戻る', async () => {
    const { root, detail, render, s0 } = await open();
    const host = hostOf(root);
    const first = host.children[0]!;
    let editing = step(s0, { type: 'START_EDIT' });
    await show(detail, editing);
    editing = step(editing, { type: 'UPDATE_OPEN_BODY', body: BODY + '\n\n打ちかけ' });
    await show(detail, editing); // 編集中の再描画は何もしない
    const calls = render.mock.calls.length;
    await show(detail, step(editing, { type: 'CANCEL_EDIT' }));
    expect(render.mock.calls.length).toBe(calls);
    expect(hostOf(root)).toBe(host);
    expect(hostOf(root).children[0]).toBe(first);
  });

  it('🔴 本文を 1 行変えた保存 ── 差分で当てる(変わった塊だけ新しい節点。全部作り直さない)', async () => {
    const { root, detail, render, s0 } = await open();
    const host = hostOf(root);
    const before = Array.from(host.children);
    let editing = step(s0, { type: 'START_EDIT' });
    await show(detail, editing);
    const calls = render.mock.calls.length;
    const changed = BODY.replace('行 15', '行 15 を直した');
    editing = step(editing, { type: 'UPDATE_OPEN_BODY', body: changed });
    await show(detail, editing);
    await show(detail, step(editing, { type: 'COMMIT_EDIT' }));

    expect(render.mock.calls.length, '変わったのに描いていない').toBe(calls + 1);
    const back = hostOf(root);
    expect(back, '器が作り直されている').toBe(host);
    const after = Array.from(back.children);
    expect(after.length).toBe(before.length);
    const renewed = after.filter((el, i) => el !== before[i]);
    expect(renewed.length, '変わった塊のぶんだけ新しい節点のはず').toBeGreaterThan(0);
    expect(renewed.length, '全部作り直している(差分になっていない)').toBeLessThan(before.length / 2);
    expect(back.textContent).toContain('行 15 を直した');
    expect(back.getAttribute(PAINTED_ATTR)).toBe('a');
  });

  it('🔴 描画設定の鍵が違えば作り直す ── 編集中に旗を切ると、戻ったとき描き直す', async () => {
    const { root, detail, render, s0 } = await open();
    const editing = step(s0, { type: 'START_EDIT' });
    await show(detail, editing);
    const calls = render.mock.calls.length;
    appCodeCollapse.setEnabled(false);
    await show(detail, step(editing, { type: 'COMMIT_EDIT' }));
    expect(render.mock.calls.length, '鍵が違うのに描き直していない').toBe(calls + 1);
    expect(hostOf(root).getAttribute(PAINTED_ATTR)).toBe('a');
  });

  it('🔴 編集のまま別の画面へ出ると持ち越しを捨てる(節点が戻る)。編集の面は残る', async () => {
    const { root, detail, s0 } = await open();
    const editing = step(s0, { type: 'START_EDIT' });
    await show(detail, editing);
    expect(detail.holdsReadingView).toBe(true);
    const nodesWithHeld = root.querySelectorAll('*').length;

    detail.releaseHeld();

    expect(detail.holdsReadingView).toBe(false);
    expect(root.querySelector(`[${HELD_ATTR}]`), '持ち越した器が残っている').toBeNull();
    expect(root.querySelectorAll('*').length, '節点が減っていない').toBeLessThan(nodesWithHeld - 20);
    expect(root.querySelector('[data-pkc-field="editor-title"]'), '編集の面が消えた').not.toBeNull();
  });

  it('🔴 捨てた後に保存すると今までの経路(描く)に落ちる', async () => {
    const { root, detail, render, s0 } = await open();
    const host = hostOf(root);
    const editing = step(s0, { type: 'START_EDIT' });
    await show(detail, editing);
    detail.releaseHeld();
    const calls = render.mock.calls.length;
    await show(detail, step(editing, { type: 'COMMIT_EDIT' }));
    expect(render.mock.calls.length, '控えが無いのに描いていない').toBe(calls + 1);
    expect(hostOf(root), '捨てた器が戻っている').not.toBe(host);
    expect(root.querySelector(`[${HELD_ATTR}]`)).toBeNull();
  });

  it('🔴 戻るとき本文がまだ届いていなければ、持ち越しは使わず捨てる(常駐を残さない)', async () => {
    const { root, detail, s0 } = await open();
    const editing = step(s0, { type: 'START_EDIT' });
    await show(detail, editing);
    expect(detail.holdsReadingView).toBe(true);
    // 編集を抜けたが、本文(`openBody`)がまだ無い形 ── 持ち越しを戻せない
    await show(detail, { ...step(editing, { type: 'COMMIT_EDIT' }), openBody: null });
    expect(detail.holdsReadingView, '使えない持ち越しが残っている').toBe(false);
    expect(root.querySelector(`[${HELD_ATTR}]`), '持ち越した器が画面に残っている').toBeNull();
  });

  it('🔴 描き終えていない読む面は持ち越さない(今までどおり全部捨てる)', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const detail = new DetailRenderer(buildShell(root).detail);
    // 描く前に編集へ入った状態を直に渡す(骨組みも本文の器も無い)
    const editing = step(ready(), { type: 'START_EDIT' });
    detail.render(editing);
    await settle();
    expect(detail.holdsReadingView).toBe(false);
    expect(root.querySelector(`[${HELD_ATTR}]`)).toBeNull();
  });

  it('🔴 別のノートへ移ったら持ち越しの節点は使わない', async () => {
    const { root, detail, s0 } = await open();
    const editing = step(s0, { type: 'START_EDIT' });
    await show(detail, editing);
    let s = step(editing, { type: 'COMMIT_EDIT' });
    await show(detail, s);
    const host = hostOf(root);
    s = step(s, { type: 'SELECT_ENTRY', lid: 'b' });
    s = step(s, { type: 'BODY_LOADED', lid: 'b', body: '別のノート' });
    await show(detail, s);
    expect(hostOf(root).textContent).toContain('別のノート');
    expect(hostOf(root).textContent).not.toContain('行 3');
    expect(host.isConnected && host.textContent?.includes('行 3'), '前のノートの節点が残っている').toBeFalsy();
  });
});

/**
 * 🔴 **本文の器を探す所は、全部 `BODY_HOST_SELECTOR` を引く**(#1467 段 5)。
 *
 * 持ち越した読む面は編集のあいだ DOM に残る。`querySelector('[data-pkc-field="detail-body"]')` を直に書いた所は、
 * それを「読む面が在る」と読む ── 編集中は読む面が無い、が今までの前提だった。拾う側を全数で見る
 * (1 か所ずつ test を書くと、数え落とした 1 か所が静かに残る)。
 */
describe('detail: 本文の器を探す所の全数(#1467 段 5)', () => {
  const UI = join(process.cwd(), 'src/adapter/ui');
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
  }
  const files = walk(UI);
  /** `querySelector` / `querySelectorAll` の第 1 引数が、`detail-body` を直に書いた文字列のもの。 */
  const DIRECT = /querySelector(?:All)?(?:<[^>]*>)?\(\s*(['"`])(?:(?!\1)[^\\])*data-pkc-field="detail-body"\](?:(?!\1)[^\\])*\1/g;

  it('🔴 `detail-body` を直書きして探している所が 0 件(持ち越しの器を掴む)', () => {
    expect(files.length, '前提: 走査対象が空').toBeGreaterThan(50);
    const hits: string[] = [];
    for (const f of files) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      // 🔑 `[data-pkc-detail-mode="view"]` で絞った探し方は、編集中(= `editor`)は何も拾わない ── 持ち越しの器が在っても掴まない
      //    (`read-columns.ts` の `columnScroller`)。⚠ この絞りが無い直書きだけを数える
      for (const m of code.matchAll(DIRECT)) {
        if (m[0].includes('[data-pkc-detail-mode="view"]')) continue;
        hits.push(`${f.replace(process.cwd() + '/', '')}: ${m[0].slice(0, 90)}`);
      }
    }
    expect(hits, '持ち越した読む面を掴む探し方が残っている(`BODY_HOST_SELECTOR` を引く)').toEqual([]);
  });

  it('🔴 対照群: 正規表現は直書きを実際に拾い、`BODY_HOST_SELECTOR` を引く所は数えない', () => {
    const bad = `const h = root.querySelector<HTMLElement>('[data-pkc-field="detail-body"]');`;
    const bad2 = "document.querySelectorAll('.x [data-pkc-field=\"detail-body\"] img');";
    const good = 'root.querySelector<HTMLElement>(BODY_HOST_SELECTOR);';
    expect(bad.match(DIRECT)?.length, '正規表現が直書きを拾えない(空振り)').toBe(1);
    expect(bad2.match(DIRECT)?.length).toBe(1);
    expect(good.match(DIRECT)).toBeNull();
    // 引く所が実在する(0 件なら上の「0 件」は何も見ていない)
    const binder = readFileSync(join(UI, 'actions/binder.ts'), 'utf8');
    expect((binder.match(/BODY_HOST_SELECTOR/g) ?? []).length, 'binder が選択子を引いていない').toBeGreaterThanOrEqual(8);
  });
});

/**
 * 持ち越した画像の貸出(ObjectURL)── 同じ `<img>` を戻すので借り直さず、寿命の終端で返す。
 * ⚠ 読み込みが飛んでいるあいだは持ち越さない(読み込み中の節点を止めない)。
 */
describe('detail: 持ち越した画像の貸出(#1467 段 5)', () => {
  const IMG_BODY = '![写真](asset:abc)\n\n' + BODY;

  function lenderOf(auto: boolean) {
    let disposed = 0;
    let lent = 0;
    const pending: Array<() => void> = [];
    const lender: AssetLender = {
      lend: () =>
        new Promise((resolve) => {
          const go = (): void => {
            lent += 1;
            resolve({ url: `blob:fake/${String(lent)}`, dispose: () => void (disposed += 1) });
          };
          if (auto) go();
          else pending.push(go);
        }),
      getBlob: () => Promise.resolve(null),
    };
    return { lender, release: () => pending.splice(0).forEach((f) => f()), disposed: () => disposed, lent: () => lent };
  }

  async function openWith(lender: AssetLender) {
    const root = document.createElement('div');
    document.body.append(root);
    const markdown = new MarkdownClient();
    const render = vi.spyOn(markdown, 'render');
    const detail = new DetailRenderer(buildShell(root).detail, lender, markdown);
    let s = ready();
    s = step(s, { type: 'BODY_LOADED', lid: 'a', body: IMG_BODY });
    detail.render(s);
    await settle();
    return { root, detail, render, s };
  }

  it('🔴 読み込みが飛んでいるあいだは持ち越さない / 終わった後は持ち越す(対照群)', async () => {
    const l = lenderOf(false);
    const { root, detail, s } = await openWith(l.lender);
    expect(root.querySelector('img[data-pkc-asset-key]'), '前提: 画像が描かれていない').not.toBeNull();
    expect(l.lent(), '前提: 借りの返事を止められていない').toBe(0);

    await show(detail, step(s, { type: 'START_EDIT' }));
    expect(detail.holdsReadingView, '読み込み中なのに持ち越した').toBe(false);

    // 対照群 ── 読み込みが済んでいれば持ち越す
    const done = lenderOf(true);
    const r2 = await openWith(done.lender);
    await show(r2.detail, step(r2.s, { type: 'START_EDIT' }));
    expect(r2.detail.holdsReadingView, '済んでいるのに持ち越せない').toBe(true);
    l.release();
  });

  it('🔴 同じ <img> が戻り、借り直さず、別のノートへ移ったときに返す', async () => {
    const l = lenderOf(true);
    const { root, detail, s } = await openWith(l.lender);
    const img = root.querySelector<HTMLImageElement>('img[data-pkc-asset-key]')!;
    expect(img.getAttribute('src'), '前提: 画像が借りられていない').toBe('blob:fake/1');
    expect(l.lent()).toBe(1);

    const editing = step(s, { type: 'START_EDIT' });
    await show(detail, editing);
    expect(l.disposed(), '編集に入った時点で貸出が返っている').toBe(0);

    await show(detail, step(editing, { type: 'COMMIT_EDIT' }));
    expect(root.querySelector('img[data-pkc-asset-key]'), '<img> が作り直されている').toBe(img);
    expect(img.getAttribute('src')).toBe('blob:fake/1');
    expect(l.lent(), '戻ったときに借り直している').toBe(1);
    expect(l.disposed(), '戻ったときに返している').toBe(0);

    let moved = step(step(editing, { type: 'COMMIT_EDIT' }), { type: 'SELECT_ENTRY', lid: 'b' });
    moved = step(moved, { type: 'BODY_LOADED', lid: 'b', body: '別のノート' });
    await show(detail, moved);
    expect(l.disposed(), '別のノートへ移ったのに貸出が残っている').toBe(1);
  });
});

/**
 * 🔴 **戻すだけの経路でも、今日が動いた分は当て直す**(#1467 段 5 レビュー)。
 * 「あとN日」は属性で、描画のたびに計算する ── 描かずに戻す経路が呼び忘れると、編集のあいだに日付をまたいだとき古い日数が残る。
 */
describe('detail: 戻すだけの経路の「あとN日」(#1467 段 5)', () => {
  const REL_BODY = '期限 @2026-10-15\n\n' + BODY;
  const labelOf = (root: HTMLElement): string | null =>
    hostOf(root).querySelector('.pkc-date-link')?.getAttribute('data-pkc-rel') ?? null;

  it('🔴 日付をまたいで戻ると、描き直さずに「あとN日」だけ計算し直す', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T12:00:00'));
    const root = document.createElement('div');
    document.body.append(root);
    const markdown = new MarkdownClient();
    const render = vi.spyOn(markdown, 'render');
    const detail = new DetailRenderer(buildShell(root).detail, null, markdown);
    const s0 = step(ready(), { type: 'BODY_LOADED', lid: 'a', body: REL_BODY });
    await show(detail, s0);
    expect(labelOf(root), '前提: 開いたときに「あとN日」が付いていない').toBe('あと5日');
    const host = hostOf(root);

    const editing = step(s0, { type: 'START_EDIT' });
    await show(detail, editing);
    vi.setSystemTime(new Date('2026-10-11T12:00:00')); // 編集のあいだに日付をまたいだ
    const calls = render.mock.calls.length;
    await show(detail, step(editing, { type: 'COMMIT_EDIT' }));

    // 前提(これが崩れると下は「描き直したから新しい」で緑になる ── 速い経路を通ったことを見る)
    expect(render.mock.calls.length, '前提: 変更なしなのに描き直している(速い経路を通っていない)').toBe(calls);
    expect(hostOf(root), '前提: 器が作り直されている').toBe(host);
    expect(labelOf(root), '日をまたいだのに古い日数のまま').toBe('あと4日');
  });
});

/**
 * 🔴 **描画設定の鍵は、要素ごとに効く**(#1467 段 5 レビュー)。
 * `paintKeyOf` の 8 要素のうち 1 つを鍵から落としても、ほかの要素が救って緑のままにならないよう、
 * **1 要素だけ**を編集に入ってから戻るまでのあいだに動かして、描き直す(持ち越した節点を使わない)ことを見る。
 */
describe('detail: 描画設定の鍵(要素ごと)(#1467 段 5)', () => {
  interface Row {
    name: string;
    /** 編集に入ったあと・戻る前に 1 要素だけ動かす。状態を替えるなら新しい状態を返す。 */
    toggle: (s: AppState, policy: ExternalImagePolicy) => AppState | void;
  }
  const rows: Row[] = [
    { name: 'containerId', toggle: (s) => ({ ...s, cid: 'c2' }) },
    {
      name: 'allowExternalImages(このノートだけの同意)',
      toggle: (_s, policy) => {
        expect(policy.allows('a'), '前提: 同意が最初から出ている').toBe(false);
        policy.answer('a', 'allow');
        expect(policy.allows('a'), '前提: 同意を動かせていない').toBe(true);
      },
    },
    { name: '日付リンク', toggle: () => appDateLinks.setEnabled(false) },
    { name: '色見本', toggle: () => appColorSwatch.setEnabled(false) },
    { name: '電話リンク', toggle: () => appPhoneLinks.setEnabled(false) },
    { name: 'コードの折りたたみ', toggle: () => appCodeCollapse.setEnabled(false) },
    { name: 'インラインコードのコピー', toggle: () => appInlineCodeCopy.setEnabled(false) },
    { name: '「あとN日」', toggle: () => appRelativeDays.setEnabled(false) },
  ];

  it('🔴 対照群 ── 何も動かさなければ描き直さない(下の表の「描き直した」が本物の差だと言える)', async () => {
    const { detail, render, s0 } = await open(new ExternalImagePolicy(null));
    const editing = step(s0, { type: 'START_EDIT' });
    await show(detail, editing);
    const calls = render.mock.calls.length;
    await show(detail, step(editing, { type: 'COMMIT_EDIT' }));
    expect(render.mock.calls.length).toBe(calls);
  });

  it('🔴 表は鍵の 8 要素を全部持つ(足し忘れ・数え落とし)', () => {
    expect(rows.length).toBe(8);
  });

  it.each(rows.map((r) => [r.name, r] as const))('🔴 %s を動かすと、戻ったとき描き直す', async (_name, row) => {
    const policy = new ExternalImagePolicy(null);
    const { root, detail, render, s0 } = await open(policy);
    const editing = step(s0, { type: 'START_EDIT' });
    await show(detail, editing);
    expect(detail.holdsReadingView, '前提: 持ち越していない').toBe(true);
    const calls = render.mock.calls.length;

    const next = row.toggle(editing, policy);
    await show(detail, step(next ?? editing, { type: 'COMMIT_EDIT' }));

    expect(render.mock.calls.length, `${row.name} が鍵に入っていない(持ち越した節点をそのまま戻した)`).toBe(calls + 1);
    expect(hostOf(root).getAttribute(PAINTED_ATTR)).toBe('a');
  });
});

/**
 * 🔴 **持ち越しの寿命の終端で、借りた物が全部返る**(#1467 段 5 レビュー)。
 * 編集に入る(`disposeLends(true)`)では返さず、編集のまま別の画面へ出る(`releaseHeld`)では返す ──
 * 前者が返すと戻るとき `<img>` の URL が死に、後者が返さないと見えない所で URL が常駐する。
 */
describe('detail: 持ち越しの捨て方と貸出の返却(#1467 段 5)', () => {
  let made = 0;
  let revoked = 0;
  beforeEach(() => {
    made = 0;
    revoked = 0;
    vi.mocked(renderToPng).mockClear();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    // 図は「見えたとき」に焼く ── 観測を始めた瞬間に見えたことにする
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private readonly cb: (e: Array<{ target: Element; isIntersecting: boolean }>) => void) {}
        observe(el: Element): void {
          queueMicrotask(() => this.cb([{ target: el, isIntersecting: true }]));
        }
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:png/${String((made += 1))}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      revoked += 1;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function lenderOf() {
    let lent = 0;
    let disposed = 0;
    const lender: AssetLender = {
      lend: () => {
        lent += 1;
        return Promise.resolve({ url: `blob:fake/${String(lent)}`, dispose: () => void (disposed += 1) });
      },
      getBlob: () => Promise.resolve(null),
    };
    return { lender, lent: () => lent, disposed: () => disposed };
  }

  const FIG_BODY = '![写真](asset:abc)\n\n```mermaid\ngraph TD; A-->B\n```\n\n' + BODY;

  async function openFig() {
    const l = lenderOf();
    const root = document.createElement('div');
    document.body.append(root);
    const detail = new DetailRenderer(buildShell(root).detail, l.lender, new MarkdownClient());
    const s = step(ready(), { type: 'BODY_LOADED', lid: 'a', body: FIG_BODY });
    await show(detail, s);
    await settle();
    await settle();
    return { l, root, detail, s };
  }

  it('🔴 編集に入っても読む面の図・画像は返さず、`releaseHeld` で両方返る', async () => {
    const { l, detail, s } = await openFig();
    expect(l.lent(), '前提: 画像が借りられていない').toBe(1);
    expect(made, '前提: 図が焼かれていない').toBe(1);

    await show(detail, step(s, { type: 'START_EDIT' }));
    expect(detail.holdsReadingView, '前提: 持ち越していない').toBe(true);
    // 🔑 編集に入る = `disposeLends(true)`。読む面の借り物はここでは返さない(戻るときに同じ節点を使う)
    expect(l.disposed(), '編集に入った時点で画像の貸出が返っている').toBe(0);
    expect(revoked, '編集に入った時点で図の URL が返っている').toBe(0);

    // ⚠ 編集の下見も同じ本文を描くので、同じ画像・図の鍵を**共有して借りている**(1 つでも生きていれば返さない ── 正しい)。
    //    ここでは「持ち越した側が返す」を単独で見たいので、下見側の要素を画面から外してから捨てる
    const held = document.querySelector(`[${HELD_ATTR}]`)!;
    const outside = [...document.querySelectorAll('img[data-pkc-asset-key], [data-pkc-mermaid-src], img[data-pkc-field="mermaid-image"]')].filter(
      (e) => !held.contains(e),
    );
    expect(outside.length, '前提: 下見側に共有している要素が無い(外す意味が無い)').toBeGreaterThan(0);
    for (const e of outside) e.remove();

    detail.releaseHeld();

    expect(l.disposed(), '`releaseHeld` で画像の貸出が返っていない').toBe(1);
    expect(revoked, '`releaseHeld` で図の URL が返っていない').toBe(1);
    expect(detail.holdsReadingView).toBe(false);
  });

  it('🔴 `releaseHeld` は板・節の埋め込みの貸出も返す / 編集に入るだけでは返さない / SQL の答えは編集の下見も使うので触らない', async () => {
    const place = vi.spyOn(PlaceEmbeds.prototype, 'release');
    const section = vi.spyOn(SectionEmbeds.prototype, 'release');
    const sql = vi.spyOn(SqlEmbedHydrator.prototype, 'release');
    const { detail, s } = await openFig();
    const editing = step(s, { type: 'START_EDIT' });
    await show(detail, editing);
    expect(detail.holdsReadingView, '前提: 持ち越していない').toBe(true);
    place.mockClear();
    section.mockClear();
    sql.mockClear();
    detail.releaseHeld();
    expect(place, '板の埋め込みの貸出を返していない').toHaveBeenCalledTimes(1);
    expect(section, '節の埋め込みの貸出を返していない').toHaveBeenCalledTimes(1);
    expect(sql, '編集の下見も使う SQL の答えを手放している').not.toHaveBeenCalled();
    // 持ち越していないときは何もしない(対照群)
    place.mockClear();
    detail.releaseHeld();
    expect(place).not.toHaveBeenCalled();
  });

  it('🔴 対照群 ── 持ち越さない経路(別のノートへ移る)では、今までどおり全部返る', async () => {
    const { l, detail, s } = await openFig();
    expect(made, '前提: 図が焼かれていない').toBe(1);
    let moved = step(s, { type: 'SELECT_ENTRY', lid: 'b' });
    moved = step(moved, { type: 'BODY_LOADED', lid: 'b', body: '別のノート' });
    await show(detail, moved);
    expect(l.disposed()).toBe(1);
    expect(revoked).toBe(1);
  });
});

/** 🔴 持ち越した読む面の音・動画は止める(見えない所で鳴り続けない)。 */
describe('detail: 持ち越した読む面のメディア(#1467 段 5)', () => {
  it('🔴 編集に入ると、持ち越した器の audio / video を止める', async () => {
    const { root, detail, s0 } = await open();
    const host = hostOf(root);
    const audio = document.createElement('audio');
    const video = document.createElement('video');
    const pauseAudio = vi.fn();
    const pauseVideo = vi.fn();
    audio.pause = pauseAudio;
    video.pause = pauseVideo;
    host.append(audio, video);
    expect(pauseAudio, '前提: 編集に入る前に止めている').not.toHaveBeenCalled();

    await show(detail, step(s0, { type: 'START_EDIT' }));

    expect(detail.holdsReadingView, '前提: 持ち越していない').toBe(true);
    expect(pauseAudio, '持ち越した audio が鳴り続ける').toHaveBeenCalledTimes(1);
    expect(pauseVideo, '持ち越した video が鳴り続ける').toHaveBeenCalledTimes(1);
  });
});
