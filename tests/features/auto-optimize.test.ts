/**
 * 🔴 **索引の片づけを、いつ自動で打つか**(#999 段③)── 判断(`planAutoOptimize`)と字。
 *
 * 見るのは **3 つの条件のそれぞれ**(最後の書込から 60 秒 / 前回から 10 分 / その間に書込 50 回)の
 * **境界の両側**、隠れているタブ、書込の lease を握らないタブ。
 * ⚠ 「全部そろったら打つ」だけでは、**1 つの条件を外す変異が緑のまま通る** ──
 * そろっている中から 1 つだけ外した入力で「打たない」を見る(= 外した条件だけが鳴る)。
 */
import { describe, expect, it } from 'vitest';
import {
  AUTO_OPTIMIZE_MIN_INTERVAL_MS,
  AUTO_OPTIMIZE_MIN_WRITES,
  AUTO_OPTIMIZE_QUIET_MS,
  OPTIMIZE_FAILED_TEXT,
  optimizeDoneText,
  planAutoOptimize,
  type AutoOptimizeInput,
} from '../../src/features/storage/auto-optimize';
import { BANNED_TERMS } from '../../src/features/ui-terms';
import { MESSAGE_KIND_LABEL, sanitizeMessageText } from '../../src/features/message/message-log';

const NOW = 10_000_000;

/** 3 条件がちょうど満たされた入力(どれか 1 つを 1 だけ外して使う)。 */
const ready: AutoOptimizeInput = {
  now: NOW,
  lastWriteAt: NOW - AUTO_OPTIMIZE_QUIET_MS,
  lastOptimizeAt: NOW - AUTO_OPTIMIZE_MIN_INTERVAL_MS,
  writesSince: AUTO_OPTIMIZE_MIN_WRITES,
  hidden: false,
  holdsWriterLease: true,
};

describe('初期値(2026-10-02)', () => {
  it('🔴 60 秒 / 10 分 / 50 回(数を動かすときは、動かした理由を添えてここを直す)', () => {
    expect(AUTO_OPTIMIZE_QUIET_MS).toBe(60_000);
    expect(AUTO_OPTIMIZE_MIN_INTERVAL_MS).toBe(600_000);
    expect(AUTO_OPTIMIZE_MIN_WRITES).toBe(50);
  });
});

describe('planAutoOptimize(#999 段③)', () => {
  it('🔴 3 条件がちょうどそろったら打つ(境界は「以上」)', () => {
    expect(planAutoOptimize(ready)).toEqual({ verdict: 'go', retryInMs: null });
  });

  it('🔴 書込が 49 回では打たない(50 回で打つ)', () => {
    const v = planAutoOptimize({ ...ready, writesSince: AUTO_OPTIMIZE_MIN_WRITES - 1 });
    expect(v.verdict).toBe('few-writes');
  });

  it('🔴 前回から 10 分に 1ms 足りなければ打たない ── 残りの時間を言う', () => {
    const v = planAutoOptimize({
      ...ready,
      lastOptimizeAt: NOW - AUTO_OPTIMIZE_MIN_INTERVAL_MS + 1,
    });
    expect(v).toEqual({ verdict: 'too-soon', retryInMs: 1 });
  });

  it('🔴 最後の書込から 60 秒に 1ms 足りなければ打たない ── 残りの時間を言う', () => {
    const v = planAutoOptimize({ ...ready, lastWriteAt: NOW - AUTO_OPTIMIZE_QUIET_MS + 1 });
    expect(v).toEqual({ verdict: 'busy', retryInMs: 1 });
  });

  it('🔴 隠れているタブでは、他の 3 条件がそろっていても打たない', () => {
    expect(planAutoOptimize({ ...ready, hidden: true }).verdict).toBe('hidden');
  });

  it('🔴 書込の lease を握らないタブでは、他の条件がそろっていても打たない', () => {
    expect(planAutoOptimize({ ...ready, holdsWriterLease: false }).verdict).toBe('not-writer');
  });

  it('🔴 1 度も打っていなければ間隔は要らない(起動して最初の 1 回)', () => {
    expect(planAutoOptimize({ ...ready, lastOptimizeAt: null }).verdict).toBe('go');
  });

  it('🔴 書込が 1 度も無ければ、時間が足りていても打たない(回数の条件が先に落ちる)', () => {
    const v = planAutoOptimize({ ...ready, lastWriteAt: null, writesSince: 0 });
    expect(v.verdict).toBe('few-writes');
  });

  it('🔴 理由は 1 つだけ返す: 全部外れたときは「立場」が先(lease → 隠れ → 回数 → 間隔 → 落ち着き)', () => {
    const none: AutoOptimizeInput = {
      now: NOW,
      lastWriteAt: NOW,
      lastOptimizeAt: NOW,
      writesSince: 0,
      hidden: true,
      holdsWriterLease: false,
    };
    expect(planAutoOptimize(none).verdict).toBe('not-writer');
    expect(planAutoOptimize({ ...none, holdsWriterLease: true }).verdict).toBe('hidden');
    expect(planAutoOptimize({ ...none, holdsWriterLease: true, hidden: false }).verdict).toBe(
      'few-writes',
    );
    expect(
      planAutoOptimize({
        ...none,
        holdsWriterLease: true,
        hidden: false,
        writesSince: AUTO_OPTIMIZE_MIN_WRITES,
      }).verdict,
    ).toBe('too-soon');
  });
});

describe('処理の記録の字(#999 段③)', () => {
  it('🔴 例: 0.4 秒・空き 11.6 MiB', () => {
    expect(optimizeDoneText(400, Math.round(11.6 * 1024 * 1024))).toBe(
      '索引を整理しました(0.4 秒、空き 11.6 MiB)',
    );
  });

  it('🔴 0.05 秒に届かないときは「0.0 秒」と書かない', () => {
    expect(optimizeDoneText(10, 0)).toBe('索引を整理しました(0.1 秒未満、空き 0.0 MiB)');
    expect(optimizeDoneText(50, 0)).toContain('0.1 秒、'); // 境界は 50ms から数字で書く
  });

  it('🔴 画面の字として使ってよい語だけ(使わない語を含まない)・メッセージの形で壊れない', () => {
    for (const text of [optimizeDoneText(400, 12_000_000), OPTIMIZE_FAILED_TEXT]) {
      // ⚠ 空振り防止 ── 一覧が空なら何も見ていない
      expect(BANNED_TERMS.length).toBeGreaterThan(10);
      for (const b of BANNED_TERMS) {
        // ⚠ 1 字の語(面 / 口 …)は、除外の複合語(画面 / 入口 …)を素通りさせる `pattern()` で見る
        expect(text.search(b.pattern()), `使わない語「${b.banned}」を含む: ${text}`).toBe(-1);
      }
      // 節の形を壊さない: 80 字以内・改行なし・「…」の囲みを含まない(= sanitize が何も変えない)
      expect(sanitizeMessageText(text)).toBe(text);
    }
    // 種類「処理」の字が禁止語でないことの確認(記録の種類の名前)
    expect(MESSAGE_KIND_LABEL.job).toBe('処理');
    expect(BANNED_TERMS.some((b) => b.banned === MESSAGE_KIND_LABEL.job)).toBe(false);
  });

  it('🔴 失敗の字は例外の字を含まない(固定)', () => {
    expect(OPTIMIZE_FAILED_TEXT).toBe('索引を整理できませんでした(次の機会にやり直します)');
  });
});
