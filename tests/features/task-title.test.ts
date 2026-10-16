/** @vitest-environment happy-dom */
/**
 * 🔴 **予定の題名は素の字で見せる / 書き出す**(#1087)。
 *
 * 札の `text` は行の字そのもの(`**重要** [資料](entry:abc)`)。見せる所(札・`.ics` の SUMMARY・
 * アラートの帯)だけが記号を落とす。⚠ 書き換えは札の `rawLine` を使う(ここでは触らない)。
 */
import { describe, expect, it } from 'vitest';
import { plainTaskTitle } from '../../src/features/schedule/task-title';
import { buildIcs, resolveIcsZone } from '../../src/features/schedule/ics';
import { itemOfCard } from '../../src/features/schedule/agenda';
import { taskCardsOf, TASK_LIMITS } from '../../src/features/schedule/task-cards';
import { alarmEntryText } from '../../src/features/alarm/alarm-due';
import { createTaskCard, patchTaskCard } from '../../src/adapter/ui/render/task-card';

describe('plainTaskTitle', () => {
  it.each([
    ['**重要** [資料](entry:abc) を送る', '重要 資料 を送る'],
    ['![図](asset:x) を見る', '図 を見る'],
    ['`code` と ~~消す~~ と *斜め*', 'code と 消す と 斜め'],
    [':strong:[太い]{x=1} 字', '太い 字'],
  ])('%s → %s', (src, plain) => {
    expect(plainTaskTitle(src)).toBe(plain);
  });

  it('⚠ 釣り合っていない記号・普通の字は触らない(字を黙って欠かない)', () => {
    for (const s of ['2*3 と 4*5', 'snake_case_name', '打ち合わせ', 'a * b', '[括弧だけ] です'])
      expect(plainTaskTitle(s), s).toBe(s);
  });
});

describe('.ics の SUMMARY(#1087)', () => {
  const zone = resolveIcsZone('Asia/Tokyo', () => 540);
  const summaryOf = (body: string): string => {
    const items = taskCardsOf('L', body).map(itemOfCard);
    const t = buildIcs(items, { stamp: new Date(0), zone }).text.replace(/\r\n[ \t]/g, '');
    return t.split('\r\n').find((l) => l.startsWith('SUMMARY:')) ?? '';
  };

  it('🔴 記号を落とす', () => {
    expect(summaryOf('- [ ] **重要** [資料](entry:abc123) を送る @2026-10-20\n')).toBe(
      'SUMMARY:重要 資料 を送る',
    );
  });

  it('🔴 長い題名も切らない(「…」で終わらない)', () => {
    const long = 'あ'.repeat(TASK_LIMITS.textChars + 30);
    expect(summaryOf(`- [ ] ${long} @2026-10-21\n`)).toBe(`SUMMARY:${long}`);
  });
});

describe('札と帯に出す字(#1087)', () => {
  it('🔴 札の字は記号を落とす。札のデータ(text)は行の字のまま', () => {
    const c = taskCardsOf('L', '- [ ] **重要** [資料](entry:abc) を送る @2026-10-20\n')[0]!;
    expect(c.text).toBe('**重要** [資料](entry:abc) を送る');
    const el = createTaskCard(itemOfCard(c));
    patchTaskCard(el, itemOfCard(c), 't', 2026, false);
    expect(el.querySelector('[data-pkc-field="text"]')?.textContent).toBe('重要 資料 を送る');
  });

  it('🔴 札では長い題名を 200 字で丸め、丸めたと判る(…)', () => {
    const long = 'あ'.repeat(TASK_LIMITS.textChars + 30);
    const c = taskCardsOf('L', `- [ ] ${long} @2026-10-20\n`)[0]!;
    const el = createTaskCard(itemOfCard(c));
    patchTaskCard(el, itemOfCard(c), 't', 2026, false);
    expect(el.querySelector('[data-pkc-field="text"]')?.textContent).toBe(
      `${'あ'.repeat(TASK_LIMITS.textChars)}…`,
    );
  });

  it('アラートの帯も記号を落とす', () => {
    expect(
      alarmEntryText({ key: 'k', lid: 'a', line: 1, text: '**会議** [資料](entry:x)', time: '14:00' }),
    ).toBe('14:00 会議 資料');
  });
});
