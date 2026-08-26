/** @vitest-environment happy-dom */
/**
 * 🔴 **操作を名前で探す ── 画面との繋がり**(#425 段①)。
 *
 * ⚠ 一覧の**組み方**(絞り・並び・理由の字)は `tests/features/palette-rows.test.ts`。
 *   ここが見るのは**繋がり**である ── 開くか / いま押せるかを**実際の画面**から
 *   決めているか / 選んだら本当に実行されるか。
 *
 * 🔑 **`runGlobalCommand` は鍵とパレットの共通の 1 本**なので、ここが落ちる変異は
 *   近道も同時に殺す(CLAUDE.md §7 ── 判定を 2 か所に置かないための作り)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { DIALOG_REGION, resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { NOT_READY_PREFIX } from '../../src/features/palette/palette-rows';

function meta(lid: string, title: string): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: 0,
  };
}

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function setup() {
  document.body.innerHTML = '';
  resetAppDialogForTest();
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
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 'めも')], relations: [] });
  sent.length = 0;
  return { root, d, sent };
}

const dialog = (): HTMLDialogElement | null =>
  document.querySelector<HTMLDialogElement>(`[data-pkc-region="${DIALOG_REGION}"]`);
const filter = (): HTMLInputElement =>
  document.querySelector<HTMLInputElement>('[data-pkc-field="palette-filter"]')!;
const rows = (): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-pkc-field="palette-row"]')];
const rowOf = (id: string): HTMLButtonElement | undefined =>
  rows().find((b) => b.getAttribute('data-pkc-command') === id);
const whyOf = (id: string): string =>
  rowOf(id)?.querySelector('[data-pkc-field="palette-why"]')?.textContent ?? '';

/** 打鍵を document へ流す(近道の経路)。 */
const key = (init: KeyboardEventInit): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
};

beforeEach(() => {
  document.body.innerHTML = '';
  resetAppDialogForTest();
});

describe('操作を名前で探す(#425 段①)', () => {
  it('🔴 ボタンで開く ── マウスだけで完結する', async () => {
    const { root } = setup();
    const btn = root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]');
    expect(btn, '画面に開く口が無い(鍵しか無い機能になっている)').not.toBeNull();
    btn!.click();
    await tick();
    expect(dialog()?.open, '押しても開いていない').toBe(true);
    expect(rows().length, '一覧が空のまま出ている').toBeGreaterThan(0);
  });

  it('🔴 近道(Ctrl+Shift+P)でも開く ── ボタンと同じ 1 本を通る', async () => {
    setup();
    key({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true });
    await tick();
    expect(dialog()?.open, '近道で開いていない').toBe(true);
  });

  it('🔴 自分自身は並ばない(パレットからパレットを開く行に意味は無い)', async () => {
    const { root } = setup();
    root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
    await tick();
    expect(rows().length).toBeGreaterThan(0);
    expect(rowOf('open-palette'), 'パレット自身が一覧に出ている').toBeUndefined();
  });

  it('打った字で絞れる(打つたびに組み直す)', async () => {
    const { root } = setup();
    root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
    await tick();
    const before = rows().length;
    filter().value = 'ヘルプ';
    filter().dispatchEvent(new Event('input', { bubbles: true }));
    expect(rows().length, '絞れていない').toBeLessThan(before);
    expect(rowOf('open-help'), '当たるはずのものが落ちている').toBeDefined();
  });

  it('当たらない語では、空だと分かる字が出る(黙って空にしない)', async () => {
    const { root } = setup();
    root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
    await tick();
    filter().value = 'ぬるぽ';
    filter().dispatchEvent(new Event('input', { bubbles: true }));
    expect(rows()).toEqual([]);
    expect(
      document.querySelector('[data-pkc-field="palette-empty"]')?.textContent ?? '',
      '空を黙って出している',
    ).toContain('操作はありません');
  });

  describe('「いま押せるか」は画面から決まる', () => {
    /**
     * 🔴 **これが本題**(#425 の規律「押せない場面で黙らない」)。
     *
     * ⚠ `edit-entry` の押しボタン(`start-edit`)は**ノートを選んでいるときだけ**
     *   画面に在る ── 選んでいない間は「押せません」と**理由つきで**出す。
     * 🔑 対照群を同じ it に置く(選べば押せるようになる)── 置かないと
     *   「別の理由で常に押せないだけ」を次に見抜けない(CLAUDE.md §1)。
     */
    it('🔴 ノートを選んでいなければ「編集」は押せず、理由が出る', async () => {
      const { root } = setup();
      root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
      await tick();
      const row = rowOf('edit-entry');
      expect(row, '編集の行が出ていない').toBeDefined();
      expect(row!.disabled, '選んでいないのに押せることになっている').toBe(true);
      expect(whyOf('edit-entry'), '理由が出ていない').toContain(NOT_READY_PREFIX);
    });

    it('🔴 対照群 ── 「編集」の押しボタンが画面に在れば押せる', async () => {
      const { root } = setup();
      /**
       * ⚠ **押しボタンを手で置く** ── この rig は renderer を立てないので、
       *   `SELECT_ENTRY` を投げても `start-edit` は描かれない。見たいのは
       *   **「器が在れば押せると出る」という規則**そのものなので、器を置いて確かめる。
       * 🔑 これが無いと上の it は「別の理由で常に押せない」だけかもしれない
       *   (CLAUDE.md §1「対照群を同じ場面に置く」)。
       */
      const edit = document.createElement('button');
      edit.setAttribute('data-pkc-action', 'start-edit');
      root.append(edit);
      root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
      await tick();
      const row = rowOf('edit-entry');
      expect(row, '編集の行が出ていない').toBeDefined();
      expect(row!.disabled, '器が在るのに押せない').toBe(false);
      expect(whyOf('edit-entry'), '押せるのに断り書きが付いている').not.toContain(NOT_READY_PREFIX);
    });

    /**
     * 🔴 **`disabled` のボタンを「押せる」と言わない**(2026-08-26 に
     *   `nav-back` を特例から `SHORTCUT_BUTTON` へ寄せた理由そのもの)。
     * ⚠ 特例のままだと**履歴が無くても常に押せる**と出ていた。
     */
    it('🔴 履歴が無ければ「戻る」は押せない(器は在るが disabled)', async () => {
      const { root } = setup();
      const back = root.querySelector<HTMLButtonElement>('[data-pkc-action="nav-back"]')!;
      expect(back.disabled, '前提が崩れている(履歴が無いのに押せる)').toBe(true);
      root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
      await tick();
      expect(rowOf('nav-back')!.disabled, 'disabled のボタンを押せると言っている').toBe(true);
      // 🔑 対照群 ── 器ごと在る操作は押せる
      expect(rowOf('toggle-sidebar')!.disabled, '常に押せるはずのものが押せない').toBe(false);
    });
  });

  describe('選ぶと実行される', () => {
    it('🔴 押した行の操作が実際に走る', async () => {
      const { root, sent } = setup();
      root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
      await tick();
      rowOf('view-query')!.click();
      await tick();
      expect(
        sent.some((a) => a.type === 'SET_VIEW_MODE' && a.mode === 'query'),
        '選んだのに何も起きていない',
      ).toBe(true);
    });

    it('🔴 やめれば何も起きない', async () => {
      const { root, sent } = setup();
      root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
      await tick();
      document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-cancel"]')!.click();
      await tick();
      expect(sent, 'やめたのに何か走った').toEqual([]);
    });

    it('🔴 打っている最中の Enter は、1 番上の押せる行を実行する', async () => {
      const { root, sent } = setup();
      root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
      await tick();
      filter().value = '集計';
      filter().dispatchEvent(new Event('input', { bubbles: true }));
      const top = rows()[0];
      expect(top?.getAttribute('data-pkc-command'), '前提が崩れている(先頭が別の行)').toBe(
        'view-query',
      );
      expect(top!.disabled, '前提が崩れている(先頭が押せない)').toBe(false);
      filter().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await tick();
      expect(
        sent.some((a) => a.type === 'SET_VIEW_MODE' && a.mode === 'query'),
        'Enter で先頭の行が走っていない',
      ).toBe(true);
    });

    /**
     * 🔑 **対照群** ── 押せる行が 1 つも無い場面で Enter を押しても何も起きない。
     * ⚠ これが無いと、上の it は「Enter が**何かを**実行した」しか言えない
     *   (先頭を拾っている証拠にならない)。
     */
    it('🔴 押せる行が無ければ Enter は何もしない(器も閉じない)', async () => {
      const { root, sent } = setup();
      root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
      await tick();
      /**
       * ⚠ **行は出ているが、1 つも押せない**場面を作る ── 「確定」は
       *   2 列の編集の操作なので、パレット(全域)からは押せない。
       * 🔑 **空にしない**のが肝である ── 0 件だと「Enter が先頭を拾うか」を
       *   見られない(何も無いのだから当然何も起きない)。
       */
      filter().value = '確定';
      filter().dispatchEvent(new Event('input', { bubbles: true }));
      expect(rows().length, '前提が崩れている(行が 1 つも無い)').toBeGreaterThan(0);
      expect(
        rows().every((b) => b.disabled),
        '前提が崩れている(押せる行が混ざっている)',
      ).toBe(true);
      filter().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await tick();
      expect(sent, '押せない行を Enter が拾った').toEqual([]);
      expect(dialog()?.open, '勝手に閉じた').toBe(true);
    });

    it('⚠ 変換確定の Enter では実行しない(打っている途中の事故)', async () => {
      const { root, sent } = setup();
      root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
      await tick();
      filter().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await tick();
      expect(sent, '変換中の Enter で実行された').toEqual([]);
    });
  });
});
