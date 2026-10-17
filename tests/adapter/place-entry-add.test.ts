/** @vitest-environment happy-dom */
/**
 * 🔴 **ほかのノートを板に置く**(#1662 2。Gemini 裁定 = #1163 依頼 48 の 2 = A)── 書換の記法と reducer の門。
 * 画面の入口(右クリック → 小窓 → 選ぶ)は `body-context-menu.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, type AppState, type DomainEvent } from '../../src/adapter/state/app-state';
import { addPlaceEntry, placeTextOf } from '../../src/features/markdown/place-notation';

const BOARD = ':::format{#p1 .pkc-place x=120 y=40 w=320 h=200}\n買い出し\n:::\n';

function setup() {
  const metas = new Map(
    ['n1', 'n2'].map((lid, i) => [
      lid,
      { lid, title: lid, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: i + 1, status: null, date: null, archived: false },
    ]),
  ) as unknown as AppState['entryMetas'];
  const d = new Dispatcher({
    ...initialState,
    cid: 'c1',
    phase: 'ready',
    selectedLid: 'n1',
    entryMetas: metas,
    openBody: { lid: 'n1', body: BOARD, baseline: BOARD, persisted: BOARD, diskAhead: false },
  });
  const events: DomainEvent[] = [];
  d.onEvent((e) => void events.push(e));
  return { d, events };
}

describe('ほかのノートを板に置く(#1662 2)', () => {
  it('🔴 本文の末尾に entry= の付箋が 1 枚足され、既存の本文は 1 バイトも動かない', () => {
    const next = addPlaceEntry(BOARD, 37, 61, 'n2')!;
    expect(next).toBe(`${BOARD}\n:::format{.pkc-place entry=n2 x=37 y=61}\n:::\n`);
    // 置いたノートの付箋として読める(字を書く口は出ない)
    expect(placeTextOf(next, BOARD.split('\n').length)).toBeNull();
  });

  it('🔴 lid に開き行を壊す字が入っていたら書かない / 閉じていない囲いの中へも書かない', () => {
    expect(addPlaceEntry(BOARD, 0, 0, 'n2 x=0}')).toBeNull();
    expect(addPlaceEntry(BOARD, 0, 0, '')).toBeNull();
    expect(addPlaceEntry('```\nコード', 0, 0, 'n2')).toBeNull();
    expect(addPlaceEntry(BOARD, -1, 0, 'n2')).toBeNull();
  });

  it('🔴 reducer: 台帳に居ないノートは置かない / テンプレートと同時には渡せない / 居れば entry つきの依頼になる', () => {
    const s = setup();
    s.d.dispatch({ type: 'ADD_PLACE', lid: 'n1', x: 1, y: 2, entry: 'ghost' });
    expect(s.events.some((e) => e.type === 'REQUEST_BODY_REWRITE'), '居ないノートの付箋を置こうとした').toBe(false);
    s.d.dispatch({ type: 'ADD_PLACE', lid: 'n1', x: 1, y: 2, entry: 'n2', template: 'matrix2' });
    expect(s.events.some((e) => e.type === 'REQUEST_BODY_REWRITE'), '2 つ同時に通した').toBe(false);
    s.d.dispatch({ type: 'ADD_PLACE', lid: 'n1', x: 1, y: 2, entry: 'n2' });
    expect(s.events.find((e) => e.type === 'REQUEST_BODY_REWRITE')).toMatchObject({
      rewrite: { kind: 'place-add', x: 1, y: 2, entry: 'n2' },
    });
  });
});
