/** @vitest-environment happy-dom */
/**
 * 🔴 行の複製・削除・見出しの段の巡回・選択を囲む(#2001 段 3)を、本文を書く欄で。
 * 書き込みは insertText(= execCommand)を通る(Ctrl+Z で戻る)/ 変換中は何もしない。
 * ⚠ 1 画面の行(`row-source`)の囲みは `row-swap.ts` が `autoPairFor` を通る(純関数の表 `line-edit.test.ts` が見る)。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import {
  EDITING_FIELD_FEATURES,
  EDITING_FIELD_KINDS,
  EDITING_FIELD_NAMES,
  type EditingFieldKind,
  type EditingFeature,
} from '../../src/adapter/ui/editing-field';
import { RowSwap } from '../../src/adapter/ui/render/row-swap';
import { renderMarkdownWithRanges } from '../../src/features/markdown/source-ranges';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}
function setup() {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  const keymap = new KeymapStore(fakeStorage());
  bindActions(root, d, { showStatus: () => {} }, keymap);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  return { root, keymap };
}
function field(root: HTMLElement, name: string, text: string, from: number, to = from) {
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', name);
  ta.value = text;
  root.append(ta);
  ta.focus();
  ta.setSelectionRange(from, to);
  return ta;
}
type Mods = { ctrl?: boolean; shift?: boolean; alt?: boolean; composing?: boolean };
const press = (t: HTMLElement, key: string, m: Mods = {}): KeyboardEvent => {
  const ev = new KeyboardEvent('keydown', {
    key,
    ctrlKey: m.ctrl === true,
    shiftKey: m.shift === true,
    altKey: m.alt === true,
    isComposing: m.composing === true,
    bubbles: true,
    cancelable: true,
  });
  t.dispatchEvent(ev);
  return ev;
};
/** happy-dom に履歴は無い。execCommand を通ったことを見る(断ると fallback が書く)。 */
function spyExec(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const doc = document as Document & { execCommand?: unknown };
  const prev = doc.execCommand;
  doc.execCommand = (cmd: string, _u?: boolean, v?: string): boolean => {
    calls.push(`${cmd}:${v ?? ''}`);
    return false;
  };
  return { calls, restore: () => void (doc.execCommand = prev) };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe.each(EDITING_FIELD_KINDS)('%s の欄', (kind) => {
  const name = EDITING_FIELD_NAMES[kind];
  it('Alt+Shift+↓ で下へ複製し、選択が写しへ移る。insertText を通る', () => {
    const { root } = setup();
    const spy = spyExec();
    try {
      const ta = field(root, name, 'a\nbc\nd', 3);
      expect(press(ta, 'ArrowDown', { alt: true, shift: true }).defaultPrevented).toBe(true);
      expect(ta.value).toBe('a\nbc\nbc\nd');
      expect(ta.selectionStart).toBe(6);
      expect(spy.calls.some((c) => c.startsWith('insertText:'))).toBe(true);
    } finally {
      spy.restore();
    }
  });
  it('Alt+Shift+↑ で上へ複製する', () => {
    const { root } = setup();
    const ta = field(root, name, 'a\nbc\nd', 3);
    press(ta, 'ArrowUp', { alt: true, shift: true });
    expect(ta.value).toBe('a\nbc\nbc\nd');
    expect(ta.selectionStart).toBe(3);
  });
  it('Alt+Shift+K で行を削除する(insertText を通る)', () => {
    const { root } = setup();
    const spy = spyExec();
    try {
      const ta = field(root, name, 'a\nbc\nd', 3);
      expect(press(ta, 'K', { alt: true, shift: true }).defaultPrevented).toBe(true);
      expect(ta.value).toBe('a\nd');
      expect(spy.calls.some((c) => c.startsWith('insertText:'))).toBe(true);
    } finally {
      spy.restore();
    }
  });
  it('見出しの段の巡回: 鍵を割り当てると欄へ当たる(既定は鍵なし)', () => {
    const { root, keymap } = setup();
    expect(keymap.addBinding('cycle-heading', 'Alt+Shift+T')).toBeNull();
    const ta = field(root, name, 'あい', 1);
    expect(press(ta, 'T', { alt: true, shift: true }).defaultPrevented).toBe(true);
    expect(ta.value).toBe('# あい');
    press(ta, 'T', { alt: true, shift: true });
    expect(ta.value).toBe('## あい');
  });
  it('変換中は何もしない', () => {
    const { root } = setup();
    const ta = field(root, name, 'a\nb', 1);
    expect(press(ta, 'ArrowDown', { alt: true, shift: true, composing: true }).defaultPrevented).toBe(false);
    expect(press(ta, 'K', { alt: true, shift: true, composing: true }).defaultPrevented).toBe(false);
    expect(ta.value).toBe('a\nb');
  });
});

describe.each(['editor', 'section', 'append'] as const)('%s の欄: 選択を囲む', (kind) => {
  const name = EDITING_FIELD_NAMES[kind];
  it.each([
    ['(', '(bc)'],
    ['[', '[bc]'],
    ['{', '{bc}'],
    ['"', '"bc"'],
    ["'", "'bc'"],
    ['「', '「bc」'],
    ['『', '『bc』'],
    ['`', '`bc`'],
    ['*', '*bc*'],
    ['_', '_bc_'],
  ])('%s', (key, wrapped) => {
    const { root } = setup();
    const spy = spyExec();
    try {
      const ta = field(root, name, 'abcd', 1, 3);
      expect(press(ta, key).defaultPrevented).toBe(true);
      expect(ta.value).toBe(`a${wrapped}d`);
      expect(ta.selectionEnd - ta.selectionStart).toBe(2);
      expect(spy.calls.some((c) => c.startsWith('insertText:'))).toBe(true);
    } finally {
      spy.restore();
    }
  });
  it('選択が無い `*` は素通し / Ctrl 付きは囲まない / 変換中は囲まない', () => {
    const { root } = setup();
    const ta = field(root, name, 'abcd', 2);
    expect(press(ta, '*').defaultPrevented).toBe(false);
    const t2 = field(root, name, 'abcd', 1, 3);
    expect(press(t2, '(', { ctrl: true }).defaultPrevented).toBe(false);
    expect(press(t2, '(', { composing: true }).defaultPrevented).toBe(false);
    expect(t2.value).toBe('abcd');
  });
});

/**
 * 🔴 **欄の表の真偽が、4 つの欄すべてで実際の打鍵を決める**(#2001 段 3 レビュー)。
 * 表だけが飾りで、各欄の道が別の判定を持っている空振りを防ぐ ── 表を書き替えて挙動が替わることを欄ごとに見る。
 * 1 画面の行(`row`)は本物の `RowSwap` を開いて打つ(binder は通らない道)。
 */
describe('欄の表(wrapSelection / autoPair)を書き替えると、4 つの欄すべてで挙動が替わる', () => {
  function open(kind: EditingFieldKind, text: string, from: number, to = from): HTMLTextAreaElement {
    if (kind !== 'row') return field(setup().root, EDITING_FIELD_NAMES[kind], text, from, to);
    document.body.innerHTML = '';
    const host = document.createElement('div');
    document.body.append(host);
    const swap = new RowSwap(host, { commit: () => {}, notify: () => {}, onInserted: () => {} });
    const { html, ranges } = renderMarkdownWithRanges('最初の段落。');
    expect(swap.update('最初の段落。', html, ranges).ok).toBe(true);
    const p = [...host.querySelectorAll('p')].find((e) => e.textContent?.includes('最初'))!;
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }));
    const ta = host.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
    expect(ta, 'row の欄が開いていない').not.toBeNull();
    ta.value = text;
    ta.setSelectionRange(from, to);
    return ta;
  }
  /** `feature` を `value` にして `run` を走らせ、必ず戻す。 */
  function withFlag<T>(kind: EditingFieldKind, feature: EditingFeature, value: boolean, run: () => T): T {
    const row = EDITING_FIELD_FEATURES[kind] as Record<EditingFeature, boolean>;
    const prev = row[feature];
    row[feature] = value;
    try {
      return run();
    } finally {
      row[feature] = prev;
    }
  }
  const typeKey = (ta: HTMLTextAreaElement, key: string): KeyboardEvent => press(ta, key);

  describe.each(EDITING_FIELD_KINDS)('%s', (kind) => {
    it('wrapSelection: 真なら ( で囲む / 偽なら囲まない(置き換えのまま)', () => {
      const on = withFlag(kind, 'wrapSelection', true, () => {
        const ta = open(kind, 'abcd', 1, 3);
        const ev = typeKey(ta, '(');
        return { prevented: ev.defaultPrevented, value: ta.value };
      });
      expect(on).toEqual({ prevented: true, value: 'a(bc)d' });
      const off = withFlag(kind, 'wrapSelection', false, () => {
        const ta = open(kind, 'abcd', 1, 3);
        const ev = typeKey(ta, '(');
        return { prevented: ev.defaultPrevented, value: ta.value };
      });
      expect(off).toEqual({ prevented: false, value: 'abcd' });
    });
    it('wrapSelection: `*` `_` も同じ表で決まる', () => {
      for (const key of ['*', '_']) {
        const on = withFlag(kind, 'wrapSelection', true, () => {
          const ta = open(kind, 'abcd', 1, 3);
          typeKey(ta, key);
          return ta.value;
        });
        expect(on, `${kind} ${key}`).toBe(`a${key}bc${key}d`);
        const off = withFlag(kind, 'wrapSelection', false, () => {
          const ta = open(kind, 'abcd', 1, 3);
          return typeKey(ta, key).defaultPrevented;
        });
        expect(off, `${kind} ${key}`).toBe(false);
      }
    });
    it('autoPair: 選んでいない ( は、真なら補い / 偽なら補わない。囲む機能は別の真偽', () => {
      const on = withFlag(kind, 'autoPair', true, () => {
        const ta = open(kind, '', 0);
        return { prevented: typeKey(ta, '(').defaultPrevented, value: ta.value };
      });
      expect(on).toEqual({ prevented: true, value: '()' });
      const off = withFlag(kind, 'autoPair', false, () => {
        const ta = open(kind, '', 0);
        return { prevented: typeKey(ta, '(').defaultPrevented, value: ta.value };
      });
      expect(off).toEqual({ prevented: false, value: '' });
      // autoPair を偽にしても、選んで打てば囲む(wrapSelection は別)
      const stillWraps = withFlag(kind, 'autoPair', false, () => {
        const ta = open(kind, 'abcd', 1, 3);
        typeKey(ta, '(');
        return ta.value;
      });
      expect(stillWraps).toBe('a(bc)d');
      // wrapSelection を偽にしても、選んでいない ( は補う
      const stillPairs = withFlag(kind, 'wrapSelection', false, () => {
        const ta = open(kind, '', 0);
        typeKey(ta, '(');
        return ta.value;
      });
      expect(stillPairs).toBe(kind === 'append' ? '' : '()');
    });
    it('Backspace で補った対を一緒に消すのも autoPair の表に従う', () => {
      const run = (v: boolean) =>
        withFlag(kind, 'autoPair', v, () => {
          const ta = open(kind, '()', 1);
          press(ta, 'Backspace');
          return ta.value;
        });
      expect(run(false)).toBe('()');
      expect(run(true)).toBe('');
    });
  });
});

describe.each(EDITING_FIELD_KINDS)('%s の欄: 字面のまま読まれる場所では囲まない', (kind) => {
  // ⚠ 1 画面の行の欄は本文の欄と同じ `typedPairFor` を通る(上の表の書き替えの試験が見ている)。fence の文脈の判定そのものは本文の欄で見る
  const name = EDITING_FIELD_NAMES[kind === 'row' ? 'editor' : kind];
  const doc = '```\nabcd\n```\nxy';
  it('fenced code の中で選んで * ( ` を打つと、囲まず置き換える', () => {
    for (const key of ['*', '(', '`']) {
      const ta = field(setup().root, name, doc, 5, 7);
      expect(press(ta, key).defaultPrevented, `${kind} ${key}`).toBe(false);
      expect(ta.value).toBe(doc);
    }
  });
  it('対照群: fence の外では囲む', () => {
    const out = field(setup().root, name, doc, 13, 15);
    press(out, '*');
    expect(out.value).toBe('```\nabcd\n```\n*xy*');
  });
});
