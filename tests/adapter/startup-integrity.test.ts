/**
 * 🔴 **起動のたびに、軽く検める ── 駆動部**(#1007 段①)。
 *
 * ここで見るのは**順番**である:
 * - 印が新しければ**1 表も検めない**
 * - 表ごとに 1 request(間に保存が割り込める形)
 * - 止めたら**次を出さない**、印も残さない
 * - 壊れていたら**印を残さず**字を出す / 無事なら**全部見終えてから**印を残す
 * - follower は検めない
 *
 * ⚠ `main.ts` の配線は原文で pin する(あの file はどの test からも実行されない)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeOnly } from '../helpers/code-only';
import { runStartupIntegrity } from '../../src/adapter/platform/storage/startup-integrity';
import type { ResultMap, StorageRequest } from '../../src/adapter/platform/storage/protocol';
import { CONTAINER_REBUILD_LABEL } from '../../src/features/storage/rescue-labels';
import { CORRUPT_REFUSAL } from '../../src/features/storage/db-corruption';

const NOW = Date.parse('2026-09-20T03:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const SCHEMA = [
  { type: 'table', name: 'entries', rootpage: 2 },
  { type: 'index', name: 'sqlite_autoindex_entries_1', rootpage: 3 },
  { type: 'table', name: 'relations', rootpage: 4 },
];

/** worker の代役 ── **何を頼まれたか**を全部残す。 */
function fakeWorker(opts: {
  lastCheckedAt: string | null;
  tables?: string[];
  broken?: Record<string, string[]>;
  fail?: (req: StorageRequest) => Error | null;
}) {
  const log: StorageRequest[] = [];
  const request = async <Op extends StorageRequest['op']>(
    req: Extract<StorageRequest, { op: Op }>,
  ): Promise<ResultMap[Op]> => {
    log.push(req);
    const err = opts.fail?.(req) ?? null;
    if (err !== null) throw err;
    switch (req.op) {
      case 'integrityPlan':
        return {
          lastCheckedAt: opts.lastCheckedAt,
          tables: opts.tables ?? ['entries', 'relations'],
        } as ResultMap[Op];
      case 'checkIntegrity': {
        const table = (req as { table?: string }).table ?? '';
        const rows = opts.broken?.[table] ?? ['ok'];
        return { rows, schema: SCHEMA, elapsedMs: 1 } as ResultMap[Op];
      }
      case 'integrityStamp':
        return null as ResultMap[Op];
      default:
        throw new Error(`頼まれないはずの op: ${req.op}`);
    }
  };
  return { log, request };
}

function deps(
  w: ReturnType<typeof fakeWorker>,
  over: Partial<Parameters<typeof runStartupIntegrity>[0]> = {},
) {
  const broken: string[] = [];
  const waited: number[] = [];
  return {
    broken,
    waited,
    deps: {
      request: w.request,
      isHost: () => true,
      now: () => NOW,
      wait: async (ms: number) => {
        waited.push(ms);
      },
      cancelled: () => false,
      onBroken: (t: string) => {
        broken.push(t);
      },
      ...over,
    },
  };
}

describe('起動の検め ── 駆動部(#1007 段①)', () => {
  it('🔴 印が新しければ、1 表も検めない(skipped)', async () => {
    const w = fakeWorker({ lastCheckedAt: new Date(NOW - DAY).toISOString() });
    const d = deps(w);
    expect(await runStartupIntegrity(d.deps)).toBe('skipped');
    expect(w.log.map((r) => r.op)).toEqual(['integrityPlan']);
    expect(d.broken).toEqual([]);
  });

  it('🔴 印が無ければ、表ごとに 1 request で検め、最後に印を残す(ok)', async () => {
    const w = fakeWorker({ lastCheckedAt: null, tables: ['entries', 'relations', 'assets'] });
    const d = deps(w);
    expect(await runStartupIntegrity(d.deps)).toBe('ok');
    // 🔑 表ごとに 1 request ── 丸ごと(table 無し)を 1 度も出さない
    const checks = w.log.filter((r) => r.op === 'checkIntegrity') as Array<{ table?: string }>;
    expect(checks.map((c) => c.table)).toEqual(['entries', 'relations', 'assets']);
    // 🔑 印は**最後**(全部見終えてから)
    expect(w.log[w.log.length - 1]?.op).toBe('integrityStamp');
    expect((w.log[w.log.length - 1] as { at: string }).at).toBe(new Date(NOW).toISOString());
    expect(d.broken).toEqual([]);
    // ⚠ boot の刻印から待っている(起動を遅くしない)
    expect(d.waited).toEqual([5_000]);
  });

  it('🔴 壊れていたら、印を残さずに字を出す(broken)', async () => {
    const w = fakeWorker({
      lastCheckedAt: null,
      broken: { entries: ['*** in database main ***\nTree 3 page 3 cell 1: bad'] },
    });
    const d = deps(w);
    expect(await runStartupIntegrity(d.deps)).toBe('broken');
    expect(w.log.some((r) => r.op === 'integrityStamp'), '壊れているのに印を残した').toBe(false);
    expect(d.broken).toHaveLength(1);
    // 🔑 次の一手が画面の字で入っている(押した検めと同じ文)
    expect(d.broken[0]).toContain(CONTAINER_REBUILD_LABEL);
    expect(d.broken[0]).toContain('起動のときに');
  });

  it('🔴 止めたら次の表を出さず、印も残さない(cancelled)', async () => {
    const w = fakeWorker({ lastCheckedAt: null, tables: ['a', 'b', 'c'] });
    let seen = 0;
    const d = deps(w, {
      // 2 表目を見終えた所で止める
      cancelled: () => {
        seen += 1;
        return seen === 3;
      },
    });
    expect(await runStartupIntegrity(d.deps)).toBe('cancelled');
    const checks = w.log.filter((r) => r.op === 'checkIntegrity') as Array<{ table?: string }>;
    expect(checks.map((c) => c.table)).toEqual(['a']);
    expect(w.log.some((r) => r.op === 'integrityStamp')).toBe(false);
  });

  it('⚠ 待っている間に隠れたら、計画すら頼まない', async () => {
    const w = fakeWorker({ lastCheckedAt: null });
    const d = deps(w, { cancelled: () => true });
    expect(await runStartupIntegrity(d.deps)).toBe('cancelled');
    expect(w.log).toEqual([]);
  });

  it('🔴 follower(別タブ)は検めない', async () => {
    const w = fakeWorker({ lastCheckedAt: null });
    const d = deps(w, { isHost: () => false });
    expect(await runStartupIntegrity(d.deps)).toBe('follower');
    expect(w.log).toEqual([]);
    expect(d.waited).toEqual([]);
  });

  it('🔴 request が壊れの綴りで落ちたら、その字をそのまま出す(schema すら読めない壊れ)', async () => {
    const w = fakeWorker({
      lastCheckedAt: null,
      fail: (req) =>
        req.op === 'integrityPlan' ? new Error(`${CORRUPT_REFUSAL}(integrityPlan で検出: database disk image is malformed)`) : null,
    });
    const d = deps(w);
    expect(await runStartupIntegrity(d.deps)).toBe('broken');
    expect(d.broken).toHaveLength(1);
    expect(d.broken[0]).toContain(CONTAINER_REBUILD_LABEL);
  });

  it('⚠ 壊れ以外の理由で落ちたら黙る(failed)── worker が交代した など', async () => {
    const w = fakeWorker({
      lastCheckedAt: null,
      fail: (req) => (req.op === 'checkIntegrity' ? new Error('worker terminated') : null),
    });
    const d = deps(w);
    expect(await runStartupIntegrity(d.deps)).toBe('failed');
    expect(d.broken).toEqual([]);
    expect(w.log.some((r) => r.op === 'integrityStamp')).toBe(false);
  });
});

describe('main.ts の配線(原文 pin ── あの file はどの test からも実行されない)', () => {
  const src = codeOnly(readFileSync(join(process.cwd(), 'src/main.ts'), 'utf-8'));

  it('🔴 boot の刻印の後に呼び、結末を DOM 属性へ出す', () => {
    const stamp = src.indexOf("root.setAttribute('data-pkc-boot', 'ready')");
    const call = src.indexOf('app.startupIntegrity()');
    expect(stamp, '刻印が無い(空振り)').toBeGreaterThanOrEqual(0);
    expect(call, '起動の検めを呼んでいない').toBeGreaterThan(stamp);
    expect(src).toContain("root.setAttribute('data-pkc-integrity', outcome)");
  });

  it('🔴 本体か / 隠れたか / 壊れの字の出し先 が配線されている', () => {
    const at = src.indexOf('runStartupIntegrity({');
    expect(at, '駆動部を呼んでいない').toBeGreaterThanOrEqual(0);
    const block = src.slice(at, src.indexOf('})', at));
    expect(block, '本体タブの判定が無い(follower も検めてしまう)').toContain('isHost: () => writerHolder');
    expect(block, '隠れたら止める形になっていない').toContain("document.visibilityState === 'hidden'");
    expect(block, '壊れの字を赤い帯へ出していない').toContain("type: 'OP_FAILED'");
  });
});
