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
import { bindActions, formatTargetOf } from '../../src/adapter/ui/actions/binder';
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

/**
 * 🔴 **編集中の記法を、パレットから入れる**(#425 段②-b)。
 *
 * ⚠ 段②-a で 4 つの記法を鍵にだけ配線したので、パレットには**出るが押せなかった**
 *   (「いまは押せません」)。⚠ しかも器は modal な `<dialog>` なので、
 *   **開いた瞬間に編集欄から焦点が外れる** ── だから「いま押せるか」を
 *   **打つたびに**見ると、常に「押せません」になる。
 * 🔑 **開いた瞬間の欄を控える**のが直しである。
 */
describe('編集中の記法をパレットから入れる(#425 段②-b)', () => {
  /** 本文の欄を 1 つ作って焦点を当て、範囲を選ぶ。 */
  function editing(root: HTMLElement, text: string, start: number, end: number) {
    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'editor-body');
    ta.value = text;
    root.append(ta);
    ta.focus();
    ta.setSelectionRange(start, end);
    return ta;
  }

  it('🔴 本文の欄に居るときは、記法が「押せる」と出る', async () => {
    const { root } = setup();
    editing(root, 'あいうえお', 1, 4);
    root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
    await tick();
    expect(rowOf('format-ruby'), 'ルビの行が出ていない').toBeDefined();
    expect(whyOf('format-ruby'), '本文の欄に居るのに「押せません」と出ている').not.toContain(
      NOT_READY_PREFIX,
    );
  });

  /**
   * ⚠ **対照群** ── 欄に居なければ、これまでどおり「押せません」と出る
   *   (理由つき)。置かないと「常に押せる」実装でも緑になる。
   */
  it('⚠ 本文の欄に居なければ、これまでどおり理由が出る', async () => {
    const { root } = setup();
    root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
    await tick();
    expect(whyOf('format-ruby'), '押せない理由が出ていない').toContain(NOT_READY_PREFIX);
  });

  /**
   * 🔴 **選んだら、控えた欄の選んだ範囲に入る**(段②-b の本体)。
   * ⚠ 器が閉じるとき焦点はこの欄へ返る(`app-dialog` の後始末)── その上で当てる。
   */
  it('🔴 選ぶと、控えた欄の選んだ範囲へ記法が入る', async () => {
    const { root } = setup();
    const ta = editing(root, 'あいうえお', 1, 4);
    root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
    await tick();
    rowOf('format-highlight')!.click();
    await tick();
    await tick();
    expect(ta.value, '選んだ範囲に入っていない').toBe('あ==いうえ==お');
  });

  /**
   * 🔴 **焦点が返る瞬間に選択が `0,0` になっても、選んだ範囲へ入る**
   *   (2026-08-27。実ブラウザで **4 回中 1〜3 回**落ちていた形)。
   *
   * ⚠ 実測した event の並び:`blur 1,4` → **`focus 0,0`** → その後 `1,4` に戻る。
   *   当てるのがその瞬間に間に合うかで結果が分かれ、外すと
   *   `あ==いうえ==お` ではなく **`====あいうえお`** になる ──
   *   **user が選んでいない先頭に記法が入り、本文がずれる**。
   * 🔑 ここでは**その瞬間を作って**測る ── 開いたあとに選択を `0,0` へ潰しておき、
   *   それでも控えた範囲に入ることを見る(happy-dom には競合が無いので、
   *   手で潰さないとこの次元を 1 度も通らない)。
   * ⚠ smoke だけに頼らない ── あちらは**時機**に依るので、直っていても
   *   たまたま通ることがある(確定的に鳴るのはこの 1 本である)。
   */
  it('🔴 焦点が返る瞬間に選択が潰れても、控えた範囲へ入る', async () => {
    const { root } = setup();
    const ta = editing(root, 'あいうえお', 1, 4);
    root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
    await tick();
    // ⚠ **焦点が返る瞬間**を再現する(Chromium はここで一度 `0,0` を返す)
    ta.setSelectionRange(0, 0);
    rowOf('format-highlight')!.click();
    await tick();
    await tick();
    expect(ta.value, '選択が潰れた瞬間に当てて、先頭へ入っている').toBe('あ==いうえ==お');
  });

  /**
   * 🔴 **控えた欄が消えていたら、当てずに理由を出す**。
   * ⚠ 当てにいくと、別の要素は**選択範囲が先頭**なので
   *   **user が選んでいない所に記法が入る**(本文が静かに壊れる向き)。
   */
  it('🔴 欄が消えていたら、当てずに理由を出す(間違った所へ書かない)', async () => {
    const { root, sent } = setup();
    const ta = editing(root, 'あいうえお', 1, 4);
    root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
    await tick();
    ta.remove(); // 待っている間に面ごと組み直された形
    sent.length = 0;
    rowOf('format-highlight')!.click();
    await tick();
    await tick();
    const failed = sent.find((a) => a.type === 'OP_FAILED');
    expect(failed, '無言で終えた').toBeDefined();
    /**
     * ⚠ **中身まで見る**(2026-08-26 の変異試験 P5 が SURVIVED で教えた)──
     *   `error: ''` にしても「OP_FAILED が在る」は真なので、**画面には何も出ないのに緑**
     *   になる。🔑 帯は空文字を出さないので、**それは無言と同じ**である。
     */
    const msg = failed?.type === 'OP_FAILED' ? failed.error : '';
    expect(msg, '断り文が空(画面には何も出ない)').not.toBe('');
    expect(msg, 'なぜ入らなかったのかが書いていない').toContain('欄');
    expect(ta.value, '消えた欄へ書き込んだ').toBe('あいうえお');
  });

  /**
   * 🔑 **鍵とパレットで同じ形が入る**(§7)── 当て方を写していないことを、
   *   **出た字を突き合わせて**見る。⚠ 綴りを引き写す test にしない。
   */
  it('🔴 鍵で入れた形と、パレットで入れた形が一致する', async () => {
    const a = setup();
    const ta1 = editing(a.root, 'あいうえお', 1, 4);
    a.root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
    await tick();
    rowOf('format-ruby')!.click();
    await tick();
    await tick();
    const viaPalette = ta1.value;

    const b = setup();
    const ta2 = editing(b.root, 'あいうえお', 1, 4);
    ta2.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'R',
        code: 'KeyR',
        altKey: true,
        shiftKey: true,
      }),
    );
    expect(ta2.value, '鍵で入っていない(前提が崩れている)').not.toBe('あいうえお');
    expect(viaPalette, '鍵とパレットで入る形が違う').toBe(ta2.value);
  });
});

/**
 * 🔴 **記法を当てられる欄は、名前で決める**(#425 段②-b)。
 *
 * ⚠ 「`<textarea>` なら何でも」にすると、**継ぎ足しの欄**(`append-input`)まで
 *   相手になる ── 鍵の側は相手にしないので、**パレットと鍵で答えが違う**形になる
 *   (§7)。変異試験 P6 が SURVIVED で教えた。
 */
describe('記法を当てられる欄(#425 段②-b)', () => {
  const ta = (field: string): HTMLTextAreaElement => {
    const el = document.createElement('textarea');
    el.setAttribute('data-pkc-field', field);
    return el;
  };

  it('🔴 本文の欄(2 列 / 1 面)だけが相手になる', () => {
    expect(formatTargetOf(ta('editor-body')), '2 列の本文が相手にならない').not.toBeNull();
    expect(formatTargetOf(ta('row-source')), '1 面の行が相手にならない').not.toBeNull();
  });

  it('🔴 それ以外の欄は相手にしない(鍵の側と答えを揃える)', () => {
    expect(formatTargetOf(ta('append-input')), '継ぎ足しの欄まで相手にした').toBeNull();
    expect(formatTargetOf(ta('entry-filter')), '絞り込みの欄まで相手にした').toBeNull();
    const input = document.createElement('input');
    input.setAttribute('data-pkc-field', 'editor-title');
    expect(formatTargetOf(input), '題名の欄まで相手にした').toBeNull();
    expect(formatTargetOf(null)).toBeNull();
    expect(formatTargetOf(document.createElement('div'))).toBeNull();
  });
});

/**
 * 🔴 **「別のウィンドウで開く」を名前で探せる**(#690 I5、2026-09-04)。
 *
 * ⚠ 直す前は「窓」「付箋」「ウィンドウ」と打っても **0 行**だった ── 一覧は
 *   `KEY_COMMANDS` から出るので、鍵の無い操作は名前で探せない。右クリック / ⋯ /
 *   右の情報にしか無い物は、置き場を知らない人には無いのと同じである。
 * 🔑 呼び名の揺れ(ウィンドウ / 小窓 / 付箋)のどれで打っても当たること。
 */
describe('小窓を名前で探す(#690 I5)', () => {
  const search = async (root: HTMLElement, q: string): Promise<void> => {
    root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
    await tick();
    filter().value = q;
    filter().dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('🔴 「ウィンドウ」「小窓」「付箋」のどれで打っても出る', async () => {
    for (const q of ['ウィンドウ', '小窓', '付箋']) {
      const { root } = setup();
      await search(root, q);
      expect(rowOf('open-note-window'), `「${q}」で別のウィンドウで開くが出ない`).toBeDefined();
      expect(rowOf('open-note-window')!.textContent, '字が「別のウィンドウで開く」ではない').toContain(
        '別のウィンドウで開く',
      );
    }
  });

  /**
   * 🔴 **ノートを選んでいなければ「押せない」と言う**(嘘の「押せます」を出さない)。
   * ⚠ 情報ペインはノートを選ぶまで操作の帯を持たない(`shape === 'empty'`)ので、
   *   受け手のボタンが無い = 押せない、が正しい答えである。
   */
  it('🔴 情報ペインの帯が無ければ押せず、在れば押せる', async () => {
    const { root } = setup();
    await search(root, 'ウィンドウ');
    expect(rowOf('open-note-window')!.disabled, '何も選んでいないのに押せると言う').toBe(true);
    expect(whyOf('open-note-window'), '押せない理由が出ていない').toContain(NOT_READY_PREFIX);
    dialog()?.close();
    /**
     * 対照群 ── 情報ペインの帯(ノートを選ぶと出る)に受け手のボタンが在れば押せる。
     * ⚠ この台には描き手が居ないので、帯を手で建てる(`start-edit` の対照群と同じ作法)。
     * 🔑 **帯の中に限る**(`SHORTCUT_BUTTON` の選択子)── 右クリックの同名ボタンは
     *   押した行の lid を運ぶので、そちらを拾うと選んでいる物と違うノートが開く。
     */
    const band = document.createElement('div');
    band.setAttribute('data-pkc-field', 'inspector-actions');
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'open-note-window');
    band.append(btn);
    root.append(band);
    await search(root, 'ウィンドウ');
    expect(rowOf('open-note-window')!.disabled, '帯が在るのに押せない').toBe(false);
    expect(whyOf('open-note-window'), '押せるのに断り書きが付いている').not.toContain(NOT_READY_PREFIX);
  });

  /** ⚠ 帯の外の同名ボタン(右クリックのメニュー)は受け手に数えない。 */
  it('⚠ 帯の外の同名ボタンでは押せることにしない', async () => {
    const { root } = setup();
    const stray = document.createElement('button');
    stray.setAttribute('data-pkc-action', 'open-note-window');
    root.append(stray);
    await search(root, 'ウィンドウ');
    expect(rowOf('open-note-window')!.disabled, '帯の外のボタンを受け手に数えた').toBe(true);
  });
});
