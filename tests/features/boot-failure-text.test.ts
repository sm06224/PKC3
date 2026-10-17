/** @vitest-environment node */
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

  it('🔴 空き容量の不足: 起動できていないので、アプリの中の画面・ボタンを案内しない(#1087 D5)', () => {
    for (const m of ['QuotaExceededError: The quota has been exceeded.', 'SQLITE_FULL: database or disk is full']) {
      const t = bootFailureText(m);
      expect(t, '起動できていないのに、アプリの中のボタンを押させている').not.toContain('使われていない添付を消す');
      expect(t).not.toContain('システム');
      expect(t, '端末の空きを作る案内が無い').toContain('空き容量を増やして');
      expect(t, '再読み込みが無い').toContain('再読み込み');
      expect(t, '詳細を消した(報告の手がかり)').toContain(`(詳細: ${m})`);
    }
  });

  it('🔴 壊れ・開けない・保存機能が無い: 英語のまま出さず、削除していないことと次の一手を言う(#1087 D5)', () => {
    const cases: [string, RegExp][] = [
      ['database disk image is malformed', /閉じて、ページを再読み込み/],
      ['SQLITE_CANTOPEN: unable to open database file', /閉じて、ページを再読み込み/],
      ['Missing required OPFS APIs', /通常のウィンドウ/],
    ];
    for (const [m, next] of cases) {
      const t = bootFailureText(m);
      expect(t, `${m}: 削除していないことを言っていない`).toContain('データは削除していません');
      expect(t, `${m}: 次の一手が無い`).toMatch(next);
      // 英語の原文は末尾の詳細にだけ残る
      expect(t.replace(`(詳細: ${m})`, ''), `${m}: 英語が本文に出ている`).not.toContain(m);
      expect(t.endsWith(`(詳細: ${m})`)).toBe(true);
    }
  });

  it('🔴 投げる側の字と、読み取る形が揃っている(片側だけ変えると素通りする)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/adapter/platform/storage/storage-worker.ts', 'utf8');
    expect(src).toContain('is newer than supported ${DB_SCHEMA_VERSION}');
  });
});
