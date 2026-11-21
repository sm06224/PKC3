/** @vitest-environment happy-dom */
/**
 * 🔴 **追記欄も本文の欄と同じ編集キーを持つ**(#2001 段 2)。欄の判定は `editing-field.ts` の 1 か所。
 *
 * - Enter のリスト / 引用の継ぎ足し・書式の鍵・`Alt+↑↓`・日時
 * - `Tab` は**リストの行と複数行の選択のときだけ**握る(それ以外は焦点が出ていく = `preventDefault` しない)
 * - `Ctrl+Enter` は今までどおり「追記」/ 変換中は何もしない
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import {
  EDITING_FIELD_FEATURES,
  EDITING_FIELD_KINDS,
  EDITING_FIELD_NAMES,
  editingFieldKind,
  editingFieldKindOfName,
  fieldHas,
  keyContextOfField,
  type EditingFeature,
} from '../../src/adapter/ui/editing-field';
import { KEY_COMMANDS } from '../../src/features/keymap';

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
  bindActions(root, d, { showStatus: () => {} }, new KeymapStore(fakeStorage()));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  return { root };
}

function field(root: HTMLElement, name: string, text: string, from?: number, to?: number) {
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', name);
  ta.value = text;
  root.append(ta);
  ta.focus();
  ta.setSelectionRange(from ?? text.length, to ?? from ?? text.length);
  return ta;
}

type Mods = { ctrl?: boolean; shift?: boolean; alt?: boolean; composing?: boolean; keyCode?: number };
const press = (target: HTMLElement, key: string, m: Mods = {}): KeyboardEvent => {
  const ev = new KeyboardEvent('keydown', {
    key,
    ctrlKey: m.ctrl === true,
    shiftKey: m.shift === true,
    altKey: m.alt === true,
    isComposing: m.composing === true,
    keyCode: m.keyCode,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(ev);
  return ev;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('追記欄の編集キー', () => {
  it('🔴 Enter でリストの記号が続く / 空の記号の行で Enter は記号をやめる', () => {
    const { root } = setup();
    const ta = field(root, 'append-input', '- りんご');
    const ev = press(ta, 'Enter');
    expect(ev.defaultPrevented).toBe(true);
    expect(ta.value).toBe('- りんご\n- ');
    press(ta, 'Enter');
    expect(ta.value).not.toContain('- \n- ');
    expect(ta.value.endsWith('- ')).toBe(false);
  });

  it('🔴 Enter で引用が続く', () => {
    const { root } = setup();
    const ta = field(root, 'append-input', '> 引用');
    press(ta, 'Enter');
    expect(ta.value).toBe('> 引用\n> ');
  });

  it('🔴 変換中の Enter は継ぎ足さない(isComposing / keyCode 229)', () => {
    const { root } = setup();
    const a = field(root, 'append-input', '- あ');
    const e1 = press(a, 'Enter', { composing: true });
    expect(e1.defaultPrevented).toBe(false);
    expect(a.value).toBe('- あ');
    const e2 = press(a, 'Enter', { keyCode: 229 });
    expect(e2.defaultPrevented).toBe(false);
    expect(a.value).toBe('- あ');
  });

  it('🔴 Ctrl+Enter は今までどおり「追記」を押す(継ぎ足さない)', () => {
    const { root } = setup();
    const ta = field(root, 'append-input', '- あ');
    const ev = press(ta, 'Enter', { ctrl: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(ta.value).toBe('- あ');
  });

  it('🔴 Ctrl+B で選んだ字が太字になる', () => {
    const { root } = setup();
    const ta = field(root, 'append-input', 'abc', 0, 3);
    const ev = press(ta, 'b', { ctrl: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(ta.value).toBe('**abc**');
  });

  it('🔴 変換中の Ctrl+B は何もしない', () => {
    const { root } = setup();
    const ta = field(root, 'append-input', 'abc', 0, 3);
    press(ta, 'b', { ctrl: true, composing: true });
    expect(ta.value).toBe('abc');
  });

  it('🔴 Alt+↑ / Alt+↓ で行を入れ替える', () => {
    const { root } = setup();
    const ta = field(root, 'append-input', 'a\nb\nc', 3, 3);
    expect(press(ta, 'ArrowUp', { alt: true }).defaultPrevented).toBe(true);
    expect(ta.value).toBe('b\na\nc');
    press(ta, 'ArrowDown', { alt: true });
    expect(ta.value).toBe('a\nb\nc');
  });
});

describe('追記欄の Tab(リストの行・複数行の選択のときだけ握る)', () => {
  it('🔴 リストの行の Tab は字下げ / Shift+Tab で戻る', () => {
    const { root } = setup();
    const ta = field(root, 'append-input', '- a');
    expect(press(ta, 'Tab').defaultPrevented).toBe(true);
    expect(ta.value).toMatch(/^\s+- a$/);
    expect(press(ta, 'Tab', { shift: true }).defaultPrevented).toBe(true);
    expect(ta.value).toBe('- a');
  });

  it('🔴 複数行の選択の Tab は字下げ', () => {
    const { root } = setup();
    const ta = field(root, 'append-input', 'x\ny', 0, 3);
    expect(press(ta, 'Tab').defaultPrevented).toBe(true);
    expect(ta.value).not.toBe('x\ny');
  });

  it('🔴 ふつうの行の Tab / Shift+Tab は握らない(焦点が出ていく)', () => {
    const { root } = setup();
    const ta = field(root, 'append-input', 'ふつうの行');
    expect(press(ta, 'Tab').defaultPrevented).toBe(false);
    expect(press(ta, 'Tab', { shift: true }).defaultPrevented).toBe(false);
    expect(ta.value).toBe('ふつうの行');
  });

  it('🔴 表の行の Tab も握らない(追記欄に表のセル移動は無い)', () => {
    const { root } = setup();
    const ta = field(root, 'append-input', '| a | b |');
    expect(press(ta, 'Tab').defaultPrevented).toBe(false);
  });

  it('🔴 変換中の Tab は握らない', () => {
    const { root } = setup();
    const ta = field(root, 'append-input', '- a');
    expect(press(ta, 'Tab', { composing: true }).defaultPrevented).toBe(false);
    expect(ta.value).toBe('- a');
  });
});

describe('欄の判定 1 か所(editing-field.ts)', () => {
  const FEATURES: EditingFeature[] = ['enterContinue', 'tabTemplate', 'tabIndent', 'keys', 'paste'];

  it('🔴 4 つの欄すべてが、全機能に対して真偽の答えを持つ(5 つ目の欄が黙って抜けない)', () => {
    expect(EDITING_FIELD_KINDS.length).toBe(4);
    expect(new Set(Object.values(EDITING_FIELD_NAMES)).size).toBe(4);
    for (const k of EDITING_FIELD_KINDS) {
      expect(Object.keys(EDITING_FIELD_FEATURES[k]).sort()).toEqual([...FEATURES].sort());
      for (const f of FEATURES) expect(typeof EDITING_FIELD_FEATURES[k][f]).toBe('boolean');
      expect(editingFieldKindOfName(EDITING_FIELD_NAMES[k])).toBe(k);
    }
  });

  it('🔴 追記欄は継ぎ足し・字下げ・鍵・貼り付けを持ち、表 / 短縮語の Tab は持たない', () => {
    const a = EDITING_FIELD_FEATURES.append;
    expect(a).toEqual({ enterContinue: true, tabTemplate: false, tabIndent: true, keys: true, paste: true });
    expect(EDITING_FIELD_FEATURES.row.tabIndent).toBe(false); // 1 画面の行の Tab は行の確定
  });

  it('欄でないものは全機能で false / 要素から種類を引ける', () => {
    for (const f of FEATURES) expect(fieldHas('editor-title', f)).toBe(false);
    expect(fieldHas(null, 'keys')).toBe(false);
    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'append-input');
    expect(editingFieldKind(ta)).toBe('append');
    expect(editingFieldKind(document.createElement('div'))).toBeNull();
  });

  it('🔴 欄ごとの鍵の文脈が、書式の命令の contexts に載っている(載せ忘れると鍵が効かない)', () => {
    const fmt = KEY_COMMANDS.filter((c) => c.id.startsWith('format-') || c.id === 'move-line-up' || c.id === 'indent');
    expect(fmt.length).toBeGreaterThan(10);
    for (const k of EDITING_FIELD_KINDS) {
      const ctx = keyContextOfField(k);
      for (const c of fmt) expect(c.contexts, `${c.id} が ${k} の文脈 ${ctx} に無い`).toContain(ctx);
    }
  });

  it('🔴 追記欄で貼った URL が選んだ字をリンクにする(貼り付けの対象欄)', () => {
    const { root } = setup();
    const ta = field(root, 'append-input', 'docs', 0, 4);
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(ev, 'clipboardData', {
      value: {
        files: [],
        items: [],
        getData: (t: string) => (t === 'text/plain' ? 'https://example.com/' : ''),
      },
    });
    ta.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(ta.value).toBe('[docs](https://example.com/)');
  });

  it('章の欄にも同じ継ぎ足し・Alt+↑ が効く', () => {
    const { root } = setup();
    const ta = field(root, EDITING_FIELD_NAMES.section, '- a');
    press(ta, 'Enter');
    expect(ta.value).toBe('- a\n- ');
    const t2 = field(root, EDITING_FIELD_NAMES.section, 'a\nb', 3, 3);
    press(t2, 'ArrowUp', { alt: true });
    expect(t2.value).toBe('b\na');
  });
});

void vi;
