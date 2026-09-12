/** @vitest-environment happy-dom */
/**
 * 🔴 **アプリのタイルの目印を、絵から選ぶ**(#770 段②、2026-09-12)。
 *
 * > user 要望 2026-09-07:「**アプリで使えるアイコンにも使用したい /
 * > なので、アイコン入力の補助としてパレット機能も欲しい**」
 *
 * ⚠ 直す前の実測: 「アイコン」欄に `calendar` と打つと、タイルには **`ca`** と出た
 *   ── 豆腐でも無反応でもなく、**それらしく壊れる**形だった。
 *
 * 🔑 ここが見るのは**繋がり**である(規則は `tests/features/launcher-tiles.test.ts`):
 *   ①選ぶ口が画面に在る ②押すと書込が飛ぶ ③**欄は消えていない**
 *   ④外す口が在る ⑤タイルが**字ではなく書体**で出る。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer, type AssetLender } from '../../src/adapter/ui/render/detail';
import { LauncherRenderer } from '../../src/adapter/ui/render/launcher';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';
import { TILE_ICON_CHOICES } from '../../src/features/icon/tile-icons';

const tick = (ms = 10): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: '電卓.html',
    archetype: 'attachment',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const body = (icon: string): string =>
  [
    '---',
    'attachment.name: 電卓.html',
    'attachment.mime: text/html',
    'attachment.asset_key: k',
    'attachment.registered_as_app: true',
    ...(icon === '' ? [] : [`attachment.app_icon: ${icon}`]),
    '---',
    '説明',
    '',
  ].join('\n');

const lender: AssetLender = {
  lend: async () => ({ url: 'blob:x', dispose: () => {} }),
  getBlob: async () => null,
};

beforeEach(() => {
  document.body.textContent = '';
});

function setup(icon: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail, lender);
  const d = new Dispatcher();
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  d.onState((s) => detail.render(s));
  bindActions(root, d);
  /**
   * ⚠ **disk を持つ**(書いたら読み直せる形)── 押した結果が本文に着地して、
   *   面が組み直されるところまで通したいので、固定値を返す fake では足りない。
   */
  const bodies: Record<string, string> = { a1: body(icon) };
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => bodies[lid] ?? null,
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      bodies[e.lid] = e.body;
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
  const q = <T extends HTMLElement>(sel: string): T | null => root.querySelector<T>(sel);
  const btn = (name: string): HTMLElement | null =>
    q(`[data-pkc-action="pick-app-icon"][data-pkc-icon-name="${name}"]`);
  return { root, d, sent, q, btn };
}

describe('目印を絵から選ぶ(#770 段②)', () => {
  it('🔴 選ぶ口が画面に在る ── そして**欄は消えていない**', async () => {
    const h = setup('🧮');
    await tick(20);
    expect(h.q('[data-pkc-field="app-icon-palette"]'), '選ぶ口が無い').not.toBeNull();
    // 🔴 欄を置き換えていない ── 絵文字を直に貼る道を減らさない(user 裁定 2026-08-07)
    const field = h.q<HTMLInputElement>('[data-pkc-field="app-icon"]');
    expect(field, 'アイコンの欄が消えた').not.toBeNull();
    expect(field!.value, '欄がいまの目印を見せていない').toBe('🧮');
    // ⚠ 空振り防止 ── 一覧が組めていないなら、下の test は何も見ていない
    expect(
      h.root.querySelectorAll('[data-pkc-action="pick-app-icon"]').length,
      '選べる絵が並んでいない',
    ).toBe(TILE_ICON_CHOICES.length + 1);
  });

  it('🔴 押すと、その絵で書込が飛ぶ', async () => {
    const h = setup('');
    await tick(20);
    h.sent.length = 0;
    h.btn('calculator')!.click();
    expect(h.sent, '押しても何も飛ばない(無言の dead click)').toEqual([
      { type: 'SET_APP_TILE', lid: 'a1', icon: 'calculator' },
    ]);
  });

  it('🔴 外す口が在る(置けるなら外せなければならない)', async () => {
    const h = setup('calculator');
    await tick(20);
    h.sent.length = 0;
    h.btn('')!.click();
    expect(h.sent).toEqual([{ type: 'SET_APP_TILE', lid: 'a1', icon: '' }]);
  });

  it('🔴 いま選んでいる絵が、押した状態で分かる', async () => {
    const h = setup('calculator');
    await tick(20);
    expect(h.btn('calculator')!.getAttribute('aria-pressed'), 'いまの絵が分からない').toBe('true');
    expect(h.btn('map')!.getAttribute('aria-pressed')).toBe('false');
    // 🔑 目印が無いときだけ「なし」が押されている
    expect(h.btn('')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('⚠ 絵文字を書いている人は、一覧のどれも押された形にならない', async () => {
    const h = setup('🧮');
    await tick(20);
    const pressed = [...h.root.querySelectorAll('[data-pkc-action="pick-app-icon"]')].filter(
      (b) => b.getAttribute('aria-pressed') === 'true',
    );
    expect(pressed, '絵文字なのに一覧のどれかが選ばれている').toHaveLength(0);
  });

  /**
   * 🔴 **押した絵にカーソルが残る**(2026-09-12、動線レビュー 2)。
   *
   * ⚠ 絵を選ぶと本文が変わり、この面は**丸ごと組み直される** ── 直す前は
   *   押したボタンごと消えて焦点が `body` へ落ちたので、**鍵だけで使う人は
   *   次の絵まで画面の頭から Tab で戻る**ことになっていた。
   */
  it('🔴 押した絵にカーソルが残る(鍵だけで次の絵へ移れる)', async () => {
    const h = setup('');
    await tick(20);
    const before = h.btn('calculator')!;
    before.focus();
    expect(document.activeElement, '押す前から焦点が無い(前提が崩れている)').toBe(before);
    before.click();
    await tick(40);
    const after = h.btn('calculator')!;
    // ⚠ 空振り防止 ── **本当に組み直された**ことを先に見る(同じ要素なら何も証明しない)
    expect(after, '面が組み直されていない(前提が崩れている)').not.toBe(before);
    expect(after.getAttribute('aria-pressed'), '押したのに書けていない').toBe('true');
    expect(document.activeElement, '組み直しで焦点が落ちた').toBe(after);
  });

  /**
   * 🔴 **押す前に何か分かる**(`icons.ts` の「図案だけのボタンを作らない」から外れる所)。
   * ⚠ 外す代わりに、**日本語の名前**を `title` と読み上げに必ず持たせる。
   */
  it('🔴 どの絵かが日本語で分かる(内部語を画面に出さない)', async () => {
    const h = setup('');
    await tick(20);
    const b = h.btn('calculator')!;
    expect(b.title).toBe('電卓');
    expect(b.getAttribute('aria-label')).toBe('電卓');
    // ⚠ 図案の器は読み上げに出さない(名前はボタンが持つ)
    expect(b.querySelector('[data-pkc-icon]')?.getAttribute('aria-hidden')).toBe('true');
  });
});

/**
 * 🔴 **横に並べた枠(留めた枠)には、この一覧を出さない**(2026-09-12、動線レビュー 1)。
 *
 * ⚠ 留めた枠は**選択と関係なく「その 1 件」**を出す面だが、`pick-app-icon` /
 *   `set-app-icon` / `set-app-group` / `toggle-app-tile` / `rename-attachment` は
 *   **`selectedLid`(主の枠のノート)**へ撃つ ── つまり留めた枠で押すと、
 *   **押していないノートの frontmatter が黙って書き換わる**。
 * 🔑 同じ面が**同じ事故を 1 か所で既に止めている** ── 帯は `pinnedLid !== null` で
 *   出さない(`detail.ts` の `renderBar`:「押した物と効く先が食い違う」)。
 *   添付の設定だけがその門を通っていなかった。
 * ⚠ ここで**捨てているのは「効かない口」**であって、動線ではない
 *   (留めた枠から設定したいなら、`splitBodies` を書き戻す経路が別に要る ── #770 に残す)。
 */
describe('留めた枠(横に並べた枠)', () => {
  function pinned() {
    const root = document.createElement('div');
    document.body.append(root);
    const host = document.createElement('div');
    root.append(host);
    const d = new Dispatcher();
    // ⚠ 8 番目が `pinnedLid` ── 留めた枠として描く
    const detail = new DetailRenderer(
      host,
      lender,
      undefined,
      null,
      undefined,
      undefined,
      undefined,
      'a1',
    );
    d.onState((s) => detail.render(s));
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('a1'), { ...meta('a2'), lid: 'a2', title: '別のノート' }],
      relations: [],
    });
    // ⚠ **主の枠は別のノートを選んでいる**(これが事故の前提)
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a2' });
    // ⚠ 留めていない lid の本文は reducer が**黙って捨てる** ── 先に留める
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'a1' });
    d.dispatch({ type: 'SPLIT_BODY_LOADED', lid: 'a1', body: body('calculator') });
    return { root };
  }

  it('🔴 留めた枠に、絵の一覧も登録の欄も出ない', () => {
    const { root } = pinned();
    // ⚠ 空振り防止 ── 留めた枠が**そもそも描けている**ことを先に見る
    expect(
      root.querySelector('[data-pkc-field="attachment-info"]'),
      '留めた枠に添付の面が描けていない(前提が崩れている)',
    ).not.toBeNull();
    expect(
      root.querySelector('[data-pkc-field="app-icon-palette"]'),
      '留めた枠に絵の一覧が出ている(押すと別のノートに書き込まれる)',
    ).toBeNull();
    expect(
      root.querySelector('[data-pkc-action="pick-app-icon"]'),
      '留めた枠に選ぶ口が出ている',
    ).toBeNull();
    expect(
      root.querySelector('[data-pkc-field="app-register"]'),
      '留めた枠に登録のチェックが出ている(押すと別のノートが登録される)',
    ).toBeNull();
    expect(
      root.querySelector('[data-pkc-action="rename-attachment"]'),
      '留めた枠に名前の欄が出ている(打つと別のノートが改名される)',
    ).toBeNull();
  });

  it('⚠ 主の枠では、いままでどおり全部出る(門を広げすぎていない)', async () => {
    const h = setup('calculator');
    await tick(20);
    expect(h.q('[data-pkc-field="app-icon-palette"]')).not.toBeNull();
    expect(h.q('[data-pkc-field="app-register"]')).not.toBeNull();
    expect(h.q('[data-pkc-action="rename-attachment"]')).not.toBeNull();
  });
});

describe('タイルに出る目印(#770 段②)', () => {
  function launcher() {
    const root = document.createElement('div');
    document.body.append(root);
    const region = document.createElement('div');
    root.append(region);
    const r = new LauncherRenderer(region);
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    const paint = (tile: Record<string, unknown>): HTMLElement | null => {
      d.dispatch({
        type: 'LAUNCHER_TILES_LOADED',
        tiles: [{ lid: 'a1', title: '電卓', group: '', kind: 'app', assetKey: 'k', ...tile }],
      } as Dispatchable);
      r.render(d.getState());
      return region.querySelector<HTMLElement>('[data-pkc-field="tile-icon"]');
    };
    return { paint };
  }

  /**
   * 🔴 **字を器に入れない**(CLAUDE.md §10)── 入れるとボタン丸ごとの
   *   `textContent` に見えない 1 文字が混ざり、文言を読む側が静かに外れる。
   */
  it('🔴 図案の目印は、書体が描く(器の字は空のまま)', () => {
    const icon = launcher().paint({ symbol: 'calculator' });
    expect(icon?.getAttribute('data-pkc-symbol'), '図案の名前が器に無い').toBe('calculator');
    expect(icon?.hasAttribute('data-pkc-icon'), '書体を当てる印が無い(豆腐になる)').toBe(true);
    expect(icon?.textContent, '器に字が入っている').toBe('');
  });

  it('🔴 絵文字の目印は、いままでどおり字で出る', () => {
    const icon = launcher().paint({ icon: '🧮' });
    expect(icon?.textContent).toBe('🧮');
    expect(icon?.hasAttribute('data-pkc-symbol'), '絵文字に図案の名前が付いた').toBe(false);
  });

  /**
   * 🔴 **題名の左端が、目印の種類でずれない**(#770 段②)。
   *
   * ⚠ 器の幅を `em` で書くと、**図案のときだけ字が 16px になる**(`[data-pkc-icon]`)ので
   *   1.25em = 20px、絵文字のときは 15px ── 同じ一覧の中で**題名の左端が 5px ずれる**。
   * 🔑 `tile-icon` の 1 行はもともと「有無で題名の左端がずれない」ために在るので、
   *   **種類でずれる**のは同じ約束を破っている。
   */
  it('🔴 目印の器の幅は px で固定(絵文字と図案で題名の左端がずれない)', () => {
    const css = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));
    const blocks = blocksFor(css, "[data-pkc-field='tile-icon']");
    // ⚠ 空振り防止 ── 規則を引けていないなら、下は何も見ていない
    expect(blocks.length, '目印の規則を引けていない(選択子が変わった)').toBe(1);
    const width = /(?:^|;)\s*width:\s*([^;]+)/.exec(blocks[0]!)?.[1]?.trim();
    expect(width, '目印の幅が書かれていない').toBeDefined();
    expect(width, `幅が em で書かれている(図案のときだけ広がる): ${width ?? ''}`).toMatch(
      /^\d+(?:\.\d+)?px$/,
    );
  });

  it('外のサイトのタイルは、目印が無ければ ↗ のまま', () => {
    const icon = launcher().paint({ kind: 'url', url: 'https://例/', assetKey: undefined });
    expect(icon?.textContent).toBe('↗');
  });
});
