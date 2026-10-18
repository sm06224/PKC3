/**
 * 🔴 **塊を動かした直後の「元に戻す」は、空行の数まで動かす前の本文に戻る**(依頼 118-3。Gemini の回答「推薦どおり」= A)。
 *
 * 直す前は、逆向きに塊を動かし直していたので、空行を 2 本入れて区切る書き方では空行の数が変わって戻った
 * (総当たりで 5576 件中 3108 件)。観測点は「動かす → 戻す」の結果の本文が、動かす前の本文と 1 字も違わないこと。
 * 対照群: 本文が動かした直後から変わっていたら、その本文を壊さず行を動かし直す道(従来)に落ちる。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { moveLinesWithInverse, type MoveLines } from '../../src/features/markdown/line-move';

/** 空行 2 本で区切った 4 つの段落。 */
const DOUBLE = ['一つ目', '', '', '二つ目', '', '', '三つ目', '', '', '四つ目', ''].join('\n');

function move(body: string, start: number, toBefore: number): MoveLines {
  const all = body.split('\n');
  return { start, end: start, toBefore, lines: [all[start]!], toBeforeLine: all[toBefore] ?? null };
}

describe('moveLinesWithInverse の「元に戻す」(依頼 118-3)', () => {
  it('🔴 空行 2 本区切りでも、動かして戻すと動かす前の本文と 1 字も違わない(全ての動かし方を総当たり)', () => {
    const all = DOUBLE.split('\n');
    let moved = 0;
    let withRestore = 0;
    for (let start = 0; start < all.length; start += 1) {
      if (all[start] === '') continue;
      for (let to = 0; to <= all.length; to += 1) {
        const m = moveLinesWithInverse(DOUBLE, move(DOUBLE, start, to));
        if (m === null || m.inverse === null) continue;
        moved += 1;
        if (m.inverse.restore !== undefined) withRestore += 1;
        const back = moveLinesWithInverse(m.body, m.inverse);
        expect(back?.body, `start=${String(start)} to=${String(to)}`).toBe(DOUBLE);
      }
    }
    // 空振り防止: 動いた回が在り、そのうち「そのままの戻し先」が必要な回(従来は空行の数がずれた回)も在る
    expect(moved).toBeGreaterThan(10);
    expect(withRestore, '空行の数がずれる回が 1 つも無い ── この検査が従来の欠陥を見ていない').toBeGreaterThan(0);
  });

  it('戻した結果の「元に戻す」(押し直し)も、動かした直後の本文へ 1 字違わず戻る', () => {
    const all = DOUBLE.split('\n');
    const start = all.indexOf('三つ目');
    const m = moveLinesWithInverse(DOUBLE, move(DOUBLE, start, 0))!;
    const back = moveLinesWithInverse(m.body, m.inverse!)!;
    expect(back.body).toBe(DOUBLE);
    expect(back.inverse).not.toBeNull();
    expect(moveLinesWithInverse(back.body, back.inverse!)?.body).toBe(m.body);
  });

  it('対照群: 動かした後に本文が変わっていたら、そのままの戻し先は使わず、行を動かし直す(別の書換を消さない)', () => {
    const all = DOUBLE.split('\n');
    const start = all.indexOf('三つ目');
    const m = moveLinesWithInverse(DOUBLE, move(DOUBLE, start, 0))!;
    expect(m.inverse?.restore, '前提: この動かし方は「そのままの戻し先」を持つはず').toBeDefined();
    const edited = `${m.body}別の窓が足した行\n`;
    const back = moveLinesWithInverse(edited, m.inverse!);
    expect(back, '変わった本文でも行を動かし直せるはず').not.toBeNull();
    expect(back!.body, '別の窓が足した行を消した').toContain('別の窓が足した行');
    expect(back!.body).not.toBe(DOUBLE);
  });

  it('空行 1 本区切り(普通の書き方)は従来どおり行を動かし直すだけ(そのままの戻し先を持たない)', () => {
    const single = ['一つ目', '', '二つ目', '', '三つ目', ''].join('\n');
    const m = moveLinesWithInverse(single, move(single, 4, 0))!;
    expect(m.inverse?.restore).toBeUndefined();
    expect(moveLinesWithInverse(m.body, m.inverse!)?.body).toBe(single);
  });
});

describe('画面の「元に戻す」(UNDO_MOVE)を通しても、空行の数まで戻る(依頼 118-3)', () => {
  it('🔴 動かした ack → UNDO_MOVE が飛ばす書換を当てると、動かす前の本文と 1 字も違わない', () => {
    const d = new Dispatcher();
    const events: DomainEvent[] = [];
    d.onEvent((e) => events.push(e));
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        {
          lid: 'n1',
          title: 't',
          archetype: 'text',
          createdAt: null,
          updatedAt: null,
          entryOrder: 1,
          status: null,
          date: null,
          archived: false,
          bodyChars: null,
        },
      ],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: DOUBLE });
    const all = DOUBLE.split('\n');
    const rewrite = {
      kind: 'move-lines' as const,
      start: all.indexOf('三つ目'),
      end: all.indexOf('三つ目'),
      toBefore: 0,
      lines: ['三つ目'],
      toBeforeLine: all[0]!,
    };
    const moved = applyBodyRewrite(DOUBLE, rewrite)!;
    expect(moved, '前提: 動いている').not.toBe(DOUBLE);
    d.dispatch({ type: 'BODY_REWRITTEN', lid: 'n1', body: moved, rewrite, status: null, date: null, archived: false });
    expect(d.getState().lastMove, '戻す材料が無い').not.toBeNull();
    events.length = 0;
    d.dispatch({ type: 'UNDO_MOVE' });
    const ev = events.find((e) => e.type === 'REQUEST_BODY_REWRITE') as
      | { rewrite: Parameters<typeof applyBodyRewrite>[1] }
      | undefined;
    expect(ev, '戻す依頼が出ていない').toBeDefined();
    expect(applyBodyRewrite(moved, ev!.rewrite), '空行の数まで元どおりに戻っていない').toBe(DOUBLE);
    // 対照群: 動かした後に本文が変わっていれば、その本文を壊さず行を動かし直す
    const changed = `${moved}別の窓の行\n`;
    const other = applyBodyRewrite(changed, ev!.rewrite);
    expect(other).not.toBeNull();
    expect(other).toContain('別の窓の行');
  });
});
