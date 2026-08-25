/** @vitest-environment happy-dom */
/**
 * 🔴 **実装が在るのに誰も読んでいなかった 3 件**(#397)。
 *
 * ⚠ 3 件とも「未実装」ではなく「**作ったのに繋いでいない**」形だった ──
 *   そして 3 件とも `npm test` は緑だった(検査は「関数が正しく動くこと」を見ており、
 *   「**その関数が呼ばれていること**」は誰も見ていなかった)。
 * 🔑 だからここが見るのは**繋がり**である。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { AppState, Dispatchable } from '../../src/adapter/state/app-state';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const meta = (over: Partial<EntryMeta> = {}): EntryMeta => ({
  lid: 'n1',
  title: 'ノート',
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: 0,
  ...over,
});

describe('① 置換の「大小を区別」が画面から渡る (#397)', () => {
  /**
   * ⚠ **前の shell を残さない。**
   * `binder` は `target.closest('[data-pkc-slot="root"]')` で束ねを探すが、
   * その印は `index.html` 側に在る(`main.ts:2256` が読む)ので、
   * **裸の div に建てた test の shell には付かない** ── `ownerDocument.body` へ
   * 落ち、`querySelector` が**前の test の shell**を拾う。
   * 🔑 1 度これで 15 分溶かした(押した checkbox と、読まれた checkbox が別物だった)。
   */
  beforeEach(() => {
    document.body.textContent = '';
  });

  function setup() {
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const d = new Dispatcher();
    const sent: Dispatchable[] = [];
    const raw = d.dispatch.bind(d);
    d.dispatch = ((a: Dispatchable) => {
      sent.push(a);
      return raw(a);
    }) as typeof d.dispatch;
    bindActions(root, d);
    sent.length = 0;
    return { root, sent };
  }

  it('🔴 押す口が画面に在る(直す前はここが無かった)', () => {
    const { root } = setup();
    const box = root.querySelector<HTMLInputElement>('[data-pkc-field="replace-case"]');
    expect(box, '大小を区別する口が無い').not.toBeNull();
    // ⚠ 既定は**区別しない**(いままでの挙動を変えない)
    expect(box!.checked).toBe(false);
    // ⚠ 文言は**起きること**で書く(user 指示 2026-08-21)
    expect(box!.title).toContain('大文字と小文字が違う語は置き換えません');
  });

  /**
   * 🔴 **入れた / 入れないの両方**を見る。
   * ⚠ 片側だけだと「常に true を渡す」実装が生き延びる(§1「A || B」の同型)。
   */
  it('🔴 checkbox の状態がそのまま action に乗る(両側)', () => {
    const { root, sent } = setup();
    const box = root.querySelector<HTMLInputElement>('[data-pkc-field="replace-case"]')!;
    const press = (): Dispatchable | undefined => {
      sent.length = 0;
      root.querySelector<HTMLElement>('[data-pkc-action="replace-all"]')!.click();
      return sent.find((a) => a.type === 'REPLACE_IN_BODY');
    };
    expect(press()).toMatchObject({ caseSensitive: false });
    box.checked = true;
    expect(press(), '入れても渡っていない').toMatchObject({ caseSensitive: true });
  });

  /**
   * ⚠ **画面の操作から、本文の結果まで**見る ── action に乗ったことだけ見る test は、
   *   reducer が受け取った値を捨てても緑になる。
   */
  it('🔴 区別を入れると、大小の違う語は残る', () => {
    const booted = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta()],
      relations: [],
    }).state;
    // ⚠ `START_EDIT` は body を持たない ── `openBody` が**選択中の lid の分**として
    //    既に在るときだけ編集に入れる(未読 body の編集・保存を構造的に不可能にしてある)
    const picked = reduce(booted, { type: 'SELECT_ENTRY', lid: 'n1' }).state;
    const loaded = reduce(picked, { type: 'BODY_LOADED', lid: 'n1', body: 'Log log' }).state;
    const editing = reduce(loaded, { type: 'START_EDIT' }).state;
    expect(editing.phase, '前提が崩れた(編集に入れていない)').toBe('editing');
    const off = reduce(editing, {
      type: 'REPLACE_IN_BODY',
      find: 'log',
      replace: 'x',
      caseSensitive: false,
    }).state;
    const on = reduce(editing, {
      type: 'REPLACE_IN_BODY',
      find: 'log',
      replace: 'x',
      caseSensitive: true,
    }).state;
    // ⚠ 対照群(区別しない)を同じ it に置く ── 置かないと「常に区別する」でも緑
    expect(off.openBody?.body, '区別しないのに Log が残っている').toBe('x x');
    expect(on.openBody?.body, '区別を入れても Log が消えている').toBe('Log x');
  });
});

describe('② 本文の埋め込みは、まだ空の器のまま (#397)', () => {
  /**
   * 🔴 **いまの実物の挙動を pin する。**
   *
   * ⚠ ここに在ったコメントは「adapter-layer expander (`adapter/ui/transclusion.ts`)
   *   later replaces…」と**現在形で file 名まで名指し**していたが、
   *   **その file は存在しなかった** ── 次に読む人が「在るもの」として設計する形である。
   * 🔑 だから**空の器が残ること**を検査にした ── 展開する側を作った日に
   *   この test が落ちるので、**コメントごと直さざるを得ない**。
   */
  it('🔴 `![](entry:…)` は空の器になる(展開する側はまだ無い)', () => {
    const html = renderMarkdown('![説明](entry:n9)');
    expect(html, '器が出ていない').toContain('pkc-transclusion-placeholder');
    expect(html, '参照が保たれていない').toContain('n9');
    // ⚠ 画像として読みに行かない(404 とコンソールの汚れを作らない)
    expect(html, '`entry:` を img の src にしている').not.toContain('src="entry:');
  });
});

describe('③ todo の状態が情報ペインに出る (#397)', () => {
  function paint(m: EntryMeta): HTMLElement {
    const region = document.createElement('div');
    document.body.append(region);
    const st: AppState = reduce(
      reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [m], relations: [] }).state,
      { type: 'SELECT_ENTRY', lid: m.lid },
    ).state;
    new InspectorRenderer(region).render(st);
    return region;
  }

  it('🔴 status を持つノートでは、状態が出る', () => {
    const box = paint(meta({ status: 'done' })).querySelector<HTMLElement>(
      '[data-pkc-field="inspector-status"]',
    );
    expect(box, '状態の行が無い').not.toBeNull();
    expect(box!.hidden, '持っているのに畳まれている').toBe(false);
    expect(box!.textContent).toBe('完了');
  });

  it('未完了も出る(片方だけ出る実装を殺す)', () => {
    const box = paint(meta({ status: 'open' })).querySelector<HTMLElement>(
      '[data-pkc-field="inspector-status"]',
    );
    expect(box!.textContent).toBe('未完了');
  });

  /** ⚠ 知らない状態を**黙って捨てない**(そのまま出す)。 */
  it('知らない状態はそのまま出す', () => {
    const box = paint(meta({ status: 'あとで' })).querySelector<HTMLElement>(
      '[data-pkc-field="inspector-status"]',
    );
    expect(box!.textContent).toBe('あとで');
  });

  /** ⚠ 持っていないノートでは**行ごと畳む**(全ノートに「無し」を出さない)。 */
  it('🔴 持っていないノートでは行ごと畳む', () => {
    const region = paint(meta({ status: null }));
    const box = region.querySelector<HTMLElement>('[data-pkc-field="inspector-status"]')!;
    expect(box.hidden, '持っていないのに行が出ている').toBe(true);
    expect(
      (box.previousElementSibling as HTMLElement).hidden,
      '見出しだけ中身なしで残っている',
    ).toBe(true);
  });
});
