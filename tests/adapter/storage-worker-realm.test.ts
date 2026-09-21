/**
 * 🔴 **system 領域(realm)のノートが、user 向けの読み手から漏れないことを見る**
 * (設計 doc §1.1、`ui-total-design-2026-09.md`。段①)。
 *
 * ⚠ 経路ごとに 1 test を持つ(CLAUDE.md §7「同じ値を複数の描画経路へ渡すものは、
 *   経路ごとに pin する」── 1 つの test で全部見ると、片方だけ規則が抜けても
 *   気づけない)。
 * ⚠ **空振り防止のため、system のノートには「出てもおかしくない中身」を持たせる**
 *   ── 対照群として同じ形の user のノートも作り、そちらは出ることを見る
 *   (CLAUDE.md §1「空振りを直したら、今度は何に救われていないかを問う」)。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';

type Op = StorageRequest['op'];

const pending = new Map<number, (resp: StorageResponse) => void>();
let seq = 0;
const workerSelf: {
  onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
} = { onmessage: null };

function request<O extends Op>(
  req: Extract<StorageRequest, { op: O }>,
): Promise<ResultMap[O]> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (resp) =>
      resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error)),
    );
    workerSelf.onmessage!({ data: { id, req } });
  });
}

const CID = 'c-realm';

function entryOf(
  lid: string,
  body: string,
  over: Partial<EntryUpsert> = {},
): EntryUpsert {
  return {
    lid,
    title: `t-${lid}`,
    archetype: 'text',
    body,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    ...over,
  };
}

const put = (lid: string, body: string, over: Partial<EntryUpsert> = {}) =>
  request({
    op: 'upsertEntry',
    cid: CID,
    entry: entryOf(lid, body, over),
    checkpoint: false,
  });

/** ⚠ **対照群の user ノートと、除外を見る system ノートは、同じ「当たる中身」を持つ**。 */
const USER_BODY = `---
tags: [新技]
tel: 000-1111-2222
usr_only_field: あり
---
- [ ] ユーザタスク項目
とくべつなたんさくご・ユーザー版
[リンク](entry:u-target)
`;
const SYSTEM_BODY = `---
tags: [新技]
tel: 000-2222-3333
sys_only_field: あり
---
- [ ] システムタスク項目
とくべつなたんさくご・システム版
[リンク](entry:u-target)
`;

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (
    msg: StorageResponse,
  ) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const init = await request({ op: 'init', dbName: 'unit-test-realm' });
  expect(init.vfs).toBe('memory'); // node に OPFS は無い ── memory fallback が前提
  await request({ op: 'openContainer', cid: CID, title: 'realm' });

  // backlink の的(中身は問わない)
  await put('u-target', '的\n');
  // 対照群 ── user のノート(すべての読み手で「出る」ことを見る)
  await put('u-rich', USER_BODY, { title: 'ユーザー目印ノート', entryOrder: 2 });
  // ⚠ 主題 ── system 領域のノート(すべての読み手で「出ない」ことを見る)
  await put('sys-msg', SYSTEM_BODY, {
    title: 'システム目印ノート',
    entryOrder: 3,
    realm: 'system',
  });
}, 30_000);

describe('system 領域のノートは user 向けの読み手から漏れない(設計 doc §1.1、段①)', () => {
  it('一覧(listEntryMetas): system は出ない / user は出る', async () => {
    const rows = await request({ op: 'listEntryMetas', cid: CID });
    const lids = rows.map((r) => r.lid);
    expect(lids, '対照群が出ていない(検査が空振りしている)').toContain('u-rich');
    expect(lids, 'system 領域のノートが一覧に漏れた').not.toContain('sys-msg');
  });

  it('system 専用の一覧(listSystemEntries)には system だけが出る', async () => {
    const rows = await request({ op: 'listSystemEntries', cid: CID });
    const lids = rows.map((r) => r.lid);
    expect(lids, 'system のノートが listSystemEntries に出ない').toContain('sys-msg');
    expect(lids, 'user のノートが listSystemEntries に紛れた').not.toContain('u-rich');
  });

  it('題名の検索(searchEntries): system は出ない / user は出る', async () => {
    const r = await request({ op: 'searchEntries', cid: CID, query: '目印' });
    expect(r.lids, '対照群が出ていない(検査が空振りしている)').toContain('u-rich');
    expect(r.lids, 'system 領域のノートが題名検索に漏れた').not.toContain('sys-msg');
  });

  it('本文の全文検索(searchDetail): system は出ない / user は出る', async () => {
    const r = await request({
      op: 'searchDetail',
      cid: CID,
      query: 'とくべつなたんさくご',
    });
    const lids = r.rows.map((row) => row.lid);
    expect(lids, '対照群が出ていない(検査が空振りしている)').toContain('u-rich');
    expect(lids, 'system 領域のノートが全文検索に漏れた').not.toContain('sys-msg');
  });

  it('backlink(findBacklinks): system は出ない / user は出る', async () => {
    const r = await request({ op: 'findBacklinks', cid: CID, lid: 'u-target' });
    expect(r.lids, '対照群が出ていない(検査が空振りしている)').toContain('u-rich');
    expect(r.lids, 'system 領域のノートが backlink に漏れた').not.toContain('sys-msg');
  });

  it('かんばん・カレンダー(taskScan): system は出ない / user は出る', async () => {
    const r = await request({ op: 'taskScan', cid: CID });
    const lids = r.cards.map((c) => c.lid);
    expect(lids, '対照群が出ていない(検査が空振りしている)').toContain('u-rich');
    expect(lids, 'system 領域のノートがかんばん・カレンダーに漏れた').not.toContain('sys-msg');
  });

  it('連絡先(contactScan): system は出ない / user は出る', async () => {
    const r = await request({ op: 'contactScan', cid: CID });
    const lids = r.cards.map((c) => c.lid);
    expect(lids, '対照群が出ていない(検査が空振りしている)').toContain('u-rich');
    expect(lids, 'system 領域のノートが連絡先に漏れた').not.toContain('sys-msg');
  });

  it('スマートフォルダ(smartScan): system は出ない / user は出る', async () => {
    const r = await request({
      op: 'smartScan',
      cid: CID,
      lid: 'self',
      tags: ['新技'],
      kind: null,
      updatedFrom: null,
      createdFrom: null,
      dated: null,
      text: null,
      tasks: null,
      openTasks: null,
    });
    expect(r.lids, '対照群が出ていない(検査が空振りしている)').toContain('u-rich');
    expect(r.lids, 'system 領域のノートがスマートフォルダに漏れた').not.toContain('sys-msg');
  });

  it('集計(queryScan): system の frontmatter key は出ない / user の key は出る', async () => {
    const r = await request({ op: 'queryScan', cid: CID });
    const keys = r.keys.keys.map((k) => k.key);
    expect(keys, '対照群が出ていない(検査が空振りしている)').toContain('usr_only_field');
    expect(keys, 'system 領域のノートの frontmatter key が集計に漏れた').not.toContain(
      'sys_only_field',
    );
  });

  /**
   * 🔴 **書出し(バックアップ zip / Markdown zip / 閲覧用 HTML)は、いずれも
   * `listBodies` の 1 op だけを通る**(`pkc3-archive.ts` / `pkc3-markdown-zip.ts` /
   * `pkc3-html.ts` の import を grep して確認済み ── 3 経路が SQL を書き写して
   * いるのではなく、同じ 1 本の op を呼ぶ)。⚠ だから、worker の `listBodies` を
   * 1 度 pin すれば 3 経路とも守れる(CLAUDE.md §7 の逆 ── 複製が無いので
   * 経路ごとに分けて test する理由が無い)。
   */
  it('書出し(listBodies ── archive dump / markdown zip / 閲覧用 HTML の共通経路): system は出ない / user は出る', async () => {
    const r = await request({ op: 'listBodies', cid: CID, maxBytes: 1_000_000 });
    const lids = r.rows.map((row) => row.lid);
    expect(lids, '対照群が出ていない(検査が空振りしている)').toContain('u-rich');
    expect(lids, 'system 領域のノートが書出しに漏れた').not.toContain('sys-msg');
  });

  /**
   * 🔴 **拾い出し(rescueEntries)**。⚠ `rescueEntries` に `cid` は無い(器をまたいで
   * rowid で舐める)── ここまでに作った行がまとめて 1 chunk(rowid 1〜200)に入る。
   */
  it('拾い出し(rescueEntries): system は出ない / user は出る', async () => {
    const r = await request({ op: 'rescueEntries', afterRowid: 0, chunks: 1 });
    const lids = r.rows.map((row) => row.lid);
    expect(lids, '対照群が出ていない(検査が空振りしている)').toContain('u-rich');
    expect(lids, 'system 領域のノートが拾い出しに漏れた').not.toContain('sys-msg');
  });

  /**
   * 🔴 **本文の名前つき csv(#681 段③)も system 領域を読まない**(設計 doc §1.1)。
   * ⚠ user 向けの読み手ではあるが、`cid` を持たない op(`runReadOnlySql`)なので
   * 別枠 ── system のノートに csv 風の中身を持たせ、表に出ないことを見る。
   */
  it('本文の csv(runReadOnlySql 経由): system の本文は表にならない / user は表になる', async () => {
    const fence = (info: string, lines: readonly string[]): string =>
      ['```' + info, ...lines, '```', ''].join('\n');
    await put('csv-user', fence('csv name=表ユーザー', ['a,b', '1,2']));
    await put('csv-sys', fence('csv name=表シス', ['a,b', '9,9']), { realm: 'system' });
    const userRows = await request({
      op: 'runReadOnlySql',
      sql: 'SELECT a, b FROM 表ユーザー',
      maxRows: 100,
      maxSteps: 1_000_000,
      maxMs: 60_000,
    });
    expect(userRows.rows, 'user の csv 表が引けない(検査が空振りしている)').toEqual([
      ['1', '2'],
    ]);
    await expect(
      request({
        op: 'runReadOnlySql',
        sql: 'SELECT a, b FROM 表シス',
        maxRows: 100,
        maxSteps: 1_000_000,
        maxMs: 60_000,
      }),
      'system 領域のノートの csv が表になった',
    ).rejects.toThrow();
  });
});

/**
 * 🔴 **互換は双方向で考える**(CLAUDE.md 不変条件 5)── 「新ビルドが旧データを
 * 読める」だけでは足りず、**旧ビルドが新データを読めるか**も互換の一部である。
 *
 * ⚠ PKC3 は単一 HTML 製品で、user は旧 `pkc3.html` を手元に残す。`realm` を
 *   **知らない**読み手(`SELECT lid, title FROM entries` だけを打つ、旧ビルドの
 *   `listEntryMetas` 相当)には、system のノートが**普通のノートとして見える**。
 *
 * 🔑 これは**既知の性質であり、実害は無い** ── 段②で system のノートを実際に
 *   作るまでは、この列にはノートが 1 件も入らない(段①は「作る口だけ用意する」)。
 *   旧 `pkc3.html` を手元に残す user は、メッセージのノートが一覧に 1 件見える
 *   だけで、**データは消えない**(realm は新ビルドがいつでも読み直せる列であり、
 *   旧ビルドの UPSERT も列の DEFAULT でこの値を壊さない ── schema.ts の注記)。
 */
describe('互換は双方向(CLAUDE.md 不変条件 5)── realm を知らない読み手には system が普通に見える', () => {
  it('⚠ 旧ビルドの読み方(realm を見ない SELECT)には system のノートが普通に見える', async () => {
    // ⚠ 実 SQL で確かめる ── 「realm を知らない」を文章で言うだけでは
    //   §1「主張そのものが成り立たない」を踏みうる(前提を assert する)
    const r = await request({
      op: 'runReadOnlySql',
      sql: `SELECT lid, title FROM entries WHERE cid = '${CID}' ORDER BY entry_order`,
      maxRows: 100,
      maxSteps: 1_000_000,
      maxMs: 60_000,
    });
    const lids = r.rows.map((row) => row[0]);
    expect(
      lids,
      '前提が崩れている(realm を見ない SELECT が system のノートを既に除外している)',
    ).toContain('sys-msg');
  });
});
