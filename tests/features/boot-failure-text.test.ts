import { describe, expect, it } from 'vitest';
import { bootFailureText } from '../../src/features/boot-failure-text';

describe('bootFailureText(#1087)', () => {
  it('🔴 新しいバージョンのデータは、何が起きたか・データが無事か・どうするかを日本語で言う', () => {
    const t = bootFailureText('db user_version 5 is newer than supported 4');
    expect(t).toContain('新しいバージョンで保存されたデータ');
    expect(t).toContain('データは変えていません');
    // ⚠ 詳細は消さない(報告の手がかり)
    expect(t).toContain('db user_version 5');
  });

  it('対照群: 原因が分からないときは、これまでどおり詳細をそのまま出す', () => {
    expect(bootFailureText('boom')).toBe('起動に失敗しました: boom');
  });

  it('🔴 投げる側の字と、読み取る形が揃っている(片側だけ変えると素通りする)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/adapter/platform/storage/storage-worker.ts', 'utf8');
    expect(src).toContain('is newer than supported ${DB_SCHEMA_VERSION}');
  });
});
