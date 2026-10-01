/**
 * 🔴 **太り方の probe の「読んでよいか」の判定**(#999 段①)。
 *
 * ⚠ 守っているのは 2 つ:
 * - **対照群(何もしない)が動いた回を、結果として数えない**(無い回も同じ)
 * - **検索の指紋**が 1 つでも違えば「同じ」と言わない(rowid が動いた = 索引が別の行を指す)
 */
import { describe, expect, it } from 'vitest';
import {
  compareFingerprints,
  controlMoved,
  gaugeDelta,
  perOp,
  problemsOfPhaseA,
  type GaugeLike,
} from '../probe/storage-gauge-judge.mjs';

const g = (over: Partial<GaugeLike> = {}): GaugeLike => ({
  pageCount: 100,
  fileBytes: 409600,
  freeBytes: 0,
  ftsSegments: 3,
  ...over,
});
const run = (name: string, n: number, after: Partial<GaugeLike>) => ({
  name,
  n,
  before: g(),
  after: g(after),
});

describe('gaugeDelta / perOp', () => {
  it('差は after − before で、null を含む段数は null(0 と読ませない)', () => {
    expect(gaugeDelta(g(), g({ fileBytes: 413696, freeBytes: 4096, ftsSegments: 5, pageCount: 101 }))).toEqual({
      pageCount: 1,
      fileBytes: 4096,
      freeBytes: 4096,
      ftsSegments: 2,
    });
    expect(gaugeDelta(g({ ftsSegments: null }), g()).ftsSegments).toBeNull();
    expect(gaugeDelta(g(), g({ ftsSegments: null })).ftsSegments).toBeNull();
  });
  it('1 操作あたり: n が 0 なら null(0 で割らない)', () => {
    const d = gaugeDelta(g(), g({ fileBytes: 409600 + 2000, freeBytes: 1000 }));
    expect(perOp(d, 0)).toBeNull();
    expect(perOp(d, 10)).toEqual({ fileBytes: 200, freeBytes: 100, ftsSegments: 0 });
  });
});

describe('対照群', () => {
  it('🔴 動いていなければ使える', () => {
    expect(controlMoved(run('idle', 0, {})).moved).toBe(false);
  });
  it('🔴 file / free / 段のどれが動いても「動いた」(3 つとも別々に見る)', () => {
    expect(controlMoved(run('idle', 0, { fileBytes: 409601 })).moved).toBe(true);
    expect(controlMoved(run('idle', 0, { freeBytes: 4096 })).moved).toBe(true);
    expect(controlMoved(run('idle', 0, { ftsSegments: 4 })).moved).toBe(true);
  });
  it('🔴 対照群そのものが無い回も「動いた」と同じ扱い(外しても緑にならない)', () => {
    expect(controlMoved(undefined).moved).toBe(true);
    expect(controlMoved(null).moved).toBe(true);
  });
});

describe('problemsOfPhaseA', () => {
  const good = { runs: [run('idle', 0, {}), run('save', 100, { fileBytes: 500000 })] };
  it('揃っていれば空', () => {
    expect(problemsOfPhaseA(good)).toEqual([]);
  });
  it('🔴 対照群が無い / 動いた / 経路が 0 操作 / 前提が 0 byte は、それぞれ別の理由で返る', () => {
    expect(problemsOfPhaseA({ runs: [run('save', 100, {})] }).join()).toContain('対照群(idle)が無い');
    expect(
      problemsOfPhaseA({ runs: [run('idle', 0, { freeBytes: 4096 }), run('save', 100, {})] }).join(),
    ).toContain('対照群が動いた');
    expect(problemsOfPhaseA({ runs: [run('idle', 0, {}), run('save', 0, {})] }).join()).toContain(
      'save: 0 操作',
    );
    const zero = { name: 'save', n: 5, before: g({ fileBytes: 0 }), after: g() };
    expect(problemsOfPhaseA({ runs: [run('idle', 0, {}), zero] }).join()).toContain('前提が崩れている');
    expect(problemsOfPhaseA({ runs: [] })).not.toEqual([]);
    expect(problemsOfPhaseA(undefined)).not.toEqual([]);
  });
});

describe('compareFingerprints', () => {
  const fp = () => ({
    counts: { entries: 3 },
    rowidAgg: [3, 6, 100, 3, 1],
    head: [['e1', 1]],
    sets: { a: ['e1', 'e2'], b: ['e3'] },
  });
  it('同じなら same', () => {
    expect(compareFingerprints(fp(), fp())).toEqual({ same: true, diffs: [] });
  });
  it('🔴 件数 / rowid 集計 / 先頭 / 検索の当たり、どれが違っても別々の理由で返る', () => {
    const base = fp();
    expect(compareFingerprints(base, { ...fp(), counts: { entries: 2 } }).diffs).toContain('件数が違う');
    expect(compareFingerprints(base, { ...fp(), rowidAgg: [3, 7, 100, 3, 1] }).diffs).toContain(
      'rowid の集計が違う',
    );
    expect(compareFingerprints(base, { ...fp(), head: [['e1', 2]] }).diffs).toContain(
      '先頭の (lid, rowid) が違う',
    );
    const moved = compareFingerprints(base, { ...fp(), sets: { a: ['e1', 'e9'], b: ['e3'] } });
    expect(moved.same).toBe(false);
    expect(moved.diffs).toEqual(['検索「a」の当たりが違う']);
    // ⚠ 片側にしか無い問いも違いとして数える
    expect(compareFingerprints(base, { ...fp(), sets: { a: ['e1', 'e2'] } }).same).toBe(false);
  });
});
