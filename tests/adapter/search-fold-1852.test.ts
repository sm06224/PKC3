/** @vitest-environment node */
/**
 * 🔴 **本文の全文検索を、全角半角・濁点をそろえた字で引く**(台帳 #1852 の束 B2。依頼 258・335・115-2・196・197・194・260・115-1)。
 * **本物の worker を node で動かして**確かめる(`search-entries.test.ts` と同じ手法)。
 *
 * ## 守るもの
 *
 * ① 揃えて引く ── 全角と半角・半角カナ・濁点の持ち方(題名も本文も)。ひらがなとカタカナは別のまま
 * ② 隠したメモの中・リンクの宛先の字では当たらない / 抜粋は書いた字で、メモも宛先も出ない
 * ③ 左の列の欄は、空白(全角も)で区切った語を全部含む。`-語` は除外と読まない
 * ④ 🔴 **索引の作り直しは起動の後に塊で流す**。作り直し中の答え(まだの行は書いた字のまま全走査)を固定する
 * ⑤ 🔴 **前の版の PKC3 が同じ保存領域を開いて読み書きしても壊れない**(前の版の読み方を再現)。旧ビルドが書いた行は次の起動で揃え直す
 * ⑥ 索引の形の版 ── 版が違えば作り直す。旧い形の画像(PKC3 入り HTML)も取り込める
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';
import {
  ENTRY_ADDED_COLUMNS,
  LEGACY_FTS_DDL,
  LEGACY_SCHEMA_DDL,
} from '../../src/adapter/platform/storage/schema';
import { SNIPPET_MARK_CLOSE, SNIPPET_MARK_OPEN } from '../../src/features/filter/search-snippet';

type Op = StorageRequest['op'];
type Req = <O extends Op>(req: Extract<StorageRequest, { op: O }>) => Promise<ResultMap[O]>;

const pending = new Map<number, (resp: StorageResponse) => void>();
let seq = 0;

/** worker を 1 本ずつ別の module として立てる(`storage-worker-rebuild-rescue.test.ts` と同じ作法)。 */
async function spawnWorker(): Promise<Req> {
  const mySelf: { onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null } = {
    onmessage: null,
  };
  (globalThis as unknown as Record<string, unknown>).self = mySelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  vi.resetModules();
  await import('../../src/adapter/platform/storage/storage-worker');
  return ((req: StorageRequest) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (resp) => (resp.ok ? resolve(resp.result as never) : reject(new Error(resp.error))));
      mySelf.onmessage!({ data: { id, req } });
    })) as Req;
}

// ── 生の sqlite(前の版の読み方・旧い DB の再現に使う) ──────────────────────────
type RawDb = {
  pointer: number;
  close: () => void;
  exec: (o: string | { sql: string; bind?: unknown[] }) => void;
  selectValue: (sql: string, bind?: unknown[]) => unknown;
  selectObjects: (sql: string, bind?: unknown[]) => Array<Record<string, unknown>>;
};
type Sqlite = {
  oo1: { DB: new (f: string, m?: string) => RawDb };
  capi: Record<string, (...a: never[]) => unknown>;
  wasm: Record<string, (...a: never[]) => unknown>;
};
let api: Sqlite;

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).sqlite3ApiConfig = {
    disable: { vfs: { opfs: true, 'opfs-wl': true } },
  };
  api = (await sqlite3InitModule()) as unknown as Sqlite;
}, 30_000);

const exportRaw = (db: RawDb): Uint8Array =>
  (api.capi.sqlite3_js_db_export as unknown as (p: number) => Uint8Array)(db.pointer);

function openRaw(image?: Uint8Array): RawDb {
  const db = new api.oo1.DB(':memory:', 'c');
  if (image !== undefined) {
    const p = (api.wasm.allocFromTypedArray as unknown as (a: Uint8Array) => number)(image);
    const rc = (api.capi.sqlite3_deserialize as unknown as (...a: unknown[]) => number)(
      db.pointer,
      'main',
      p,
      BigInt(image.byteLength),
      BigInt(image.byteLength),
      1 | 2,
    );
    expect(rc, '前提: 画像を開けている').toBe(0);
  }
  return db;
}

/** 束 B2 より前のビルドが作る DB(列も索引も旧い形)。 */
function legacyDb(rows: ReadonlyArray<readonly [string, string, string]>): RawDb {
  const db = openRaw();
  const added = ENTRY_ADDED_COLUMNS.map((c) => c.name).filter((n) => ['title_f', 'body_f', 'fold_rev'].includes(n));
  for (const ddl of LEGACY_SCHEMA_DDL()) {
    let out = ddl;
    for (const n of added) out = out.replace(new RegExp(`\\n\\s*${n}\\s+[^,]+,`), '');
    db.exec(out);
  }
  db.exec('PRAGMA user_version = 3');
  db.exec(
    `INSERT INTO containers (cid, title, created_at, updated_at, schema_version) VALUES ('c1', 't', datetime('now'), datetime('now'), 3)`,
  );
  rows.forEach(([lid, title, body], i) =>
    db.exec({
      sql: `INSERT INTO entries (cid, lid, title, archetype, created_at, updated_at, entry_order, archived, body)
            VALUES ('c1', ?, ?, 'text', '2020-01-01 00:00:00', '2020-01-01 00:00:00', ?, 0, ?)`,
      bind: [lid, title, i + 1, body],
    }),
  );
  return db;
}

const CID = 'c1';
const entry = (lid: string, title: string, body: string, order = 1) => ({
  lid,
  title,
  archetype: 'text',
  body,
  entryOrder: order,
  status: null,
  date: null,
  archived: false,
});

const lidsOf = async (request: Req, query: string): Promise<string[]> =>
  (await request({ op: 'searchEntries', cid: CID, query })).lids.slice().sort();

const progress = async (request: Req): Promise<string | null> => {
  const r = await request({
    op: 'runReadOnlySql',
    sql: "SELECT v FROM settings WHERE scope = '__fts__' AND k = 'built_upto'",
    maxRows: 2,
    maxSteps: 100_000,
    maxMs: 10_000,
  });
  return r.rows.length === 0 ? null : String(r.rows[0]![0]);
};

/** 揃え直しが要る行の数(旧ビルドが書いた行・まだ作っていない行)。 */
const waitingRows = async (request: Req): Promise<number> =>
  Number(
    (
      await request({
        op: 'runReadOnlySql',
        sql: 'SELECT count(*) FROM entries WHERE fold_rev IS NULL',
        maxRows: 2,
        maxSteps: 100_000,
        maxMs: 10_000,
      })
    ).rows[0]![0],
  );

/** 作り直しが済むまで待つ(印の行が消え、揃え直しが要る行が無くなる)。⚠ 上限を置く ── 済まない回を「永久に待つ」にしない。 */
async function untilBuilt(request: Req): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if ((await progress(request)) === null && (await waitingRows(request)) === 0) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('索引の作り直しが済まない');
}

const NFD_GA = 'が'; // 「か」+ 結合の濁点
const marked = (snippet: string): string[] => {
  const a = snippet.indexOf(SNIPPET_MARK_OPEN);
  const b = snippet.indexOf(SNIPPET_MARK_CLOSE);
  return a < 0 ? [] : [snippet.slice(a + 1, b)];
};

// ── ①②③ 揃えて引く / メモとリンクの宛先 / 左の列の語 ─────────────────────────────
describe('揃えて引く・メモとリンクの宛先・左の列の語(束 B2)', () => {
  let request: Req;

  beforeAll(async () => {
    request = await spawnWorker();
    await request({ op: 'init', dbName: 'fold-1852', memory: true });
    await request({ op: 'openContainer', cid: CID, title: 't' });
    const put = (lid: string, title: string, body: string) =>
      request({
        op: 'upsertEntry',
        cid: CID,
        entry: entry(lid, title, body, Number(lid.replace(/\D/g, '')) || 1),
        checkpoint: false,
      });
    await put('n1', 'ＰＫＣ報告', '全角ＰＫＣの本文です\n');
    await put('n2', '番号', '１２３４５ の番号\n');
    await put('n3', '半角カナ', 'ﾊﾝｶｸ のメモ\n');
    await put('n4', 'ガイド', `${NFD_GA}いど の手引き\n`);
    await put('n5', 'ひらがな', 'りんごを買う\n');
    await put('n6', 'カタカナ', 'リンゴを買う\n');
    await put('n7', '公開', '公開の文 %% 秘密のメモ %% 続き\n');
    await put('n8', 'ブロック', '前\n%%%\n極秘事項\n%%%\n後\n');
    await put('n9', 'コメント', '前\n:::comment\n社外秘\n:::\n後\n');
    await put('n10', 'リンク', '[議事録](entry:abc123) と ![図](asset:xyz789) を見る\n');
    await put('n11', '字のまま', '100\\%% done と 50\\%% more\n');
    await put('n12', '離れた語', '田中さんが来た。\n\n長い長い文章がここにある。\n\n見積を送る。\n');
    await put('n13', '会議', '議事録の件\n');
  }, 30_000);

  it('🔴 ① 全角で書いた本文を半角で、半角カナを全角カナで、結合の濁点を普通の字で引ける(題名も)', async () => {
    expect(await lidsOf(request, 'pkc'), '本文の「ＰＫＣ」と題名の「ＰＫＣ報告」').toEqual(['n1']);
    expect(await lidsOf(request, '12345')).toEqual(['n2']);
    expect(await lidsOf(request, 'ハンカク')).toEqual(['n3']);
    expect(await lidsOf(request, 'がいど'), 'Mac のファイル名由来の「が」(か+゛)').toEqual(['n4']);
    // 逆向き: 半角で書いた字を全角で打つ / 結合の濁点で打つ
    expect(await lidsOf(request, 'ＰＫＣ')).toEqual(['n1']);
    expect(await lidsOf(request, `${NFD_GA}いど`)).toEqual(['n4']);
  });

  it('🔴 ① 2 文字の語(LIKE)でも揃えて引く / 対照群: ひらがなとカタカナは別の字のまま', async () => {
    expect(await lidsOf(request, 'ＰＫ'), '2 文字の全角 → 半角で書いた語は無いが全角で書いた本文に当たる').toEqual(['n1']);
    expect(await lidsOf(request, 'pk')).toEqual(['n1']);
    expect(await lidsOf(request, 'りんご')).toEqual(['n5']);
    expect(await lidsOf(request, 'リンゴ')).toEqual(['n6']);
    expect(await lidsOf(request, 'りん')).toEqual(['n5']);
  });

  it('🔴 ② 隠したメモの中の字では当たらない(行内 / ブロック / :::comment)── 対照群: メモの外は当たる', async () => {
    expect(await lidsOf(request, '秘密')).toEqual([]);
    expect(await lidsOf(request, '秘密のメモ')).toEqual([]);
    expect(await lidsOf(request, '極秘事項')).toEqual([]);
    expect(await lidsOf(request, '社外秘')).toEqual([]);
    expect(await lidsOf(request, '公開の文')).toEqual(['n7']);
    expect(await lidsOf(request, '続き')).toEqual(['n7']);
    // `\%%` で字のまま書いた %% はメモではない
    expect(await lidsOf(request, 'done')).toEqual(['n11']);
    expect(await lidsOf(request, 'more')).toEqual(['n11']);
  });

  it('🔴 ② リンクの書き方の字(entry / asset / ID)では当たらず、リンクの見出しの字では当たる', async () => {
    expect(await lidsOf(request, 'entry')).toEqual([]);
    expect(await lidsOf(request, 'asset')).toEqual([]);
    expect(await lidsOf(request, 'abc123')).toEqual([]);
    expect(await lidsOf(request, 'xyz789')).toEqual([]);
    expect(await lidsOf(request, '議事録'), '見出しの字と、題名が「会議」のノートは本文の「議事録」').toEqual(['n10', 'n13']);
  });

  it('🔴 ② 内部の用途(raw)は、リンクの宛先の字を書いたまま引ける(添付の key の持ち主を探す道)', async () => {
    const r = await request({ op: 'searchEntries', cid: CID, query: 'xyz789', raw: true });
    expect(r.lids).toEqual(['n10']);
    const e = await request({ op: 'searchEntries', cid: CID, query: 'entry:abc123', raw: true });
    expect(e.lids).toEqual(['n10']);
  });

  it('🔴 ③ 左の列の欄は、空白(全角も)で区切った語を全部含む(離れていてもよい)', async () => {
    expect(await lidsOf(request, '田中 見積')).toEqual(['n12']);
    expect(await lidsOf(request, '田中　見積'), '全角の空白も区切り').toEqual(['n12']);
    expect(await lidsOf(request, '田中 存在しない語'), '片方しか無いのに当たった').toEqual([]);
    // 題名か本文のどちらかに入っていればよい(語ごと)── 題名「会議」+ 本文「議事録」
    expect(await lidsOf(request, '会議 議事録')).toEqual(['n13']);
  });

  it('🔴 ③ 対照群: 左の列の欄は `-語` を除外と読まない(字のまま探す)', async () => {
    expect(await lidsOf(request, '田中 -見積'), '`-見積` は字として探す ── どこにも無い').toEqual([]);
    expect(await lidsOf(request, '全角 -ＰＫＣ')).toEqual([]);
  });

  it('🔴 「探す」: 揃えて引き、抜粋は書いた字(ＰＫＣ)で出す。メモも宛先も抜粋に出ない', async () => {
    const r = await request({ op: 'searchDetail', cid: CID, query: 'pkc' });
    const n1 = r.rows.find((x) => x.lid === 'n1')!;
    expect(marked(n1.snippet), '印は書いた字を囲む').toEqual(['ＰＫＣ']);
    expect(n1.snippet).not.toContain('PKC');
    const m = await request({ op: 'searchDetail', cid: CID, query: '公開' });
    expect(m.rows.map((x) => x.lid)).toEqual(['n7']);
    expect(m.rows[0]!.snippet, '隠したメモが抜粋に出ている').not.toContain('秘密');
    expect((await request({ op: 'searchDetail', cid: CID, query: '秘密' })).rows).toEqual([]);
    const l = await request({ op: 'searchDetail', cid: CID, query: '議事録' });
    const link = l.rows.find((x) => x.lid === 'n10')!;
    expect(marked(link.snippet)).toEqual(['議事録']);
    expect(link.snippet, 'リンクの書き方が抜粋に出ている').not.toMatch(/entry:|asset:|abc123|\]\(/);
    expect((await request({ op: 'searchDetail', cid: CID, query: 'entry' })).rows).toEqual([]);
  });

  it('「探す」: 3 字未満の語・除外・複数語でも揃える', async () => {
    const two = await request({ op: 'searchDetail', cid: CID, query: 'ｐｋ' });
    expect(two.rows.map((x) => x.lid)).toEqual(['n1']);
    const ex = await request({ op: 'searchDetail', cid: CID, query: 'りんご -ＰＫＣ' });
    expect(ex.rows.map((x) => x.lid)).toEqual(['n5']);
    const none = await request({ op: 'searchDetail', cid: CID, query: '買う -リンゴ' });
    expect(none.rows.map((x) => x.lid), '除く語も揃えて引く').toEqual(['n5']);
  });

  it('🔴 改名・本文の書き換えで索引が追う(題名は renameEntry、本文は upsertEntry)', async () => {
    await request({ op: 'renameEntry', cid: CID, lid: 'n2', title: 'ＡＢＣ番号' });
    expect(await lidsOf(request, 'abc番号'), '改名後の題名を半角で引けない').toEqual(['n2']);
    expect(await lidsOf(request, 'ＡＢＣ番号')).toEqual(['n2']);
    await request({
      op: 'upsertEntry',
      cid: CID,
      entry: entry('n2', 'ＡＢＣ番号', 'もう半角だけの本文 plain\n', 2),
      checkpoint: false,
    });
    expect(await lidsOf(request, '12345'), '書き換えた本文に古い語が残っている').toEqual([]);
    expect(await lidsOf(request, 'plain')).toEqual(['n2']);
  });

  it('索引は整合している(外部内容の integrity-check が通る)', async () => {
    const { image } = await request({ op: 'exportImage' });
    const raw = openRaw(image);
    try {
      expect(() => raw.exec(`INSERT INTO entries_fts(entries_fts) VALUES ('integrity-check')`)).not.toThrow();
    } finally {
      raw.close();
    }
  });
});

// ── ④ 索引の作り直し(起動の後に塊で流す。作り直し中の答え) ─────────────────────────
describe('索引の作り直しは起動の後に塊で流す(束 B2)', () => {
  const N = 250; // 1 塊(100 件)を越える件数
  const rowsOf = (): Array<readonly [string, string, string]> =>
    Array.from({ length: N }, (_, i) => {
      const lid = `r${String(i).padStart(3, '0')}`;
      // r010 = 全角の ＰＫＣ(最初の塊)/ r200 = 全角の ＱＱＱ(3 塊目)/ r249 = 一意な語
      const body =
        i === 10 ? '全角ＰＫＣの行' : i === 200 ? '全角ＱＱＱの行' : i === 249 ? 'ゆにーく777の行' : `ふつうの本文 ${lid}`;
      return [lid, `題 ${lid}`, body] as const;
    });

  it('🔴 起動の返事の時点では索引を作り直していない(起動を止めない)── 旧い形の索引は空で、印が置かれる', async () => {
    const db = legacyDb(rowsOf());
    const image = exportRaw(db);
    db.close();
    const request = await spawnWorker();
    await request({ op: 'init', dbName: 'rebuild-1852', memory: true, image });
    // 返事の直後 ── 作り直しの係はまだ 1 塊も流していない(係は setTimeout で動く)
    expect(await progress(request), '印が置かれていない').toBe('-1');
    await untilBuilt(request);
    expect(await progress(request)).toBeNull();
  });

  it('🔴 作り直し中の答え: まだの行も書いた字のまま全走査で引け、流し終えた行は揃えて引ける / 済めば全部揃えて引ける', async () => {
    const db = legacyDb(rowsOf());
    const image = exportRaw(db);
    db.close();
    const request = await spawnWorker();
    await request({ op: 'init', dbName: 'rebuild-1852b', memory: true, image });

    // (a) 1 塊も流していない間 ── 書いた字のままなら全行を引ける(索引が空でも「無い」と言わない)
    expect(await progress(request)).toBe('-1');
    expect(await lidsOf(request, 'ゆにーく777'), '索引が空の間に最後の行が見つからない').toEqual(['r249']);
    expect(await lidsOf(request, 'ふつうの本文 r005')).toEqual(['r005']);
    expect(
      await lidsOf(request, 'pkc'),
      '決まり: 揃える前の行は書いた字のまま ── 全角の「ＰＫＣ」は半角の語ではまだ当たらない',
    ).toEqual([]);
    expect(
      await lidsOf(request, 'ＰＫＣ'),
      '書いた字のままの語なら当たる(揃えた語だけで引くと、全角で書いた行が作り直しの間だけ消える)',
    ).toEqual(['r010']);
    expect(await lidsOf(request, 'ふつうの本文 ＰＫＣ'), '複数語でも、語ごとに書いた字のままで引く').toEqual([]);
    // 探す面も同じ集合(全走査)
    expect((await request({ op: 'searchDetail', cid: CID, query: 'ゆにーく777' })).rows.map((r) => r.lid)).toEqual(['r249']);

    // (b) 1 塊だけ流す ── 流し終えた行(rowid <= 印)は揃えた字で引け、まだの行は書いた字のまま
    await new Promise((r) => setTimeout(r, 0));
    const cursor = await progress(request);
    expect(cursor, '1 塊流したのに印が動いていない / 全部済んでしまった').not.toBeNull();
    const upto = Number(cursor);
    expect(upto, '1 塊(100 件)ぶんだけ進んでいるはず').toBeGreaterThanOrEqual(100);
    expect(upto).toBeLessThan(N);
    // r010 は rowid 11(流し終えた側)、r200 は rowid 201(まだの側)
    expect(11).toBeLessThanOrEqual(upto);
    expect(201).toBeGreaterThan(upto);
    expect(await lidsOf(request, 'pkc'), '流し終えた行は揃えて引ける').toEqual(['r010']);
    expect(await lidsOf(request, 'qqq'), 'まだの行は書いた字のまま').toEqual([]);
    expect(await lidsOf(request, 'ＱＱＱ')).toEqual(['r200']);

    // (c) 済んだら全部揃えて引ける(索引で引く)
    await untilBuilt(request);
    expect(await lidsOf(request, 'qqq')).toEqual(['r200']);
    expect(await lidsOf(request, 'pkc')).toEqual(['r010']);
    expect(await lidsOf(request, 'ゆにーく777')).toEqual(['r249']);
    // 索引は整合している(入れ直しの二重・欠けが無い)
    const { image: out } = await request({ op: 'exportImage' });
    const raw = openRaw(out);
    try {
      expect(() => raw.exec(`INSERT INTO entries_fts(entries_fts) VALUES ('integrity-check')`)).not.toThrow();
      expect(Number(raw.selectValue('SELECT count(*) FROM entries_fts_docsize'))).toBe(N);
    } finally {
      raw.close();
    }
  }, 30_000);

  it('🔴 作り直し中に書いた行・消した行でも、索引が壊れない(印より後の行へは引き金が黙る)', async () => {
    const db = legacyDb(rowsOf());
    const image = exportRaw(db);
    db.close();
    const request = await spawnWorker();
    await request({ op: 'init', dbName: 'rebuild-1852c', memory: true, image });
    // まだ 1 件も流していない間に、書く・消す(印より後の行に 'delete' を撃つと索引が壊れる ── 2026-08-20 と同じ型)
    await request({ op: 'upsertEntry', cid: CID, entry: entry('r249', '題', '書き換えた最後の行 ＺＺＺ', 249), checkpoint: false });
    await request({ op: 'deleteEntry', cid: CID, lid: 'r248' } as never);
    await request({ op: 'upsertEntry', cid: CID, entry: entry('newrow', '新', '作り直し中に足した行 ＮＥＷ', 999), checkpoint: false });
    await untilBuilt(request);
    expect(await lidsOf(request, 'zzz'), '作り直し中に書き換えた行が揃えて引けない').toEqual(['r249']);
    expect(await lidsOf(request, 'new'), '作り直し中に足した行が引けない').toEqual(['newrow']);
    expect(await lidsOf(request, 'ふつうの本文 r248'), '消した行が残っている').toEqual([]);
    const { image: out } = await request({ op: 'exportImage' });
    const raw = openRaw(out);
    try {
      expect(() => raw.exec(`INSERT INTO entries_fts(entries_fts) VALUES ('integrity-check')`)).not.toThrow();
    } finally {
      raw.close();
    }
  }, 30_000);
});

// ── ⑤ 前の版の PKC3 が同じ保存領域を開いても壊れない ───────────────────────────────
describe('前の版の PKC3 が同じ保存領域を開いて読み書きしても壊れない(束 B2)', () => {
  /**
   * 前の版の読み方を再現する: 前の版の `applySchema` は旧い DDL を `IF NOT EXISTS` で流し、索引の数が `entries` と合っていれば
   * 何もしない。書くのは旧い UPSERT(新しい列を挙げない)── 引き金は DB の中の新しい文面がそのまま走る。
   */
  const oldBuildOpens = (db: RawDb): void => {
    for (const ddl of LEGACY_SCHEMA_DDL().filter((d) => /IF NOT EXISTS/.test(d))) {
      // 旧い entries の CREATE は新しい列を持たないが、IF NOT EXISTS なので何もしない
      if (/CREATE TABLE IF NOT EXISTS entries\b/.test(ddl)) continue;
      db.exec(ddl);
    }
    for (const ddl of LEGACY_FTS_DDL) db.exec(ddl);
    const docs = Number(db.selectValue('SELECT count(*) FROM entries_fts_docsize'));
    const entries = Number(db.selectValue('SELECT count(*) FROM entries'));
    expect(docs, '前の版の「数が合うか」の判定が組み直しに倒れる(新しい索引が前の版に壊れて見える)').toBe(entries);
  };

  it('🔴 前の版が開いて、書き換えて、足して、消しても落ちず、索引は整合する。次の新ビルドの起動が揃え直す', async () => {
    // 新ビルドで DB を作る(全角の本文を含む)
    const first = await spawnWorker();
    await first({ op: 'init', dbName: 'compat-1852', memory: true });
    await first({ op: 'openContainer', cid: CID, title: 't' });
    const put = (r: Req, lid: string, title: string, body: string, order: number) =>
      r({ op: 'upsertEntry', cid: CID, entry: entry(lid, title, body, order), checkpoint: false });
    await put(first, 'k1', '残す', '全角ＫＥＥＰの本文', 1);
    await put(first, 'k2', '直す', '全角ＥＤＩＴの本文', 2);
    await put(first, 'k3', '消す', '全角ＤＥＬの本文', 3);
    await put(first, 'k5', '平文', '平らな本文だけの行', 5);
    const { image } = await first({ op: 'exportImage' });

    // ── 前の版が開く
    const raw = openRaw(image);
    oldBuildOpens(raw);
    // 前の版が読む(書いた字そのままの語は引ける)
    expect(Number(raw.selectValue(`SELECT count(*) FROM entries_fts WHERE entries_fts MATCH '"の本文"'`))).toBe(3);
    // 前の版が書く: INSERT(新しい列を挙げない)/ UPDATE(題名と本文だけ)/ DELETE
    raw.exec(
      `INSERT INTO entries (cid, lid, title, archetype, entry_order, archived, body)
       VALUES ('c1', 'k4', '旧ビルド', 'text', 4, 0, '旧ビルドが書いた全角ＯＬＤの本文')`,
    );
    raw.exec(`UPDATE entries SET body = '半角に直した edit の本文だよ' WHERE lid = 'k2'`);
    raw.exec(`UPDATE entries SET body = '平らに直した行です' WHERE lid = 'k5'`);
    raw.exec(`UPDATE entries SET title = 'ＲＥＮＡＭＥ' WHERE lid = 'k1'`);
    raw.exec(`DELETE FROM entries WHERE lid = 'k3'`);
    expect(
      () => raw.exec(`INSERT INTO entries_fts(entries_fts) VALUES ('integrity-check')`),
      '前の版が書いたあとの索引が壊れている',
    ).not.toThrow();
    // 前の版の語で引ける(書き換えた本文・足した行)
    // 元の字を持たない行(平文)は、旧ビルド自身の検索でも書き換えた本文に当たる
    expect(Number(raw.selectValue(`SELECT count(*) FROM entries_fts WHERE entries_fts MATCH '"平らに直した"'`))).toBe(1);
    expect(Number(raw.selectValue(`SELECT count(*) FROM entries_fts WHERE entries_fts MATCH '"旧ビルドが書いた"'`))).toBe(1);
    expect(Number(raw.selectValue(`SELECT count(*) FROM entries_fts WHERE entries_fts MATCH '"全角ＤＥＬ"'`)), '消した行が索引に残る').toBe(0);
    // 前の版が書いた行は「作り直しが要る」に戻る(旧ビルドは fold_rev を知らない)
    const waiting = raw.selectObjects(`SELECT lid FROM entries WHERE fold_rev IS NULL ORDER BY lid`).map((r) => r.lid);
    expect(waiting, '旧ビルドが書いた行(足した・本文を書き換えた・題名を書き換えた)が印されていない').toEqual(['k1', 'k2', 'k4', 'k5']);
    const afterOld = exportRaw(raw);
    raw.close();

    // ── 次に新ビルドが開く
    const second = await spawnWorker();
    await second({ op: 'init', dbName: 'compat-1852b', memory: true, image: afterOld });
    await untilBuilt(second);
    expect(await lidsOf(second, 'old'), '旧ビルドが書いた全角の行が、新ビルドの起動で半角の語で引ける').toEqual(['k4']);
    expect(await lidsOf(second, 'rename'), '旧ビルドが書き換えた題名').toEqual(['k1']);
    expect(await lidsOf(second, 'edit'), '旧ビルドが書き換えた本文(元の字を持つ行も、新ビルドの起動で新しい本文に当たる)').toEqual(['k2']);
    expect(await lidsOf(second, '平らに直した')).toEqual(['k5']);
    expect(await lidsOf(second, 'keep'), '触っていない行').toEqual(['k1']);
    expect(await lidsOf(second, 'del')).toEqual([]);
    const { image: out } = await second({ op: 'exportImage' });
    const check = openRaw(out);
    try {
      expect(() => check.exec(`INSERT INTO entries_fts(entries_fts) VALUES ('integrity-check')`)).not.toThrow();
      expect(Number(check.selectValue('SELECT count(*) FROM entries WHERE fold_rev IS NULL'))).toBe(0);
    } finally {
      check.close();
    }
  }, 30_000);

  it('🔴 前の版が索引を組み直した(旧い形に戻した)DB も、次の新ビルドの起動で揃え直す', async () => {
    const first = await spawnWorker();
    await first({ op: 'init', dbName: 'compat-1852c', memory: true });
    await first({ op: 'openContainer', cid: CID, title: 't' });
    await first({ op: 'upsertEntry', cid: CID, entry: entry('a1', '一', '全角ＲＥＢＵＩＬＤの本文', 1), checkpoint: false });
    const { image } = await first({ op: 'exportImage' });
    const raw = openRaw(image);
    // 前の版の「最後の手段」: 仮想表ごと落として旧い DDL で作り直し、'rebuild'
    raw.exec('DROP TABLE entries_fts');
    for (const ddl of LEGACY_FTS_DDL) raw.exec(ddl);
    raw.exec(`INSERT INTO entries_fts(entries_fts) VALUES ('rebuild')`);
    const legacySql = String(raw.selectValue(`SELECT sql FROM sqlite_master WHERE name = 'entries_fts'`));
    expect(legacySql, '前提: 旧い形に戻っていない').toContain("content='entries'");
    const out = exportRaw(raw);
    raw.close();
    const second = await spawnWorker();
    await second({ op: 'init', dbName: 'compat-1852d', memory: true, image: out });
    await untilBuilt(second);
    expect(await lidsOf(second, 'rebuild'), '旧い形から移した後、半角の語で引けない').toEqual(['a1']);
    const { image: done } = await second({ op: 'exportImage' });
    const check = openRaw(done);
    try {
      expect(String(check.selectValue(`SELECT sql FROM sqlite_master WHERE name = 'entries_fts'`))).toContain('entries_fts_src');
      expect(() => check.exec(`INSERT INTO entries_fts(entries_fts) VALUES ('integrity-check')`)).not.toThrow();
    } finally {
      check.close();
    }
  }, 30_000);
});

// ── ⑥ 索引の形の版 / 旧い形の画像 ────────────────────────────────────────────────
describe('索引の形の版(束 B2)', () => {
  it('🔴 版が違う DB は、起動したとき索引を捨てて作り直す(版を上げれば揃え方を変えられる)', async () => {
    const first = await spawnWorker();
    await first({ op: 'init', dbName: 'form-1852', memory: true });
    await first({ op: 'openContainer', cid: CID, title: 't' });
    await first({ op: 'upsertEntry', cid: CID, entry: entry('a1', '一', '全角ＦＯＲＭの本文', 1), checkpoint: false });
    const { image } = await first({ op: 'exportImage' });
    const raw = openRaw(image);
    expect(raw.selectValue(`SELECT v FROM settings WHERE scope = '__fts__' AND k = 'form'`), '前提: 版が刻まれている').toBe('2');
    // 版を古くする(= 前の版の作り方で作られた索引を持つ端末)
    raw.exec(`UPDATE settings SET v = '1' WHERE scope = '__fts__' AND k = 'form'`);
    // 前の作り方の名残: 元の字を空にして、索引も空にしておく ── 作り直しがこれを埋める
    raw.exec(`UPDATE entries SET fold_rev = NULL, body_f = NULL`);
    const old = exportRaw(raw);
    raw.close();
    const second = await spawnWorker();
    await second({ op: 'init', dbName: 'form-1852b', memory: true, image: old });
    expect(await progress(second), '版が違うのに作り直しの印が置かれていない').toBe('-1');
    await untilBuilt(second);
    expect(await lidsOf(second, 'form')).toEqual(['a1']);
    const { image: done } = await second({ op: 'exportImage' });
    const check = openRaw(done);
    try {
      expect(check.selectValue(`SELECT v FROM settings WHERE scope = '__fts__' AND k = 'form'`)).toBe('2');
    } finally {
      check.close();
    }
  }, 30_000);

  it('対照群: 版が合っている DB は、開き直しても作り直さない(印が置かれない)', async () => {
    const first = await spawnWorker();
    await first({ op: 'init', dbName: 'form-1852c', memory: true });
    await first({ op: 'openContainer', cid: CID, title: 't' });
    await first({ op: 'upsertEntry', cid: CID, entry: entry('a1', '一', '本文', 1), checkpoint: false });
    await untilBuilt(first);
    const { image } = await first({ op: 'exportImage' });
    const second = await spawnWorker();
    await second({ op: 'init', dbName: 'form-1852d', memory: true, image });
    expect(await progress(second), '版が合っているのに作り直そうとしている').toBeNull();
  });

  it('🔴 旧い形の索引の引き金を持つ画像(前のビルドが書き出した PKC3 入り HTML)も、読める', async () => {
    const db = legacyDb([['a1', '題', '旧い形の本文']]);
    const image = exportRaw(db);
    db.close();
    const request = await spawnWorker();
    await request({ op: 'init', dbName: 'img-1852', memory: true });
    const r = await request({ op: 'readImageArchive', image });
    expect(r.metas.length, '旧い形の画像が断られた / 読めていない').toBe(1);
    expect(r.bodies.map((b) => b.body)).toEqual(['旧い形の本文']);
  });
});
