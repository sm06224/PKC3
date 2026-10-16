/** @vitest-environment happy-dom */
/**
 * 書式バーの書き込みは、Ctrl+Z で戻せる形(`insertText`)で、変わった範囲だけを置き換える(#1087、#765)。
 *
 * 直す前は `writeBack` が `ta.value =` で全文を代入し、「完了項目を末尾へ」「番号を振り直す」は
 * `setRangeText` で書いていたので、どれもブラウザの取り消し履歴が切れた。
 * 実ブラウザの履歴は happy-dom では見えないので、ここでは `document.execCommand('insertText')` が
 * **変わった範囲だけ**を受け取ったこと(= 履歴に載る入口を通ったこと)を見る。
 * unit の fallback(`execCommand` が無い環境)でも、本文・選択範囲・input の回数は従来どおり。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';

function setup() {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  const said: string[] = [];
  bindActions(root, d, { showStatus: (t) => void said.push(t) });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', 'editor-body');
  // 書式の効く先は detail 領域の中の欄(`formatTarget`)
  root.querySelector('[data-pkc-region="detail"]')!.append(ta);
  const inputs: number[] = [];
  ta.addEventListener('input', () => inputs.push(1));
  const press = (attr: string, value: string): void => {
    const b = document.createElement('button');
    b.setAttribute(attr, value);
    if (attr === 'data-pkc-format') b.setAttribute('data-pkc-action', 'format-text');
    root.append(b);
    b.click();
  };
  const action = (name: string): void => {
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', name);
    root.append(b);
    b.click();
  };
  return { root, d, ta, said, inputs, press, action };
}

type Call = { cmd: string; text: string; start: number; end: number };

/** `execCommand('insertText')` を持つ環境を真似る(履歴に載る入口)。呼ばれ方を記録する。 */
function withExecCommand(ta: HTMLTextAreaElement): { calls: Call[]; off: () => void } {
  const calls: Call[] = [];
  const doc = document as unknown as { execCommand?: unknown };
  doc.execCommand = (cmd: string, _ui: boolean, text: string): boolean => {
    calls.push({ cmd, text, start: ta.selectionStart, end: ta.selectionEnd });
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  return { calls, off: () => void delete doc.execCommand };
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  delete (document as unknown as { execCommand?: unknown }).execCommand;
});

describe('書式バーのボタン', () => {
  it('🔴 太字:insertText が「変わった範囲」だけを受け取る(全文の代入ではない)', () => {
    const { ta, press } = setup();
    ta.value = '強調したい文';
    ta.setSelectionRange(0, 2);
    const { calls, off } = withExecCommand(ta);
    try {
      press('data-pkc-format', 'bold');
    } finally {
      off();
    }
    expect(ta.value).toBe('**強調**したい文');
    expect(calls, 'insertText を通っていない').toHaveLength(1);
    expect(calls[0]!.cmd).toBe('insertText');
    // 前の「強調」の前後で同じ字(空の頭と「したい文」の尻)は触らず、差し込む記号だけを受け取る
    expect(calls[0]!.text).toBe('**強調**');
    expect([calls[0]!.start, calls[0]!.end]).toEqual([0, 2]);
    // 選択は中身のまま(続けて斜体を押せる)
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([2, 4]);
  });

  it('fallback(execCommand 無し):本文・選択・input は従来どおり(input は 1 回)', () => {
    const { ta, press, inputs } = setup();
    ta.value = '強調したい文';
    ta.setSelectionRange(0, 2);
    press('data-pkc-format', 'bold');
    expect(ta.value).toBe('**強調**したい文');
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([2, 4]);
    expect(inputs).toHaveLength(1);
  });
});

describe('Ctrl+B などのショートカットキー', () => {
  it('🔴 Ctrl+B も insertText で、変わった範囲だけ置き換える', () => {
    const { ta } = setup();
    ta.value = '強調したい文';
    ta.setSelectionRange(0, 2);
    const { calls, off } = withExecCommand(ta);
    try {
      const ev = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true });
      ta.dispatchEvent(ev);
      expect(ev.defaultPrevented, 'Ctrl+B が効いていない(前提)').toBe(true);
    } finally {
      off();
    }
    expect(ta.value).toBe('**強調**したい文');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe('**強調**');
  });
});

describe('「完了項目を末尾へ」「番号を振り直す」', () => {
  it('🔴 完了項目を末尾へ:並べ替わった範囲だけを insertText で置き換える', () => {
    const { ta, action, said } = setup();
    ta.value = '前\n- [x] 済\n- [ ] 未\n- [ ] 未2\n後';
    const { calls, off } = withExecCommand(ta);
    try {
      action('sort-tasks');
    } finally {
      off();
    }
    expect(ta.value).toBe('前\n- [ ] 未\n- [ ] 未2\n- [x] 済\n後');
    expect(calls, 'insertText を通っていない').toHaveLength(1);
    expect(calls[0]!.cmd).toBe('insertText');
    // 前の「前\n- 」と後ろの「\n後」は触らない(全文を選んで置き換えない)
    expect(calls[0]!.start).toBeGreaterThan(0);
    expect(calls[0]!.end).toBeLessThan('前\n- [x] 済\n- [ ] 未\n- [ ] 未2\n後'.length);
    expect(said).toEqual(['完了したチェック項目を末尾へ移動しました']);
  });

  it('🔴 整理のあと、カーソルは本文の末尾へ飛ばない(#1087)', () => {
    const a = setup();
    a.ta.value = '- [x] 済\n- [ ] 未\n後ろの文';
    a.action('sort-tasks');
    expect(a.ta.value).toBe('- [ ] 未\n- [x] 済\n後ろの文');
    expect(a.ta.selectionStart).toBeLessThan(a.ta.value.length);
    expect(a.ta.selectionStart).toBe('- [ ] 未\n- [x] 済'.length);
    const b = setup();
    b.ta.value = '1. あ\n5. い\n後ろの文';
    b.action('renumber-lists');
    expect(b.ta.value).toBe('1. あ\n2. い\n後ろの文');
    // 変わったのは `5` → `2` の 1 字だけ ── カーソルはその直後(`replaceChanged` が置いた所)
    expect(b.ta.selectionStart).toBe('1. あ\n2'.length);
  });

  it('🔴 番号を振り直す:変わった行の範囲だけ。fallback でも本文・input 1 回', () => {
    const a = setup();
    a.ta.value = '1. あ\n5. い\n9. う';
    const { calls, off } = withExecCommand(a.ta);
    try {
      a.action('renumber-lists');
    } finally {
      off();
    }
    expect(a.ta.value).toBe('1. あ\n2. い\n3. う');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('insertText');
    // 先頭の「1. あ\n」は同じなので触らない
    expect(calls[0]!.start).toBeGreaterThanOrEqual('1. あ\n'.length);

    const b = setup();
    b.ta.value = '1. あ\n5. い\n9. う';
    b.action('renumber-lists');
    expect(b.ta.value).toBe('1. あ\n2. い\n3. う');
    expect(b.inputs, 'fallback の input が 1 回でない').toHaveLength(1);
    expect(b.said).toEqual(['番号を振り直しました']);
  });
});

describe('該当する物が本文に 1 つも無いとき', () => {
  it.each([
    ['sort-tasks', '', 'このノートにチェック項目はありません'],
    ['sort-tasks', '普通の文章', 'このノートにチェック項目はありません'],
    // fence の中は数えない(並べ替え関数と同じ読み方)
    ['sort-tasks', '```\n- [ ] 未\n- [x] 済\n```', 'このノートにチェック項目はありません'],
    // 引用の中は押せるチェックだが並べ替えない ── 「無い」と偽を言わない(#1087)
    ['sort-tasks', '> - [x] 済\n> - [ ] 未', '引用の中のチェック項目は並べ替えません'],
    // 対照群:在って、もう揃っている
    ['sort-tasks', '- [ ] 未\n- [x] 済', '完了項目は既に末尾に揃っています'],
    ['renumber-lists', '普通の文章 2024.', 'このノートに番号付きリストはありません'],
    ['renumber-lists', '```\n1. a\n5. b\n```', 'このノートに番号付きリストはありません'],
    // 対照群:在って、もう揃っている
    ['renumber-lists', '1. あ\n2. い', '番号はもう揃っています'],
  ])('%s / %j → %s', (name, body, expected) => {
    const { ta, action, said } = setup();
    ta.value = body;
    action(name);
    expect(ta.value, '本文が変わった').toBe(body);
    expect(said).toEqual([expected]);
  });
});
