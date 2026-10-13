import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { errorMessageJa, errorText } from '../../src/features/error-text';

describe('errorText(#1087)', () => {
  it('Error の前置きを付けず、中身だけを返す', () => {
    expect(errorText(new Error('通信失敗'))).toBe('通信失敗');
    expect(errorText(new TypeError('x'))).toBe('x');
    expect(errorText('文字のまま')).toBe('文字のまま');
  });

  it('🔴 PKC3 自身が英語で投げる物は日本語にし、元の英語は括弧に残す', () => {
    const cases = [
      'store client terminated',
      'storage worker not initialized',
      'storage worker error: load failed',
      'storage worker message deserialization failed',
      'asset: spawn failed: Error: x',
      'ooxml: load failed',
      'asr: message deserialization failed',
      'revision restore failed (no base): n1',
    ];
    for (const raw of cases) {
      const t = errorMessageJa(raw);
      expect(t, raw).not.toBe(raw);
      expect(t, `${raw}: 元の英語を消した`).toContain(raw);
    }
  });

  it('対照群: 知らない英語・ふつうの日本語はそのまま', () => {
    expect(errorMessageJa('SQLITE_FULL')).toBe('SQLITE_FULL');
    expect(errorMessageJa('通信失敗')).toBe('通信失敗');
  });

  it('🔴 表の英語は、投げる側の字と揃っている(片側だけ変えると素通りする)', () => {
    const client = readFileSync('src/adapter/platform/storage/store-client.ts', 'utf8');
    expect(client).toContain("'store client terminated'");
    expect(client).toContain('storage worker error: ');
    expect(client).toContain("'storage worker message deserialization failed'");
    const worker = readFileSync('src/adapter/platform/storage/storage-worker.ts', 'utf8');
    expect(worker).toContain("'storage worker not initialized'");
    expect(worker).toContain('revision restore failed');
    const lease = readFileSync('src/adapter/platform/worker-lease.ts', 'utf8');
    expect(lease).toContain(': spawn failed: ');
    expect(lease).toContain(": message deserialization failed`");
  });
});
