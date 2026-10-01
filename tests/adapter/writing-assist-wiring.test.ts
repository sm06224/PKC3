/** @vitest-environment happy-dom */
/**
 * 🔴 **繋がっているか**を見る(#396)。
 *
 * ⚠ 規則は `tests/features/*` が見ている。**ここが見るのは配線**である ──
 *   #397 で「作ったのに繋いでいない 3 件」を直したばかりなので、
 *   同じ穴を自分で開けない。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { buildFormatBar } from '../../src/adapter/ui/render/format-bar';

beforeEach(() => {
  document.body.textContent = '';
});

function setup(services: Record<string, unknown> = {}) {
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
  // ⚠ 書式の帯は `buildShell` には入らない(`detail.ts` が編集に入るとき足す)──
  //    押す口を見るので、ここで組んで束ねの中へ入れる
  root.append(buildFormatBar());
  bindActions(root, d, services);
  return { root, d, sent };
}

/**
 * 編集欄を 1 つ置く(2 列の全文欄と同じ印)。
 * ⚠ **`[data-pkc-region="detail"]` の中**に置く ── 書式の効く先を探す
 *   `formatTarget` はその面の中しか見ない(実物と同じ形にしないと空振りする)。
 */
function editor(
  root: HTMLElement,
  value: string,
  caret: number,
  field: 'editor-body' | 'row-source' | 'append-input' = 'editor-body',
): HTMLTextAreaElement {
  let detail = root.querySelector<HTMLElement>('[data-pkc-region="detail"]');
  if (detail === null) {
    detail = document.createElement('div');
    detail.setAttribute('data-pkc-region', 'detail');
    root.append(detail);
  }
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', field);
  ta.value = value;
  detail.append(ta);
  ta.setSelectionRange(caret, caret);
  return ta;
}

const enter = (ta: HTMLTextAreaElement, over: Partial<KeyboardEventInit> = {}): void => {
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...over }));
};

describe('引用の継続が編集欄に繋がっている #396', () => {
  it('🔴 引用の行で Enter を押すと、`> ` が継ぎ足される', () => {
    const { root } = setup();
    const ta = editor(root, '> 引用', 4);
    enter(ta);
    expect(ta.value, '継ぎ足されていない(繋がっていない)').toBe('> 引用\n> ');
  });

  it('🔴 空の `> ` で Enter を押すと、引用から抜ける', () => {
    const { root } = setup();
    const ta = editor(root, '> あ\n> ', 6);
    enter(ta);
    expect(ta.value).toBe('> あ\n');
  });

  /**
   * ⚠ **修飾キー付きの Enter は別の意味**(確定 / 送信)なので触らない。
   * 🔑 対照群を同じ describe に置く ── 置かないと「常に効く」実装が生き延びる。
   */
  it('⚠ 修飾キー付きの Enter は触らない', () => {
    const { root } = setup();
    const ta = editor(root, '> 引用', 4);
    enter(ta, { ctrlKey: true });
    expect(ta.value, 'Ctrl+Enter まで奪っている').toBe('> 引用');
    enter(ta, { shiftKey: true });
    expect(ta.value, 'Shift+Enter まで奪っている').toBe('> 引用');
  });

  /** 🔴 変換中の Enter は **IME のもの**(日本語で書く人が毎回踏む)。 */
  it('🔴 変換中の Enter は触らない', () => {
    const { root } = setup();
    const ta = editor(root, '> 引用', 4);
    ta.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
    );
    expect(ta.value, '変換確定の Enter を奪っている').toBe('> 引用');
  });

  /** ⚠ 引用でない行では普通の改行のまま(奪わない)。 */
  it('引用でない行では何もしない', () => {
    const { root } = setup();
    const ta = editor(root, 'ただの本文', 3);
    enter(ta);
    expect(ta.value).toBe('ただの本文');
  });
});

describe('リストの継続が編集欄に繋がっている #1167', () => {
  it('🔴 `- ` の行で Enter を押すと、`- ` が継ぎ足される(全文欄・行の欄の両方)', () => {
    for (const field of ['editor-body', 'row-source'] as const) {
      const { root } = setup();
      const ta = editor(root, '- 牛乳', 4, field);
      enter(ta);
      expect(ta.value, `${field}: 継ぎ足されていない(繋がっていない)`).toBe('- 牛乳\n- ');
    }
  });

  it('番号は +1、チェックは未完了で続く', () => {
    const { root } = setup();
    const a = editor(root, '9. あ', 5);
    enter(a);
    expect(a.value).toBe('9. あ\n10. ');
    const b = editor(root, '- [x] 済', 8);
    enter(b);
    expect(b.value).toBe('- [x] 済\n- [ ] ');
  });

  it('🔴 記号だけの行で Enter を押すと、リストから抜ける', () => {
    const { root } = setup();
    const v = '- あ\n- [ ] ';
    const ta = editor(root, v, v.length);
    enter(ta);
    expect(ta.value, '記号が残っている').toBe('- あ\n');
  });

  /** ⚠ 追記の欄は引用と同じく入れない(Enter は計算にだけ使い、送るのは Ctrl+Enter)。 */
  it('🔴 追記欄では続けない(対照: 同じ値の全文欄では続く)', () => {
    const { root } = setup();
    const ap = editor(root, '- 牛乳', 4, 'append-input');
    enter(ap);
    expect(ap.value, '追記欄でリストが続いている').toBe('- 牛乳');
    const ed = editor(root, '- 牛乳', 4);
    enter(ed);
    expect(ed.value).toBe('- 牛乳\n- ');
  });

  it('⚠ Shift+Enter は記号を付けない普通の改行 / 変換中は触らない', () => {
    const { root } = setup();
    const ta = editor(root, '- 牛乳', 4);
    enter(ta, { shiftKey: true });
    enter(ta, { ctrlKey: true });
    ta.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
    );
    expect(ta.value).toBe('- 牛乳');
  });

  /**
   * 🔑 順番: 計算が先に答えを挿し、リストの継続は**挿した後の値**を読む。
   * ⚠ 継続が先に走ると `- 2+3=` の `=` の後ろで割れて、答えが次の行へ落ちる。
   */
  it('🔴 `- 2+3=` で Enter → 答えが先に入り、その行末から続く', () => {
    const { root } = setup();
    const ta = editor(root, '- 2+3=', 6);
    enter(ta);
    expect(ta.value).toBe('- 2+3=5\n- ');
  });

  it('コードの中では続けない', () => {
    const { root } = setup();
    const v = '```\n- コード';
    const ta = editor(root, v, v.length);
    enter(ta);
    expect(ta.value).toBe(v);
  });
});

describe('番号の振り直しが押せる #396', () => {
  it('🔴 押すと本文の番号が振り直される', () => {
    const status: string[] = [];
    const { root } = setup({ showStatus: (t: string) => status.push(t) });
    const ta = editor(root, '1. あ\n5. い', 0);
    root.querySelector<HTMLElement>('[data-pkc-action="renumber-lists"]')!.click();
    expect(ta.value, '振り直されていない(繋がっていない)').toBe('1. あ\n2. い');
    expect(status.join('')).toContain('振り直しました');
  });

  /** ⚠ **押して無反応にしない** ── 変わらなかったことも言う。 */
  it('🔴 もう揃っていたら、そう言う', () => {
    const status: string[] = [];
    const { root } = setup({ showStatus: (t: string) => status.push(t) });
    editor(root, '1. あ\n2. い', 0);
    root.querySelector<HTMLElement>('[data-pkc-action="renumber-lists"]')!.click();
    expect(status.join('')).toContain('もう揃っています');
  });

  it('編集していないときは理由を出す', () => {
    const { root, sent } = setup();
    sent.length = 0;
    root.querySelector<HTMLElement>('[data-pkc-action="renumber-lists"]')!.click();
    expect(sent.some((a) => a.type === 'OP_FAILED')).toBe(true);
  });
});

describe('素の Markdown で写せる #396', () => {
  it('🔴 押すと方言が落ちた本文が写る', () => {
    const copied: string[] = [];
    const { root, d } = setup({ copyText: (t: string) => copied.push(t), showStatus: () => 0 });
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        {
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
        },
      ],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: ':::note\n==目立つ==\n:::' });
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'copy-plain-markdown');
    root.append(btn);
    btn.click();
    expect(copied, '写していない(繋がっていない)').toEqual(['目立つ']);
  });

  it('本文が無ければ理由を出す', () => {
    const { root, sent } = setup({ copyText: () => 0 });
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'copy-plain-markdown');
    root.append(btn);
    sent.length = 0;
    btn.click();
    expect(sent.some((a) => a.type === 'OP_FAILED')).toBe(true);
  });
});

describe('表の編集アシスト(Tab / Shift+Tab)が編集欄に繋がっている #1093', () => {
  const tab = (ta: HTMLTextAreaElement, over: Partial<KeyboardEventInit> = {}): void => {
    ta.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, ...over }),
    );
  };

  it('🔴 表のセルで Tab を押すと、次のセルへ移動して内容を選択する', () => {
    const { root } = setup();
    const text = '| 列A | 列B |\n|---|---|\n| 1 | 2 |';
    const ta = editor(root, text, 2); // '列A' の位置
    tab(ta);
    expect(ta.selectionStart).toBe(text.indexOf('列B'));
    expect(ta.selectionEnd).toBe(text.indexOf('列B') + 2);
  });

  it('🔴 表のセルで Shift+Tab を押すと、前のセルへ戻る', () => {
    const { root } = setup();
    const text = '| 列A | 列B |\n|---|---|\n| 1 | 2 |';
    const posB = text.indexOf('列B');
    const ta = editor(root, text, posB);
    tab(ta, { shiftKey: true });
    expect(ta.selectionStart).toBe(text.indexOf('列A'));
    expect(ta.selectionEnd).toBe(text.indexOf('列A') + 2);
  });

  it('🔴 表の最終セルで Tab を押すと、新しい空行が追加されてその第1セルへ移る', () => {
    const { root } = setup();
    const text = '| 列A | 列B |\n|---|---|\n| 1 | 2 |';
    const pos2 = text.indexOf('2');
    const ta = editor(root, text, pos2);
    tab(ta);
    expect(ta.value).toBe('| 列A | 列B |\n|---|---|\n| 1 | 2 |\n|   |   |');
    // 新しい行の第1セルにカーソルが位置している
    expect(ta.selectionStart).toBe(text.length + 1 + 2); // '\n| ' の直後
  });

  it('⚠ 表の外では通常の Tab のまま(preventDefault されない)', () => {
    const { root } = setup();
    const text = '通常のテキスト';
    const ta = editor(root, text, 3);
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    expect(ev.defaultPrevented, '表の外なのに Tab が奪われた').toBe(false);
  });
});

describe('チェックリストの完了項目整理が押せる #1108', () => {
  it('🔴 押すと本文の完了タスクが末尾へ移動する', () => {
    const status: string[] = [];
    const { root } = setup({ showStatus: (t: string) => status.push(t) });
    const ta = editor(root, '- [x] 済\n- [ ] 未', 0);
    root.querySelector<HTMLElement>('[data-pkc-action="sort-tasks"]')!.click();
    expect(ta.value, '完了項目が末尾へ移動していない').toBe('- [ ] 未\n- [x] 済');
    expect(status.join('')).toContain('移動しました');
  });

  it('🔴 もう揃っていたら、そう言う', () => {
    const status: string[] = [];
    const { root } = setup({ showStatus: (t: string) => status.push(t) });
    editor(root, '- [ ] 未\n- [x] 済', 0);
    root.querySelector<HTMLElement>('[data-pkc-action="sort-tasks"]')!.click();
    expect(status.join('')).toContain('既に末尾に揃っています');
  });

  it('編集していないときは理由を出す', () => {
    const { root, sent } = setup();
    sent.length = 0;
    root.querySelector<HTMLElement>('[data-pkc-action="sort-tasks"]')!.click();
    expect(sent.some((a) => a.type === 'OP_FAILED')).toBe(true);
  });
});


