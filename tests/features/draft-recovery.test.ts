/**
 * 保存していない編集の復元(#1376)── 判断の純関数。
 * 守るもの:控える頻度(止まって 1 秒 / 打ち続けても 5 秒)・上限・本文が変わったかの判定・1 行の字。
 */
import { describe, expect, it } from 'vitest';
import {
  DRAFT_BYTES_MAX,
  DRAFT_COUNT_MAX,
  DRAFT_LIVE_FALLBACK_MS,
  DraftThrottle,
  byteLength,
  draftKey,
  draftOfferLine,
  fingerprint,
  fitsDraft,
  isLiveDraft,
  judgeDraft,
  pruneDrafts,
  type DraftClock,
  type DraftRecord,
} from '../../src/features/draft/draft-recovery';

function rec(over: Partial<DraftRecord> = {}): DraftRecord {
  return { cid: 'c', lid: 'n1', body: 'new', title: 't', base: fingerprint('old'), at: 1, tab: 'A', ...over };
}

/** 時刻を手で進める偽のタイマー。 */
function fakeClock() {
  let now = 0;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  let seq = 0;
  const clock: DraftClock = {
    now: () => now,
    set: (fn, ms) => {
      const id = ++seq;
      timers.push({ id, at: now + ms, fn });
      return id;
    },
    clear: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  return {
    clock,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.splice(timers.indexOf(next), 1);
        now = next.at;
        next.fn();
      }
      now = end;
    },
  };
}

describe('judgeDraft(起動のとき、聞くかどうか)', () => {
  const T = 't'; // rec() の既定の題名
  it('保存されている本文と題名が控えと同じなら聞かない(same)', () => {
    expect(judgeDraft(rec({ body: 'x' }), { body: 'x', title: T })).toBe('same');
  });
  it('🔴 題名だけ違うなら聞く(題名だけ直した控えを「同じ」と読んで黙って片付けない)', () => {
    // 本文は編集前のまま(base と一致)、題名だけ直した控え
    const titleOnly = rec({ body: 'old', title: '新しい題名' });
    expect(judgeDraft(titleOnly, { body: 'old', title: '古い題名' })).toBe('plain');
    // 対照群:題名も同じなら同じ
    expect(judgeDraft(titleOnly, { body: 'old', title: '新しい題名' })).toBe('same');
  });
  it('ノートが無ければ聞かない(gone)。空の本文とは別', () => {
    expect(judgeDraft(rec(), null)).toBe('gone');
    expect(judgeDraft(rec({ body: 'x' }), { body: '', title: T })).not.toBe('gone');
  });
  it('編集に入ったときのままなら plain、変わっていたら moved', () => {
    expect(judgeDraft(rec(), { body: 'old', title: T })).toBe('plain');
    expect(judgeDraft(rec(), { body: 'old + 別の場所の更新', title: T })).toBe('moved');
  });
  it('指紋は長さも見る(同じ指紋の別の長さを取り違えない)', () => {
    expect(fingerprint('a')).not.toBe(fingerprint('aa'));
    expect(fingerprint('old')).toBe(fingerprint('old'));
  });
});

describe('draftOfferLine(1 行の字)', () => {
  it('題名つき・無題・別の場所で更新・ほか N 件', () => {
    expect(draftOfferLine('買い物', false, 0)).toBe('保存していない編集が残っています(買い物)');
    expect(draftOfferLine('  ', false, 0)).toBe('保存していない編集が残っています(無題)');
    expect(draftOfferLine('買い物', true, 0)).toContain(
      '別の場所で更新されています。戻して保存すると、その更新は履歴に残ります',
    );
    expect(draftOfferLine('買い物', false, 2)).toContain('ほか 2 件');
    expect(draftOfferLine('買い物', false, 0)).not.toContain('ほか');
    expect(draftOfferLine('買い物', false, 0)).not.toContain('別の場所');
  });
});

describe('上限', () => {
  it('2 MB を超える本文は控えない。日本語は byte で数える', () => {
    expect(byteLength('あ')).toBe(3);
    expect(fitsDraft('a'.repeat(DRAFT_BYTES_MAX), '')).toBe(true);
    expect(fitsDraft('a'.repeat(DRAFT_BYTES_MAX), 'x')).toBe(false);
    // 文字数では 2M 未満でも byte では超える
    expect(fitsDraft('あ'.repeat(Math.ceil(DRAFT_BYTES_MAX / 3) + 1), '')).toBe(false);
  });
  it('21 件目からは古い控えが落ちる(新しい 20 件が残る)', () => {
    const all = Array.from({ length: DRAFT_COUNT_MAX + 3 }, (_, i) => rec({ lid: `n${i}`, at: i }));
    const kept = pruneDrafts(all);
    expect(kept).toHaveLength(DRAFT_COUNT_MAX);
    expect(kept.map((r) => r.at)).not.toContain(0);
    expect(kept[0]?.at).toBe(DRAFT_COUNT_MAX + 2);
  });
  it('鍵はコレクションとノートの両方で決まる', () => {
    expect(draftKey('c1', 'n')).not.toBe(draftKey('c2', 'n'));
    expect(draftKey('c', 'n1')).not.toBe(draftKey('c', 'n2'));
  });
});

describe('isLiveDraft(別のタブが編集中の控えを聞かない)', () => {
  it('自分の控えは生きている。他のタブは印の有無で決まる', () => {
    expect(isLiveDraft(rec({ tab: 'me' }), 'me', new Set(), 0)).toBe(true);
    expect(isLiveDraft(rec({ tab: 'B' }), 'me', new Set(['B']), 0)).toBe(true);
    expect(isLiveDraft(rec({ tab: 'B' }), 'me', new Set(['C']), 0)).toBe(false);
  });
  it('印が取れない端末では、新しい控えだけを生きていると見る', () => {
    const d = rec({ tab: 'B', at: 1000 });
    expect(isLiveDraft(d, 'me', null, 1000 + DRAFT_LIVE_FALLBACK_MS - 1)).toBe(true);
    expect(isLiveDraft(d, 'me', null, 1000 + DRAFT_LIVE_FALLBACK_MS)).toBe(false);
  });
});

describe('DraftThrottle(控える頻度)', () => {
  it('打鍵が止まって 1 秒で 1 回だけ控える', () => {
    const f = fakeClock();
    let n = 0;
    const t = new DraftThrottle(f.clock, () => n++);
    t.touch();
    f.advance(999);
    expect(n).toBe(0);
    f.advance(1);
    expect(n).toBe(1);
    f.advance(10_000);
    expect(n).toBe(1);
  });
  it('打つたびに待ち直す(0.5 秒おきに打つ間は控えない)', () => {
    const f = fakeClock();
    let n = 0;
    const t = new DraftThrottle(f.clock, () => n++);
    for (let i = 0; i < 6; i++) {
      t.touch();
      f.advance(500);
    }
    expect(n).toBe(0);
    f.advance(500);
    expect(n).toBe(1);
  });
  it('打ち続けても最初の打鍵から 5 秒で必ず控える(5 秒の手前では控えない)', () => {
    const f = fakeClock();
    let n = 0;
    const t = new DraftThrottle(f.clock, () => n++);
    // 0.5 秒おき。最初の打鍵は 0 秒、期限は 5 秒
    for (let i = 0; i < 10; i++) {
      t.touch();
      f.advance(500);
      if (i < 9) expect(n, `${String((i + 1) * 500)}ms で控えた`).toBe(0);
    }
    expect(n).toBe(1);
  });
  it('flush は待っている分をすぐ控え、cancel は控えない', () => {
    const f = fakeClock();
    let n = 0;
    const t = new DraftThrottle(f.clock, () => n++);
    t.touch();
    t.flush();
    expect(n).toBe(1);
    f.advance(10_000);
    expect(n).toBe(1);
    t.touch();
    t.cancel();
    f.advance(10_000);
    expect(n).toBe(1);
    expect(t.pending()).toBe(false);
    t.flush(); // 何も待っていなければ控えない
    expect(n).toBe(1);
  });
});
