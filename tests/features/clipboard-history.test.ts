/** @vitest-environment node */
/**
 * コピーした物の履歴(#678)の規則を縛る。
 *
 * 🔴 ここで守るのは **20 件の枠が user の役に立つこと**である ── 枠が
 * 「同じ物」や「押し間違いの空」で埋まると、**本当に要る物が押し出される**。
 * ⚠ そのとき症状は「履歴を開いても目当ての物が無い」で、user には
 * **なぜ消えたのか分からない**。
 */
import { describe, expect, it } from 'vitest';
import {
  COPY_HISTORY_BYTES_MAX,
  COPY_HISTORY_MAX,
  copyLabel,
  copyWeight,
  dropCopied,
  fitCopied,
  isRecordableCopy,
  pushCopied,
  type CopiedItem,
} from '../../src/features/clipboard/history';

const item = (text: string, at = 1): CopiedItem => ({ at, text, html: '' });

describe('積む規則', () => {
  it('新しいものが先頭に来る', () => {
    const list = pushCopied(pushCopied([], item('a', 1)), item('b', 2));
    expect(list.map((c) => c.text)).toEqual(['b', 'a']);
  });

  it('🔴 同じ中身は積み直す(枠が同じ物で埋まらない)', () => {
    let list: CopiedItem[] = [];
    for (const t of ['a', 'b', 'a']) list = pushCopied(list, item(t));
    expect(list.map((c) => c.text), '同じ物が 2 件残っている').toEqual(['a', 'b']);
  });

  it('🔴 押し間違いの空は積まない(本当に要る 20 件が押し出される)', () => {
    expect(pushCopied([item('a')], item('')).map((c) => c.text)).toEqual(['a']);
    expect(pushCopied([item('a')], item('   \n ')).map((c) => c.text)).toEqual(['a']);
    // ⚠ **対照群** ── 字が在れば積む(規則そのものが死んでいない)
    expect(pushCopied([item('a')], item(' b ')).map((c) => c.text)).toEqual([' b ', 'a']);
  });

  it('20 件を超えたら、いちばん古いものから落ちる', () => {
    let list: CopiedItem[] = [];
    for (let i = 0; i < COPY_HISTORY_MAX + 5; i += 1) list = pushCopied(list, item(`t${String(i)}`));
    expect(list).toHaveLength(COPY_HISTORY_MAX);
    expect(list[0]?.text, '新しいものが先頭でない').toBe(`t${String(COPY_HISTORY_MAX + 4)}`);
    expect(list.some((c) => c.text === 't0'), 'いちばん古いものが残っている').toBe(false);
  });

  it('⚠ 元の配列を書き換えない(呼び側が state を持つ)', () => {
    const before: CopiedItem[] = [item('a')];
    pushCopied(before, item('b'));
    expect(before.map((c) => c.text)).toEqual(['a']);
  });

  it('空かどうかの判定は、字が在るかで決まる', () => {
    expect(isRecordableCopy('')).toBe(false);
    expect(isRecordableCopy(' \t\n ')).toBe(false);
    expect(isRecordableCopy('x')).toBe(true);
  });
});

describe('🔴 総量でも切る(件数だけでは破れる)', () => {
  it('大きい物が続くと、20 件に届く前に古いものから落ちる', () => {
    // ⚠ 1 件 400 KB を 4 件 ── 件数は 20 の内だが、総量 1 MB を超える
    const big = (n: number): CopiedItem => ({ at: n, text: 'x'.repeat(400_000), html: '' });
    let list: CopiedItem[] = [];
    for (let i = 0; i < 4; i += 1) list = pushCopied(list, { ...big(i), text: 'x'.repeat(400_000) + String(i) });
    expect(list.length, '総量を無視して 4 件持っている').toBeLessThan(4);
    expect(list.reduce((a, c) => a + copyWeight(c), 0)).toBeLessThanOrEqual(COPY_HISTORY_BYTES_MAX);
    // 🔑 **新しいものが残る**(いま貼りたい物が落ちない)
    expect(list[0]?.text.endsWith('3'), '新しいほうが落ちている').toBe(true);
  });

  it('🔴 先頭の 1 件は、単独で超えていても残す(いまコピーした物が消えない)', () => {
    const huge: CopiedItem = { at: 1, text: 'x'.repeat(COPY_HISTORY_BYTES_MAX * 2), html: '' };
    expect(fitCopied([huge]), 'いまコピーした物が履歴から消えた').toHaveLength(1);
  });

  it('⚠ 小さい物なら 20 件まで入る(総量の規則が常に効いていない)', () => {
    let list: CopiedItem[] = [];
    for (let i = 0; i < COPY_HISTORY_MAX; i += 1) list = pushCopied(list, { at: i, text: `t${String(i)}`, html: '' });
    expect(list).toHaveLength(COPY_HISTORY_MAX);
  });
});

describe('一覧に出す字', () => {
  it('🔴 改行を畳む(表をコピーすると一覧が縦に伸びて選べなくなる)', () => {
    expect(copyLabel('a\nb\n\nc')).toBe('a b c');
  });

  it('🔴 長すぎるものは切って、切った印を出す', () => {
    const long = 'あ'.repeat(100);
    const out = copyLabel(long, 10);
    expect(out).toHaveLength(11); // 10 字 + …
    expect(out.endsWith('…'), '切った印が無い(短い物に見える)').toBe(true);
    // ⚠ **対照群** ── 収まる物には印を付けない
    expect(copyLabel('みじかい', 10)).toBe('みじかい');
  });
});

describe('消す', () => {
  it('名指した 1 件だけ消える', () => {
    expect(dropCopied([item('a'), item('b')], 'a').map((c) => c.text)).toEqual(['b']);
  });

  it('⚠ 無い物を指しても、ほかを巻き込まない', () => {
    expect(dropCopied([item('a')], 'zzz').map((c) => c.text)).toEqual(['a']);
  });
});
