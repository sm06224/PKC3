/** @vitest-environment happy-dom */
/**
 * 🔴 **選んだ字を整える 5 つ**(#1233)を、本文の欄へ当てる。
 *
 * ⚠ 整え方そのもの(対応表・つなぎ目・選択の動き)は `tests/features/text-tidy.test.ts`。
 *   ここで見るのは**配線**だけである ──
 *   ①「操作を探す」に 5 つが**画面の字で**出る ②選ぶと、選んだ範囲だけが書き換わり、選びが結果に合う
 *   ③選んでいない / もう整っているときは**本文を 1 文字も変えず、理由を字で出す**
 *   ④書くのは `insertText`(`Ctrl+Z` で戻せる)で、置き換えるのは**範囲だけ**
 *   ⑤user が鍵を割り当てたとき、2 列の欄でも 1 面の行でも同じ口を通る。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { KEY_COMMANDS } from '../../src/features/keymap';
import { TIDY_NOTES } from '../../src/features/markdown/text-tidy';

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function setup(store = new KeymapStore(fakeStorage())) {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  const status: string[] = [];
  bindActions(root, d, { showStatus: (t) => void status.push(t) }, store);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  return { root, status };
}

function field(root: HTMLElement, name: string, text: string, start: number, end = start) {
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', name);
  ta.value = text;
  root.append(ta);
  ta.focus();
  ta.setSelectionRange(start, end);
  return ta;
}

const rowOf = (id: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-pkc-field="palette-row"]')].find(
    (b) => b.getAttribute('data-pkc-command') === id,
  );

async function openPalette(root: HTMLElement): Promise<void> {
  root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
  await tick();
}

async function pick(root: HTMLElement, id: string): Promise<void> {
  await openPalette(root);
  const row = rowOf(id);
  expect(row, `${id} の行が「操作を探す」に出ていない`).toBeDefined();
  row!.click();
  await tick();
  await tick();
}

/** 画面に出す 5 つの名前(id → 字)。⚠ 手で書く ── `KEY_COMMANDS` を種にしない。 */
const TIDY: readonly (readonly [string, string])[] = [
  ['tidy-join-lines', '改行を詰める'],
  ['tidy-to-halfwidth', '全角を半角にそろえる'],
  ['tidy-kana-to-fullwidth', '半角カナを全角にそろえる'],
  ['tidy-squeeze-blank-lines', '空行を減らす'],
  ['tidy-strip-bullets', '箇条書きの記号を外す'],
];

beforeEach(() => {
  document.body.innerHTML = '';
  resetAppDialogForTest();
});

describe('選んだ字を整える ── 「操作を探す」に出る', () => {
  it('🔴 5 つが画面の字で並び、鍵の既定は持たない', async () => {
    const { root } = setup();
    field(root, 'editor-body', 'あ', 0, 1);
    await openPalette(root);
    for (const [id, label] of TIDY) {
      const row = rowOf(id);
      expect(row, `${id} が「操作を探す」に出ていない`).toBeDefined();
      expect(row!.textContent, `${id} の名前`).toContain(label);
      const def = KEY_COMMANDS.find((c) => c.id === id);
      expect(def?.label).toBe(label);
      expect(def?.defaults, `${id}: 鍵の既定は置かない(user が割り当てる)`).toEqual([]);
    }
  });
});

describe('選んだ字を整える ── 配線', () => {
  it('🔴 改行を詰める: 選んだ行だけが 1 行になり、選びは結果に合う', async () => {
    const { root } = setup();
    const text = '前\nあ\nい\n後';
    const ta = field(root, 'editor-body', text, 2, 5);
    await pick(root, 'tidy-join-lines');
    expect(ta.value).toBe('前\nあい\n後');
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([2, 4]);
  });

  it('🔴 全角を半角にそろえる: 選んだ範囲の外は全角のまま', async () => {
    const { root } = setup();
    const ta = field(root, 'editor-body', 'Ａ１Ｂ２', 1, 3);
    await pick(root, 'tidy-to-halfwidth');
    expect(ta.value).toBe('Ａ1B２');
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([1, 3]);
  });

  it('🔴 半角カナを全角にそろえる: 濁点がまとまって字数が減り、選びも縮む', async () => {
    const { root } = setup();
    const ta = field(root, 'editor-body', 'xｶﾞｱy', 1, 4);
    await pick(root, 'tidy-kana-to-fullwidth');
    expect(ta.value).toBe('xガアy');
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([1, 3]);
  });

  it('🔴 空行を減らす', async () => {
    const { root } = setup();
    const text = 'a\n\n\n\nb';
    const ta = field(root, 'editor-body', text, 0, text.length);
    await pick(root, 'tidy-squeeze-blank-lines');
    expect(ta.value).toBe('a\n\nb');
  });

  it('🔴 箇条書きの記号を外す: 一部の行にだけ付いていても全部外れる', async () => {
    const { root } = setup();
    const text = '- あ\nい\n- う';
    const ta = field(root, 'editor-body', text, 0, text.length);
    await pick(root, 'tidy-strip-bullets');
    expect(ta.value).toBe('あ\nい\nう');
  });

  /**
   * 🔴 **書くのは `insertText`(= `execCommand`)** ── `value` 直代入だと**取り消しの履歴が切れる**(#765)。
   *   happy-dom に `execCommand` は無いので、ここで**本物の入口が呼ばれたこと**と、
   *   **差し替えた範囲が整えた行だけ**であることを見る。
   */
  it('🔴 `execCommand(insertText)` で、整えた範囲だけを差し替える(取り消せる)', async () => {
    const { root } = setup();
    const text = '前\nあ\nい\n後';
    const ta = field(root, 'editor-body', text, 2, 5);
    const calls: Array<{ cmd: string; text: string; start: number; end: number }> = [];
    const doc = document as unknown as { execCommand?: unknown };
    doc.execCommand = (cmd: string, _ui: boolean, t: string): boolean => {
      calls.push({ cmd, text: t, start: ta.selectionStart, end: ta.selectionEnd });
      ta.setRangeText(t, ta.selectionStart, ta.selectionEnd, 'end');
      return true;
    };
    try {
      await pick(root, 'tidy-join-lines');
    } finally {
      delete doc.execCommand;
    }
    expect(calls, '`insertText` を通っていない').toHaveLength(1);
    expect(calls[0]!.cmd).toBe('insertText');
    expect(text.slice(calls[0]!.start, calls[0]!.end)).toBe('あ\nい');
    expect(calls[0]!.text).toBe('あい');
    expect(ta.value).toBe('前\nあい\n後');
  });

  it('🔴 選んでいないと、5 つとも本文を変えず「範囲を選んで」と出る', async () => {
    for (const [id] of TIDY) {
      const { root, status } = setup();
      const text = '- Ａ\n\n\nｶﾞ';
      const ta = field(root, 'editor-body', text, 2);
      await pick(root, id);
      expect(ta.value, `${id}: 選んでいないのに本文が変わった`).toBe(text);
      expect(status, id).toEqual([TIDY_NOTES['no-selection']]);
    }
  });

  it('🔴 もう整っているときは、本文を変えず「整える所がありません」と出る(対照群: 全角なら変わる)', async () => {
    const { root, status } = setup();
    const clean = 'abc';
    const ta = field(root, 'editor-body', clean, 0, 3);
    await pick(root, 'tidy-to-halfwidth');
    expect(ta.value).toBe(clean);
    expect(status).toEqual([TIDY_NOTES.unchanged]);
    ta.value = 'ａｂｃ';
    ta.setSelectionRange(0, 3);
    await pick(root, 'tidy-to-halfwidth');
    expect(ta.value, '対照群: 全角なら半角になる').toBe('abc');
  });
});

describe('選んだ字を整える ── 鍵を割り当てたとき', () => {
  const press = (target: HTMLElement) =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'J',
        code: 'KeyJ',
        altKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

  it('🔴 2 列の欄でも、1 面の行の欄でも、同じ口で整う(行の欄で黙って捨てない)', () => {
    const store = new KeymapStore(fakeStorage());
    expect(store.addBinding('tidy-to-halfwidth', 'Alt+Shift+J')).toBeNull();
    const { root } = setup(store);
    const ta = field(root, 'editor-body', 'ＡＢ', 0, 2);
    press(ta);
    expect(ta.value).toBe('AB');
    ta.remove();
    const row = field(root, 'row-source', '１２', 0, 2);
    press(row);
    expect(row.value, '1 面の行で鍵が捨てられた').toBe('12');
  });
});
