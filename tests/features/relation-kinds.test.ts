/**
 * 関係の種類の正本(#185 / 台帳 #180 の A-7)。
 *
 * 🔴 守る主張:
 * 1. 一覧は**1 か所だけ** ── 取込・居場所の判定・作る側が同じ表を見る
 * 2. user に内部名(`semantic`)を見せない
 * 3. **居場所は手で作れない**(ファイラの操作が作る ── 作り方を 2 つにしない)
 * 4. 知らない種類でも**黙って消さない**
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CREATABLE_KINDS,
  RELATION_KINDS,
  RELATION_LABELS,
  STRUCTURAL,
  isRelationKind,
  relationLabel,
} from '../../src/features/relation/kinds';

describe('関係の種類', () => {
  it('🔴 一覧に漏れがなく、全部に表示名がある', () => {
    expect(RELATION_KINDS.length).toBeGreaterThan(1);
    for (const k of RELATION_KINDS) {
      expect(RELATION_LABELS[k], `${k} の表示名が無い`).toBeTruthy();
      // ⚠ 内部名がそのまま出ていないこと(user に semantic と見せない)
      expect(RELATION_LABELS[k]).not.toBe(k);
    }
  });

  it('🔴 居場所は手で作れない(作り方を 2 つにしない)', () => {
    expect(RELATION_KINDS).toContain(STRUCTURAL);
    expect(CREATABLE_KINDS, '居場所が手で作れる側に入っている').not.toContain(STRUCTURAL);
    expect(CREATABLE_KINDS.length).toBe(RELATION_KINDS.length - 1);
  });

  it('知らない種類は名前をそのまま出す(黙って消さない)', () => {
    expect(isRelationKind('unknown')).toBe(false);
    expect(relationLabel('unknown')).toBe('unknown');
    expect(relationLabel('semantic')).toBe('関連');
  });

  /**
   * 🔴 **散らばっていた 3 か所が、本当に寄ったことを見る**(§7)。
   * ⚠ 「正本を作った」だけでは意味が無い ── 古い literal が残っていれば、
   *   種類を足したときに**そこだけ古くなる**。file を読んで literal の不在を見る。
   */
  it('🔴 種類の文字列を自前で持っている file が無い', () => {
    const files = [
      'src/features/relation/tree.ts',
      'src/features/import/pkc2-convert.ts',
      'src/adapter/state/app-state.ts',
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf-8');
      // ⚠ 注釈は除く ── 説明文に語が出るのは構わない(実装が持っていないこと)
      const code = src
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      expect(code, `${f} が 'structural' を直書きしている`).not.toContain("'structural'");
    }
  });
});
