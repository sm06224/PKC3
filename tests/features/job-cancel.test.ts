/**
 * 🔴 **長い仕事をやめる印**(台帳 #1852 束 F2 / 依頼 253)。
 * 印は「立てる前は通り、立てた後は区切りで必ず抜ける」── どちらか片側だけだと、常に抜ける / 常に抜けない実装でも緑になるので両方見る。
 */
import { describe, expect, it } from 'vitest';
import {
  createCancelToken,
  isOperationCancelled,
  OperationCancelled,
} from '../../src/features/job-cancel';

describe('createCancelToken', () => {
  it('立てる前は通る(対照群)。立てた後は区切りで OperationCancelled を投げる', () => {
    const t = createCancelToken();
    expect(t.cancelled).toBe(false);
    expect(() => t.throwIfCancelled()).not.toThrow();
    t.cancel();
    expect(t.cancelled).toBe(true);
    expect(() => t.throwIfCancelled()).toThrow(OperationCancelled);
  });

  it('2 度立てても同じ。別の印には移らない', () => {
    const a = createCancelToken();
    const b = createCancelToken();
    a.cancel();
    a.cancel();
    expect(a.cancelled).toBe(true);
    expect(b.cancelled, '別の仕事の印まで立った').toBe(false);
  });

  it('isOperationCancelled は OperationCancelled だけを真にする(失敗と取り違えない)', () => {
    expect(isOperationCancelled(new OperationCancelled())).toBe(true);
    expect(isOperationCancelled(new Error('操作を途中でやめました'))).toBe(false);
    expect(isOperationCancelled(null)).toBe(false);
    expect(isOperationCancelled('x')).toBe(false);
  });
});
