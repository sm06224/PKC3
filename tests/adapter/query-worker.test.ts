/**
 * 集計(#184)を **worker の実物**で確かめる(`search-entries.test.ts` と同じ手法 ──
 * `:memory:` へ落ちる)。
 *
 * 🔴 ここで守る主張は 4 つ:
 * 1. **SQL から本文の先頭が読めている**(束ねられる項目が出る)
 * 2. **並びは `entry_order`**(組の中の lid が一覧と同じ順)
 * 3. **本文が長くても frontmatter は拾える**(`substr` の字数が足りている ──
 *    足りないと「長いノートだけ黙って未設定に落ちる」という最も気づきにくい壊れ方をする)
 * 4. **本文は返らない**(返る形に body が混ざっていない ── 主スレッドへ全文を渡さない)
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { StorageRequest } from '../../src/adapter/platform/storage/protocol';
import {
  FRONTMATTER_SCAN_CHARS,
  type GroupResult,
  type KeyResult,
} from '../../src/features/query/group-by';
import { resolveCap } from '../../src/features/notation/caps';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Handle = (req: StorageRequest) => Promise<unknown>;

const pending = new Map<number, (resp: any) => void>();
let seq = 0;
const workerSelf: { onmessage: ((ev: { data: any }) => void) | null } = { onmessage: null };

const call: Handle = (req) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (resp) => (resp.ok ? resolve(resp.result) : reject(new Error(resp.error))));
    workerSelf.onmessage!({ data: { id, req } });
  });

const CID = 'q1';

const put = (lid: string, title: string, body: string, order: number) =>
  call({
    op: 'upsertEntry',
    cid: CID,
    entry: {
      lid,
      title,
      archetype: 'text',
      entryOrder: order,
      status: null,
      date: null,
      archived: false,
      body,
    },
    checkpoint: false,
    keepLatest: 10,
  } as StorageRequest);

/** ⚠ 目録と表は **1 回の走査**で返る(別々に頼むと DB を 2 度舐める)。 */
const scan = (key?: string) =>
  call({ op: 'queryScan', cid: CID, ...(key === undefined ? {} : { key }) } as StorageRequest) as
    Promise<{ keys: KeyResult; groups: GroupResult | null }>;
const keys = async (): Promise<KeyResult> => (await scan()).keys;
const groupBy = async (key: string): Promise<GroupResult> => (await scan(key)).groups!;

/** frontmatter の**後ろ**に長い本文を置く(先頭だけ読む作りを踏む)。 */
const LONG_TAIL = 'あ'.repeat(200_000);

/**
 * 🔴 **frontmatter そのものが長い**ノート(変異試験 M6 で判明した空振りの穴)。
 * ⚠ 「本文が長い」だけでは窓の大きさを試していない ── frontmatter は先頭 30 字に
 * 収まってしまい、窓を 100 字に縮めても拾えてしまう。**狙う key を後ろに置く**。
 */
const FAT_FRONTMATTER = `---\n${Array.from(
  { length: 1300 },
  (_, i) => `pad${String(i).padStart(4, '0')}: x`,
).join('\n')}\nauthor: 大野\n---\n\n本文\n`;

describe('集計を worker の実物で(#184)', () => {
  beforeAll(async () => {
    (globalThis as any).self = workerSelf;
    (globalThis as any).postMessage = (msg: any) => {
      const cb = pending.get(msg.id);
      pending.delete(msg.id);
      cb?.(msg);
    };
    await import('../../src/adapter/platform/storage/storage-worker');
    await call({ op: 'init', dbName: 'query-test' } as StorageRequest);
    await call({ op: 'openContainer', cid: CID, title: 't' } as StorageRequest);
    await put('n2', '二番', '---\nauthor: 佐藤\n---\n\n本文\n', 2);
    await put('n1', '一番', '---\nauthor: 田中\nstatus: 済\n---\n\n本文\n', 1);
    await put('n3', '三番', `---\nauthor: 佐藤\n---\n\n${LONG_TAIL}\n`, 3);
    await put('n4', '四番', '前置きの無い本文\n', 4);
    await put('n5', '五番', FAT_FRONTMATTER, 5);
  }, 30_000);

  it('🔴 SQL から本文の先頭が読めていて、束ねられる項目が出る', async () => {
    const r = await keys();
    expect(r.scanned, '1 件も見ていない = 空振り').toBe(5);
    // 件数の多い順 ── author は 4 件でいちばん多い
    expect(r.keys[0]).toEqual({ key: 'author', count: 4 });
    /**
     * ⚠ ここは**上限に触れている**(pad* が 400 個あるので 1 件の key は
     * 字順で切られ、`status` は目録に出ない)。🔑 **切ったことは数で返る**ので、
     * 「無い」と「切った」を取り違えない。
     */
    expect(r.keys.length).toBe(50);
    expect(r.omittedKeys, '切ったのに数が 0 = 黙って切っている').toBeGreaterThan(0);
    // 目録に出なくても**束ねられる**(上限は目録の話であって、束ね方の話ではない)
    const byStatus = await groupBy('status');
    expect(byStatus.groups[0]).toMatchObject({ value: '済', total: 1, lids: ['n1'] });
  });

  it('🔴 窓の大きさは cap から導く(直書きしない ── 囲みのぶんが足りなくなる)', () => {
    /**
     * ⚠ 1 稿目は `16 * 1024` を直書きし、コメントに「字数はバイト数以下だから入る」と
     * 書いていたが**因果が間違っていた** ── 上限が掛かるのは囲みの**中身**で、
     * 窓は囲みごと切る。ASCII でちょうど上限まで書くと閉じの `---` が窓の外へ出て、
     * そのノートは黙って「未設定」へ落ちる(実測: 中身 16,384 バイト → 本文 16,397 字)。
     */
    expect(FRONTMATTER_SCAN_CHARS).toBeGreaterThan(resolveCap('frontmatter', 'bytes') + 8);
  });

  it('🔴 上限ちょうどの frontmatter でも拾える(閉じの --- が窓に入る)', async () => {
    const inner = `k: ${'a'.repeat(resolveCap('frontmatter', 'bytes') - 3)}`;
    await put('n6', '六番', `---\n${inner}\n---\n\n本文\n`, 6);
    const r = await groupBy('k');
    expect(
      r.groups.some((g) => g.lids.includes('n6')),
      '上限ちょうどのノートが未設定へ落ちている = 窓が囲みのぶん足りない',
    ).toBe(true);
  });

  it('🔴 frontmatter が長くても、後ろに書いた項目まで読める(窓の大きさ)', async () => {
    const r = await groupBy('author');
    const ono = r.groups.find((g) => g.value === '大野');
    expect(
      ono?.lids,
      '長い frontmatter の後ろの項目が落ちている = substr の窓が小さすぎる',
    ).toEqual(['n5']);
  });

  it('🔴 並びは entry_order(組の中の lid が一覧と同じ順)', async () => {
    /**
     * ⚠ **投入順と entry_order がずれた行を入れてから見る** ── 揃っていると
     * `ORDER BY rowid` に変えても同じ答えになり、規則を壊す変異が生き延びる
     * (レビュー指摘)。`n0` は**最後に入れて order は 0**。
     */
    await put('n0', '零番', '---\nauthor: 佐藤\n---\n\n本文\n', 0);
    const r = await groupBy('author');
    const sato = r.groups.find((g) => g.value === '佐藤');
    expect(sato?.lids, '一覧の並びと違う(entry_order で並んでいない)').toEqual(['n0', 'n2', 'n3']);
  });

  it('🔴 本文が 20 万字あっても frontmatter は拾える(先頭の字数が足りている)', async () => {
    const r = await groupBy('author');
    const sato = r.groups.find((g) => g.value === '佐藤');
    expect(sato?.lids, '長いノートが未設定へ落ちている = substr が短すぎる').toContain('n3');
  });

  it('項目を持たないノートは未設定の組へ、いちばん下に', async () => {
    const r = await groupBy('author');
    const last = r.groups.at(-1)!;
    expect(last.value, '未設定が最後に来ていない').toBe('');
    // ⚠ 件数は fixture の増減で動くので、**中身**で見る(n4 = frontmatter が無いノート)
    expect(last.lids).toContain('n4');
    expect(last.total).toBe(last.lids.length);
  });

  it('長い frontmatter の項目も目録に出る(上限まで)', async () => {
    const r = await keys();
    expect(r.keys.some((k) => k.key.startsWith('pad')), 'pad* が 1 つも出ていない').toBe(true);
  });

  it('🔴 返る形に本文が混ざっていない(主スレッドへ全文を渡さない)', async () => {
    const r = await groupBy('author');
    const json = JSON.stringify(r);
    expect(json.includes('あああ'), '本文が返っている').toBe(false);
    // ⚠ 空振り防止 ── 実際に中身のある結果を見ている
    expect(r.groups.length).toBeGreaterThan(1);
    expect(json).toContain('佐藤');
  });

  it('書いていない項目で束ねると、全部が未設定の 1 組になる', async () => {
    const r = await groupBy('存在しない項目');
    expect(r.groups).toHaveLength(1);
    const only = r.groups[0]!;
    expect(only.value).toBe('');
    expect(only.total, '見た件数と組の件数が合わない').toBe(r.scanned);
    // 並びは entry_order(投入順ではない)── n0 は最後に入れたが order は 0
    expect(only.lids).toEqual([...only.lids].sort((a, b) => a.localeCompare(b)));
  });
});
