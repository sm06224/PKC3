/**
 * 🔴 **前の日の未完了を引き継ぐ**(#1966 4-4。user 裁定 2026-11-16「写して前の日から外す」)の書換規則。
 */
import { describe, expect, it } from 'vitest';
import { CARRY_OVER_LEAD, carryOverTasks } from '../../src/features/schedule/carry-over';
import { listTaskItems } from '../../src/features/markdown/task-count';

const FENCE = '```';
const run = (fromBody: string, toBody = '') =>
  carryOverTasks({
    from: { lid: 'd15', title: '2026-11-15', body: fromBody },
    to: { lid: 'd16', title: '2026-11-16', body: toBody },
  });

describe('写して、前の日から外す', () => {
  it('🔴 未完了だけを今日の末尾へ写し、前の日の行は取り消し線 + 今日へのリンクに変える', () => {
    const r = run('# 作業\n- [ ] 見積を送る @2026-11-15\n- [x] 済んだこと\n- [ ] 電話する\n', '朝のメモ\n');
    expect(r.count).toBe(2);
    expect(r.fromBody).toBe(
      '# 作業\n- ~~見積を送る @2026-11-15~~ → [2026-11-16](entry:d16)\n- [x] 済んだこと\n- ~~電話する~~ → [2026-11-16](entry:d16)\n',
    );
    expect(r.toBody).toBe(
      `朝のメモ\n\n${CARRY_OVER_LEAD}[2026-11-15](entry:d15)\n- [ ] 見積を送る @2026-11-15\n- [ ] 電話する\n`,
    );
  });

  it('🔴 前の日の未完了は 0 件になり(同じ未完了が 2 日に残らない)、今日の未完了に数えられる', () => {
    const r = run('- [ ] a\n- [ ] b\n');
    expect(listTaskItems(r.fromBody).filter((t) => !t.done)).toEqual([]);
    expect(listTaskItems(r.toBody).filter((t) => !t.done).map((t) => t.text)).toEqual(['a', 'b']);
  });

  it('⚠ 空の今日のノートには、空行を挟まずに書く', () => {
    expect(run('- [ ] a\n').toBody).toBe(`${CARRY_OVER_LEAD}[2026-11-15](entry:d15)\n- [ ] a\n`);
  });

  it('⚠ 未完了が無ければ何も変えない(0 件)', () => {
    const r = run('- [x] 済み\n- 普通の箇条書き\n', '今日\n');
    expect(r).toEqual({ fromBody: '- [x] 済み\n- 普通の箇条書き\n', toBody: '今日\n', count: 0 });
  });

  it('⚠ コードの中・中身が空のチェックは送らない', () => {
    const body = `${FENCE}\n- [ ] コードの例\n${FENCE}\n- [ ]\n- [ ] 本物\n`;
    const r = run(body);
    expect(r.count).toBe(1);
    expect(r.fromBody).toBe(`${FENCE}\n- [ ] コードの例\n${FENCE}\n- [ ]\n- ~~本物~~ → [2026-11-16](entry:d16)\n`);
  });

  it('⚠ 引用・字下げ・番号の前置きは、前の日では保ち、今日では素のチェック項目にする', () => {
    const r = run('> - [ ] 引用の中\n  1. [ ] 入れ子の番号\n');
    expect(r.fromBody).toBe('> - ~~引用の中~~ → [2026-11-16](entry:d16)\n  1. ~~入れ子の番号~~ → [2026-11-16](entry:d16)\n');
    expect(r.toBody).toBe(`${CARRY_OVER_LEAD}[2026-11-15](entry:d15)\n- [ ] 引用の中\n- [ ] 入れ子の番号\n`);
  });

  it('⚠ CRLF の本文は CRLF のまま', () => {
    const r = run('- [ ] a\r\n- [x] b\r\n', 'x\r\n');
    expect(r.fromBody).toBe('- ~~a~~ → [2026-11-16](entry:d16)\r\n- [x] b\r\n');
    expect(r.toBody).toBe(`x\r\n\r\n${CARRY_OVER_LEAD}[2026-11-15](entry:d15)\r\n- [ ] a\r\n`);
  });

  it('⚠ もう一度通しても、引き継いだ行は 2 度送らない(冪等)', () => {
    const once = run('- [ ] a\n', '');
    const twice = carryOverTasks({
      from: { lid: 'd15', title: '2026-11-15', body: once.fromBody },
      to: { lid: 'd16', title: '2026-11-16', body: once.toBody },
    });
    expect(twice.count).toBe(0);
  });
});
