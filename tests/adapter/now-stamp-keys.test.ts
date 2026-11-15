/** @vitest-environment happy-dom */
/**
 * 🔴 **いまの日時を 1 打鍵で入れる**(#1966 2-C。PKC2 の作業ログの近道を戻す)。
 *
 * - 字の形: 時刻 `HH:mm:ss` / 日時 `yyyy/MM/dd HH:mm:ss` / 曜日つき `yy/MM/dd ddd`(+ 時刻)/ ISO 8601(時差つき)
 * - 鍵: `Ctrl + '`(日本語配列の `:` のキー)/ `Ctrl + Shift + ;` / `Ctrl + D` / `Ctrl + Shift + D` / `Ctrl + Alt + Shift + D`
 * - 効くのは本文の欄(2 列の `editor-body` / 1 面の行の `row-source`)だけ ── 編集していないときの `Ctrl + D`(ブックマーク)は奪わない
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import {
  NOW_STAMP_COMMANDS,
  formatDateTime,
  formatISO8601,
  formatShortDate,
  formatShortDateTime,
  formatTime,
} from '../../src/features/datetime/datetime-format';
import { KEY_COMMANDS } from '../../src/features/keymap';
import { SECTION_BOX_INPUT_FIELD } from '../../src/adapter/ui/render/section-box';

// 2026-11-15(日)14:05:30(端末の時刻)
const NOW = new Date(2026, 10, 15, 14, 5, 30);

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

function field(root: HTMLElement, name: string, text: string) {
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', name);
  ta.value = text;
  root.append(ta);
  ta.focus();
  ta.setSelectionRange(text.length, text.length);
  return ta;
}

type Keys = { key: string; code: string; shift?: boolean; alt?: boolean };
const press = (target: HTMLElement, k: Keys): KeyboardEvent => {
  const ev = new KeyboardEvent('keydown', {
    key: k.key,
    code: k.code,
    ctrlKey: true,
    shiftKey: k.shift === true,
    altKey: k.alt === true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(ev);
  return ev;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('字の形(PKC2 と同じ)', () => {
  it('🔴 時刻 / 日時 / 曜日つき / ISO 8601', () => {
    expect(formatTime(NOW)).toBe('14:05:30');
    expect(formatDateTime(NOW)).toBe('2026/11/15 14:05:30');
    expect(formatShortDate(NOW)).toBe('26/11/15 日');
    expect(formatShortDateTime(NOW)).toBe('26/11/15 日 14:05:30');
    expect(formatISO8601(NOW)).toMatch(/^2026-11-15T14:05:30[+-]\d\d:\d\d$/);
  });

  it('⚠ 1 桁の月日・時分秒は 0 で詰める / 年の下 2 桁も詰める', () => {
    const d = new Date(2009, 0, 2, 3, 4, 5);
    expect(formatTime(d)).toBe('03:04:05');
    expect(formatDateTime(d)).toBe('2009/01/02 03:04:05');
    expect(formatShortDate(d)).toBe('09/01/02 金');
  });

  it('🔑 命令の表と鍵の表が揃っている(片方だけに在る命令が無い)', () => {
    const ids = KEY_COMMANDS.filter((c) => c.id.startsWith('insert-now-')).map((c) => c.id).sort();
    expect(ids).toEqual(Object.keys(NOW_STAMP_COMMANDS).sort());
    expect(ids.length).toBe(5);
  });
});

describe('鍵で入れる(本文の欄)', () => {
  const cases: Array<[string, Keys, string]> = [
    ["Ctrl + '(US 配列)", { key: "'", code: 'Quote' }, '14:05:30'],
    // 🔴 日本語配列の `:` のキーは Shift なしで `:` を打つ(位置は Quote)── PKC2 の `Ctrl + :`
    ['Ctrl + :(日本語配列)', { key: ':', code: 'Quote' }, '14:05:30'],
    ['Ctrl + Shift + ;', { key: ':', code: 'Semicolon', shift: true }, '2026/11/15 14:05:30'],
    ['Ctrl + D', { key: 'd', code: 'KeyD' }, '26/11/15 日'],
    ['Ctrl + Shift + D', { key: 'D', code: 'KeyD', shift: true }, '26/11/15 日 14:05:30'],
  ];
  for (const [name, keys, want] of cases) {
    it(`🔴 ${name} → カーソルの位置に「${want}」(2 列の欄)`, () => {
      const { root } = setup();
      const ta = field(root, 'editor-body', 'メモ ');
      const ev = press(ta, keys);
      expect(ev.defaultPrevented, '鍵が素通りした(ブラウザの既定が走る)').toBe(true);
      expect(ta.value).toBe(`メモ ${want}`);
    });
  }

  it('🔴 ISO 8601(Ctrl + Alt + Shift + D)', () => {
    const { root } = setup();
    const ta = field(root, 'editor-body', '');
    press(ta, { key: 'D', code: 'KeyD', shift: true, alt: true });
    expect(ta.value).toMatch(/^2026-11-15T14:05:30[+-]\d\d:\d\d$/);
  });

  // 🔴 本文の欄の外の 3 つの欄でも、5 つ全部が同じ口で入る(着地前レビュー: 1 本だけでは他の 4 つが死んでも緑)
  for (const name of ['row-source', 'append-input', SECTION_BOX_INPUT_FIELD]) {
    for (const [label, keys, want] of cases) {
      it(`🔴 ${name} で ${label} → 「${want}」`, () => {
        const { root } = setup();
        const ta = field(root, name, '- ');
        const ev = press(ta, keys);
        expect(ev.defaultPrevented, `${name} で鍵が素通りした`).toBe(true);
        expect(ta.value).toBe(`- ${want}`);
      });
    }
  }

  /**
   * ⚠ **日本語配列の `Ctrl + Shift + ;` は奪わない**(着地前レビュー 🔴1 を受けた判断)。
   * 日本語配列では `;` のキーに Shift を足すと `+` になり、`Ctrl + +` はブラウザの拡大である ── 日時の別名にすると、
   * 編集中に拡大できなくなる。日本語配列で日時を入れるのは `Ctrl + Shift + D`(曜日つき)か、操作を探す。
   */
  it('⚠ 対照群: 日本語配列の Ctrl + Shift + ;(= Ctrl + + の拡大)は奪わない', () => {
    const { root } = setup();
    const ta = field(root, 'editor-body', 'メモ ');
    const ev = press(ta, { key: '+', code: 'Semicolon', shift: true });
    expect(ev.defaultPrevented, '拡大の鍵を奪った').toBe(false);
    expect(ta.value).toBe('メモ ');
  });

  it('🔑 選んでいた字は置き換わる(打つのと同じ)', () => {
    const { root } = setup();
    const ta = field(root, 'editor-body', 'AAA BBB');
    ta.setSelectionRange(4, 7);
    press(ta, { key: "'", code: 'Quote' });
    expect(ta.value).toBe('AAA 14:05:30');
  });

  it('⚠ 対照群: 編集していないとき(本文の欄の外)の Ctrl + D は奪わない(ブラウザのブックマーク)', () => {
    const { root } = setup();
    const btn = document.createElement('button');
    root.append(btn);
    btn.focus();
    const ev = press(btn, { key: 'd', code: 'KeyD' });
    expect(ev.defaultPrevented, '編集していないのに Ctrl + D を止めた').toBe(false);
  });
});
