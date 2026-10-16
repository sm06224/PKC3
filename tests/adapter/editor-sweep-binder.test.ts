/** @vitest-environment happy-dom */
/**
 * 編集の入力まわりの直し(E2 / E3 / E4)── binder の配線を見る。
 * 各項に対照群(外では今までどおり働く)を置く ── 置かないと「元から何も起きない設定」で緑になる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { resetCellChains } from '../../src/adapter/state/shown-line';

function rootWith(html: string): HTMLElement {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

describe('E2: コード・数式の中では Enter でその場計算しない', () => {
  function enter(value: string) {
    const root = rootWith(
      '<div data-pkc-region="detail"><textarea data-pkc-field="row-source"></textarea></div>',
    );
    bindActions(root, new Dispatcher(), {});
    const ta = root.querySelector<HTMLTextAreaElement>('textarea')!;
    ta.value = value;
    ta.setSelectionRange(value.length, value.length);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return ta;
  }

  it('対照群: 普通の本文の `2+3=` は答えが入る', () => {
    expect(enter('2+3=').value, '対照群が計算していない ── 以下は空振り').toBe('2+3=5');
  });

  it('fence の中の `2+3=` には答えを入れない', () => {
    expect(enter('```\n2+3=').value).toBe('```\n2+3=');
  });

  it('数式の中の `2+3=` には答えを入れない', () => {
    expect(enter('$$\n2+3=').value).toBe('$$\n2+3=');
  });
});

describe('E3: 文字(表)と画像が一緒に来たら、画像にせず文字を貼る', () => {
  const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'x.png', { type: 'image/png' });
  const TABLE = '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>';

  function paste(data: Record<string, string>) {
    const root = rootWith(
      '<div data-pkc-region="detail"><textarea data-pkc-field="row-source"></textarea></div>',
    );
    const pasteImages = vi.fn(async (files: readonly File[]) => files.map(() => '![ず](asset:k1)'));
    const services: BinderServices = { attachFiles: () => {}, pasteImages };
    bindActions(root, new Dispatcher(), services);
    const ta = root.querySelector<HTMLTextAreaElement>('textarea')!;
    const e = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', {
      value: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => png }],
        getData: (t: string) => data[t] ?? '',
      },
    });
    ta.dispatchEvent(e);
    return { ta, e, pasteImages };
  }

  it('対照群: 画像だけのクリップボード(スクショ)は今までどおり画像になる', () => {
    const { pasteImages, e } = paste({});
    expect(pasteImages).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('🔴 表の HTML と文字が一緒なら、画像にせず表を貼る', () => {
    const { ta, pasteImages, e } = paste({ 'text/html': TABLE, 'text/plain': 'a\tb\nc\td' });
    expect(pasteImages, '画像にしてしまった(表が消える)').not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    expect(ta.value, '表が貼られていない').toContain('a');
    expect(ta.value).toContain('d');
  });

  it('文字だけ(plain)が一緒でも画像にしない', () => {
    const { pasteImages } = paste({ 'text/plain': 'a\tb\nc\td' });
    expect(pasteImages).not.toHaveBeenCalled();
  });
});

describe('E4: 表の升の欄 ── 変換の確定直後(keyCode 229)の Enter で確定しない', () => {
  const CSV_LINE = 'あ,い';
  const CSV_BODY = `\`\`\`csv\n${CSV_LINE}\n\`\`\`\n`;

  beforeEach(() => resetCellChains());

  function setup() {
    const dispatched: Array<Record<string, unknown>> = [];
    const dispatcher = {
      getState: () => ({
        phase: 'ready',
        selectedLid: 'n1',
        openBody: null,
        splitBodies: new Map([['n1', CSV_BODY]]),
      }),
      dispatch: (a: Record<string, unknown>) => dispatched.push(a),
    } as unknown as Dispatcher;
    const root = rootWith(
      '<table><tbody><tr>' +
        '<td data-pkc-action="edit-cell" data-pkc-cell-line="1" data-pkc-cell-col="0" data-pkc-cell-raw="あ">あ</td>' +
        '<td data-pkc-action="edit-cell" data-pkc-cell-line="1" data-pkc-cell-col="1" data-pkc-cell-raw="い">い</td>' +
        '</tr></tbody></table>',
    );
    bindActions(root, dispatcher, {});
    root.querySelector<HTMLElement>('td')!.click();
    const input = root.querySelector<HTMLInputElement>('[data-pkc-field="cell-input"]')!;
    return { input, dispatched };
  }

  it('対照群: 普通の Enter は確定して撃つ', () => {
    const { input, dispatched } = setup();
    expect(input, '前提:欄が開いていない').not.toBeNull();
    input.value = '品名';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(dispatched.length, '対照群が確定していない').toBe(1);
  });

  it('🔴 keyCode 229 の Enter(isComposing は false)では確定しない', () => {
    const { input, dispatched } = setup();
    input.value = '品名';
    const ev = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: false, bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    expect(dispatched, '変換の確定の Enter で升を確定した').toEqual([]);
    expect(ev.defaultPrevented).toBe(false);
  });
});
