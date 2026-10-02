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
  problemsOfOptimizeOp,
  problemsOfPhaseA,
  problemsOfReservedLock,
  stateOfKill,
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

describe('problemsOfOptimizeOp(#999 段③)', () => {
  const ok = {
    roundTripMs: 400,
    result: {
      before: g({ ftsSegments: 14, freeBytes: 4096, fileBytes: 409600 }),
      after: g({ ftsSegments: 1, freeBytes: 12288, fileBytes: 409600 }),
    },
  };
  it('揃っていれば空', () => {
    expect(problemsOfOptimizeOp(ok)).toEqual([]);
  });
  it('🔴 1 秒に 1ms 超えた / 打てていない / 畳む前が 1 段 / 畳まれていない は、それぞれ別の理由で返る', () => {
    expect(problemsOfOptimizeOp({ ...ok, roundTripMs: 1000 })).toEqual([]);
    expect(problemsOfOptimizeOp({ ...ok, roundTripMs: 1001 }).join()).toContain('1 秒を超えた');
    expect(problemsOfOptimizeOp(undefined).join()).toContain('打てていない');
    const flat = { ...ok, result: { ...ok.result, before: g({ ftsSegments: 1, freeBytes: 4096 }) } };
    expect(problemsOfOptimizeOp(flat).join()).toContain('前提が崩れている');
    const unmerged = { ...ok, result: { ...ok.result, after: g({ ftsSegments: 3, freeBytes: 12288 }) } };
    expect(problemsOfOptimizeOp(unmerged).join()).toContain('畳まれていない');
  });
  it('🔴 空きが減った / file が縮んだ = VACUUM を打っている、は別々に返る', () => {
    const lessFree = { ...ok, result: { ...ok.result, after: g({ ftsSegments: 1, freeBytes: 0, fileBytes: 409600 }) } };
    expect(problemsOfOptimizeOp(lessFree).join()).toContain('空きが減った');
    const shrunk = { ...ok, result: { ...ok.result, after: g({ ftsSegments: 1, freeBytes: 12288, fileBytes: 300000 }) } };
    expect(problemsOfOptimizeOp(shrunk).join()).toContain('file が縮んだ');
  });
});

describe('problemsOfReservedLock / stateOfKill(#1218 F1)', () => {
  const good = (killAtMs: number) => ({
    killAtMs,
    patched: true,
    reopen: 'ok',
    quickCheck: ['ok'],
    total: 100,
    touched: 0,
  });
  const failed = (killAtMs: number) => ({ killAtMs, patched: false, reopen: 'FAIL' });

  it('結末は 5 通りに分かれる(巻き戻し / 終わっていた / 途中 / 読めない / 開けない)', () => {
    expect(stateOfKill(good(1))).toBe('rolled-back');
    expect(stateOfKill({ ...good(1), touched: 100 })).toBe('completed');
    expect(stateOfKill({ ...good(1), touched: 40 })).toBe('half');
    expect(stateOfKill({ ...good(1), quickCheck: ['page 3: bad'] })).toBe('unreadable');
    expect(stateOfKill({ reopen: 'ok', total: 100, touched: 0 })).toBe('unreadable'); // quick_check を読めていない
    expect(stateOfKill({ ...good(1), total: 0 })).toBe('unreadable'); // 件数が読めていない = 空に満たされない
    expect(stateOfKill(failed(1))).toBe('init-failed');
  });

  it('patched: 全部が巻き戻っていれば空', () => {
    expect(problemsOfReservedLock([good(1500), good(3000), good(4500)], 'patched')).toEqual([]);
  });

  it('🔴 patched: 差し替わっていない / 終わっていた / 開けない / 途中 は、それぞれ別の理由で返る', () => {
    expect(problemsOfReservedLock([{ ...good(1500), patched: false }], 'patched').join()).toContain('差し替えが当たっていない');
    expect(problemsOfReservedLock([{ ...good(1500), patched: undefined }], 'patched').join()).toContain('差し替えが当たっていない');
    expect(problemsOfReservedLock([{ ...good(1500), touched: 100 }], 'patched').join()).toContain('測れていない');
    expect(problemsOfReservedLock([{ ...failed(1500), patched: true }], 'patched').join()).toContain('init-failed');
    expect(problemsOfReservedLock([{ ...good(1500), touched: 3 }], 'patched').join()).toContain('half');
    expect(problemsOfReservedLock([], 'patched').join()).toContain('1 つも無い');
  });

  it('unpatched(対照群): 差し替わっておらず、1 件以上が壊れていれば空', () => {
    expect(problemsOfReservedLock([failed(1500), { ...good(3000), patched: false }], 'unpatched')).toEqual([]);
  });

  it('🔴 unpatched: 1 件も壊れない / 差し替わっている は「対照群として成り立たない」と返る', () => {
    const intact = { ...good(1500), patched: false };
    expect(problemsOfReservedLock([intact, intact], 'unpatched').join()).toContain('1 件も壊れなかった');
    expect(problemsOfReservedLock([{ ...failed(1500), patched: true }], 'unpatched').join()).toContain('対照群なのに差し替わっている');
    // 「終わっていた」は壊れに数えない(終わった回は巻き戻しの話に入らない)
    expect(problemsOfReservedLock([{ ...good(1500), patched: false, touched: 100 }], 'unpatched').join()).toContain('1 件も壊れなかった');
  });

  it('expect が不明なら読ませない', () => {
    // @ts-expect-error 不正な expect を渡す
    expect(problemsOfReservedLock([good(1)], 'x').join()).toContain('不明');
  });
});
