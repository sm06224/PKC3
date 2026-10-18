/** @vitest-environment happy-dom */
/**
 * 🔴 **台帳 #1852「入れる前に確かめる物」の実装**(#1163 の依頼 182・237・261・310・332)。
 *
 * - 182 = A  「ノートを作る」の既定を `Alt+N` へ(`Ctrl+N` はブラウザが取る)。mac の `Option+N`(Dead キー)でも効く
 * - 261 / 310 = A  記号のキーは**刻印**で読む(日本語配列の `]` の刻印のキーで「字下げ Ctrl+]」)。
 *                  変える前に自分で割り当てた記号のキー(位置で保存)は、同じキーで効き続ける
 * - 237 = A  スマホ用画面の編集中: 書式のボタンは 1 段 + 「…」/ 下の保存・やめるは出さない
 *
 * ⚠ 守っていない物:実ブラウザ・実機の日本語配列での打鍵(合成 event で、刻印と位置の食い違いを再現する)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, stripComments } from '../helpers/css-blocks';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import {
  KEY_COMMANDS,
  baseKeyOf,
  chordOf,
  chordToString,
  findCommand,
  matchCommand,
  matchPositionCommand,
  positionChordOf,
  defaultBindings,
  type KeyContext,
} from '../../src/features/keymap';
import {
  COMPACT_BAR_OPS,
  FORMAT_MORE_FIELD,
  FORMAT_MORE_ITEM_ATTR,
  FORMAT_MORE_OPEN_ATTR,
  buildFormatBar,
} from '../../src/adapter/ui/render/format-bar';

type Init = { key: string; code: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean };
const ev = (i: Init) => ({
  key: i.key,
  code: i.code,
  ctrlKey: i.ctrlKey ?? false,
  metaKey: i.metaKey ?? false,
  altKey: i.altKey ?? false,
  shiftKey: i.shiftKey ?? false,
});
const chordStr = (i: Init, mac = false): string | null => {
  const c = chordOf(ev(i), mac);
  return c === null ? null : chordToString(c);
};

function fakeStorage(initial?: Record<string, unknown>) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set('pkc3.keymap', JSON.stringify(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe('182 = A: ノートを作るの既定は Alt+N', () => {
  it('🔴 既定が Alt+N で、その打鍵で「ノートを作る」に当たる', () => {
    expect(findCommand('create-entry')?.defaults).toEqual(['Alt+N']);
    expect(matchCommand(chordOf(ev({ key: 'n', code: 'KeyN', altKey: true })), 'global', defaultBindings())).toBe('create-entry');
    // 対照群: 前の既定(Ctrl+N)はもう当たらない
    expect(matchCommand(chordOf(ev({ key: 'n', code: 'KeyN', ctrlKey: true })), 'global', defaultBindings())).toBeNull();
  });

  it('🔴 mac の Option+N(key は Dead)でも読める ── 読めないと既定が mac で死ぬ', () => {
    expect(chordStr({ key: 'Dead', code: 'KeyN', altKey: true }, true)).toBe('Alt+N');
    expect(chordStr({ key: 'Dead', code: 'Digit5', altKey: true }, true)).toBe('Alt+5');
    // 対照群: Alt の無い Dead(アクセント記号を打つだけ)と、字のキーでない Dead は今までどおり読まない
    expect(chordStr({ key: 'Dead', code: 'KeyN' })).toBeNull();
    expect(chordStr({ key: 'Dead', code: 'Equal', altKey: true })).toBeNull();
    // 対照群: 修飾キー単独は読まない
    expect(chordStr({ key: 'Alt', code: 'AltLeft', altKey: true })).toBeNull();
  });

  it('🔴 Alt+N は他の操作の既定と重ならない', () => {
    const owners = KEY_COMMANDS.filter((c) => c.defaults.includes('Alt+N')).map((c) => c.id);
    expect(owners).toEqual(['create-entry']);
  });
});

describe('261 / 310 = A: 記号のキーは刻印で読む', () => {
  // 日本語配列の記号のキー(`code` は US 配列の位置の名前。`key` が刻印)
  const JIS_CLOSE = { key: ']', code: 'Backslash' }; // `]` の刻印のキー
  const JIS_OPEN = { key: '[', code: 'BracketRight' }; // `[` の刻印のキー
  const JIS_AT = { key: '@', code: 'BracketLeft' };
  const JIS_YEN = { key: '¥', code: 'IntlYen' };
  const JIS_RO = { key: '\\', code: 'IntlRo' };

  it('🔴 日本語配列: `]` の刻印のキーは BracketRight、`[` の刻印のキーは BracketLeft(画面の字と一致)', () => {
    expect(chordStr({ ...JIS_CLOSE, ctrlKey: true })).toBe('Mod+BracketRight');
    expect(chordStr({ ...JIS_OPEN, ctrlKey: true })).toBe('Mod+BracketLeft');
    // 直す前(位置で読む)の答えは取り違えていた ── 対照群として残す
    expect(chordToString(positionChordOf(ev({ ...JIS_CLOSE, ctrlKey: true }), false)!)).toBe('Mod+Backslash');
    expect(chordToString(positionChordOf(ev({ ...JIS_OPEN, ctrlKey: true }), false)!)).toBe('Mod+BracketRight');
  });

  it('🔴 画面に「字下げ Ctrl+]」と出る操作が、`]` の刻印のキーで動く', () => {
    const indent = KEY_COMMANDS.find((c) => c.defaults.includes('Mod+BracketRight'));
    expect(indent, '前提: Ctrl+] を既定に持つ操作が在る').toBeDefined();
    const ctx: KeyContext = indent!.contexts[0]!;
    const hit = matchCommand(chordOf(ev({ ...JIS_CLOSE, ctrlKey: true })), ctx, defaultBindings());
    expect(hit, '`]` の刻印のキーで字下げに当たらない').toBe(indent!.id);
    // ⚠ 直す前に「Ctrl+]」で畳まれた左のペイン(`Mod+Backslash`)には当たらない
    const fold = KEY_COMMANDS.find((c) => c.defaults.includes('Mod+Backslash'));
    expect(hit).not.toBe(fold?.id);
  });

  it('🔴 日本語配列の `@` `¥` `\\`', () => {
    expect(chordStr({ ...JIS_AT, altKey: true })).toBe('Alt+@');
    // `¥` と `\` の刻印のキーは、今までも Backslash の仲間(既定の Ctrl+\\ が押せる)
    expect(chordStr({ ...JIS_YEN, ctrlKey: true })).toBe('Mod+Backslash');
    expect(chordStr({ ...JIS_RO, ctrlKey: true })).toBe('Mod+Backslash');
  });

  it('対照群: US 配列は今までと同じ(位置と刻印が同じ)', () => {
    expect(chordStr({ key: ']', code: 'BracketRight', ctrlKey: true })).toBe('Mod+BracketRight');
    expect(chordStr({ key: '[', code: 'BracketLeft', ctrlKey: true })).toBe('Mod+BracketLeft');
    expect(chordStr({ key: '/', code: 'Slash', ctrlKey: true })).toBe('Mod+Slash');
    expect(chordStr({ key: '?', code: 'Slash', ctrlKey: true, shiftKey: true })).toBe('Mod+Shift+Slash');
    expect(chordStr({ key: ',', code: 'Comma', ctrlKey: true })).toBe('Mod+Comma');
  });

  it('対照群: 英字と数字は位置のまま(日本語入力中でも効かせる)。ドイツ語配列の Y/Z も入れ替えない', () => {
    // ドイツ語配列: `Z` の刻印のキーの code は KeyY
    expect(chordStr({ key: 'z', code: 'KeyY', ctrlKey: true })).toBe('Mod+Y');
    expect(chordStr({ key: 'q', code: 'KeyA', ctrlKey: true })).toBe('Mod+A'); // AZERTY
    expect(chordStr({ key: 'á', code: 'Digit5', ctrlKey: true })).toBe('Mod+5');
    // 日本語入力中(key が Process)でも位置で読める
    expect(chordStr({ key: 'Process', code: 'KeyN', altKey: true })).toBe('Alt+N');
  });

  it('対照群: 印字を読めない打鍵(mac の Option+[ は “)は、位置に落ちる ── 今までどおり', () => {
    expect(chordStr({ key: '“', code: 'BracketLeft', altKey: true }, true)).toBe('Alt+BracketLeft');
    expect(baseKeyOf({ key: '“', code: 'BracketLeft' })).toBe('BracketLeft');
  });

  it('⚠ Shift の字が Shift 無しで出たキー(日本語配列の `:`)は、`;` の割り当てへ寄せない', () => {
    expect(chordStr({ key: ':', code: 'Quote', ctrlKey: true })).toBe('Mod+Quote');
    // 対照群: `;` の刻印のキーは Semicolon
    expect(chordStr({ key: ';', code: 'Semicolon', ctrlKey: true })).toBe('Mod+Semicolon');
  });
});

describe('261 / 310 の互換: 変える前に自分で割り当てた記号のキー(位置で保存)は同じキーで効き続ける', () => {
  const ctx = (id: string): KeyContext => findCommand(id)!.contexts[0]!;
  // 日本語配列の `@` の刻印のキー(code BracketLeft)を、前の版で「Ctrl+Alt+そのキー」として割り当てた人
  const JIS_AT = { key: '@', code: 'BracketLeft', ctrlKey: true, altKey: true };

  it('🔴 位置で保存した割り当てが、刻印で読んでも当たらなかったとき、同じ物理キーで効く', () => {
    const store = new KeymapStore(fakeStorage({ 'add-tag': ['Mod+Alt+BracketLeft'] }));
    expect(store.getBindings()['add-tag']).toEqual(['Mod+Alt+BracketLeft']);
    expect(chordStr(JIS_AT), '前提: 刻印では別の和音になる').toBe('Mod+Alt+@');
    expect(store.match(ev(JIS_AT), ctx('add-tag'))).toBe('add-tag');
  });

  it('対照群: 既定の割り当ては位置では当てない(画面の字と押すキーのずれが戻る)', () => {
    const store = new KeymapStore(fakeStorage());
    // 既定 `Alt+BracketLeft`(左のペインを畳む)は、日本語配列の `@` のキー(位置は BracketLeft)では動かない
    const fold = KEY_COMMANDS.find((c) => c.defaults.includes('Alt+BracketLeft'))!;
    expect(store.match(ev({ key: '@', code: 'BracketLeft', altKey: true }), fold.contexts[0]!)).toBeNull();
    // 刻印の `[` のキー(位置は BracketRight)で動く
    expect(store.match(ev({ key: '[', code: 'BracketRight', altKey: true }), fold.contexts[0]!)).toBe(fold.id);
  });

  it('対照群: US 配列(刻印と位置が同じ)では読み直しが起きない', () => {
    const b = { 'add-tag': ['Mod+Alt+BracketLeft'] };
    const e = ev({ key: '[', code: 'BracketLeft', ctrlKey: true, altKey: true });
    expect(matchPositionCommand(positionChordOf(e, false), chordOf(e, false), ctx('add-tag'), { ...defaultBindings(), ...b })).toBeNull();
  });

  it('対照群: 英字・数字の割り当ては位置で読み直さない(記号のキーだけ)', () => {
    const b = { ...defaultBindings(), 'add-tag': ['Mod+Alt+Q'] };
    // AZERTY の `A` の刻印のキー(code KeyQ ではなく KeyA)── 位置は Mod+Alt+A で、そもそも記号ではない
    const e = ev({ key: 'a', code: 'KeyQ', ctrlKey: true, altKey: true });
    expect(matchPositionCommand(positionChordOf(e, false), chordOf(e, false), ctx('add-tag'), b)).toBeNull();
  });
});

describe('237 = A: 狭い画面の編集で、書式のボタンを 1 段にまとめる', () => {
  const bar = buildFormatBar();
  const buttons = [...bar.querySelectorAll<HTMLElement>('button')];
  const more = bar.querySelector<HTMLButtonElement>(`button[data-pkc-field="${FORMAT_MORE_FIELD}"]`);

  it('🔴 「…」が 1 つ在り、帯の末尾にある。開閉の状態を aria-expanded で持つ', () => {
    expect(more, '「…」が無い').not.toBeNull();
    expect(more!.textContent).toBe('…');
    expect(bar.lastElementChild).toBe(more);
    expect(more!.getAttribute('aria-expanded')).toBe('false');
    expect(more!.getAttribute('aria-label') ?? '', '読み上げで名前が無い').not.toBe('');
  });

  it('🔴 1 段に残すのは太字 / 斜体 / 箇条書き / チェック / リンクの 5 つ。ほかの全部は「しまう」印を持つ', () => {
    expect([...COMPACT_BAR_OPS].sort()).toEqual(['bold', 'italic', 'link', 'task', 'ul']);
    const kept = buttons.filter((b) => b !== more && !b.hasAttribute(FORMAT_MORE_ITEM_ATTR));
    expect(kept.map((b) => b.getAttribute('data-pkc-format')).sort()).toEqual(['bold', 'italic', 'link', 'task', 'ul']);
    // 道を減らしていない: しまうボタンも「…」を開けば全部出る(数は帯の全ボタン − 1 つ目の 5 つ − 「…」)
    const stowed = buttons.filter((b) => b.hasAttribute(FORMAT_MORE_ITEM_ATTR));
    expect(stowed.length + kept.length + 1).toBe(buttons.length);
    expect(stowed.length, '何もしまっていない(空振り)').toBeGreaterThan(10);
    // 日付・テンプレート・置換など、先に聞く道具も「…」の中にある(消えていない)
    for (const a of ['insert-date', 'insert-snippet', 'toggle-replace', 'insert-diagram']) {
      expect(bar.querySelector(`[data-pkc-action="${a}"]`)?.hasAttribute(FORMAT_MORE_ITEM_ATTR), `${a} が「…」の中に無い`).toBe(true);
    }
  });

  it('🔴 「…」を押すと開き、もう一度押すと閉じる(印と aria-expanded が揃う)', () => {
    const b = buildFormatBar();
    const m = b.querySelector<HTMLButtonElement>(`button[data-pkc-field="${FORMAT_MORE_FIELD}"]`)!;
    m.click();
    expect(b.hasAttribute(FORMAT_MORE_OPEN_ATTR)).toBe(true);
    expect(m.getAttribute('aria-expanded')).toBe('true');
    m.click();
    expect(b.hasAttribute(FORMAT_MORE_OPEN_ATTR)).toBe(false);
    expect(m.getAttribute('aria-expanded')).toBe('false');
  });

  it('🔴 押しても本文の欄から焦点を奪わない(mousedown を止める)', () => {
    const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    more!.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  describe('見た目(CSS)── スマホ用画面のときだけ当たる', () => {
    const css = stripComments(readFileSync('src/styles/app.css', 'utf-8'));
    const SHELL = `[data-pkc-region='shell'][data-pkc-layout='phone']`;

    it('「…」は既定で出ない(広い画面は 1px も変わらない)/ スマホ用画面でだけ出る', () => {
      const base = blocksFor(css, `[data-pkc-field='format-more']`).join(' ');
      expect(base, '広い画面で「…」が出てしまう').toMatch(decl('display', 'none'));
      const phone = blocksFor(css, `${SHELL} [data-pkc-region='format-bar'] [data-pkc-field='format-more']`).join(' ');
      expect(phone, 'スマホ用画面で「…」が出ない').toMatch(decl('display', 'inline-flex'));
    });

    it('スマホ用画面では帯は 1 段(折り返さない)で、しまうボタンは「…」を開くまで出ない。開くと折り返して全部出る', () => {
      expect(blocksFor(css, `${SHELL} [data-pkc-region='format-bar']`).join(' ')).toMatch(decl('flex-wrap', 'nowrap'));
      expect(
        blocksFor(css, `${SHELL} [data-pkc-region='format-bar']:not([data-pkc-more-open]) [data-pkc-format-more-item]`).join(' '),
      ).toMatch(decl('display', 'none'));
      expect(blocksFor(css, `${SHELL} [data-pkc-region='format-bar'][data-pkc-more-open]`).join(' ')).toMatch(decl('flex-wrap', 'wrap'));
    });

    it('🔴 「…」を開いている間は、押し込んだ見た目(aria-expanded を色でも言う)', () => {
      expect(
        blocksFor(css, `[data-pkc-region='format-bar'] [data-pkc-field='format-more'][aria-expanded='true']`).join(' '),
      ).toMatch(decl('background', 'var\\(--surface-2\\)'));
    });

    it('🔴 編集中は、下(追記欄の場所)の保存 / やめるの帯を出さない(スマホ用画面だけ)', () => {
      expect(blocksFor(css, `${SHELL} [data-pkc-region='append'][data-pkc-lock-editing]`).join(' ')).toMatch(decl('display', 'none'));
    });
  });
});
