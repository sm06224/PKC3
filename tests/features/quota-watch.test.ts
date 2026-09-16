/**
 * 🔴 **空きが尽きる前に言う**(#971 段②)。
 *
 * ⚠ ここがいちばん守りたいのは「**分からないときに、余裕があると言わない**」である ──
 *   逆へ倒れると、user は**いちばん危ない環境で安心する**。
 */
import { describe, expect, it } from 'vitest';
import {
  QUOTA_ALARM_RATIO,
  QUOTA_WARN_RATIO,
  quotaBootNotice,
  quotaLevel,
  quotaText,
} from '../../src/features/storage/quota-watch';

const GB = 1024 * 1024 * 1024;

describe('空きの段(#971 段②)', () => {
  it('⚠ 普通に空いていれば ok', () => {
    expect(quotaLevel({ usage: 1 * GB, quota: 10 * GB })).toBe('ok');
  });

  it('🔴 境目のちょうど上で段が変わる(片側だけ見て決めていない)', () => {
    const quota = 100 * GB;
    // ⚠ **両側**を見る ── 片側だけだと「always warn」に壊しても落ちない
    expect(quotaLevel({ usage: quota * (QUOTA_WARN_RATIO - 0.01), quota })).toBe('ok');
    expect(quotaLevel({ usage: quota * QUOTA_WARN_RATIO, quota })).toBe('warn');
    expect(quotaLevel({ usage: quota * (QUOTA_ALARM_RATIO - 0.01), quota })).toBe('warn');
    expect(quotaLevel({ usage: quota * QUOTA_ALARM_RATIO, quota })).toBe('alarm');
  });

  /**
   * 🔴 **`quota` が 0 のとき** ── 割ると `Infinity` になる。
   * ⚠ そこを `ok` に倒すと、**いちばん危ない環境が「余裕がある」と出る**
   *   (CLAUDE.md §1「無いときに何が返るかを 1 度実測してから条件を書く」)。
   */
  it('🔴 上限が 0 の端末を「余裕がある」と言わない', () => {
    expect(quotaLevel({ usage: 0, quota: 0 })).toBe('unknown');
    expect(quotaLevel({ usage: 100, quota: 0 })).toBe('unknown');
  });

  it('🔴 値が欠けていたら unknown(勝手に 0 を埋めない)', () => {
    expect(quotaLevel({})).toBe('unknown');
    expect(quotaLevel({ usage: 1 * GB })).toBe('unknown');
    expect(quotaLevel({ quota: 10 * GB })).toBe('unknown');
    expect(quotaLevel({ usage: Number.NaN, quota: 10 * GB })).toBe('unknown');
  });
});

describe('画面に出す字(#971 段②)', () => {
  const noMarkup = (s: string): void => {
    expect(s, `記法が混じっている: ${s}`).not.toMatch(/[*`_]|\[.*\]\(.*\)/);
  };

  /**
   * 🔴 **数はいつも出す** ── これが無かったのが、直す前のいちばんの穴である。
   *   「何が容量を使っているか」は**添付の合計だけ**を数え、ブラウザの数とは
   *   一致しないと断ってあるので、**本当の残りを知る道が 1 つも無かった**。
   */
  it('🔴 余裕があるときでも、実際の数を出す', () => {
    const s = quotaText({ usage: 1 * GB, quota: 10 * GB });
    expect(s, '使用量を出していない').toContain('1.0 GB');
    expect(s, '上限を出していない').toContain('10.0 GB');
    expect(s, '割合を出していない').toContain('10 パーセント');
    noMarkup(s);
  });

  it('🔴 危ないときは、次の一手まで書く', () => {
    const s = quotaText({ usage: 95 * GB, quota: 100 * GB });
    expect(s, '数が消えている').toContain('95 パーセント');
    expect(s, '何をすればよいか書いていない').toMatch(/添付を消す|バックアップ/);
    noMarkup(s);
  });

  it('⚠ 読めなかったときは、読めなかったと言う(0 と言わない)', () => {
    const s = quotaText({});
    expect(s).toContain('読めませんでした');
    expect(s, '0 バイトだと嘘をついた').not.toContain('0 B');
    noMarkup(s);
  });

  /**
   * 🔴 **起動のときは、危ない日だけ言う**。
   * ⚠ 毎回の起動で何か言うと、本当に危ない日の 1 行が**同じ顔に埋もれる**。
   */
  it('🔴 起動の合図は、危ないときだけ出る', () => {
    expect(quotaBootNotice({ usage: 1 * GB, quota: 10 * GB }), '余裕があるのに言った').toBe('');
    expect(quotaBootNotice({}), '読めないのに言った').toBe('');
    expect(quotaBootNotice({ usage: 85 * GB, quota: 100 * GB })).not.toBe('');
    expect(quotaBootNotice({ usage: 95 * GB, quota: 100 * GB })).not.toBe('');
  });
});
