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
import { initialState } from '../../src/adapter/state/app-state';
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
import { commandRowsFor, editorCommand, formatTargetOf, paletteScene } from '../../src/adapter/ui/actions/binder';

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
  return { root, d, keymap };
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
  const FEATURES: EditingFeature[] = ['enterContinue', 'tabTemplate', 'tabIndent', 'keys', 'paste', 'enterCalc', 'autoPair', 'formatBar', 'wrapSelection'];

  /** 欄 × 機能の全数の期待(実装の表を写さず、ここで独立に書く。変えたらこの表と下の振る舞いの両方が動く)。 */
  const EXPECT: Record<string, Record<EditingFeature, boolean>> = {
    editor: { enterContinue: true, tabTemplate: true, tabIndent: true, keys: true, paste: true, enterCalc: true, autoPair: true, formatBar: true, wrapSelection: true },
    row: { enterContinue: true, tabTemplate: false, tabIndent: false, keys: true, paste: true, enterCalc: true, autoPair: true, formatBar: true, wrapSelection: true },
    section: { enterContinue: true, tabTemplate: true, tabIndent: true, keys: true, paste: true, enterCalc: true, autoPair: true, formatBar: false, wrapSelection: true },
    append: { enterContinue: true, tabTemplate: false, tabIndent: true, keys: true, paste: true, enterCalc: true, autoPair: false, formatBar: false, wrapSelection: true },
  };
  const ALL: EditingFeature[] = ['enterContinue', 'tabTemplate', 'tabIndent', 'keys', 'paste', 'enterCalc', 'autoPair', 'formatBar', 'wrapSelection'];

  it('🔴 4 つの欄 × 全機能の真偽を 1 つずつ固定する(5 つ目の欄・機能が黙って抜けない)', () => {
    expect(EDITING_FIELD_KINDS.length).toBe(4);
    expect(new Set(Object.values(EDITING_FIELD_NAMES)).size).toBe(4);
    for (const k of EDITING_FIELD_KINDS) {
      expect(Object.keys(EDITING_FIELD_FEATURES[k]).sort()).toEqual([...ALL].sort());
      expect(EDITING_FIELD_FEATURES[k], k).toEqual(EXPECT[k]);
      expect(editingFieldKindOfName(EDITING_FIELD_NAMES[k])).toBe(k);
      for (const f of ALL) expect(fieldHas(EDITING_FIELD_NAMES[k], f), `${k}.${f}`).toBe(EXPECT[k]![f]);
    }
  });

  describe('🔴 表の値が実際の振る舞いを決める(欄 × 機能。表だけ変えて挙動が動かない空振りを防ぐ)', () => {
    const NAME = EDITING_FIELD_NAMES;
    const tabPrevented = (name: string, text: string, from?: number, to?: number): boolean => {
      const { root } = setup();
      const ta = field(root, name, text, from, to);
      return press(ta, 'Tab').defaultPrevented;
    };
    for (const k of ['editor', 'section', 'append', 'row'] as const) {
      it(`tabIndent: ${k} のリスト行の Tab は ${EXPECT[k]!.tabIndent ? '握る' : '握らない'}(行は row-swap が受ける)`, () => {
        expect(tabPrevented(NAME[k], '- a')).toBe(EXPECT[k]!.tabIndent);
      });
      it(`tabTemplate: ${k} の表のセルの Tab は ${EXPECT[k]!.tabTemplate ? '握る' : '握らない'}`, () => {
        expect(tabPrevented(NAME[k], '| a | b |', 2)).toBe(EXPECT[k]!.tabTemplate);
      });
      it(`enterCalc: ${k} で 2+3= の Enter は答えを入れる`, () => {
        const { root } = setup();
        const ta = field(root, NAME[k], '2+3=');
        press(ta, 'Enter');
        expect(ta.value.startsWith('2+3=5'), `${k}: ${ta.value}`).toBe(EXPECT[k]!.enterCalc);
      });
      it(`autoPair: ${k} で ( を打つと ${EXPECT[k]!.autoPair ? '括弧を補う' : '補わない'}`, () => {
        const { root } = setup();
        const ta = field(root, NAME[k], '');
        const ev = press(ta, '(');
        // 1 画面の行の欄の打鍵は `row-swap.ts` が受ける(この素の欄では起きない)── 行は `line-ops-fields.test.ts` が RowSwap で見る
        const viaBinder = EXPECT[k]!.autoPair && k !== 'row';
        expect(ev.defaultPrevented, `${k}`).toBe(viaBinder);
        if (viaBinder) expect(ta.value).toBe('()');
      });
      it(`formatBar: ${k} は書式バーの対象欄か = ${EXPECT[k]!.formatBar}`, () => {
        const ta = document.createElement('textarea');
        ta.setAttribute('data-pkc-field', NAME[k]);
        expect(formatTargetOf(ta) !== null).toBe(EXPECT[k]!.formatBar);
      });
      it(`enterContinue: ${k} で - a の Enter は記号を続ける`, () => {
        const { root } = setup();
        const ta = field(root, NAME[k], '- a');
        press(ta, 'Enter');
        expect(ta.value).toBe(EXPECT[k]!.enterContinue ? '- a\n- ' : '- a');
      });
      it(`keys: ${k} で Ctrl+B は太字 = ${EXPECT[k]!.keys}`, () => {
        const { root } = setup();
        const ta = field(root, NAME[k], 'abc', 0, 3);
        press(ta, 'b', { ctrl: true });
        expect(ta.value === '**abc**', `${k}: ${ta.value}`).toBe(EXPECT[k]!.keys);
      });
    }
  });

  it('🔴 追記欄の裁定(2026-11-21): 字下げは持つが、表 / 短縮語の Tab と書式バーは持たない', () => {
    expect(EDITING_FIELD_FEATURES.append.tabTemplate).toBe(false);
    expect(EDITING_FIELD_FEATURES.append.formatBar).toBe(false);
    expect(EDITING_FIELD_FEATURES.append.tabIndent).toBe(true);
  });

  it('🔴 欄ごとの鍵の文脈(追記は append / 2 ペインは editor / 行と章は row)', () => {
    expect(EDITING_FIELD_KINDS.map((k) => keyContextOfField(k))).toEqual(['editor', 'row', 'row', 'append']);
    // 🔴 「操作を探す」の場面も同じ 1 か所から(章の欄だけ append と言っていた食い違いを防ぐ)
    for (const k of EDITING_FIELD_KINDS) {
      const ta = document.createElement('textarea');
      ta.setAttribute('data-pkc-field', EDITING_FIELD_NAMES[k]);
      expect([...paletteScene(ta, initialState)], k).toEqual([keyContextOfField(k)]);
    }
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

describe('追記欄の取り消し(Ctrl+Z)と素通しの鍵', () => {
  /**
   * 取り消しの履歴に載るのは `document.execCommand('insertText')` で書いたときだけ(`setRangeText` / `value` 直代入は履歴を捨てる)。
   * happy-dom に履歴は無いので、書き込みが execCommand を通ったことを見る(実ブラウザの Ctrl+Z は smoke が見る)。
   */
  function spyExec(): { calls: string[]; restore: () => void } {
    const calls: string[] = [];
    const doc = document as Document & { execCommand?: unknown };
    const prev = doc.execCommand;
    doc.execCommand = (cmd: string, _ui?: boolean, value?: string): boolean => {
      calls.push(`${cmd}:${value ?? ''}`);
      return false; // 断ると fallback が書く(値の検算ができる)
    };
    return { calls, restore: () => void (doc.execCommand = prev) };
  }

  it('🔴 Enter の継ぎ足しは insertText で書く(= Ctrl+Z で戻せる)', () => {
    const { root } = setup();
    const spy = spyExec();
    try {
      const ta = field(root, 'append-input', '- りんご');
      press(ta, 'Enter');
      expect(spy.calls).toContain('insertText:\n- ');
    } finally {
      spy.restore();
    }
  });

  it('🔴 字下げは insertText で書く(= Ctrl+Z で戻せる)', () => {
    const { root } = setup();
    const spy = spyExec();
    try {
      const ta = field(root, 'append-input', '- a');
      press(ta, 'Tab');
      expect(spy.calls.some((c) => c.startsWith('insertText:')), '字下げが insertText を通っていない').toBe(true);
    } finally {
      spy.restore();
    }
  });

  it('🔴 Shift+Enter / Alt+Enter は継ぎ足さず素通し(ふつうの改行)', () => {
    const { root } = setup();
    const ta = field(root, 'append-input', '- a');
    expect(press(ta, 'Enter', { shift: true }).defaultPrevented).toBe(false);
    expect(press(ta, 'Enter', { alt: true }).defaultPrevented).toBe(false);
    expect(ta.value).toBe('- a');
  });
});

describe('「操作を探す」と鍵の対応(欄ごと)', () => {
  it('🔴 欄の中で鍵で押せる命令 = その欄から開いた「操作を探す」で押せる命令(全命令・両向き)', () => {
    const { root, d, keymap } = setup();
    for (const k of EDITING_FIELD_KINDS) {
      const ta = field(root, EDITING_FIELD_NAMES[k], 'x');
      const ctx = keyContextOfField(k);
      // 鍵で押せる = 欄へ当てる命令で、その欄の文脈を名乗る(binder が keymap.match(ke, ctx) で拾う集合)
      const byKey = KEY_COMMANDS.filter((c) => editorCommand(c.id) && c.contexts.includes(ctx)).map((c) => c.id).sort();
      const byPalette = commandRowsFor(root, d, keymap, '', ta, true)
        .filter((r) => r.ready && editorCommand(r.id))
        .map((r) => r.id)
        .sort();
      expect(byKey.length, `${k}: 空振り`).toBeGreaterThan(20);
      expect(byPalette, k).toEqual(byKey);
    }
  });
});

describe('章の欄の貼り付けと画像の落とし込み(#2001 段 2 の決定: 章の下書きへ差し込む)', () => {
  function sectionSetup() {
    document.body.textContent = '';
    const root = document.createElement('div');
    root.innerHTML = '<textarea data-pkc-field="section-draft-input"></textarea>';
    document.body.append(root);
    const calls = { paste: [] as (readonly File[])[], attach: [] as File[][] };
    bindActions(root, new Dispatcher(), {
      attachFiles: (files) => void calls.attach.push(files),
      pasteImages: async (files) => {
        calls.paste.push(files);
        return files.map((_, i) => `![ず](asset:k${i + 1})`);
      },
    });
    return { ta: root.querySelector('textarea')!, calls };
  }
  const png = (): File => new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' });

  it('🔴 選んだ字へ URL を貼ると [字](URL) になる', () => {
    const { ta } = sectionSetup();
    ta.value = 'docs';
    ta.focus();
    ta.setSelectionRange(0, 4);
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', {
      value: { files: [], items: [], getData: (t: string) => (t === 'text/plain' ? 'https://example.com/' : '') },
    });
    ta.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(ta.value).toBe('[docs](https://example.com/)');
  });

  it('🔴 画像を落とすと、資産にして参照が章の下書きへ入る(添付のノート作成へは回さない)', async () => {
    const { ta, calls } = sectionSetup();
    ta.value = 'まえ';
    ta.focus();
    ta.setSelectionRange(2, 2);
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    const files = [png()];
    Object.defineProperty(ev, 'dataTransfer', {
      value: { types: ['Files'], dropEffect: 'none', files: { length: 1, item: (i: number) => files[i] ?? null }, items: [] },
    });
    ta.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(ta.value).toContain('asset:k1'));
    expect(calls.paste).toHaveLength(1);
    expect(calls.attach, '章の下書きに落としたのに添付へ回った').toHaveLength(0);
  });
});
