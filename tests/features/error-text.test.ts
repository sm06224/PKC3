import { describe, expect, it } from 'vitest';
import { errorText } from '../../src/features/error-text';

describe('errorText(#1087)', () => {
  it('Error の前置きを付けず、中身だけを返す', () => {
    expect(errorText(new Error('通信失敗'))).toBe('通信失敗');
    expect(errorText(new TypeError('x'))).toBe('x');
    expect(errorText('文字のまま')).toBe('文字のまま');
  });
});
