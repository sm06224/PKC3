/**
 * 🔴 **textlog の「今日のノート」へ追記した `- [ ] …` は、予定として走査される**(レビュー指摘の確認)。
 *
 * 予定の「足す」は追記できる種類(ノート / ログ)の今日のノートへ書く(`findScheduleTargetNote`)。ログへ足すと本文は
 * 「日時の見出し(`## 2026-10-29 10:00:00`)+ チェックリストの行」になる。走査(`taskCardsOf`)も、候補の数え(`listTaskItems`
 * ── 保存時に `task_total` へ)も種類を見ない、ことをここで確かめる(見出しの節の下の行も札になる)。
 * 走査の SQL(`TASK_CANDIDATE_WHERE`)に種類の条件が無いことも原文で pin する。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { taskCardsOf } from '../../src/features/schedule/task-cards';
import { listTaskItems } from '../../src/features/markdown/task-count';
import { appendHeadingFor } from '../../src/features/flavor/append-spec';

describe('ログ(textlog)へ足した予定も、予定として走査される', () => {
  const heading = appendHeadingFor('textlog', new Date('2026-10-29T01:00:00Z'));
  const body = `## 2026-10-29 09:00:00\n\n朝会\n\n${heading}\n\n- [ ] 会議 @2026-10-30 14:00..15:00\n`;

  it('🔴 日時の見出しの節の下の `- [ ] … @日付` が札になる(日付・時刻つき)', () => {
    expect(heading, '前提: ログの追記は日時の見出しを付ける').toMatch(/^## \d{4}-\d{2}-\d{2} /);
    const cards = taskCardsOf('log1', body);
    expect(cards, '札になっていない').toHaveLength(1);
    expect(cards[0]).toMatchObject({ lid: 'log1', date: '2026-10-30', time: '14:00', timeEnd: '15:00' });
  });

  it('保存時に数える候補(task_total の元)も 1 件になる ── 0 だと走査の候補から外れる', () => {
    expect(listTaskItems(body).length).toBeGreaterThan(0);
  });

  it('日付なしで足した行も札になる(日付なしの札)', () => {
    const cards = taskCardsOf('log1', `${heading}\n\n- [ ] 電話する\n`);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.date).toBeNull();
  });

  it('走査の候補の条件(SQL)は種類を見ない', () => {
    const src = readFileSync('src/adapter/platform/storage/storage-worker.ts', 'utf-8');
    const cond = /export const TASK_CANDIDATE_COND = [^;]+;/.exec(src)?.[0] ?? '';
    const where = /export const TASK_CANDIDATE_WHERE = [^;]+;/.exec(src)?.[0] ?? '';
    expect(cond).not.toBe('');
    expect(`${cond}${where}`).not.toMatch(/archetype/);
  });
});
