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
      visible: () => true,
      onceVisible: async () => {},
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

  it('🔴 閉じられたら次の表を出さず、印も残さない(cancelled)', async () => {
    const w = fakeWorker({ lastCheckedAt: null, tables: ['a', 'b', 'c'] });
    // a を見終えた所でタブが閉じられる(⚠ 呼び出し回数で数えない ── 回数は実装の都合で動く)
    let closing = false;
    const orig = w.request;
    (w as { request: typeof orig }).request = (async (req: StorageRequest) => {
      const r = await orig(req as never);
      if (req.op === 'checkIntegrity' && (req as { table?: string }).table === 'a') closing = true;
      return r;
    }) as typeof orig;
    const d = deps(w, { request: w.request, cancelled: () => closing });
    expect(await runStartupIntegrity(d.deps)).toBe('cancelled');
    const checks = w.log.filter((r) => r.op === 'checkIntegrity') as Array<{ table?: string }>;
    expect(checks.map((c) => c.table)).toEqual(['a']);
    expect(w.log.some((r) => r.op === 'integrityStamp')).toBe(false);
  });

  it('🔴 隠れている間は次の表を出さず、見えたら続きから進む(止めない)', async () => {
    const w = fakeWorker({ lastCheckedAt: null, tables: ['a', 'b', 'c'] });
    let hidden = false;
    let waits = 0;
    const d = deps(w, {
      visible: () => !hidden,
      onceVisible: async () => {
        waits += 1;
        hidden = false; // 見えた
      },
    });
    // a を見終えた所で隠れる
    const orig = w.request;
    (w as { request: typeof orig }).request = (async (req: StorageRequest) => {
      const r = await orig(req as never);
      if (req.op === 'checkIntegrity' && (req as { table?: string }).table === 'a') hidden = true;
      return r;
    }) as typeof orig;
    d.deps.request = w.request;
    expect(await runStartupIntegrity(d.deps)).toBe('ok');
    expect(waits, '隠れたのに待っていない(裏で読み続けた)').toBe(1);
    const checks = w.log.filter((r) => r.op === 'checkIntegrity') as Array<{ table?: string }>;
    expect(checks.map((c) => c.table), '見えた後に続きから進んでいない').toEqual(['a', 'b', 'c']);
    expect(w.log[w.log.length - 1]?.op).toBe('integrityStamp');
  });

  it('🔴 起動の時点で既に隠れていたら、計画すら出さずに見えるまで待つ(止めない)', async () => {
    // ⚠ ループの**前**の門 ── 途中で隠れる fixture(上)では 1 度も通らない(変異試験 M22 が SURVIVED で教えた)
    const w = fakeWorker({ lastCheckedAt: null, tables: ['a'] });
    let hidden = true;
    let waits = 0;
    const orig = w.request;
    (w as { request: typeof orig }).request = (async (req: StorageRequest) => {
      // 🔑 「呼ばれた」だけでは足りない ── 呼ばれた**時点で見えている**こと(= 待った後)を見る
      expect(hidden, `隠れたまま ${req.op} を出した(裏で読み続ける形)`).toBe(false);
      return orig(req as never);
    }) as typeof orig;
    const d = deps(w, {
      request: w.request,
      visible: () => !hidden,
      onceVisible: async () => {
        waits += 1;
        hidden = false;
      },
    });
    expect(await runStartupIntegrity(d.deps)).toBe('ok');
    expect(waits, '見えるまで待っていない').toBe(1);
    expect(w.log.map((r) => r.op)).toEqual(['integrityPlan', 'checkIntegrity', 'integrityStamp']);
  });

  it('⚠ 待っている間に閉じられたら、計画すら頼まない', async () => {
    const w = fakeWorker({ lastCheckedAt: null });
    const d = deps(w, { cancelled: () => true });
    expect(await runStartupIntegrity(d.deps)).toBe('cancelled');
    expect(w.log).toEqual([]);
  });

  it('⚠ schema は最初に読めた回の物を持つ(最後の回だけ読めなくても名指しを失わない)', async () => {
    const w = fakeWorker({
      lastCheckedAt: null,
      tables: ['entries', 'relations'],
      broken: { entries: ['Tree 3 page 3 cell 1: bad'] },
    });
    const orig = w.request;
    (w as { request: typeof orig }).request = (async (req: StorageRequest) => {
      const r = (await orig(req as never)) as { schema?: unknown[] };
      // 最後の表の回だけ schema が空で返る
      if (req.op === 'checkIntegrity' && (req as { table?: string }).table === 'relations') {
        return { ...r, schema: [] } as never;
      }
      return r as never;
    }) as typeof orig;
    const d = deps(w, { request: w.request });
    expect(await runStartupIntegrity(d.deps)).toBe('broken');
    expect(d.broken[0], '目次の名指しが消えて「どこかまでは分かりません」に落ちた').toContain('目次だけ');
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
    // ⚠ 閉じは**呼び出しの閉じ**(4 字下げの `});`)で切る ── 最初の `})` で切ると
    //    引数の中の `})` で止まり、並びを変えただけで偽陽性になる(着地前レビュー 💭5)
    const end = src.indexOf('\n    });', at);
    expect(end, '呼び出しの閉じが読めない').toBeGreaterThan(at);
    const block = src.slice(at, end);
    expect(block, '本体タブの判定が無い(follower も検めてしまう)').toContain('isHost: () => writerHolder');
    expect(block, '隠れている間は進まない形になっていない').toContain(
      "visible: () => document.visibilityState !== 'hidden'",
    );
    expect(block, '見えたら続く約束が無い(背景で開く user は永久に検め終わらない)').toContain('onceVisible:');
    expect(block, '閉じる合図で止める形になっていない').toContain('cancelled: () => unloading');
    /**
     * 🔴 出し先は**一時の知らせ**(`showStatus`)── `OP_FAILED` ではない。
     * ⚠ `OP_FAILED` は `SELECT_ENTRY` が `error: null` で消すので、ノートを 1 件選んだ
     *   瞬間に壊れの知らせが消える(user 目線レビュー 2026-09-20)。
     */
    expect(block, '壊れの字を一時の知らせへ出していない').toContain('onBroken: (text) => showStatus(text)');
    expect(block, 'ノートを選ぶと消える口(OP_FAILED)へ出している').not.toContain('OP_FAILED');
  });

  it('🔴 follower が本体へ昇格した直後にも 1 回検める', () => {
    // ⚠ 昇格の印(`promotedHost = host` … `writerHolder = true`)の**後**、本体になった
    //    知らせの**前**に呼ぶ ── 前だと follower として即終わる
    const from = src.indexOf('promotedHost = host;');
    const to = src.indexOf("showStatus('このタブが本体になりました')");
    expect(from, '昇格の経路が読めない(空振り)').toBeGreaterThanOrEqual(0);
    expect(to, '昇格の知らせが読めない(空振り)').toBeGreaterThan(from);
    const promote = src.slice(from, to);
    expect(promote, '昇格の直後に検めを呼んでいない(昇格したタブは読み直すまで検めない)').toContain(
      'void startupIntegrity()',
    );
    expect(promote.indexOf('writerHolder = true'), '本体の印より前に呼んでいる(follower として即終わる)').toBeLessThan(
      promote.indexOf('void startupIntegrity()'),
    );
  });
});
