/** @vitest-environment happy-dom */
/**
 * 🔴 **「表の列幅を揃える」を、本文の欄へ当てる**(#1171)。
 *
 * ⚠ 揃え方そのもの(幅・寄せの印・カーソルの写し)は `tests/features/table-align.test.ts`。
 *   ここで見るのは**配線**だけである ── ①「操作を探す」から選ぶと 2 列の欄が書き換わる
 *   ②表の外 / もう揃っているときは**本文を 1 文字も変えず、理由を字で出す**
 *   ③1 面のライブ編集(`row-source`)は揃えず、行き先(「全文を編集」)を言う
 *   ④user が鍵を割り当てたとき、ライブの行でも**黙らない**。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';

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

function field(root: HTMLElement, name: string, text: string, caret: number) {
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', name);
  ta.value = text;
  root.append(ta);
  ta.focus();
  ta.setSelectionRange(caret, caret);
  return ta;
}

const rowOf = (id: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-pkc-field="palette-row"]')].find(
    (b) => b.getAttribute('data-pkc-command') === id,
  );

async function pick(root: HTMLElement, id: string): Promise<void> {
  root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
  await tick();
  const row = rowOf(id);
  expect(row, `${id} の行が「操作を探す」に出ていない`).toBeDefined();
  row!.click();
  await tick();
  await tick();
}

const TABLE = '前\n\n| 名前 | 価格 |\n|---|---|\n| りんご | 100 |\n\n後';
const ALIGNED = '前\n\n| 名前   | 価格 |\n| ------ | ---- |\n| りんご | 100  |\n\n後';

beforeEach(() => {
  document.body.innerHTML = '';
  resetAppDialogForTest();
});

describe('表の列幅を揃える ── 配線', () => {
  it('🔴 「操作を探す」から選ぶと、2 列の欄の表が揃い、カーソルは同じ升に残る', async () => {
    const { root } = setup();
    const caret = TABLE.indexOf('ご');
    const ta = field(root, 'editor-body', TABLE, caret);
    await pick(root, 'align-table');
    expect(ta.value, '表が揃っていない').toBe(ALIGNED);
    expect(ta.selectionStart, 'カーソルが同じ升の同じ字へ戻っていない').toBe(
      ALIGNED.indexOf('ご'),
    );
    expect(ta.selectionEnd).toBe(ta.selectionStart);
  });

  /**
   * 🔴 **書くのは `insertText`(= `execCommand`)** ── `value` 直代入だと**取り消しの履歴が
   *   切れる**(#765)。happy-dom に `execCommand` は無く、`insertText` は手で書き換える側を
   *   通るので、ここで**本物の入口が呼ばれたこと**と**差し替えた範囲が表の行だけ**であることを見る。
   */
  it('🔴 `execCommand(insertText)` で、表の行だけを差し替える(取り消せる)', async () => {
    const { root } = setup();
    const ta = field(root, 'editor-body', TABLE, TABLE.indexOf('ご'));
    const calls: Array<{ cmd: string; text: string; start: number; end: number }> = [];
    const doc = document as unknown as { execCommand?: unknown };
    doc.execCommand = (cmd: string, _ui: boolean, text: string): boolean => {
      calls.push({ cmd, text, start: ta.selectionStart, end: ta.selectionEnd });
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
      return true;
    };
    try {
      await pick(root, 'align-table');
    } finally {
      delete doc.execCommand;
    }
    expect(calls, '`insertText` を通っていない').toHaveLength(1);
    expect(calls[0]!.cmd).toBe('insertText');
    // 差し替えたのは表の 3 行だけ(前後の段落は選んでいない)
    expect(TABLE.slice(calls[0]!.start, calls[0]!.end)).toBe(
      '| 名前 | 価格 |\n|---|---|\n| りんご | 100 |',
    );
    expect(ta.value).toBe(ALIGNED);
    expect(ta.selectionStart).toBe(ALIGNED.indexOf('ご'));
  });

  it('🔴 表の外では本文を変えず、「表の外です」と出す', async () => {
    const { root, status } = setup();
    const ta = field(root, 'editor-body', TABLE, 0);
    await pick(root, 'align-table');
    expect(ta.value, '表の外で本文が変わった').toBe(TABLE);
    expect(status).toEqual(['表の外です']);
  });

  it('🔴 もう揃っているときは、本文を変えず「もう揃っています」と出す', async () => {
    const { root, status } = setup();
    const ta = field(root, 'editor-body', ALIGNED, ALIGNED.indexOf('ご'));
    await pick(root, 'align-table');
    expect(ta.value).toBe(ALIGNED);
    expect(status).toEqual(['もう揃っています']);
  });

  it('🔴 1 面のライブ編集の行では揃えず、「全文を編集」への切り替えを案内する', async () => {
    const { root, status } = setup();
    // 押した 1 行だけが欄に入っている(表が見えない)
    const line = '| りんご | 100 |';
    const ta = field(root, 'row-source', line, 3);
    await pick(root, 'align-table');
    expect(ta.value, 'ライブの行が書き換わった').toBe(line);
    expect(status).toHaveLength(1);
    expect(status[0]).toContain('表の列幅を揃えるには');
    // ⚠ 案内に書いた押し所の字が、画面のボタンの字と同じであること(行き止まりにしない)
    const label = /editAll\.textContent = '([^']+)'/.exec(
      readFileSync('src/adapter/ui/render/detail.ts', 'utf8'),
    );
    expect(label, '画面のボタンの字を引けなかった').not.toBeNull();
    expect(status[0]).toContain(`「${label![1]!}」`);
  });

  it('🔴 鍵を割り当てると、ライブの行でも黙らず案内が出る / 2 列の欄では揃う', () => {
    const store = new KeymapStore(fakeStorage());
    expect(store.addBinding('align-table', 'Alt+Shift+J')).toBeNull();
    const { root, status } = setup(store);
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
    const row = field(root, 'row-source', '| a |', 2);
    press(row);
    expect(row.value).toBe('| a |');
    expect(status, 'ライブの行で鍵が黙って捨てられた').toHaveLength(1);
    row.remove();
    // 🔑 対照群: 2 列の欄では同じ鍵で揃う(鍵そのものが死んでいない)
    const ta = field(root, 'editor-body', TABLE, TABLE.indexOf('ご'));
    press(ta);
    expect(ta.value).toBe(ALIGNED);
  });
});
