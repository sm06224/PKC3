/** @vitest-environment happy-dom */
/**
 * 🔴 **本文に埋め込んだ SQL(` ```sql embed `)の答えを、見えたときに引いて表にする**(#1223)。
 *
 * 引く相手は**本物の storage worker**(`storage-worker.test.ts` と同じ手法で node で動かす)。
 * ⚠ 字の門・上限・直列・世代の判断は adapter の `sql-embed-hydrate.ts` が持つので、
 *   その判断を見る検査は **runner を差し替えた版**(何が渡ったかを記録する)で、
 *   「本当に表になる / 保存と同じ worker で引ける」は**実物**で見る。
 *
 * 守る主張:
 * 1. 見えるまで引かない / 見えたら 1 回だけ引く
 * 2. 200 行で切り、「さらに N 行」で次の 200(押すと増え、尽きたらボタンが消える)
 * 3. 🔴 同じ本文のうちは引き直さない / 本文が変われば引き直す(対照群)
 * 4. 読むだけ(書く SQL は runner まで届かない)/ 全角で打っても引ける
 * 5. 同時に走るのは 1 件(直列)
 * 6. 上限(行・歩数・時間)が runner へ届く / 時間が尽きたら止まる(実 worker)
 * 7. 手放したら画面に当てない(世代)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import {
  SQL_EMBED_ATTR,
  SQL_EMBED_FETCH_ROWS,
  SQL_EMBED_MAX_MS,
  SQL_EMBED_MAX_STEPS,
  SQL_EMBED_MORE_FIELD,
  SQL_EMBED_NOTE_FIELD,
  SQL_EMBED_PAGE_ROWS,
} from '../../src/features/markdown/sql-embed';
import {
  askSqlEmbed,
  setSqlEmbedRunner,
  SqlEmbedHydrator,
  type SqlEmbedRunner,
} from '../../src/adapter/ui/render/sql-embed-hydrate';
import { SQL_MAX_MS, SQL_MAX_STEPS } from '../../src/adapter/state/store-effects';

type Op = StorageRequest['op'];
const pending = new Map<number, (resp: StorageResponse) => void>();
let seq = 0;
const workerSelf: {
  onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
} = { onmessage: null };

function request<O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (resp) =>
      resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error)),
    );
    workerSelf.onmessage!({ data: { id, req } });
  });
}

const CID = 'c-embed';
const put = (lid: string, body: string) =>
  request({
    op: 'upsertEntry',
    cid: CID,
    entry: {
      lid,
      title: `t-${lid}`,
      archetype: 'text',
      body,
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
    },
    checkpoint: false,
  });

const csvNote = (rows: number): string =>
  '```csv name=t\nid,v\n' +
  Array.from({ length: rows }, (_, i) => `${String(i + 1)},v${String(i + 1)}`).join('\n') +
  '\n```\n';

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const init = await request({ op: 'init', dbName: 'unit-test-embed' });
  expect(init.vfs).toBe('memory');
  await request({ op: 'openContainer', cid: CID, title: 'embed' });
  await put('csv-t', csvNote(250));
}, 30_000);

afterAll(async () => {
  await request({ op: 'close' });
});

// ── 観測器(見えるのを手で起こす)────────────────────────────────
interface FakeEntry {
  isIntersecting: boolean;
  target: Element;
}
const watchers: FakeIO[] = [];
class FakeIO {
  targets = new Set<Element>();
  constructor(private readonly cb: (e: FakeEntry[]) => void) {
    watchers.push(this);
  }
  observe(el: Element): void {
    this.targets.add(el);
  }
  unobserve(el: Element): void {
    this.targets.delete(el);
  }
  disconnect(): void {
    this.targets.clear();
  }
  /** いま観測している物が全部見えた。 */
  see(): void {
    this.cb([...this.targets].map((target) => ({ isIntersecting: true, target })));
  }
}
const seeAll = (): void => {
  for (const w of watchers) w.see();
};

/** 本物の worker へ引く runner(呼ばれた回数と SQL を数える)。 */
const realRunner = (): { run: SqlEmbedRunner; spy: ReturnType<typeof vi.fn> } => {
  const spy = vi.fn();
  const run: SqlEmbedRunner = (sql, limits) => {
    spy(sql, limits);
    return request({ op: 'runReadOnlySql', sql, ...limits });
  };
  return { run, spy };
};

const embedBody = (sql: string): string => '```sql embed\n' + sql + '\n```\n';

let root: HTMLElement;
function mount(body: string): HTMLElement {
  root = document.createElement('div');
  root.innerHTML = renderMarkdown(body);
  document.body.append(root);
  return root;
}
const hostsOf = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(`[${SQL_EMBED_ATTR}]`)];
const rowsOf = (host: HTMLElement): number => host.querySelectorAll('tbody tr').length;
const moreOf = (host: HTMLElement): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>(`[data-pkc-field="${SQL_EMBED_MORE_FIELD}"]`);
const noteOf = (host: HTMLElement): string =>
  host.querySelector(`[data-pkc-field="${SQL_EMBED_NOTE_FIELD}"]`)?.textContent ?? '';

beforeEach(() => {
  watchers.length = 0;
  document.body.textContent = '';
  vi.stubGlobal('IntersectionObserver', FakeIO);
});
afterEach(() => {
  setSqlEmbedRunner(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('見えたときに引いて、表にする(実 worker)', () => {
  it('🔴 見えるまで引かない / 見えたら引いて表になる', async () => {
    const { run, spy } = realRunner();
    setSqlEmbedRunner(run);
    const body = embedBody('SELECT id, v FROM t ORDER BY CAST(id AS INTEGER) LIMIT 3');
    mount(body);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body);
    expect(spy, '見えていないのに引いた').not.toHaveBeenCalled();
    expect(hostsOf()[0]!.childElementCount).toBe(0);

    seeAll();
    await vi.waitFor(() => expect(rowsOf(hostsOf()[0]!)).toBe(3));
    expect(spy).toHaveBeenCalledTimes(1);
    const host = hostsOf()[0]!;
    expect([...host.querySelectorAll('th')].map((e) => e.textContent)).toEqual(['id', 'v']);
    expect([...host.querySelectorAll('tbody tr')].map((tr) => tr.textContent)).toEqual([
      '1v1',
      '2v2',
      '3v3',
    ]);
    // 原文のコード枠は器の外に残っている
    expect(root.querySelector('pre code.language-sql')!.textContent).toContain('LIMIT 3');
    hydrator.release();
  });

  it('🔴 見えたものを 2 度引かない(観測が外れる)', async () => {
    const { run, spy } = realRunner();
    setSqlEmbedRunner(run);
    const body = embedBody('SELECT 1 AS x');
    mount(body);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body);
    seeAll();
    seeAll();
    await vi.waitFor(() => expect(rowsOf(hostsOf()[0]!)).toBe(1));
    expect(spy).toHaveBeenCalledTimes(1);
    hydrator.release();
  });

  it('🔴 200 行で切り、「さらに N 行」で次の 200 ── 押すと増え、尽きたらボタンが消える', async () => {
    const { run } = realRunner();
    setSqlEmbedRunner(run);
    const body = embedBody('SELECT id FROM t ORDER BY id');
    mount(body);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body);
    seeAll();
    const host = hostsOf()[0]!;
    await vi.waitFor(() => expect(rowsOf(host)).toBe(SQL_EMBED_PAGE_ROWS));
    expect(moreOf(host)!.textContent, '残り 50 行が数えられていない').toBe('さらに 50 行');
    moreOf(host)!.click();
    expect(rowsOf(host)).toBe(250);
    expect(moreOf(host), '尽きたのにボタンが残っている').toBeNull();
    // 押した後も表は 1 つ(描き直しが積まれない)
    expect(host.querySelectorAll('table')).toHaveLength(1);
    // 🔴 同じ本文の描き直し(別の塊を編集した等)で、広げた行が 200 に戻らない
    hydrator.sync(root, body);
    seeAll();
    await new Promise((r) => setTimeout(r, 20));
    expect(rowsOf(host), '描き直しで「さらに」が巻き戻った').toBe(250);
    hydrator.release();
  });

  it('🔴 エラーは器の中に 1 行で出る(原文のコード枠は残る)', async () => {
    const { run } = realRunner();
    setSqlEmbedRunner(run);
    const body = embedBody('SELECT * FROM no_such_table');
    mount(body);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body);
    seeAll();
    const host = hostsOf()[0]!;
    await vi.waitFor(() => expect(host.getAttribute('data-pkc-sql-embed-state')).toBe('failed'));
    expect(noteOf(host)).toContain('答えを引けませんでした: ');
    expect(noteOf(host)).toContain('no_such_table');
    expect(host.querySelector('table')).toBeNull();
    expect(root.querySelector('pre code.language-sql')).not.toBeNull();
    hydrator.release();
  });

  it('0 行の答えは「該当する行はありません」', async () => {
    const { run } = realRunner();
    setSqlEmbedRunner(run);
    const body = embedBody('SELECT id FROM t WHERE id < 0');
    mount(body);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body);
    seeAll();
    const host = hostsOf()[0]!;
    await vi.waitFor(() => expect(noteOf(host)).toBe('該当する行はありません'));
    hydrator.release();
  });

  it('🔴 引く口を差していない版では「この版では引けません」(黙って空にしない)', async () => {
    setSqlEmbedRunner(null);
    const body = embedBody('SELECT 1');
    mount(body);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body);
    seeAll();
    const host = hostsOf()[0]!;
    await vi.waitFor(() => expect(noteOf(host)).toContain('この版では引けません'));
    hydrator.release();
  });

  it('観測器の無い環境では、見えるのを待たずに引く', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { run, spy } = realRunner();
    setSqlEmbedRunner(run);
    const body = embedBody('SELECT 1 AS x');
    mount(body);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body);
    await vi.waitFor(() => expect(rowsOf(hostsOf()[0]!)).toBe(1));
    expect(spy).toHaveBeenCalledTimes(1);
    hydrator.release();
  });
});

describe('鮮度 ── 同じ本文のうちは同じ答え / 本文が変われば引き直す', () => {
  it('🔴 同じ本文を描き直しても、同じ SQL を持つ別の器が増えても、引き直さない', async () => {
    const { run, spy } = realRunner();
    setSqlEmbedRunner(run);
    const body = embedBody('SELECT count(*) AS n FROM t');
    mount(body);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body);
    seeAll();
    await vi.waitFor(() => expect(rowsOf(hostsOf()[0]!)).toBe(1));
    expect(spy).toHaveBeenCalledTimes(1);

    // 同じ本文の描き直し(別の塊を編集した等)── 器は同じ節点のまま
    hydrator.sync(root, body);
    seeAll();
    await new Promise((r) => setTimeout(r, 20));
    expect(spy, '同じ本文なのに引き直した').toHaveBeenCalledTimes(1);

    // 同じ SQL の器が後から増えた(同じ本文の別の位置)── 答えは使い回す
    const extra = document.createElement('div');
    extra.innerHTML = renderMarkdown(body);
    root.append(...extra.childNodes);
    hydrator.sync(root, body);
    seeAll();
    await vi.waitFor(() => expect(rowsOf(hostsOf()[1]!)).toBe(1));
    expect(spy, '同じ SQL を 2 度引いた').toHaveBeenCalledTimes(1);
    hydrator.release();
  });

  it('🔴 対照群: 本文が変わる(csv を編集して保存した)と引き直し、新しい答えが出る', async () => {
    const { run, spy } = realRunner();
    setSqlEmbedRunner(run);
    const embed = embedBody('SELECT count(*) AS n FROM t');
    const body1 = csvNote(250) + '\n' + embed;
    mount(body1);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body1);
    seeAll();
    const host = hostsOf()[0]!;
    await vi.waitFor(() => expect(host.querySelector('td')?.textContent).toBe('250'));
    expect(spy).toHaveBeenCalledTimes(1);

    // 保存して csv が 3 行になった。⚠ SQL の枠は 1 バイトも変わらない(= 差し替えられない)
    await put('csv-t', csvNote(3));
    const body2 = csvNote(3) + '\n' + embed;
    hydrator.sync(root, body2);
    seeAll();
    await vi.waitFor(() => expect(host.querySelector('td')?.textContent).toBe('3'));
    expect(spy, '本文が変わったのに引き直していない').toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll('table'), '古い表が残った').toHaveLength(1);
    hydrator.release();
    await put('csv-t', csvNote(250));
  });

  it('手放した(release)後に同じ本文へ戻っても、答えの控えは残っていない', async () => {
    const { run, spy } = realRunner();
    setSqlEmbedRunner(run);
    const body = embedBody('SELECT 1 AS x');
    mount(body);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body);
    seeAll();
    await vi.waitFor(() => expect(rowsOf(hostsOf()[0]!)).toBe(1));
    hydrator.release();
    // 新しい器(別のノートを開き直した)
    mount(body);
    hydrator.sync(root, body);
    seeAll();
    await vi.waitFor(() => expect(rowsOf(hostsOf()[0]!)).toBe(1));
    expect(spy, '手放したのに答えを持ち続けている').toHaveBeenCalledTimes(2);
    hydrator.release();
  });
});

describe('読むだけ・全角 ── 字の門は runner の手前', () => {
  it.each([
    ['DELETE FROM t'],
    ['UPDATE t SET v = 1'],
    ['DROP TABLE t'],
    ['SELECT 1; DELETE FROM t'],
    ['WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x'],
    ['PRAGMA query_only = 0'],
  ])('🔴 %s は runner まで届かず、断り文が 1 行出る', async (sql) => {
    const spy = vi.fn();
    setSqlEmbedRunner(async (s, l) => {
      spy(s, l);
      return { columns: [], rows: [], truncated: false, ms: 0 };
    });
    const body = embedBody(sql);
    mount(body);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body);
    seeAll();
    const host = hostsOf()[0]!;
    await vi.waitFor(() => expect(host.getAttribute('data-pkc-sql-embed-state')).toBe('failed'));
    expect(spy, '書く SQL が引く口まで届いた').not.toHaveBeenCalled();
    expect(noteOf(host)).toContain('答えを引けませんでした: ');
    hydrator.release();
  });

  it('🔴 書く SQL を打っても、ノートの表は 1 行も減らない(実 worker)', async () => {
    const { run } = realRunner();
    setSqlEmbedRunner(run);
    await expect(askSqlEmbed('DELETE FROM entries')).rejects.toThrow(/読み取り専用/);
    const r = await request({ op: 'runReadOnlySql', sql: 'SELECT count(*) FROM t', maxRows: 5, maxSteps: 1_000_000, maxMs: 10_000 });
    expect(r.rows[0]![0]).toBe(250);
  });

  it('🔴 全角で打っても引ける(直した字が runner へ渡る)', async () => {
    const spy = vi.fn();
    setSqlEmbedRunner(async (s, l) => {
      spy(s, l);
      return { columns: ['x'], rows: [[1]], truncated: false, ms: 0 };
    });
    await askSqlEmbed('ＳＥＬＥＣＴ　１　ＡＳ　ｘ');
    expect(spy.mock.calls[0]![0]).toBe('SELECT 1 AS x');
  });
});

describe('直列 ── 同時に走るのは 1 件', () => {
  it('🔴 器が 3 つ見えても、前の 1 件が終わるまで次を走らせない', async () => {
    let running = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const started: string[] = [];
    setSqlEmbedRunner(async (sql) => {
      started.push(sql);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((r) => gates.push(r));
      running -= 1;
      return { columns: ['x'], rows: [[1]], truncated: false, ms: 0 };
    });
    const body = embedBody('SELECT 1') + '\n' + embedBody('SELECT 2') + '\n' + embedBody('SELECT 3');
    mount(body);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body);
    seeAll();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(started.map((q) => q.trim()), '前の 1 件が終わる前に次を走らせた').toEqual(['SELECT 1']);
    gates.shift()!();
    await vi.waitFor(() => expect(started).toHaveLength(2));
    gates.shift()!();
    await vi.waitFor(() => expect(started).toHaveLength(3));
    gates.shift()!();
    await vi.waitFor(() => expect(hostsOf().every((h) => rowsOf(h) === 1)).toBe(true));
    expect(peak).toBe(1);
    hydrator.release();
  });
});

describe('上限 ── 閲覧用は別建てで小さい', () => {
  it('🔴 行・歩数・時間の上限が runner へ届く(SQL を打つ面の数を使い回していない)', async () => {
    const spy = vi.fn();
    setSqlEmbedRunner(async (s, l) => {
      spy(s, l);
      return { columns: ['x'], rows: [[1]], truncated: false, ms: 0 };
    });
    await askSqlEmbed('SELECT 1');
    expect(spy.mock.calls[0]![1]).toEqual({
      maxRows: SQL_EMBED_FETCH_ROWS,
      maxSteps: SQL_EMBED_MAX_STEPS,
      maxMs: SQL_EMBED_MAX_MS,
    });
  });

  it('🔴 SQL を打つ面の上限より小さい(歩数は 1/10 / 時間は 2 秒)', () => {
    expect(SQL_EMBED_MAX_STEPS).toBe(SQL_MAX_STEPS / 10);
    expect(SQL_EMBED_MAX_MS).toBe(2000);
    expect(SQL_EMBED_MAX_MS).toBeLessThan(SQL_MAX_MS);
  });

  it('🔴 時間が尽きたら止まる(実 worker。時計を差して 2 秒を越えさせる)', async () => {
    const { run } = realRunner();
    setSqlEmbedRunner(run);
    let t = 1_000_000;
    const real = Date.now.bind(Date);
    // ⚠ 呼ばれるたびに 700ms 進む ── worker の見張りが 3 回目で 2 秒を超えたと読む
    vi.spyOn(Date, 'now').mockImplementation(() => {
      t += 700;
      return t;
    });
    let failure: unknown = null;
    try {
      await askSqlEmbed(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c',
      );
    } catch (e) {
      failure = e;
    }
    vi.mocked(Date.now).mockImplementation(real);
    expect(failure, '終わらない SQL が止まらなかった').toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('時間がかかりすぎたので止めました');
    // ⚠ 止めた後も保存と同じ接続は生きている(`query_only` が戻っている)
    await put('csv-after', '保存できる\n');
  }, 20_000);
});

describe('寿命 ── 手放した後の答えは画面に当てない', () => {
  it('🔴 引いている最中に手放したら、答えが返っても表を入れない', async () => {
    let finish: (() => void) | null = null;
    setSqlEmbedRunner(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ columns: ['x'], rows: [[1]], truncated: false, ms: 0 });
        }),
    );
    const body = embedBody('SELECT 1');
    mount(body);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body);
    seeAll();
    await vi.waitFor(() => expect(finish).not.toBeNull());
    hydrator.release();
    finish!();
    await new Promise((r) => setTimeout(r, 20));
    expect(hostsOf()[0]!.querySelector('table'), '手放した後に表を入れた').toBeNull();
  });

  /**
   * 🔴 **引いている間は 1 行出す**(#1254 §1)。⚠ 空振り防止: **引いている瞬間に字が在る**ことを見る
   * (答えが来た後だけ見る検査は、1 行を出す実装を丸ごと消しても緑になる)。
   */
  it('🔴 引いている間は「答えを引いています…」が出て、答えが来たら消えて表になる', async () => {
    let finish: (() => void) | null = null;
    setSqlEmbedRunner(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ columns: ['x'], rows: [[1]], truncated: false, ms: 0 });
        }),
    );
    const body = embedBody('SELECT 1');
    mount(body);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body);
    // 見える前は何も出さない(引いていない)
    expect(noteOf(hostsOf()[0]!), '引いていないのに出た').toBe('');
    seeAll();
    await vi.waitFor(() => expect(finish).not.toBeNull());
    const host = hostsOf()[0]!;
    expect(host.getAttribute('data-pkc-sql-embed-state')).toBe('pending');
    expect(noteOf(host), '引いている間に 1 行も出ていない').toBe('答えを引いています…');
    expect(host.querySelector('table')).toBeNull();
    finish!();
    await vi.waitFor(() => expect(rowsOf(host)).toBe(1));
    expect(host.textContent, '答えが来ても「引いています」が残っている').not.toContain('引いています');
    hydrator.release();
  });

  it('🔴 引けなかったら「引いています」は消えて、失敗の 1 行に替わる', async () => {
    let fail: (() => void) | null = null;
    setSqlEmbedRunner(
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(new Error('no such table: nope'));
        }),
    );
    const body = embedBody('SELECT 1 FROM nope');
    mount(body);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body);
    seeAll();
    await vi.waitFor(() => expect(fail).not.toBeNull());
    expect(noteOf(hostsOf()[0]!)).toBe('答えを引いています…');
    fail!();
    await vi.waitFor(() => expect(noteOf(hostsOf()[0]!)).toContain('答えを引けませんでした'));
    expect(hostsOf()[0]!.textContent).not.toContain('引いています');
    hydrator.release();
  });

  it('🔴 引いている最中に手放したら、「引いています」を居座らせない(嘘になる)', async () => {
    let finish: (() => void) | null = null;
    setSqlEmbedRunner(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ columns: ['x'], rows: [[1]], truncated: false, ms: 0 });
        }),
    );
    const body = embedBody('SELECT 1');
    mount(body);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body);
    seeAll();
    await vi.waitFor(() => expect(finish).not.toBeNull());
    expect(noteOf(hostsOf()[0]!)).toBe('答えを引いています…');
    hydrator.release();
    finish!();
    await new Promise((r) => setTimeout(r, 20));
    expect(hostsOf()[0]!.childElementCount, '手放したのに「引いています」が残っている').toBe(0);
  });

  it('🔴 前の答えの表が残っている器は、引き直している間もその表を見せたまま(1 行に縮めない)', async () => {
    const { run } = realRunner();
    setSqlEmbedRunner(run);
    const body = embedBody('SELECT 1 AS x');
    mount(body);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body);
    seeAll();
    await vi.waitFor(() => expect(rowsOf(hostsOf()[0]!)).toBe(1));
    // 本文が変わって引き直す(同じ器が残る)── 答えが来るまで、古い表のまま
    let finish: (() => void) | null = null;
    setSqlEmbedRunner(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ columns: ['x'], rows: [[2]], truncated: false, ms: 0 });
        }),
    );
    hydrator.sync(root, body + '\n');
    seeAll();
    await vi.waitFor(() => expect(finish).not.toBeNull());
    const host = hostsOf()[0]!;
    expect(rowsOf(host), '引き直している間に表が消えた').toBe(1);
    expect(host.textContent).not.toContain('引いています');
    finish!();
    await vi.waitFor(() => expect(host.querySelector('td')?.textContent).toBe('2'));
    hydrator.release();
  });

  it('🔴 手放した後、まだ走っていなかった SQL は引かない', async () => {
    const started: string[] = [];
    let finish: (() => void) | null = null;
    setSqlEmbedRunner(async (sql) => {
      started.push(sql);
      await new Promise<void>((r) => {
        finish = r;
      });
      return { columns: ['x'], rows: [[1]], truncated: false, ms: 0 };
    });
    const body = embedBody('SELECT 1') + '\n' + embedBody('SELECT 2');
    mount(body);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body);
    seeAll();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    hydrator.release();
    finish!();
    await new Promise((r) => setTimeout(r, 20));
    expect(started.map((q) => q.trim()), '手放したのに待っていた SQL を走らせた').toEqual(['SELECT 1']);
  });

  it('release は観測器をまとめて外す', () => {
    const body = embedBody('SELECT 1');
    mount(body);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body);
    expect(watchers).toHaveLength(1);
    expect(watchers[0]!.targets.size).toBe(1);
    hydrator.release();
    expect(watchers[0]!.targets.size).toBe(0);
  });

  it('🔴 観測器は 1 つだけ作る(描くたびに作らない)', () => {
    const body = embedBody('SELECT 1') + '\n' + embedBody('SELECT 2');
    mount(body);
    const hydrator = new SqlEmbedHydrator();
    hydrator.sync(root, body);
    hydrator.sync(root, body + '\n追記');
    hydrator.sync(root, body + '\n追記 2');
    expect(watchers).toHaveLength(1);
    hydrator.release();
  });
});
