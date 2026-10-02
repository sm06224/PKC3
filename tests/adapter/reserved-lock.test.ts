/**
 * #1218 F1: `xCheckReservedLock` の差し替え(`reserved-lock.ts`)の分岐を、node で見る。
 *
 * SAHPool の本物は node に無い(実ブラウザで殺して開き直す probe が見る ──
 * `tests/probe/storage-gauge-probe.mjs` の `reserved-lock` phase)。ここで守るのは
 * **差し替えが当たらなかった枝を黙って通さないこと**と、**関数を使い回すこと**:
 *
 * 1. 上流が 1 を返すとき:差し替わり、差し替わった関数は**呼ぶと 0 を書く**
 * 2. 同じ表を共有する 2 本目の接続:**もう 1 度 install しない**(接続ごとに増やさない)
 * 3. 上流が既に 0 を返すとき:差し替えない(`reservedLockUpstreamFixed`)
 * 4. 当たらなかった 3 通り(rc ≠ 0 / file が無い / 表が無い):**両方 false**
 *    ── 呼び側(main)が「効いていません」と言う材料
 * 5. 確保した 8 byte は、どの枝でも返す
 *
 * ⚠ 守っていない物:本物の `sqlite3_file_control` が `FILE_POINTER` に返す形
 *   (struct の配置)は fake の写しである ── 本物は probe が見る。
 */
import { describe, expect, it } from 'vitest';
import {
  fixReservedLock,
  reservedLockInstallCount,
  type ReservedLockSqlite,
} from '../../src/adapter/platform/storage/reserved-lock';

interface Rig {
  sqlite3: ReservedLockSqlite;
  /** 接続(db pointer)→ file pointer → 表。 */
  connect(opts?: { rc?: number; noFile?: boolean; noMethods?: boolean; shared?: Table }): number;
  newTable(upstreamAnswer: 0 | 1): Table;
  allocated: () => number;
  /** 最後に current が受け取った pFile。 */
  lastCalledWith: () => number | null;
}
interface Table {
  ptr: number;
  $xCheckReservedLock: number;
}

function makeRig(): Rig {
  const heap = new Map<number, number>();
  const fns = new Map<number, (pFile: number, pRes: number) => number>();
  const tables = new Map<number, Table>();
  const dbs = new Map<number, { rc: number; file: number }>();
  const files = new Map<number, { pMethods: number }>();
  let next = 1000;
  let live = 0;
  let lastFile: number | null = null;
  const fresh = (): number => (next += 16);

  const sqlite3: ReservedLockSqlite = {
    capi: {
      SQLITE_FCNTL_FILE_POINTER: 7,
      sqlite3_file_control(pDb, name, op, pArg) {
        const d = dbs.get(pDb);
        if (d === undefined || name !== 'main' || op !== 7) return 1;
        if (d.rc !== 0) return d.rc;
        heap.set(pArg, d.file);
        return 0;
      },
      sqlite3_file: class {
        private readonly f: { pMethods: number };
        constructor(p: number) {
          this.f = files.get(p) ?? { pMethods: 0 };
        }
        get $pMethods(): number {
          return this.f.pMethods;
        }
        set $pMethods(v: number) {
          this.f.pMethods = v;
        }
      } as unknown as ReservedLockSqlite['capi']['sqlite3_file'],
      sqlite3_io_methods: class {
        private readonly t: Table;
        constructor(p: number) {
          this.t = tables.get(p)!;
        }
        get $xCheckReservedLock(): number {
          return this.t.$xCheckReservedLock;
        }
        set $xCheckReservedLock(v: number) {
          this.t.$xCheckReservedLock = v;
        }
      } as unknown as ReservedLockSqlite['capi']['sqlite3_io_methods'],
    },
    wasm: {
      alloc: () => {
        live++;
        return fresh();
      },
      dealloc: () => {
        live--;
      },
      peekPtr: (p) => heap.get(p) ?? 0,
      peek32: (p) => heap.get(p) ?? 0,
      poke32: (p, v) => {
        heap.set(p, v);
      },
      installFunction: (_sig, fn) => {
        const p = fresh();
        fns.set(p, fn);
        return p;
      },
      functionEntry: (p) => fns.get(p),
    },
  };

  return {
    sqlite3,
    newTable(upstreamAnswer) {
      const ptr = fresh();
      const fp = sqlite3.wasm.installFunction('i(pp)', (pFile, pRes) => {
        lastFile = pFile;
        sqlite3.wasm.poke32(pRes, upstreamAnswer);
        return 0;
      });
      const t: Table = { ptr, $xCheckReservedLock: fp };
      tables.set(ptr, t);
      return t;
    },
    connect(opts = {}) {
      const dbPtr = fresh();
      const filePtr = fresh();
      const table = opts.shared ?? this.newTable(1);
      files.set(filePtr, { pMethods: opts.noMethods ? 0 : table.ptr });
      dbs.set(dbPtr, { rc: opts.rc ?? 0, file: opts.noFile ? 0 : filePtr });
      return dbPtr;
    },
    allocated: () => live,
    lastCalledWith: () => lastFile,
  };
}

describe('xCheckReservedLock の差し替え(#1218 F1)', () => {
  it('上流が 1 を返すとき差し替え、差し替わった関数は 0 を書く(本物の file ポインタで呼んで確かめた)', () => {
    const rig = makeRig();
    const table = rig.newTable(1);
    const before = table.$xCheckReservedLock;
    const out = fixReservedLock(rig.sqlite3, rig.connect({ shared: table }));
    expect(out).toEqual({ reservedLockPatched: true, reservedLockUpstreamFixed: false });
    expect(table.$xCheckReservedLock, '表の関数が替わっていない').not.toBe(before);
    // 替わった関数を実際に呼び、答えが 0 であること(「替えた」だけでは別の関数かもしれない)
    const fn = rig.sqlite3.wasm.functionEntry(table.$xCheckReservedLock)!;
    rig.sqlite3.wasm.poke32(5, 9);
    fn(1, 5);
    expect(rig.sqlite3.wasm.peek32(5)).toBe(0);
    // 確かめに呼んだ上流の関数は、空の pFile ではなく本物の file ポインタを受けた
    expect(rig.lastCalledWith(), '上流の関数に file ポインタを渡していない').toBeGreaterThan(0);
    expect(rig.allocated(), '確保した 8 byte を返していない').toBe(0);
  });

  it('🔑 同じ表を共有する 2 本目の接続は、もう 1 度 install しない(接続ごとに関数を増やさない)', () => {
    const rig = makeRig();
    const table = rig.newTable(1);
    const n0 = reservedLockInstallCount();
    const a = fixReservedLock(rig.sqlite3, rig.connect({ shared: table }));
    const mine = table.$xCheckReservedLock;
    const b = fixReservedLock(rig.sqlite3, rig.connect({ shared: table }));
    const c = fixReservedLock(rig.sqlite3, rig.connect({ shared: table }));
    expect(reservedLockInstallCount() - n0, 'install が接続ごとに増えている').toBe(1);
    expect(table.$xCheckReservedLock, '2 本目が関数を差し替え直した').toBe(mine);
    // 2 本目以降は「差し替え済み」であって「上流が直した」ではない(自分の関数を上流と読まない)
    for (const r of [a, b, c]) {
      expect(r).toEqual({ reservedLockPatched: true, reservedLockUpstreamFixed: false });
    }
    expect(rig.allocated()).toBe(0);
  });

  it('wasm が作り直されたら別の関数を 1 つ install する(別の wasm の関数を使い回さない)', () => {
    const r1 = makeRig();
    const r2 = makeRig();
    const n0 = reservedLockInstallCount();
    fixReservedLock(r1.sqlite3, r1.connect());
    fixReservedLock(r2.sqlite3, r2.connect());
    expect(reservedLockInstallCount() - n0).toBe(2);
  });

  it('上流が既に 0 を返すときは差し替えない(上流が直した日に二重にしない)', () => {
    const rig = makeRig();
    const table = rig.newTable(0);
    const before = table.$xCheckReservedLock;
    const n0 = reservedLockInstallCount();
    const out = fixReservedLock(rig.sqlite3, rig.connect({ shared: table }));
    expect(out).toEqual({ reservedLockPatched: false, reservedLockUpstreamFixed: true });
    expect(table.$xCheckReservedLock, '直っている関数を差し替えた').toBe(before);
    expect(reservedLockInstallCount() - n0).toBe(0);
    expect(rig.allocated()).toBe(0);
  });

  describe('🔴 当たらなかった枝は、両方 false で返す(黙って patched とは言わない)', () => {
    const cases: Array<[string, Parameters<Rig['connect']>[0]]> = [
      ['sqlite3_file_control が失敗(rc ≠ 0)', { rc: 1 }],
      ['file ポインタが取れない', { noFile: true }],
      ['io_methods の表が無い($pMethods = 0)', { noMethods: true }],
    ];
    for (const [name, opts] of cases) {
      it(name, () => {
        const rig = makeRig();
        const n0 = reservedLockInstallCount();
        const out = fixReservedLock(rig.sqlite3, rig.connect(opts));
        expect(out).toEqual({ reservedLockPatched: false, reservedLockUpstreamFixed: false });
        expect(reservedLockInstallCount() - n0, '当たっていないのに install した').toBe(0);
        expect(rig.allocated(), '確保した 8 byte を返していない').toBe(0);
      });
    }

    it('いまの関数が引けない(functionEntry が undefined)', () => {
      const rig = makeRig();
      const table = rig.newTable(1);
      table.$xCheckReservedLock = 99999; // 関数表に無い
      const out = fixReservedLock(rig.sqlite3, rig.connect({ shared: table }));
      expect(out).toEqual({ reservedLockPatched: false, reservedLockUpstreamFixed: false });
      expect(table.$xCheckReservedLock, '確かめられないのに差し替えた').toBe(99999);
    });
  });
});
