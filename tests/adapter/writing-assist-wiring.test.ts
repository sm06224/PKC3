/** @vitest-environment happy-dom */
/**
 * 🔴 **繋がっているか**を見る(#396)。
 *
 * ⚠ 規則は `tests/features/*` が見ている。**ここが見るのは配線**である ──
 *   #397 で「作ったのに繋いでいない 3 件」を直したばかりなので、
 *   同じ穴を自分で開けない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('字下げ(Tab / Shift+Tab / Ctrl+] / Ctrl+[)が編集欄に繋がっている #1166', () => {
  const key = (ta: HTMLTextAreaElement, over: KeyboardEventInit): KeyboardEvent => {
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...over });
    ta.dispatchEvent(ev);
    return ev;
  };
  const tab = (ta: HTMLTextAreaElement, over: KeyboardEventInit = {}) =>
    key(ta, { key: 'Tab', ...over });
  const ctrl = (ta: HTMLTextAreaElement, glyph: '[' | ']') =>
    key(ta, {
      key: glyph,
      code: glyph === ']' ? 'BracketRight' : 'BracketLeft',
      ctrlKey: true,
    });

  /** ⚠ 取り消しの履歴が切れない書き方(`execCommand('insertText')`)を通ったかを見る。 */
  const inserted: string[] = [];
  beforeEach(() => {
    inserted.length = 0;
    // happy-dom に `execCommand` は無い ── 選択を置き換える本物の意味論を真似る
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn(
      (cmd: string, _ui?: boolean, value?: string) => {
        if (cmd !== 'insertText') return false;
        const ta = document.activeElement as HTMLTextAreaElement | null;
        const target = ta instanceof HTMLTextAreaElement ? ta : lastTa;
        inserted.push(value ?? '');
        const { selectionStart: s, selectionEnd: e, value: v } = target;
        const at = s + (value ?? '').length;
        target.value = v.slice(0, s) + (value ?? '') + v.slice(e);
        target.setSelectionRange(at, at);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      },
    );
  });
  afterEach(() => {
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });
  let lastTa!: HTMLTextAreaElement;
  const open = (value: string, caret: number, field: 'editor-body' | 'row-source' = 'editor-body') => {
    const { root } = setup();
    lastTa = editor(root, value, caret, field);
    return lastTa;
  };

  it('🔴 リストの行の Tab は字下げし、キーを握る', () => {
    const ta = open('- 牛乳\n- パン', 8);
    const ev = tab(ta);
    expect(ta.value).toBe('- 牛乳\n  - パン');
    expect(ev.defaultPrevented, '字下げしたのにキーを握っていない(焦点も動く)').toBe(true);
    expect(ta.selectionStart, 'caret が行の中身に付いていない').toBe(10);
  });

  it('🔴 番号付きは 3 つ入る', () => {
    const ta = open('1. あ', 5);
    tab(ta);
    expect(ta.value).toBe('   1. あ');
  });

  /** ⚠ 取り消し(Ctrl+Z)が効く書き方か ── `ta.value =` の代入は履歴を切る(#765)。 */
  it('🔴 書くのは insertText(取り消しの履歴を切らない)で、行の範囲だけ', () => {
    const ta = open('- 牛乳\n- パン', 8);
    tab(ta);
    expect(inserted, 'insertText を通っていない').toEqual(['  - パン']);
  });

  it('🔴 普通の段落の Tab は握らない(焦点が出ていく)', () => {
    const ta = open('通常のテキスト', 3);
    const ev = tab(ta);
    expect(ev.defaultPrevented, '普通の行なのに Tab が奪われた').toBe(false);
    expect(ta.value).toBe('通常のテキスト');
    expect(inserted).toEqual([]);
  });

  it('複数行を選んで Tab ── 地の文も入る', () => {
    const ta = open('あ\nい\nう', 0);
    ta.setSelectionRange(0, 3);
    const ev = tab(ta);
    expect(ta.value).toBe('  あ\n  い\nう');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('🔴 Shift+Tab は戻せる字下げがあるときだけ握る', () => {
    const ta = open('- a\n  - b', 9);
    const ev = tab(ta, { shiftKey: true });
    expect(ta.value).toBe('- a\n- b');
    expect(ev.defaultPrevented).toBe(true);
    // 対照群:もう戻せない行は握らない(焦点が前へ出る)
    const again = tab(ta, { shiftKey: true });
    expect(again.defaultPrevented, '戻せる字下げが無いのに Shift+Tab が奪われた').toBe(false);
    expect(ta.value).toBe('- a\n- b');
  });

  it('🔴 遠くのコードの塊の ${HOME} が、リストの行の Tab を奪わない', () => {
    const text = `- 牛乳\n${'あ'.repeat(500)}\n\`\`\`sh\necho \${HOME}\n\`\`\`\n`;
    const ta = open(text, 4);
    const ev = tab(ta);
    expect(ev.defaultPrevented).toBe(true);
    expect(ta.value.startsWith('  - 牛乳\n'), '印へ飛んで字下げされていない').toBe(true);
    expect(ta.selectionStart).toBe(6);
  });

  it('対照群:雛形の印(塊の外)が在れば、リストの行でも印が先(雛形を呼ぶ Tab を奪わない)', () => {
    const ta = open('- 牛乳 ${数}', 0);
    tab(ta);
    expect(ta.value, '印があるのに字下げが先に走った').toBe('- 牛乳 ${数}');
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('${数}');
  });

  it('🔴 Ctrl+] / Ctrl+[ は 2 列の欄で字下げ / 戻す(普通の 1 行にも効く)', () => {
    const ta = open('ふつう', 3);
    const ev = ctrl(ta, ']');
    expect(ta.value).toBe('  ふつう');
    expect(ev.defaultPrevented).toBe(true);
    ctrl(ta, '[');
    expect(ta.value).toBe('ふつう');
  });

  it('🔴 1 面のライブの行の欄でも Ctrl+] / Ctrl+[ が効く(Tab は行の保存のまま)', () => {
    const ta = open('1. あ', 5, 'row-source');
    const ev = ctrl(ta, ']');
    expect(ta.value).toBe('   1. あ');
    expect(ev.defaultPrevented).toBe(true);
    ctrl(ta, '[');
    expect(ta.value).toBe('1. あ');
    // 🔑 行の欄の Tab は字下げではない(行の保存は `row-swap.ts` が持つ)
    const t = tab(ta);
    expect(ta.value, 'ライブの行の欄で Tab が字下げになった').toBe('1. あ');
    void t;
  });
});

describe('行の入れ替え(Alt+↑ / Alt+↓)が編集欄に繋がっている #1213', () => {
  const alt = (ta: HTMLTextAreaElement, k: 'ArrowUp' | 'ArrowDown', over: KeyboardEventInit = {}) => {
    const ev = new KeyboardEvent('keydown', {
      key: k,
      code: k,
      altKey: true,
      bubbles: true,
      cancelable: true,
      ...over,
    });
    ta.dispatchEvent(ev);
    return ev;
  };

  /** ⚠ 取り消しの履歴が切れない書き方(`execCommand('insertText')`)を通ったかを見る。 */
  const inserted: string[] = [];
  /** 🔴 動かせなかったときに出る 1 行(#1254 §1)。 */
  const status: string[] = [];
  let lastTa!: HTMLTextAreaElement;
  beforeEach(() => {
    inserted.length = 0;
    status.length = 0;
    // happy-dom に `execCommand` は無い ── 選択を置き換える本物の意味論を真似る
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn(
      (cmd: string, _ui?: boolean, value?: string) => {
        if (cmd !== 'insertText') return false;
        inserted.push(value ?? '');
        const { selectionStart: s, selectionEnd: e, value: v } = lastTa;
        const at = s + (value ?? '').length;
        lastTa.value = v.slice(0, s) + (value ?? '') + v.slice(e);
        lastTa.setSelectionRange(at, at);
        lastTa.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      },
    );
  });
  afterEach(() => {
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });
  const open = (
    value: string,
    caret: number,
    field: 'editor-body' | 'row-source' = 'editor-body',
  ): HTMLTextAreaElement => {
    const { root } = setup({ showStatus: (t: string) => status.push(t) });
    lastTa = editor(root, value, caret, field);
    return lastTa;
  };

  it('🔴 2 列の欄: Alt+↓ で行が下と入れ替わり、caret が付いていく', () => {
    const ta = open('あ\nいう\nえ', 3);
    const ev = alt(ta, 'ArrowDown');
    expect(ta.value).toBe('あ\nえ\nいう');
    expect(ev.defaultPrevented, '動かしたのにキーを握っていない').toBe(true);
    expect(ta.selectionStart, 'caret が行に付いていない').toBe(5);
    // 続けて Alt+↑ で戻る
    alt(ta, 'ArrowUp');
    expect(ta.value).toBe('あ\nいう\nえ');
    expect(ta.selectionStart).toBe(3);
  });

  it('🔴 書くのは insertText(取り消しの履歴を切らない)で、入れ替えた 2 行だけ', () => {
    const ta = open('A\nB\nC\nD', 4);
    alt(ta, 'ArrowUp');
    expect(ta.value).toBe('A\nC\nB\nD');
    expect(inserted, 'insertText を通っていない(ta.value 直代入は取り消しを切る)').toEqual(['C\nB']);
  });

  it('複数行を選べば、選んだ行の塊ごと動く(選択は残る)', () => {
    const ta = open('あ\nい\nう\nえ', 0);
    ta.setSelectionRange(2, 5);
    alt(ta, 'ArrowDown');
    expect(ta.value).toBe('あ\nえ\nい\nう');
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([4, 7]);
  });

  it('🔴 欄の端では何も書かない ── ただしキーは握る(mac の Option+↑↓ を出さない)', () => {
    const top = open('あ\nい', 0);
    const evUp = alt(top, 'ArrowUp');
    expect(top.value).toBe('あ\nい');
    expect(evUp.defaultPrevented, '端でキーを握っていない').toBe(true);
    expect(inserted).toEqual([]);
    const bottom = open('あ\nい', 3);
    const evDown = alt(bottom, 'ArrowDown');
    expect(bottom.value).toBe('あ\nい');
    expect(evDown.defaultPrevented).toBe(true);
    expect(inserted).toEqual([]);
  });

  it('🔴 #1254 §1: 全文編集の端で動かせないときは「これ以上は動かせません」と言う(押した場所と対)', () => {
    const top = open('あ\nい', 0);
    alt(top, 'ArrowUp');
    expect(status, '先頭行で ↑ が無言だった').toEqual(['これ以上は動かせません']);
    status.length = 0;
    const bottom = open('あ\nい', 3);
    alt(bottom, 'ArrowDown');
    expect(status, '末尾行で ↓ が無言だった').toEqual(['これ以上は動かせません']);
  });

  it('🔴 #1254 §1: 1 画面編集の行の欄では「ここでは隣の行とは入れ替えません」(全文編集の字とは別)', () => {
    for (const k of ['ArrowUp', 'ArrowDown'] as const) {
      status.length = 0;
      const ta = open('# 見出し', 3, 'row-source');
      alt(ta, k);
      expect(status, `${k}`).toEqual(['ここでは隣の行とは入れ替えません(「全文を編集」なら動かせます)']);
    }
    // 複数行の塊でも、欄の端なら同じ字(全文編集の字ではない)
    status.length = 0;
    alt(open('- a\n- b', 0, 'row-source'), 'ArrowUp');
    expect(status).toEqual(['ここでは隣の行とは入れ替えません(「全文を編集」なら動かせます)']);
  });

  it('対照群(#1254 §1): 動かせたときは何も知らせない(全文編集も 1 画面編集の複数行の塊も)', () => {
    alt(open('あ\nい\nう', 3), 'ArrowDown');
    alt(open('- a\n- b\n- c', 5, 'row-source'), 'ArrowDown');
    expect(status).toEqual([]);
  });

  it('🔴 1 面のライブの行の欄(複数行の塊)でも効く', () => {
    const ta = open('- a\n- b\n- c', 5, 'row-source');
    const ev = alt(ta, 'ArrowDown');
    expect(ta.value).toBe('- a\n- c\n- b');
    expect(ev.defaultPrevented).toBe(true);
    expect(inserted).toEqual(['- c\n- b']);
    alt(ta, 'ArrowUp');
    expect(ta.value).toBe('- a\n- b\n- c');
  });

  it('🔴 1 行だけの塊の行の欄では何も起きない(隣の塊とは入れ替えない)', () => {
    for (const k of ['ArrowUp', 'ArrowDown'] as const) {
      const ta = open('# 見出し', 3, 'row-source');
      const ev = alt(ta, k);
      expect(ta.value, `${k} で 1 行の塊が動いた`).toBe('# 見出し');
      expect(ev.defaultPrevented).toBe(true);
    }
    expect(inserted).toEqual([]);
  });

  it('🔴 変換中(isComposing)は横取りしない', () => {
    for (const field of ['editor-body', 'row-source'] as const) {
      const ta = open('あ\nい', 3, field);
      const ev = alt(ta, 'ArrowUp', { isComposing: true });
      expect(ta.value, `${field}: 変換中に行を動かした`).toBe('あ\nい');
      expect(ev.defaultPrevented, `${field}: 変換中のキーを握った`).toBe(false);
    }
    expect(inserted).toEqual([]);
  });

  it('対照群: Alt を押さない ↑ / ↓ は何もしない(欄の既定のカーソル移動に任せる)', () => {
    const ta = open('あ\nい\nう', 3);
    const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    expect(ta.value).toBe('あ\nい\nう');
    expect(ev.defaultPrevented).toBe(false);
  });

  it('Shift / Ctrl を重ねた Alt+↓ は別の鍵 ── 行を動かさない', () => {
    for (const over of [{ shiftKey: true }, { ctrlKey: true }]) {
      const ta = open('あ\nい', 0);
      alt(ta, 'ArrowDown', over);
      expect(ta.value, JSON.stringify(over)).toBe('あ\nい');
    }
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


