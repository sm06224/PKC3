/** @vitest-environment happy-dom */
/**
 * 🔴 **メッセージの約束が、画面とマニュアルの両方に出ている**(#1087)。
 *
 * メッセージは「ノートの中身・題名・添付名は書き込まれません」と約束している。守っているのは
 * ①書き出しボタンの下に、その約束が**見える字**で出ていること(ホバーでしか読めないと指で触る端末には届かない)
 * ②マニュアルの数字(未読の数え方・空きの段の境目)が実装と揃っていること。
 * ⚠ 守っていないもの:書き込み側の漏れ(`tests/message-name-leak.test.ts` が見る)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { initialState } from '../../src/adapter/state/app-state';
import { paintStatusMessages } from '../../src/adapter/ui/render/status-open';
import { QUOTA_ALARM_RATIO, quotaText } from '../../src/features/storage/quota-watch';

const MANUAL = readFileSync('docs/manual.md', 'utf-8');

/** 「### 見出し」から次の「### 」の手前まで。 */
function sectionOf(title: string): string {
  const i = MANUAL.indexOf(`### ${title}\n`);
  expect(i, `マニュアルに「${title}」の節が無い`).toBeGreaterThanOrEqual(0);
  const j = MANUAL.indexOf('\n### ', i + 5);
  return MANUAL.slice(i, j < 0 ? undefined : j);
}

describe('書き出しボタンの下に、書き込まないものを字で言う(#1087)', () => {
  it('ボタンの次の兄弟が、約束の説明である', () => {
    const host = document.createElement('div');
    new SettingsRenderer(host).render(initialState);
    const btn = host.querySelector('[data-pkc-action="export-messages"]');
    expect(btn, '書き出しボタンが無い(空振り)').not.toBeNull();
    const note = btn!.nextElementSibling;
    expect(note?.getAttribute('data-pkc-field')).toBe('settings-note');
    expect(note?.textContent).toBe(
      'ノートの中身・題名・添付名は書き込まれません。バグ報告にはこのメッセージを貼ってください。',
    );
  });
});

describe('マニュアル「メッセージ」と実装の数字', () => {
  it('🔴 未読が出る条件(注意と問題だけ)と、押すと開いて既読になることを言っている', () => {
    const sec = sectionOf('メッセージ');
    expect(sec).toContain('画面下に**未読 N 件**と出るのは、**注意**と**問題**が読まれていないときです');
    expect(sec).toContain('結果・配信・処理は数えません');
    // 画面の字(「未読 N 件」)は実装から引く ── 手で書いた字と食い違ったら落ちる
    const btn = document.createElement('button');
    paintStatusMessages(btn, 3);
    expect(btn.textContent).toBe('未読 3 件');
    expect(sec).toContain('未読 N 件');
  });

  it('🔴 「注意」が溜まる場面を、2 つだけと言い切っていない', () => {
    const sec = sectionOf('メッセージ');
    expect(sec).not.toContain('いまは次の 2 つ');
    expect(sec).toContain('たとえば次のとき溜まります');
  });
});

describe('マニュアル「残りが少なくなったとき」と実装の数字', () => {
  it('🔴 「文面が変わる」境目は、実装の割合(百分率)と同じ', () => {
    const sec = sectionOf('残りが少なくなったとき');
    const pct = Math.round(QUOTA_ALARM_RATIO * 100);
    expect(sec).toContain(`${pct} パーセントを超えると`);
    expect(sec).not.toContain('9 割を超えると');
  });

  it('🔴 マニュアルに引いた文は、実装が出す文の一部そのまま', () => {
    const sec = sectionOf('残りが少なくなったとき');
    const alarm = quotaText({ usage: 95, quota: 100 });
    const warn = quotaText({ usage: 85, quota: 100 });
    for (const sentence of ['空きがほとんどありません。', 'これ以上増えると保存に失敗して、', '途中までしか書き込まれないことがあります。']) {
      expect(alarm, `実装が出さない文を書いた: ${sentence}`).toContain(sentence);
      expect(sec).toContain(sentence);
    }
    for (const sentence of ['空きが少なくなってきました。重いノートから整理しておくと安全です。', 'システム → 保存領域 →「容量を調べる」で、重いノートを探せます。']) {
      expect(warn, `実装が出さない文を書いた: ${sentence}`).toContain(sentence);
      expect(sec).toContain(sentence);
    }
  });
});
