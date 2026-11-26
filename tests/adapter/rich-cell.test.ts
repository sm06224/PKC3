/** @vitest-environment happy-dom */
/**
 * 🔴 **リッチ編集のセル**(v4.0 Phase 1 / PR-05。PR-06 で設定「編集の仕方」= リッチ編集へ昇格)── `RowSwap` への組み込みの検査。
 *
 * 守ること:
 * ① 既定(live)では今までどおり原文の `<textarea>` が開く(既存無破壊)
 * ② リッチ編集で安全なブロックは `contenteditable` のセル、表せないブロックは原文の `<textarea>` へ自動で落ちる
 * ③ 何も変えずに閉じたら `commit` は 0 回(原文を 1 バイトも書き換えない)
 * ④ 書式の帯(太字・ハイライト・文字色・見出し)がセルに効き、確定で正しい PKC-Markdown が行の範囲だけ書き戻される
 * ⑤ 日本語入力: 変換中の `input` / `blur` で DOM を壊さず同期確定しない。`compositionend` の後に確定する
 * ⑥ 「原文」ボタンで、打った内容を失わずに `<textarea>` へ切り替えられる
 * ⑦ Enter で次のブロック(リストなら次の項目 / 空の項目ならリストを外す)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RowSwap } from '../../src/adapter/ui/render/row-swap';
import { activeRichCell, RICH_CELL_FIELD, RICH_INSERT_BUTTON_ATTR, RICH_SOURCE_BUTTON_ATTR, richCellOf } from '../../src/adapter/ui/render/rich-cell';
import { RICH_BACK_BUTTON_ATTR } from '../../src/adapter/ui/render/row-swap';
import { renderMarkdownWithRanges } from '../../src/features/markdown/source-ranges';
import { applyFormat } from '../../src/features/markdown/text-ops';
import { applyTextColor } from '../../src/features/markdown/word-format';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { DEFAULT_EDITOR_MODE, EDITOR_MODES } from '../../src/features/editor-mode';
import { findFlag } from '../../src/features/flags';

const DOC = [
  '# 題', //                         0
  '', //                             1
  '最初の段落。', //                  2
  '', //                             3
  '```js', //                        4
  'const  x = 1;  ', //              5
  '```', //                          6
  '', //                             7
  ':::format{align=center}', //      8
  '中央の段落', //                    9
  ':::', //                         10
  '', //                            11
  '- 一つめ', //                      12
  '- 二つめ', //                      13
  '', //                            14
  '面積は $x^2$ です。', //           15
].join('\n');

interface Rig {
  host: HTMLElement;
  swap: RowSwap;
  commits: { start: number; end: number; text: string }[];
  body(): string;
}

let richOn = true;
/** 可視の知らせ(rig の `notify`)。 */
const notes: string[] = [];

function rig(initial = DOC): Rig {
  const host = document.createElement('div');
  host.setAttribute('data-pkc-region', 'detail');
  document.body.append(host);
  const commits: Rig['commits'] = [];
  let body = initial;
  const swap = new RowSwap(
    host,
    {
      commit: (start, end, text) => {
        commits.push({ start, end, text });
        const lines = body.split('\n');
        body = [...lines.slice(0, start), ...text.split('\n'), ...lines.slice(end + 1)].join('\n');
        render(body);
      },
      notify: (m) => notes.push(m),
      onInserted: () => undefined,
      richEnabled: () => richOn,
    },
    new KeymapStore(null),
  );
  const render = (text: string): void => {
    const { html, ranges } = renderMarkdownWithRanges(text);
    expect(swap.update(text, html, ranges).ok).toBe(true);
  };
  render(body);
  return { host, swap, commits, body: () => body };
}

function findByText(host: HTMLElement, selector: string, text: string): Element {
  const hit = [...host.querySelectorAll(selector)].find((e) => e.textContent?.includes(text));
  if (!hit) throw new Error(`見つからない: ${selector} / ${text}`);
  return hit;
}

function openClick(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }));
}

const cellOf = (host: HTMLElement): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[data-pkc-field="${RICH_CELL_FIELD}"]`);
const rowOf = (host: HTMLElement): HTMLTextAreaElement | null =>
  host.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]');

/** セルの中の字を選ぶ(テキストノード 1 つの中)。 */
function selectText(cell: HTMLElement, needle: string): void {
  const walker = document.createTreeWalker(cell, 4);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const i = (n.nodeValue ?? '').indexOf(needle);
    if (i < 0) continue;
    const r = document.createRange();
    r.setStart(n, i);
    r.setEnd(n, i + needle.length);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    return;
  }
  throw new Error(`字が無い: ${needle}`);
}

function caretAtEnd(cell: HTMLElement): void {
  const r = document.createRange();
  r.selectNodeContents(cell);
  r.collapse(false);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(r);
}

/** 打鍵の代わり(caret の位置に字を入れて input を出す)。 */
function typeText(cell: HTMLElement, text: string): void {
  const sel = document.getSelection()!;
  const r = sel.getRangeAt(0);
  r.deleteContents();
  const t = document.createTextNode(text);
  r.insertNode(t);
  r.setStartAfter(t);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  cell.dispatchEvent(new Event('input', { bubbles: true }));
}

function key(cell: HTMLElement, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  cell.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  richOn = true;
  notes.length = 0;
  document.body.textContent = '';
});

describe('① 既定(live)では今までどおり', () => {
  it('既定の編集の仕方は live のまま(入れた瞬間に何も変わらない)。リッチ編集は設定の 3 択の 1 つで、flag は退役', () => {
    expect(DEFAULT_EDITOR_MODE).toBe('live');
    expect(EDITOR_MODES.map((m) => m.id)).toEqual(['live', 'rich', 'split']);
    expect(findFlag('editor.rich')).toBeNull();
  });

  it('段落を押すと原文の <textarea> が開き、セルは作られない', () => {
    richOn = false;
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落'));
    expect(rowOf(r.host)?.value).toBe('最初の段落。');
    expect(cellOf(r.host)).toBeNull();
  });

  it('richEnabled を渡さない呼び手(既存の配線)も原文の <textarea>', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const swap = new RowSwap(host, { commit: () => undefined, onInserted: () => undefined }, new KeymapStore(null));
    const { html, ranges } = renderMarkdownWithRanges('段落');
    swap.update('段落', html, ranges);
    openClick(host.querySelector('p')!);
    expect(rowOf(host)?.value).toBe('段落');
    expect(cellOf(host)).toBeNull();
  });
});

describe('② フラグ ON ── 安全なブロックはセル、表せないブロックは原文へ自動で落ちる', () => {
  it('段落は記号の無い contenteditable で開く', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落'));
    const cell = cellOf(r.host)!;
    expect(cell).not.toBeNull();
    expect(cell.getAttribute('contenteditable')).toBe('true');
    expect(cell.textContent).toBe('最初の段落。');
    expect(rowOf(r.host)).toBeNull();
    expect(r.swap.activeRange).toEqual({ start: 2, end: 2 });
  });

  it('見出しは同じレベルの見出しの要素で、記号(#)を出さずに開く', () => {
    const r = rig();
    openClick(findByText(r.host, 'h1', '題'));
    const cell = cellOf(r.host)!;
    expect(cell.tagName).toBe('H1');
    expect(cell.textContent).toBe('題');
  });

  it('リスト項目は項目だけを開き、ほかの項目は画面に残る', () => {
    const r = rig();
    openClick(findByText(r.host, 'li', '二つめ'));
    expect(cellOf(r.host)?.textContent).toBe('二つめ');
    expect(r.swap.activeRange).toEqual({ start: 13, end: 13 });
    expect(findByText(r.host, 'li', '一つめ')).toBeTruthy();
  });

  it.each([
    ['コードブロック', 'pre', 'const'],
    [':::format', '[data-pkc-align]', '中央の段落'],
    ['行内の数式', 'p', '面積は'],
  ])('%s は原文の <textarea> で開く', (_name, sel, text) => {
    const r = rig();
    openClick(findByText(r.host, sel, text));
    expect(cellOf(r.host)).toBeNull();
    expect(rowOf(r.host)).not.toBeNull();
  });
});

describe('③ 原本不変 ── 何も変えずに閉じたら commit は 0 回', () => {
  it('blur で閉じても、Escape で閉じても書かない', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落'));
    cellOf(r.host)!.dispatchEvent(new Event('blur'));
    expect(cellOf(r.host)).toBeNull();
    openClick(findByText(r.host, 'h1', '題'));
    key(cellOf(r.host)!, 'Escape');
    expect(cellOf(r.host)).toBeNull();
    expect(r.commits).toEqual([]);
    expect(r.body()).toBe(DOC);
    // 閉じたら描画が戻る(穴を残さない)
    expect(findByText(r.host, 'p', '最初の段落')).toBeTruthy();
  });

  it('打って確定すると、そのブロックの行だけが書き戻され、コード・:::format は 1 バイトも変わらない', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落'));
    const cell = cellOf(r.host)!;
    caretAtEnd(cell);
    typeText(cell, '追記 *星*');
    key(cell, 'Escape');
    expect(r.commits).toEqual([{ start: 2, end: 2, text: '最初の段落。追記 \\*星\\*' }]);
    expect(r.body()).toBe(DOC.replace('最初の段落。', '最初の段落。追記 \\*星\\*'));
    expect(r.body().split('\n').slice(4, 11)).toEqual(DOC.split('\n').slice(4, 11));
  });
});

describe('④ 書式(帯と同じ規則)がセルに効く', () => {
  it('太字・ハイライト・文字色を当てると即座にセルへ出て、確定で PKC-Markdown が書き戻される', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落'));
    let cell = cellOf(r.host)!;
    const rich = activeRichCell(r.host.parentElement!)!;
    expect(rich).not.toBeNull();
    selectText(cell, '最初');
    rich.applyEdit((sel) => applyFormat(sel, 'bold'));
    cell = cellOf(r.host)!;
    expect(cell.querySelector('strong')?.textContent).toBe('最初');
    selectText(cell, '段落');
    rich.applyEdit((sel) => applyFormat(sel, 'highlight'));
    expect(cellOf(r.host)!.querySelector('mark')?.textContent).toBe('段落');
    selectText(cellOf(r.host)!, '。');
    rich.applyEdit((sel) => applyTextColor(sel, '#e03131'));
    expect(cellOf(r.host)!.querySelector('[data-pkc-rich-color="#e03131"]')?.textContent).toBe('。');
    cellOf(r.host)!.dispatchEvent(new Event('blur'));
    expect(r.commits).toEqual([{ start: 2, end: 2, text: '**最初**の==段落==:。:#e03131:' }]);
  });

  it('もう一度太字を押すと外れる(トグル)── 結果が原文と同じなら書かない', () => {
    const r = rig('a **b** c');
    openClick(findByText(r.host, 'p', 'a'));
    const rich = activeRichCell(r.host.parentElement!)!;
    selectText(cellOf(r.host)!, 'b');
    rich.applyEdit((sel) => applyFormat(sel, 'bold'));
    expect(cellOf(r.host)!.querySelector('strong')).toBeNull();
    selectText(cellOf(r.host)!, 'b');
    rich.applyEdit((sel) => applyFormat(sel, 'bold'));
    expect(cellOf(r.host)!.querySelector('strong')?.textContent).toBe('b');
    cellOf(r.host)!.dispatchEvent(new Event('blur'));
    expect(r.commits).toEqual([]);
  });

  it('見出しの切替: 段落 → 見出し 2 → 見出し 3(セルの要素も変わる)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落'));
    const rich = activeRichCell(r.host.parentElement!)!;
    caretAtEnd(cellOf(r.host)!);
    rich.applyEdit((sel) => applyFormat(sel, 'h2'));
    expect(cellOf(r.host)!.tagName).toBe('H2');
    rich.applyEdit((sel) => applyFormat(sel, 'h3'));
    expect(cellOf(r.host)!.tagName).toBe('H3');
    key(cellOf(r.host)!, 'Escape');
    expect(r.commits).toEqual([{ start: 2, end: 2, text: '### 最初の段落。' }]);
  });

  it('表せない書式(段落の揃え)は原文の編集へ切り替えて適用する(壊さない)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落'));
    const rich = activeRichCell(r.host.parentElement!)!;
    caretAtEnd(cellOf(r.host)!);
    rich.applyEdit((sel) => applyFormat(sel, 'align-center'));
    expect(cellOf(r.host)).toBeNull();
    expect(rowOf(r.host)?.value).toBe(':::format{align=center}\n最初の段落。\n:::');
  });
});

describe('⑤ 日本語入力の契約', () => {
  it('変換中の input / blur では DOM を壊さず確定しない。compositionend の後に確定する', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落'));
    const cell = cellOf(r.host)!;
    caretAtEnd(cell);
    cell.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(r.swap.isComposing).toBe(true);
    typeText(cell, 'にほんご');
    const before = cell.innerHTML;
    // 変換中の Enter / Escape は IME のもの
    key(cell, 'Enter', { isComposing: true });
    key(cell, 'Escape', { isComposing: true });
    cell.dispatchEvent(new Event('blur'));
    expect(r.commits).toEqual([]);
    expect(cellOf(r.host)).toBe(cell);
    expect(cell.innerHTML).toBe(before);
    expect(cell.isConnected).toBe(true);
    cell.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    expect(r.commits).toEqual([{ start: 2, end: 2, text: '最初の段落。にほんご' }]);
    expect(cellOf(r.host)).toBeNull();
  });

  it('変換中は書式を当てない(DOM を置き換えない)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落'));
    const cell = cellOf(r.host)!;
    selectText(cell, '最初');
    cell.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    richCellOf(cell)!.applyEdit((sel) => applyFormat(sel, 'bold'));
    expect(cellOf(r.host)).toBe(cell);
    expect(cell.querySelector('strong')).toBeNull();
  });

  it('安全弁: 変換中なのに焦点が外れていたら封印を解く', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落'));
    const cell = cellOf(r.host)!;
    cell.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.focus();
    cell.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(r.swap.isComposing).toBe(false);
  });
});

describe('⑥ 「原文」ボタン(片道を作らない)', () => {
  it('打った内容を持って <textarea> へ切り替わり、確定でそのまま書かれる', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落'));
    const cell = cellOf(r.host)!;
    selectText(cell, '最初');
    activeRichCell(r.host.parentElement!)!.applyEdit((sel) => applyFormat(sel, 'bold'));
    const btn = r.host.querySelector<HTMLButtonElement>(`[${RICH_SOURCE_BUTTON_ATTR}]`)!;
    expect(btn.textContent).toBe('原文');
    btn.click();
    const ta = rowOf(r.host)!;
    expect(ta).not.toBeNull();
    expect(ta.value).toBe('**最初**の段落。');
    expect(cellOf(r.host)).toBeNull();
    expect(r.commits).toEqual([]);
    ta.dispatchEvent(new Event('blur'));
    expect(r.commits).toEqual([{ start: 2, end: 2, text: '**最初**の段落。' }]);
  });

  it('Alt+M でも切り替わる', () => {
    const r = rig();
    openClick(findByText(r.host, 'h1', '題'));
    key(cellOf(r.host)!, 'm', { altKey: true, code: 'KeyM' });
    expect(rowOf(r.host)?.value).toBe('# 題');
  });
});

describe('⑦ Enter で次のブロック', () => {
  it('リスト項目の末尾で Enter → 次の同じ種類の項目が開く', () => {
    const r = rig();
    openClick(findByText(r.host, 'li', '二つめ'));
    caretAtEnd(cellOf(r.host)!);
    key(cellOf(r.host)!, 'Enter');
    expect(r.commits).toEqual([{ start: 13, end: 13, text: '- 二つめ\n- ' }]);
    expect(r.swap.activeRange).toEqual({ start: 14, end: 14 });
    const cell = cellOf(r.host)!;
    expect(cell).not.toBeNull();
    typeText(cell, '三つめ');
    key(cell, 'Escape');
    expect(r.body()).toContain('- 一つめ\n- 二つめ\n- 三つめ\n');
  });

  it('空の項目で Enter → リストを外して段落へ', () => {
    const r = rig('- 一つめ\n- ');
    openClick(r.host.querySelectorAll('li')[1]!);
    expect(cellOf(r.host)).not.toBeNull();
    key(cellOf(r.host)!, 'Enter');
    const cell = cellOf(r.host)!;
    expect(cell).not.toBeNull();
    typeText(cell, '段落');
    key(cell, 'Escape');
    expect(r.body()).toBe('- 一つめ\n\n段落');
  });

  it('段落の途中で Enter → caret の後ろの字が次の段落になる', () => {
    const r = rig('前半後半');
    openClick(r.host.querySelector('p')!);
    const cell = cellOf(r.host)!;
    const t = cell.firstChild!;
    const range = document.createRange();
    range.setStart(t, 2);
    range.collapse(true);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    key(cell, 'Enter');
    expect(r.body()).toBe('前半\n\n後半');
    expect(cellOf(r.host)?.textContent).toBe('後半');
  });

  it('段落の末尾で Enter → 間に空の段落が開き、打つと前後に空行を補って入る', () => {
    const r = rig('一\n\n二');
    openClick(findByText(r.host, 'p', '一'));
    caretAtEnd(cellOf(r.host)!);
    key(cellOf(r.host)!, 'Enter');
    expect(r.commits).toEqual([]);
    const cell = cellOf(r.host)!;
    expect(cell.textContent).toBe('');
    typeText(cell, '間');
    key(cell, 'Escape');
    expect(r.body()).toBe('一\n\n間\n\n二');
  });

  it('Shift+Enter はブロックの中の改行(<br>)', () => {
    const r = rig('一');
    openClick(r.host.querySelector('p')!);
    const cell = cellOf(r.host)!;
    caretAtEnd(cell);
    key(cell, 'Enter', { shiftKey: true });
    typeText(cell, '二');
    key(cell, 'Escape');
    expect(r.body()).toBe('一\n二');
  });
});

describe('ブラウザ自前の書式・段落の挿入を止める(beforeinput)', () => {
  it('formatBold などは止め、DOM に <b> を入れさせない。ソフトキーボードの段落挿入は Enter と同じ', () => {
    const r = rig('一\n\n二');
    openClick(findByText(r.host, 'p', '一'));
    const cell = cellOf(r.host)!;
    caretAtEnd(cell);
    for (const inputType of ['formatBold', 'formatItalic', 'insertFromDrop', 'insertFromPaste']) {
      const ev = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
      cell.dispatchEvent(ev);
      expect(ev.defaultPrevented, inputType).toBe(true);
    }
    // 打つ字は止めない
    const typing = new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true });
    cell.dispatchEvent(typing);
    expect(typing.defaultPrevented).toBe(false);
    // 変換中は何も止めない
    cell.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const composing = new InputEvent('beforeinput', { inputType: 'insertParagraph', isComposing: true, bubbles: true, cancelable: true });
    cell.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    cell.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    // 段落の挿入 = Enter(間に空の段落が開く)
    const para = new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true });
    cellOf(r.host)!.dispatchEvent(para);
    expect(para.defaultPrevented).toBe(true);
    expect(cellOf(r.host)?.textContent).toBe('');
    expect(r.swap.activeRange).toEqual({ start: 1, end: 0 });
  });
});

describe('書き足す行(範囲が空)の描き直し', () => {
  it('開いている間に同じ本文の描き直しが来ても、閉じたらスロットが残らない(原文の欄・リッチの両方)', () => {
    for (const on of [false, true]) {
      richOn = on;
      document.body.textContent = '';
      const r = rig('一\n\n二');
      expect(r.swap.appendRow()).toBe(true);
      const { html, ranges } = renderMarkdownWithRanges(r.body());
      r.swap.update(r.body(), html, ranges);
      expect(r.host.querySelectorAll('[data-pkc-row-slot]').length, `on=${on}`).toBe(1);
      expect(r.host.lastElementChild?.hasAttribute('data-pkc-row-slot'), `on=${on}`).toBe(true);
      const field = cellOf(r.host) ?? rowOf(r.host)!;
      field.dispatchEvent(new Event('blur'));
      expect(r.host.querySelectorAll('[data-pkc-row-slot]').length, `on=${on}`).toBe(0);
      expect([...r.host.querySelectorAll('p')].map((p) => p.textContent), `on=${on}`).toEqual(['一', '二']);
    }
  });

  it('段落の間に開いた行も、描き直しで次の塊を飲み込まない', () => {
    const r = rig('一\n\n二');
    openClick(findByText(r.host, 'p', '一'));
    caretAtEnd(cellOf(r.host)!);
    key(cellOf(r.host)!, 'Enter');
    const { html, ranges } = renderMarkdownWithRanges(r.body());
    r.swap.update(r.body(), html, ranges);
    expect([...r.host.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['一', '二']);
    expect(cellOf(r.host)).not.toBeNull();
    key(cellOf(r.host)!, 'Escape');
    expect([...r.host.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['一', '二']);
    expect(r.host.querySelectorAll('[data-pkc-row-slot]').length).toBe(0);
  });
});

describe('貼り付けは素の字だけ', () => {
  it('HTML は入れず text/plain を字として入れる(改行は <br>)', () => {
    const r = rig('一');
    openClick(r.host.querySelector('p')!);
    const cell = cellOf(r.host)!;
    caretAtEnd(cell);
    const dt = new DataTransfer();
    dt.setData('text/html', '<b style="color:red">X</b><script>alert(1)</script>');
    dt.setData('text/plain', 'X*\nY');
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    cell.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(cell.querySelector('b,script')).toBeNull();
    key(cell, 'Escape');
    expect(r.body()).toBe('一X\\*\nY');
  });
});

/** 描き直しの着弾を待つ(予約した開き直しが走るまで)。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

describe('⑧ リッチ ⇔ 原文の双方向切替(PR-06。片道を作らない)', () => {
  it('Alt+M でリッチ → 原文 → リッチへ往復でき、打った字と位置を持って行く', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落'));
    let cell = cellOf(r.host)!;
    caretAtEnd(cell);
    typeText(cell, 'A');
    key(cell, 'm', { altKey: true, code: 'KeyM' });
    const ta = rowOf(r.host)!;
    expect(ta.value).toBe('最初の段落。A');
    expect(cellOf(r.host)).toBeNull();
    // 原文の欄の隣に「リッチ」ボタン(戻り道)が出ている
    expect(r.host.querySelector(`[${RICH_BACK_BUTTON_ATTR}]`)).not.toBeNull();
    ta.value = '最初の段落。A**B**';
    ta.setSelectionRange(3, 3);
    key(ta, 'm', { altKey: true, code: 'KeyM' });
    cell = cellOf(r.host)!;
    expect(cell, 'Alt+M でリッチへ戻らない').not.toBeNull();
    expect(rowOf(r.host)).toBeNull();
    expect(cell.querySelector('strong')?.textContent).toBe('B');
    expect(r.host.querySelector(`[${RICH_BACK_BUTTON_ATTR}]`)).toBeNull();
    // 往復しても確定は 1 回で、行の範囲だけ
    key(cell, 'Escape');
    expect(r.commits).toEqual([{ start: 2, end: 2, text: '最初の段落。A**B**' }]);
  });

  it('「リッチ」ボタンでも戻せる。往復しても欄の聞き手は二重にならない(Escape 1 回で 1 段)', () => {
    const r = rig();
    openClick(findByText(r.host, 'h1', '題'));
    r.host.querySelector<HTMLButtonElement>(`[${RICH_SOURCE_BUTTON_ATTR}]`)!.click();
    r.host.querySelector<HTMLButtonElement>(`[${RICH_BACK_BUTTON_ATTR}]`)!.click();
    expect(cellOf(r.host)?.tagName).toBe('H1');
    r.host.querySelector<HTMLButtonElement>(`[${RICH_SOURCE_BUTTON_ATTR}]`)!.click();
    const ta = rowOf(r.host)!;
    expect(ta.value).toBe('# 題');
    key(ta, 'Escape');
    expect(rowOf(r.host)).toBeNull();
    expect(r.commits).toEqual([]);
  });

  it('表せない記法を含むブロックは、理由を出して原文のまま(壊さない)', () => {
    const r = rig();
    openClick(findByText(r.host, 'pre', 'const'));
    const ta = rowOf(r.host)!;
    expect(r.host.querySelector(`[${RICH_BACK_BUTTON_ATTR}]`)).not.toBeNull();
    key(ta, 'm', { altKey: true, code: 'KeyM' });
    expect(cellOf(r.host)).toBeNull();
    expect(rowOf(r.host)).toBe(ta);
    expect(notes.at(-1)).toContain('原文のまま編集します');
  });

  it('既定(live)では原文の欄に「リッチ」ボタンは出ず、Alt+M も何もしない', () => {
    richOn = false;
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落'));
    const ta = rowOf(r.host)!;
    expect(r.host.querySelector(`[${RICH_BACK_BUTTON_ATTR}]`)).toBeNull();
    key(ta, 'm', { altKey: true, code: 'KeyM' });
    expect(cellOf(r.host)).toBeNull();
    expect(notes).toEqual([]);
  });
});

describe('⑨ セルの中の取り消し / やり直し(PR-06)', () => {
  it('太字・文字色を当てた直後の Ctrl+Z で当てる前へ戻り、Ctrl+Y / Ctrl+Shift+Z で当て直せる', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落'));
    const rich = activeRichCell(r.host.parentElement!)!;
    selectText(cellOf(r.host)!, '最初');
    rich.applyEdit((sel) => applyFormat(sel, 'bold'));
    selectText(cellOf(r.host)!, '段落');
    rich.applyEdit((sel) => applyTextColor(sel, 'red'));
    expect(rich.currentSource()).toBe('**最初**の:段落:red:。');
    const z = key(cellOf(r.host)!, 'z', { ctrlKey: true, code: 'KeyZ' });
    expect(z.defaultPrevented).toBe(true);
    expect(rich.currentSource()).toBe('**最初**の段落。');
    expect(cellOf(r.host)!.querySelector('strong')?.textContent).toBe('最初');
    key(cellOf(r.host)!, 'z', { ctrlKey: true, code: 'KeyZ' });
    expect(rich.currentSource()).toBe('最初の段落。');
    expect(cellOf(r.host)!.querySelector('strong')).toBeNull();
    key(cellOf(r.host)!, 'y', { ctrlKey: true, code: 'KeyY' });
    expect(rich.currentSource()).toBe('**最初**の段落。');
    key(cellOf(r.host)!, 'z', { ctrlKey: true, shiftKey: true, code: 'KeyZ' });
    expect(rich.currentSource()).toBe('**最初**の:段落:red:。');
    // 戻し切って閉じれば何も書かない(原本不変)
    key(cellOf(r.host)!, 'z', { ctrlKey: true, code: 'KeyZ' });
    key(cellOf(r.host)!, 'z', { ctrlKey: true, code: 'KeyZ' });
    key(cellOf(r.host)!, 'Escape');
    expect(r.commits).toEqual([]);
  });

  it('打った字も区切りで 1 手になる(書式の前に打った字は書式の取り消しで消えない)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落'));
    const rich = activeRichCell(r.host.parentElement!)!;
    caretAtEnd(cellOf(r.host)!);
    typeText(cellOf(r.host)!, '追記');
    selectText(cellOf(r.host)!, '追記');
    rich.applyEdit((sel) => applyFormat(sel, 'bold'));
    key(cellOf(r.host)!, 'z', { ctrlKey: true, code: 'KeyZ' });
    expect(rich.currentSource()).toBe('最初の段落。追記');
    key(cellOf(r.host)!, 'z', { ctrlKey: true, code: 'KeyZ' });
    expect(rich.currentSource()).toBe('最初の段落。');
  });

  it('🔴 変換中は記録も組み直しもしない(Ctrl+Z も IME のもの)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落'));
    const rich = activeRichCell(r.host.parentElement!)!;
    const cell = cellOf(r.host)!;
    cell.dispatchEvent(new Event('compositionstart'));
    caretAtEnd(cell);
    const sel = document.getSelection()!.getRangeAt(0);
    const t = document.createTextNode('へんかん');
    sel.insertNode(t);
    cell.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    expect(rich.historyDepth()).toEqual({ past: 0, future: 0 });
    const z = key(cell, 'z', { ctrlKey: true, code: 'KeyZ', isComposing: true });
    expect(z.defaultPrevented).toBe(false);
    expect(cellOf(r.host)).toBe(cell);
    expect(cell.contains(t), '変換中に DOM を組み直した').toBe(true);
    cell.dispatchEvent(new Event('compositionend'));
    expect(rich.historyDepth().past).toBe(1);
  });

  it('セルの履歴の先頭では素通しする(ブロックを跨ぐ取り消しへ譲る)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落'));
    const z = key(cellOf(r.host)!, 'z', { ctrlKey: true, code: 'KeyZ' });
    expect(z.defaultPrevented).toBe(false);
  });
});

describe('⑩ 空の段落の / でブロックを挿入(PR-06)', () => {
  function inRoot(r: Rig): HTMLElement {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    root.append(r.host);
    return root;
  }
  const menuOf = (root: HTMLElement): HTMLElement | null => root.querySelector<HTMLElement>('[data-pkc-rich-insert-menu]');

  async function emptyParagraph(): Promise<{ r: Rig; root: HTMLElement; cell: HTMLElement }> {
    const r = rig('前の段落\n\n後の段落');
    const root = inRoot(r);
    openClick(findByText(r.host, 'p', '前の段落'));
    caretAtEnd(cellOf(r.host)!);
    key(cellOf(r.host)!, 'Enter');
    await settle();
    const cell = cellOf(r.host)!;
    expect(cell.textContent).toBe('');
    return { r, root, cell };
  }

  it('/ を打つと一覧が開き、打った字で絞り込み、Escape で一覧だけ閉じて / は残る', async () => {
    const { r, root, cell } = await emptyParagraph();
    typeText(cell, '/');
    const menu = menuOf(root)!;
    expect(menu, '/ で一覧が開かない').not.toBeNull();
    expect([...menu.querySelectorAll('button')].map((b) => b.textContent)).toContain('見出し 2');
    typeText(cell, '見出し');
    expect([...menuOf(root)!.querySelectorAll('button[role="menuitem"]')].map((b) => b.textContent)).toEqual(['見出し 1', '見出し 2', '見出し 3']);
    // Esc は binder の受け手が閉じる(ここでは一覧が開いているのでセルは閉じない)
    key(cell, 'Escape');
    expect(cellOf(r.host)).toBe(cell);
    activeRichCell(root)!.closeInsertMenu();
    expect(menuOf(root)).toBeNull();
    expect(cell.textContent).toBe('/見出し');
  });

  it('🔴 変換中の / では開かない(確定してから)', async () => {
    const { root, cell } = await emptyParagraph();
    cell.dispatchEvent(new Event('compositionstart'));
    const t = document.createTextNode('／');
    document.getSelection()!.getRangeAt(0).insertNode(t);
    cell.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    expect(menuOf(root)).toBeNull();
    const ev = key(cell, '/', { isComposing: true });
    expect(ev.defaultPrevented).toBe(false);
    expect(menuOf(root)).toBeNull();
    cell.dispatchEvent(new Event('compositionend'));
    expect(menuOf(root), '確定した ／ で開かない').not.toBeNull();
  });

  it('↓ で選んで Enter → 見出し 2 になってリッチ編集を続け、確定で「## 」の原文になる', async () => {
    const { r, root, cell } = await emptyParagraph();
    typeText(cell, '/');
    expect(menuOf(root)).not.toBeNull();
    key(cell, 'ArrowDown');
    key(cell, 'ArrowDown');
    const active = menuOf(root)!.querySelector<HTMLElement>('[data-pkc-active]')!;
    expect(active.textContent).toBe('見出し 2');
    expect(active.getAttribute('data-pkc-rich-insert')).toBe('h2');
    expect(cellOf(r.host), '↓ で別のブロックへ移った').toBe(cell);
    // Enter は強調した項目を押して一覧を閉じる。押した項目は binder の受け手を通る ── ここでは binder が無いので、
    // 受け手と同じ口で当てる(binder の配線は下の「書式の帯の配線」で通す)
    key(cell, 'Enter');
    expect(menuOf(root)).toBeNull();
    activeRichCell(root)!.insertBlock('h2', true);
    const h = cellOf(r.host)!;
    expect(h.tagName).toBe('H2');
    expect(h.textContent).toBe('');
    typeText(h, '章');
    key(h, 'Escape');
    expect(r.body()).toBe('前の段落\n\n## 章\n\n後の段落');
  });

  it('コードブロックを選ぶとテンプレートを入れて原文の編集へ移る(caret は中)', async () => {
    const { r, root, cell } = await emptyParagraph();
    typeText(cell, '/code');
    activeRichCell(root)!.insertBlock('codeblock', true);
    const ta = rowOf(r.host)!;
    expect(ta.value).toBe('```\n\n```');
    expect(ta.selectionStart).toBe(4);
    key(ta, 'Escape');
    // 打っていた(/code)ので捨てるかを聞く ── ここは確定で閉じる
  });

  it('「+」ボタンでも同じ一覧が開く(中身のあるブロックでは、表をブロックの後ろに足す)', () => {
    const r = rig('本文');
    const root = inRoot(r);
    openClick(findByText(r.host, 'p', '本文'));
    r.host.querySelector<HTMLButtonElement>(`[${RICH_INSERT_BUTTON_ATTR}]`)!.click();
    expect(menuOf(root)?.getAttribute('data-pkc-rich-insert-menu')).toBe('button');
    activeRichCell(root)!.insertBlock('table', false);
    const ta = rowOf(r.host)!;
    expect(ta.value.startsWith('本文\n\n| 項目 | 値 |')).toBe(true);
    ta.dispatchEvent(new Event('blur'));
    expect(r.body().startsWith('本文\n\n| 項目 | 値 |\n|---|---|')).toBe(true);
  });
});

describe('⑪ ブロックの上下移動(Alt+↑ / Alt+↓。PR-06)', () => {
  it('段落を下のブロックと入れ替え、確定は 1 回、動かした先をリッチのまま開き直す', async () => {
    const r = rig('一の段落\n\n二の段落\n\n三の段落');
    openClick(findByText(r.host, 'p', '一の段落'));
    key(cellOf(r.host)!, 'ArrowDown', { altKey: true });
    expect(r.commits).toHaveLength(1);
    expect(r.body()).toBe('二の段落\n\n一の段落\n\n三の段落');
    await settle();
    expect(cellOf(r.host)?.textContent, '動かした先を開き直していない').toBe('一の段落');
    key(cellOf(r.host)!, 'ArrowUp', { altKey: true });
    expect(r.body()).toBe('一の段落\n\n二の段落\n\n三の段落');
  });

  it('打っていた字も一緒に動く。いちばん上では動かず理由を出す', async () => {
    const r = rig('# 題\n\n本文');
    openClick(findByText(r.host, 'h1', '題'));
    key(cellOf(r.host)!, 'ArrowUp', { altKey: true });
    expect(r.commits).toEqual([]);
    expect(notes.at(-1)).toContain('上へは動かせません');
    caretAtEnd(cellOf(r.host)!);
    typeText(cellOf(r.host)!, 'X');
    key(cellOf(r.host)!, 'ArrowDown', { altKey: true });
    expect(r.body()).toBe('本文\n\n# 題X');
  });

  it('リストの項目は隣の項目と入れ替え、リストの端では動かない', async () => {
    const r = rig('- 一\n- 二\n\n後');
    openClick(findByText(r.host, 'li', '一'));
    key(cellOf(r.host)!, 'ArrowDown', { altKey: true });
    expect(r.body()).toBe('- 二\n- 一\n\n後');
    await settle();
    expect(cellOf(r.host)?.textContent).toBe('一');
    key(cellOf(r.host)!, 'ArrowDown', { altKey: true });
    expect(r.body()).toBe('- 二\n- 一\n\n後');
    expect(notes.at(-1)).toContain('下へは動かせません');
  });
});

/** 書式の帯(binder)からセルへ ── 実際の画面の組み立てで、帯のボタンを押す。 */
describe('書式の帯の配線(DetailRenderer + binder)', () => {
  const unbinds: (() => void)[] = [];
  afterEach(() => {
    for (const u of unbinds.splice(0)) u();
    localStorage.removeItem('pkc3.editor-mode');
  });

  function meta(lid: string): EntryMeta {
    return { lid, title: 't', archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1, status: null, date: null, archived: false, bodyChars: null };
  }

  function editing(body: string) {
    localStorage.setItem('pkc3.editor-mode', 'rich');
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const detail = new DetailRenderer(regions.detail, null, undefined, (b) => d.dispatch({ type: 'UPDATE_OPEN_BODY', body: b }));
    d.onState((s) => detail.render(s));
    unbinds.push(bindActions(root, d, {}));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
    d.dispatch({ type: 'START_EDIT' });
    return { root, d };
  }

  it('段落を押すとセル、帯の「太字」で太字になり、確定で下書きの本文に PKC-Markdown が入る', async () => {
    const { root, d } = editing('# 題\n\n本文の段落\n\n```\ncode  \n```');
    const live = root.querySelector<HTMLElement>('[data-pkc-region="editor-live"]');
    expect(live, '1 面の編集の面が無い(この検査は何も見ていない)').not.toBeNull();
    // 描画が非同期でも着弾するまで待つ
    for (let i = 0; i < 20 && live!.querySelector('p') === null; i += 1) await new Promise((r) => setTimeout(r, 0));
    openClick(findByText(live!, 'p', '本文の段落'));
    const cell = live!.querySelector<HTMLElement>(`[data-pkc-field="${RICH_CELL_FIELD}"]`);
    expect(cell).not.toBeNull();
    selectText(cell!, '本文');
    const bold = root.querySelector<HTMLButtonElement>('[data-pkc-region="format-bar"] button[data-pkc-action="format-text"][data-pkc-format="bold"]');
    expect(bold).not.toBeNull();
    bold!.click();
    const cell2 = live!.querySelector<HTMLElement>(`[data-pkc-field="${RICH_CELL_FIELD}"]`)!;
    expect(cell2.querySelector('strong')?.textContent).toBe('本文');
    // 鍵(Ctrl+B)でも同じ 1 本 ── もう一度押すと外れる
    selectText(cell2, '本文');
    key(cell2, 'b', { ctrlKey: true, code: 'KeyB' });
    expect(live!.querySelector(`[data-pkc-field="${RICH_CELL_FIELD}"] strong`)).toBeNull();
    selectText(live!.querySelector<HTMLElement>(`[data-pkc-field="${RICH_CELL_FIELD}"]`)!, '本文');
    bold!.click();
    key(live!.querySelector<HTMLElement>(`[data-pkc-field="${RICH_CELL_FIELD}"]`)!, 'Escape');
    expect(d.getState().openBody?.body).toBe('# 題\n\n**本文**の段落\n\n```\ncode  \n```');
  });

  it('担当外の道具(番号を振り直す等)を押すと、セルは原文の欄へ切り替わる', async () => {
    const { root } = editing('段落');
    const live = root.querySelector<HTMLElement>('[data-pkc-region="editor-live"]')!;
    for (let i = 0; i < 20 && live.querySelector('p') === null; i += 1) await new Promise((r) => setTimeout(r, 0));
    openClick(live.querySelector('p')!);
    expect(live.querySelector(`[data-pkc-field="${RICH_CELL_FIELD}"]`)).not.toBeNull();
    activeRichCell(root)!.toSource();
    expect(live.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')?.value).toBe('段落');
  });

  it('/ の一覧で Enter を押すと binder の受け手(rich-insert-block)が当て、見出しになる', async () => {
    const { root, d } = editing('段落');
    const live = root.querySelector<HTMLElement>('[data-pkc-region="editor-live"]')!;
    for (let i = 0; i < 20 && live.querySelector('p') === null; i += 1) await new Promise((r) => setTimeout(r, 0));
    openClick(live.querySelector('p')!);
    const cell = live.querySelector<HTMLElement>(`[data-pkc-field="${RICH_CELL_FIELD}"]`)!;
    caretAtEnd(cell);
    key(cell, 'Enter');
    for (let i = 0; i < 20 && live.querySelector<HTMLElement>(`[data-pkc-field="${RICH_CELL_FIELD}"]`)?.textContent !== ''; i += 1) await new Promise((r) => setTimeout(r, 0));
    const empty = live.querySelector<HTMLElement>(`[data-pkc-field="${RICH_CELL_FIELD}"]`)!;
    caretAtEnd(empty);
    typeText(empty, '/');
    typeText(empty, '見出し');
    expect(root.querySelector('[data-pkc-rich-insert-menu="slash"]')).not.toBeNull();
    // 強調が無いときの Enter は先頭の項目(見出し 1)
    key(empty, 'Enter');
    const h = live.querySelector<HTMLElement>(`[data-pkc-field="${RICH_CELL_FIELD}"]`)!;
    expect(h.tagName).toBe('H1');
    expect(root.querySelector('[data-pkc-rich-insert-menu]')).toBeNull();
    typeText(h, '見出し');
    key(h, 'Escape');
    expect(d.getState().openBody?.body).toBe('段落\n\n# 見出し');
  });

  it('セルの履歴を戻し切った Ctrl+Z は、ブロックを跨ぐ取り消し(確定 1 件ずつ)へ譲る', async () => {
    const { root, d } = editing('一\n\n二');
    const live = root.querySelector<HTMLElement>('[data-pkc-region="editor-live"]')!;
    for (let i = 0; i < 20 && live.querySelector('p') === null; i += 1) await new Promise((r) => setTimeout(r, 0));
    openClick(findByText(live, 'p', '一'));
    let cell = live.querySelector<HTMLElement>(`[data-pkc-field="${RICH_CELL_FIELD}"]`)!;
    caretAtEnd(cell);
    typeText(cell, 'A');
    key(cell, 'Escape');
    expect(d.getState().openBody?.body).toBe('一A\n\n二');
    for (let i = 0; i < 20 && live.querySelector('p') === null; i += 1) await new Promise((r) => setTimeout(r, 0));
    openClick(findByText(live, 'p', '二'));
    cell = live.querySelector<HTMLElement>(`[data-pkc-field="${RICH_CELL_FIELD}"]`)!;
    expect(cell.textContent).toBe('二');
    key(cell, 'z', { ctrlKey: true, code: 'KeyZ' });
    expect(d.getState().openBody?.body).toBe('一\n\n二');
  });
});
