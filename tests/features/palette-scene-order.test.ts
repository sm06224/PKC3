/** @vitest-environment happy-dom */
/**
 * 🔴 **「操作を探す」で、いまの場面に合う操作を上に寄せる**(#1966 3-2。🟣 Gemini の裁定 = 案 A)。
 *
 * - 見出しの節は作らない(#582 段③)── 並び順だけが変わる
 * - 押せる行の中で、いまの場面の文脈で効く操作が先(押せない行より前に出ることは無い)
 * - 名前の当たり方が先、場面は同じ当たり方の中だけ(字を打って探した結果を崩さない)
 * - どこでも効く(`global`)操作は場面の操作に数えない
 */
import { describe, expect, it } from 'vitest';
import { KEY_COMMANDS, type KeyContext } from '../../src/features/keymap';
import { paletteRows } from '../../src/features/palette/palette-rows';
import { bindActions, commandRowsFor, paletteScene } from '../../src/adapter/ui/actions/binder';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { SECTION_BOX_INPUT_FIELD } from '../../src/adapter/ui/render/section-box';

const ALL = new Set(KEY_COMMANDS.map((c) => c.id));
const ctxOf = (id: string): readonly KeyContext[] => KEY_COMMANDS.find((c) => c.id === id)!.contexts;
const rows = (query: string, scene: KeyContext[], ready: ReadonlySet<string> = ALL) =>
  paletteRows(query, {}, ready, false, () => null, undefined, false, new Set(scene));
const isHere = (id: string, scene: KeyContext): boolean => ctxOf(id).includes(scene);

describe('並び', () => {
  it('🔴 空欄では、いまの場面で効く操作が先に並ぶ(編集の欄)', () => {
    const r = rows('', ['editor']).map((x) => x.id);
    const firstOther = r.findIndex((id) => !isHere(id, 'editor'));
    const lastHere = r.map((id) => isHere(id, 'editor')).lastIndexOf(true);
    expect(firstOther, '前提: 場面の外の操作が無い').toBeGreaterThan(0);
    expect(lastHere, '場面の操作が、場面の外の操作より後ろに混ざっている').toBeLessThan(firstOther);
  });

  it('🔴 場面が変われば、先頭も変わる(読んでいる → 「ノートを閉じる」/ 別の画面 → 「画面を閉じる」)', () => {
    expect(rows('', ['reading'])[0]!.id).toBe('deselect-entry');
    expect(rows('', ['window'])[0]!.id).toBe('close-pane');
  });

  it('⚠ 対照群: 場面が空なら、今までどおりの並び(定義の順)', () => {
    expect(rows('', []).map((x) => x.id)).toEqual(KEY_COMMANDS.map((c) => c.id));
  });

  it('⚠ 押せない行は、場面に合っても押せる行より前に出ない', () => {
    const ready = new Set([...ALL].filter((id) => !isHere(id, 'reading')));
    const r = rows('', ['reading'], ready);
    const firstBlocked = r.findIndex((x) => !x.ready);
    expect(r.slice(0, firstBlocked).every((x) => x.ready)).toBe(true);
    expect(r.slice(firstBlocked).every((x) => !x.ready)).toBe(true);
  });

  it('🔴 字を打ったときは、名前の当たり方が先(場面は同じ当たり方の中だけ)', () => {
    // 「閉じる」: 名前が「閉じる」で始まる操作は無く、途中に含む物が並ぶ ── 読んでいる場面でも、
    // 名前の頭に当たる操作(rank 0)が在れば、それが場面の操作より先
    const q = 'ノート';
    const plain = rows(q, []);
    const inScene = rows(q, ['reading']);
    const rankZero = plain.filter((x) => x.label.startsWith('ノート')).map((x) => x.id);
    expect(rankZero.length, '前提: 名前が「ノート」で始まる操作が無い').toBeGreaterThan(0);
    expect(inScene.slice(0, rankZero.length).map((x) => x.id).sort(), '場面の寄せが名前の当たり方を追い越した').toEqual(
      [...rankZero].sort(),
    );
  });

  it('🔴 場面の操作でも、名前の当たり方が悪ければ後ろ(「画面」: 説明だけに当たる「ノートを閉じる」は、名前の頭に当たる「画面を閉じる」より後)', () => {
    const r = rows('画面', ['reading']).map((x) => x.id);
    expect(r.indexOf('deselect-entry'), '前提: 説明の「画面」に当たっていない').toBeGreaterThan(-1);
    expect(r[0], '場面の寄せが名前の当たり方を追い越した').toBe('close-pane');
    expect(r.indexOf('close-pane')).toBeLessThan(r.indexOf('deselect-entry'));
  });

  it('⚠ どこでも効く(global)操作は、場面の操作として上に寄らない', () => {
    const globalOnly = KEY_COMMANDS.filter((c) => c.contexts.length === 1 && c.contexts[0] === 'global').map((c) => c.id);
    const r = rows('', ['reading']).map((x) => x.id);
    expect(r.indexOf(globalOnly[0]!)).toBeGreaterThan(r.indexOf('deselect-entry'));
  });
});

describe('場面の決め方(paletteScene)', () => {
  const ta = (field: string): HTMLTextAreaElement => {
    const t = document.createElement('textarea');
    t.setAttribute('data-pkc-field', field);
    return t;
  };
  const booted = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] }).state;

  it('🔴 欄から開いたら、その欄の文脈', () => {
    expect([...paletteScene(ta('editor-body'), booted)]).toEqual(['editor']);
    expect([...paletteScene(ta('row-source'), booted)]).toEqual(['row']);
    expect([...paletteScene(ta('append-input'), booted)]).toEqual(['append']);
    expect([...paletteScene(ta(SECTION_BOX_INPUT_FIELD), booted)]).toEqual(['append']);
  });

  it('🔴 欄の外: 1 画面の編集中 → live / 別の画面 → window / ノートを読んでいる → reading / 何も開いていない → 空', () => {
    expect([...paletteScene(null, { ...booted, phase: 'editing' })]).toEqual(['live']);
    expect([...paletteScene(null, { ...booted, viewMode: 'settings' as typeof booted.viewMode })]).toEqual(['window']);
    expect([...paletteScene(null, { ...booted, selectedLid: 'n1' })]).toEqual(['reading']);
    expect([...paletteScene(null, booted)]).toEqual([]);
  });
});

describe('🔴 実際の一覧(`commandRowsFor`)に場面が届く', () => {
  it('ノートを読んでいるとき、空欄の一覧の先頭は「ノートを閉じる」(場面を渡し忘れると定義の順のまま)', () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    buildShell(root);
    const d = new Dispatcher();
    const keymap = new KeymapStore();
    bindActions(root, d, {}, keymap);
    const meta = { lid: 'n1', title: 'メモ', archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1, status: null, date: null, archived: false, bodyChars: null };
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    const r = commandRowsFor(root, d, keymap, '', null);
    expect(r.find((x) => x.id === 'deselect-entry')?.ready, '前提: 読んでいるのに「ノートを閉じる」が押せない').toBe(true);
    expect(r[0]!.id, '場面が一覧に届いていない').toBe('deselect-entry');
  });
});
