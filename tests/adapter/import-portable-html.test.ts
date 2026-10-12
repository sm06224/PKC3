/** @vitest-environment happy-dom */
/**
 * 🔴 **PKC3 入り HTML(`.pkc3.html`)を取り込む**(#1416)── 書き出した 1 枚が、取り込みで戻る。
 *
 * ⚠ 実物の storage-worker(sqlite-wasm)を node で動かす(`storage-worker-sqlite-export.test.ts` と同じ作法)。
 *   書き出しは本物の `writePortableBundle`(雛形だけ小さな偽物)、DB の画像は本物の `exportImage`、
 *   読み取りは本物の `readImageArchive`、取り込みは本物の `importPkc2File` を通す。
 *   ── 両端が相手の stub と話す形にしない(CLAUDE.md §7)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { importPkc2File, type ImportDeps } from '../../src/adapter/ui/actions/import-pkc2';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { writePortableBundle } from '../../src/features/export/portable-bundle';
import { IMAGE_PART_BYTES } from '../../src/features/portable/bundle';
import { detectPkc2Format } from '../../src/features/import/detect-format';
import { readPortableHtml, sniffPortableHtml } from '../../src/features/import/portable-html';

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

let cid = '';
let shared: { html: string; blob: Blob };
beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const init = await request({ op: 'init', dbName: 'unit-test' });
  expect(init.vfs).toBe('memory');
  cid = (await request({ op: 'resolveContainer', title: 'テスト' })).cid;
  // 🔑 書き出しは 1 回だけ(履歴の版が test ごとに増えない)
  shared = await exportedHtml();
}, 30_000);

afterAll(async () => {
  await request({ op: 'close' });
});

const TEMPLATE =
  `<!doctype html><html><head>` +
  `<script type="application/json" data-pkc-bundle>{"id":"pkcb-template","exportedAt":0}</script>` +
  `</head><body><div data-pkc-slot="root"></div>` +
  // 🔑 アプリ本体の JS の中に、書き出しの綴りが**文字列として**現れる形(本物の雛形がそう)
  `<script>var s='<script type="application/octet-stream;base64" data-pkc-db-image>';</script>` +
  `</body></html>`;

const row = (lid: string, title: string, body: string, order: number): EntryUpsert => ({
  lid,
  title,
  archetype: 'text',
  body,
  entryOrder: order,
  status: null,
  date: null,
  archived: false,
});

const ASSET_BYTES = new Uint8Array([1, 2, 3, 250, 251, 252, 0, 77]);
const ASSET_KEY = 'ast-0123456789abcdef';

/** コレクションに「ノート 3 件 + つながり 1 本 + 添付 1 件 + 履歴 + タグの色」を用意して 1 枚に書き出す。 */
async function exportedHtml(): Promise<{ html: string; blob: Blob }> {
  await request({
    op: 'bulkUpsertEntries',
    cid,
    entries: [
      row('n1', '一つ目', '# 一つ目\n本文 #色付き\n', 1),
      row('n2', '二つ目', '二つ目の本文\n', 2),
      row('n3', '三つ目', 'asset:' + ASSET_KEY + '\n', 3),
    ],
  });
  await request({
    op: 'bulkUpsertRelations',
    cid,
    relations: [{ id: 'rel-1', fromLid: 'n1', toLid: 'n2', kind: 'semantic' }],
  });
  await request({
    op: 'putAssetMeta',
    cid,
    meta: { key: ASSET_KEY, mime: 'application/octet-stream', size: ASSET_BYTES.length, hash: null },
  });
  // 履歴: 変更前の本文を 1 版積む(checkpoint)
  await request({
    op: 'upsertEntry',
    cid,
    entry: row('n2', '二つ目', '二つ目の本文(書き換えた)\n', 2),
    checkpoint: true,
  });
  await request({ op: 'putTagColor', cid, key: 'いろ', tag: '色付き', color: '#aa3300' });

  const { image } = await request({ op: 'exportImage' });
  const out = await writePortableBundle({
    template: TEMPLATE,
    bundle: { id: 'pkcb-roundtrip01', exportedAt: 1_700_000_000_000 },
    image,
    assets: (async function* () {
      yield {
        key: ASSET_KEY,
        mime: 'application/octet-stream',
        blob: new Blob([ASSET_BYTES]),
      };
    })(),
  });
  return { html: await out.blob.text(), blob: out.blob };
}

interface Seen {
  entries: EntryUpsert[];
  relations: Array<{ id: string; fromLid: string; toLid: string; kind: string }>;
  blobs: Map<string, Blob>;
  chains: number;
  tagColors: Array<{ tag: string; color: string }>;
  notices: string[];
  errors: string[];
  confirmed: Array<{ notes: number; assets: number; relations: boolean; revisions: boolean }>;
}

function deps(over: Partial<ImportDeps> = {}): { d: Dispatcher; deps: ImportDeps; seen: Seen } {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c-dest', metas: [], relations: [] });
  const seen: Seen = {
    entries: [],
    relations: [],
    blobs: new Map(),
    chains: 0,
    tagColors: [],
    notices: [],
    errors: [],
    confirmed: [],
  };
  const orig = d.dispatch.bind(d);
  d.dispatch = (a: Parameters<typeof orig>[0]) => {
    if (a.type === 'OP_FAILED') seen.errors.push((a as { error: string }).error);
    return orig(a);
  };
  let n = 0;
  const base: ImportDeps = {
    // 🔑 取り込み先は空 ── 元の ID のまま入る(衝突の付け替えは別の test が見る)
    existingLids: async () => new Set(),
    existingRelationIds: () => new Set(),
    orderBase: () => 0,
    genLid: () => `gen-lid-${++n}`,
    genAssetKey: () => `ast-gen-${++n}`,
    genRelationId: () => `rel-gen-${++n}`,
    bulkUpsertEntries: async (e) => {
      seen.entries.push(...e);
    },
    bulkUpsertRelations: async (r) => {
      seen.relations.push(...r);
    },
    importRevisionChains: async () => ({
      added: 0,
      skippedNoChange: 0,
      droppedOverLimit: 0,
      skippedEntries: [],
    }),
    restoreRevisionChains: async (chains) => {
      seen.chains += chains.length;
      return {
        added: chains.reduce((a, c) => a + c.rows.length, 0),
        skippedNoChange: 0,
        droppedOverLimit: 0,
        skippedEntries: [],
        brokenChains: [],
      };
    },
    importTagColors: async (incoming) => {
      seen.tagColors.push(...incoming);
      return { added: incoming.length, kept: 0, overLimit: 0 };
    },
    listStoredBlobKeys: async () => new Set(),
    putBlob: async (k, b) => {
      seen.blobs.set(k, b);
    },
    putAssetMeta: async () => {},
    reload: async () => {},
    notify: (m) => seen.notices.push(m),
    confirmArchiveImport: async (p) => {
      seen.confirmed.push({
        notes: p.noteCount,
        assets: p.assetCount,
        relations: p.hasRelations,
        revisions: p.hasRevisions,
      });
      return true;
    },
    // 🔑 本物の worker に頼む(stub に頼まない)
    readImageArchive: (image) => request({ op: 'readImageArchive', image }),
    ...over,
  };
  return { d, deps: base, seen };
}

describe('PKC3 入り HTML の取り込み (#1416)', () => {
  it('🔴 書き出した 1 枚を取り込むと、ノート・添付・つながり・履歴・タグの色が元と一致する', async () => {
    const { blob } = shared;
    const { d, deps: dd, seen } = deps();

    const count = await importPkc2File(
      d,
      dd,
      new File([blob], 'carried-20261011.pkc3.html', { type: 'text/html' }),
    );

    expect(seen.errors, `断られた: ${seen.errors.join(' / ')}`).toEqual([]);
    expect(count).toBe(3);
    // ノート: 題名・本文とも元と同じ(取り込み先が空なので ID も同じ)
    const byLid = new Map(seen.entries.map((e) => [e.lid, e]));
    expect([...byLid.keys()].sort()).toEqual(['n1', 'n2', 'n3']);
    expect(byLid.get('n1')!.title).toBe('一つ目');
    expect(byLid.get('n1')!.body).toBe('# 一つ目\n本文 #色付き\n');
    expect(byLid.get('n2')!.body, '書き換えた後の本文').toBe('二つ目の本文(書き換えた)\n');
    // つながり
    expect(seen.relations).toEqual([
      { id: 'rel-1', fromLid: 'n1', toLid: 'n2', kind: 'semantic' },
    ]);
    // 添付: 中身が 1 バイトも違わない
    expect(seen.blobs.size).toBe(1);
    const got = new Uint8Array(await [...seen.blobs.values()][0]!.arrayBuffer());
    expect([...got]).toEqual([...ASSET_BYTES]);
    // 履歴: 変更前の本文を積んだ n2 の鎖が運ばれる
    expect(seen.chains, '履歴の鎖が 1 本も戻っていない').toBe(1);
    // タグの色
    expect(seen.tagColors).toEqual([{ tag: '色付き', color: '#aa3300' }]);
    // 🔑 バックアップと同じ道を通った証拠: 取り込む前の確認が、中身の件数つきで出ている
    expect(seen.confirmed).toEqual([
      { notes: 3, assets: 1, relations: true, revisions: true },
    ]);
  });

  it('🔴 いま開いているコレクションには触れない(写しを読んだ後も、元のノートはそのまま)', async () => {
    const { blob } = shared;
    // 画像を作った「後」に増えたノート ── 写しには入らず、読んだ後も消えない
    await request({
      op: 'bulkUpsertEntries',
      cid,
      entries: [row('live-only', '後から増えたノート', '本体にだけある\n', 99)],
    });
    const before = (await request({ op: 'listEntryMetas', cid })).map((m) => m.lid).sort();
    expect(before).toContain('live-only');

    const { d, deps: dd, seen } = deps();
    await importPkc2File(d, dd, new File([blob], 'x.pkc3.html'));

    const after = (await request({ op: 'listEntryMetas', cid })).map((m) => m.lid).sort();
    expect(after, '読んだせいで本体のノートが変わった').toEqual(before);
    // 写しの側には後から増えたノートが無い(対照群: 本体と取り違えて読んでいない)
    expect(seen.entries.map((e) => e.lid)).not.toContain('live-only');
    expect(seen.entries.length, '写しからノートが読めていない').toBeGreaterThan(0);
  });

  it('見分けは印で行う: 名前を変えても読める / 印が無ければ PKC3 入り HTML と見なさない', async () => {
    const { blob } = shared;
    const { d, deps: dd, seen } = deps();
    // 拡張子が .txt でも、印があれば読む
    const count = await importPkc2File(d, dd, new File([blob], 'renamed.txt'));
    expect(seen.errors).toEqual([]);
    expect(count).toBeGreaterThan(0);

    // 同じ名前 (.pkc3.html) でも、印の無い PKC2 風の HTML は PKC3 入り HTML ではない
    const head = new TextEncoder().encode('<!doctype html><html><head></head><body></body></html>');
    expect(detectPkc2Format(head, null, 'fake.pkc3.html')).toBe('html');
    expect(sniffPortableHtml('<html><head></head>')).toBeNull();
  });

  it('🔴 対照群: PKC2 の単一 HTML は今までどおり PKC2 の道で取り込まれる', async () => {
    const payload = {
      container: {
        meta: {},
        entries: [{ lid: 'a', title: 'PKC2 のノート', archetype: 'text', body: '# 本文\n' }],
        relations: [],
      },
      export_meta: { mode: 'full', asset_encoding: 'base64' },
    };
    const html =
      `<!doctype html><html><head><script id="pkc-meta" type="application/json">{"app":"pkc2","schema":1}</script></head>` +
      `<body><script id="pkc-data" type="application/json">${JSON.stringify(payload)}</script></body></html>`;
    const head = new TextEncoder().encode(html);
    expect(detectPkc2Format(head, null, 'p.html')).toBe('html');

    // readImageArchive を渡さない配線でも通る = PKC3 入り HTML の道を踏んでいない
    const { d, deps: dd, seen } = deps({ readImageArchive: undefined });
    const count = await importPkc2File(d, dd, new File([html], 'p.html', { type: 'text/html' }));
    expect(seen.errors).toEqual([]);
    expect(count).toBe(1);
    expect(seen.entries[0]!.title).toBe('PKC2 のノート');
    expect(seen.confirmed, 'PKC2 の HTML なのにバックアップの確認が出た').toEqual([]);
  });

  describe('壊れた / 途中で切れたファイルは断り文で返す(1 件も書かない)', () => {
    it('途中で切れた(終わりの </body> が無い)', async () => {
      const { html } = shared;
      const cut = html.slice(0, html.lastIndexOf('</body>'));
      const { d, deps: dd, seen } = deps();
      const count = await importPkc2File(d, dd, new File([cut], 'cut.pkc3.html'));
      expect(count).toBeNull();
      expect(seen.errors.join('\n')).toContain('最後まで書き込まれていません');
      expect(seen.entries).toEqual([]);
    });

    it('中身(DB)の要素が無い', async () => {
      const { html } = shared;
      const open = '<script type="application/octet-stream;base64" data-pkc-db-image="0/1">';
      const from = html.lastIndexOf(open);
      expect(from, '前提: 差し込まれた要素が見つかる').toBeGreaterThan(0);
      const stripped = html.slice(0, from) + html.slice(html.indexOf('</script>', from) + 9);
      expect(stripped.length, '前提: 取り除けている').toBeLessThan(html.length);
      const { d, deps: dd, seen } = deps();
      expect(await importPkc2File(d, dd, new File([stripped], 'no-db.pkc3.html'))).toBeNull();
      expect(seen.errors.join('\n')).toContain('ノートの中身が見つかりません');
      expect(seen.entries).toEqual([]);
    });

    it('中身が sqlite として読めない', async () => {
      const { html } = shared;
      // ⚠ 差し込まれた(最後の)要素を差し替える ── 先頭に当たるのは雛形の JS の中の文字列
      const at = html.lastIndexOf('data-pkc-db-image="0/1">') + 'data-pkc-db-image="0/1">'.length;
      const bad =
        html.slice(0, at) +
        btoa('this is not a sqlite database '.repeat(40)) +
        html.slice(html.indexOf('</script>', at));
      expect(bad.length, '前提: 差し替えられている').not.toBe(html.length);
      const { d, deps: dd, seen } = deps();
      expect(await importPkc2File(d, dd, new File([bad], 'bad-db.pkc3.html'))).toBeNull();
      expect(seen.errors.join('\n')).toContain('読み込めませんでした');
      expect(seen.entries).toEqual([]);
      // 客のファイルが読めなかっただけで、本体の worker は生きている
      expect((await request({ op: 'listEntryMetas', cid })).length).toBeGreaterThan(0);
      // 🔴 そして本体への**書き込みも断られない**(客の破損を、うちの破損として扱わない)
      await expect(
        request({ op: 'bulkUpsertEntries', cid, entries: [row('after-bad', '壊れた後の書き込み', 'x\n', 90)] }),
        '壊れた HTML を選んだだけで、本体への書き込みが止まった',
      ).resolves.toBeNull();
    });

    it('この画面に読む口が無いときは、理由を言って断る', async () => {
      const { html } = shared;
      const { d, deps: dd, seen } = deps({ readImageArchive: undefined });
      expect(await importPkc2File(d, dd, new File([html], 'x.pkc3.html'))).toBeNull();
      expect(seen.errors.join('\n')).toContain('PKC3 入り HTML を取り込めません');
    });
  });

  it('雛形の本体の JS に書き出しの綴りが現れても、差し込まれた要素だけを取り出す', async () => {
    const { html } = shared;
    const parts = readPortableHtml(html);
    expect(parts.bundle.id).toBe('pkcb-roundtrip01');
    expect(parts.assets.size).toBe(1);
    expect(parts.assets.has(ASSET_KEY)).toBe(true);
    // 雛形の JS の文字列(中身が空の綴り)に引きずられて、画像が空になっていない
    expect(parts.image.byteLength).toBeGreaterThan(1000);
  });
});

type RawDb = {
  exec: (o: unknown) => void;
  pointer: number;
  close: () => void;
  selectValue: (sql: string) => unknown;
};
type Sqlite = {
  oo1: { DB: new (f: string, m?: string) => RawDb };
  capi: Record<string, (...a: never[]) => unknown>;
  wasm: Record<string, (...a: never[]) => unknown>;
};

/** 画像を一度開いて SQL を流し、また画像に戻す(細工した画像を作る)。 */
async function tamper(image: Uint8Array, sqls: string[]): Promise<Uint8Array> {
  const api = (await sqlite3InitModule()) as unknown as Sqlite;
  const db = new api.oo1.DB(':memory:', 'c');
  try {
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
    for (const sql of sqls) db.exec({ sql });
    return (api.capi.sqlite3_js_db_export as unknown as (p: number) => Uint8Array)(db.pointer);
  } finally {
    db.close();
  }
}

describe('客の画像が、本体を巻き込まない・占有しない', () => {
  it('🔴 整える段で壊れの綴りが出る画像でも、読んだ後に本体への書き込みが止まらない', async () => {
    // 壊すのは PK の自動索引の root page(`storage-worker-corrupt.test.ts` と同じ手)
    const api = (await sqlite3InitModule()) as unknown as Sqlite;
    const db = new api.oo1.DB(':memory:', 'c');
    db.exec({
      sql: `CREATE TABLE entries (
       cid TEXT NOT NULL, lid TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
       archetype TEXT NOT NULL DEFAULT 'text', created_at TEXT, updated_at TEXT,
       entry_order INTEGER NOT NULL DEFAULT 0, status TEXT, date TEXT,
       archived INTEGER NOT NULL DEFAULT 0, task_total INTEGER, body_chars INTEGER,
       body_tags TEXT, body TEXT NOT NULL DEFAULT '', PRIMARY KEY (cid, lid))`,
    });
    db.exec({ sql: 'BEGIN' });
    for (let i = 0; i < 400; i += 1) {
      db.exec({
        sql: `INSERT INTO entries (cid, lid, title, archetype, body) VALUES ('c1','k${i}','題 ${i}','text','本文 ${i}')`,
      });
    }
    db.exec({ sql: 'COMMIT' });
    const pageSize = Number(db.selectValue('PRAGMA page_size'));
    const root = Number(
      db.selectValue("SELECT rootpage FROM sqlite_schema WHERE type='index' AND tbl_name='entries'"),
    );
    const image = (api.capi.sqlite3_js_db_export as unknown as (p: number) => Uint8Array)(db.pointer);
    db.close();
    const off = (root - 1) * pageSize;
    for (let i = 0; i < 400; i += 1) image[off + 12 + i] = 0x5a;

    await expect(request({ op: 'readImageArchive', image })).rejects.toThrow(
      '読み取れない形になっています',
    );
    // 🔑 本体は壊れ扱いになっていない(壊れ扱いなら、この書き込みは断られる)
    await expect(
      request({ op: 'bulkUpsertEntries', cid, entries: [row('after-broken', '後の書き込み', 'x\n', 91)] }),
      '客の画像の壊れを、本体の壊れとして扱った',
    ).resolves.toBeNull();
  });

  it('🔴 PKC3 が作らない引き金・ビュー、中身を書き換えた引き金が入った画像は、読まずに断る(対照群: 元の画像は通る)', async () => {
    const image = readPortableHtml(shared.html).image;
    // 対照群: 細工していない画像は読める
    expect((await request({ op: 'readImageArchive', image })).metas.length).toBeGreaterThan(0);

    const refusal = 'PKC3 が書き出したものではないため取り込めません';
    const cases: Array<[string, string[]]> = [
      ['想定外の引き金', ['CREATE TRIGGER evil_t AFTER UPDATE ON entries BEGIN SELECT 1; END']],
      ['ビュー', ['CREATE VIEW evil_v AS SELECT * FROM entries']],
      [
        '名前は同じで中身が違う引き金',
        [
          'DROP TRIGGER entries_fts_ai',
          'CREATE TRIGGER entries_fts_ai AFTER INSERT ON entries BEGIN SELECT 1; END',
        ],
      ],
    ];
    for (const [name, sqls] of cases) {
      const bad = await tamper(image, sqls);
      await expect(request({ op: 'readImageArchive', image: bad }), name).rejects.toThrow(refusal);
    }
  });
});

describe('大きい要素の base64 を小分けに復号する', () => {
  const rand = (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    // 決定的な擬似乱数(再現できる)
    let x = 123456789;
    for (let i = 0; i < n; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      out[i] = x & 0xff;
    }
    return out;
  };
  const same = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  async function bake(image: Uint8Array, asset: Uint8Array): Promise<string> {
    const out = await writePortableBundle({
      template: TEMPLATE,
      bundle: { id: 'pkcb-bigdecode01', exportedAt: 1 },
      image,
      assets: (async function* () {
        yield { key: 'ast-big', mime: 'application/octet-stream', blob: new Blob([asset as BlobPart]) };
      })(),
    });
    return out.blob.text();
  }

  it('🔴 割って焼いた画像(IMAGE_PART_BYTES を超える、3 要素)が 1 バイトも違わず戻る (#1416 §7-4)', async () => {
    const image = rand(IMAGE_PART_BYTES * 2 + 11);
    const html = await bake(image, rand(10));
    expect([...html.matchAll(/data-pkc-db-image="([^"]*)"/g)].map((m) => m[1])).toEqual(['0/3', '1/3', '2/3']);
    expect(same(readPortableHtml(html).image, image), '画像が違う').toBe(true);
  });

  it('🔴 割った要素が欠けた・順が乱れたファイルは、短い画像として読まず断る', async () => {
    const html = await bake(rand(IMAGE_PART_BYTES * 2 + 11), rand(10));
    const el = (i: number): RegExp => new RegExp(`<script [^>]*data-pkc-db-image="${i}/3">[^<]*</script>`);
    const missingMiddle = html.replace(el(1), '');
    expect(missingMiddle.length, '前提: 取り除けている').toBeLessThan(html.length);
    expect(() => readPortableHtml(missingMiddle)).toThrow(/番号が合いません/);
    const missingTail = html.replace(el(2), '');
    expect(missingTail.length, '前提: 取り除けている').toBeLessThan(html.length);
    expect(() => readPortableHtml(missingTail)).toThrow(/番号が合いません/);
    // 並べ替え: 0 と 1 を入れ替える
    const e0 = html.match(el(0))![0];
    const e1 = html.match(el(1))![0];
    const swapped = html.replace(e0, '@@A@@').replace(e1, e0).replace('@@A@@', e1);
    expect(swapped, '前提: 入れ替わっている').not.toBe(html);
    expect(() => readPortableHtml(swapped)).toThrow(/番号が合いません/);
  });

  it('🔴 途中の要素が短く切れたファイルは「何個目が欠けている」と断り、後ろをずらして読まない', async () => {
    const html = await bake(rand(IMAGE_PART_BYTES * 2 + 11), rand(10));
    const m = html.match(/(<script [^>]*data-pkc-db-image="1\/3">)([^<]*)(<\/script>)/)!;
    const cut = html.replace(m[0], m[1]! + m[2]!.slice(0, m[2]!.length - 4) + m[3]!);
    expect(cut.length, '前提: 縮んでいる').toBeLessThan(html.length);
    expect(() => readPortableHtml(cut)).toThrow(/2 個目が途中で欠けています/);
  });

  it('🔴 最後の要素が base64 でなくなったら、「中身が見つかりません」ではなく壊れた部分を言う', async () => {
    const html = await bake(rand(IMAGE_PART_BYTES + 11), rand(10));
    const m = html.match(/(<script [^>]*data-pkc-db-image="1\/2">)([^<]*)(<\/script>)/)!;
    const broken = html.replace(m[0], m[1]! + m[2]!.slice(0, 100) + '!!!!' + m[2]!.slice(100) + m[3]!);
    expect(broken, '前提: 書き換わっている').not.toBe(html);
    expect(() => readPortableHtml(broken)).toThrow(/DB の中身の一部が読み取れません.*2 個目/);
    expect(() => readPortableHtml(broken)).not.toThrow(/見つかりません/);
  });

  it('割る前の版が焼いた 1 本物(印の値が無い)も、今も読める', async () => {
    const image = rand(1000);
    const legacy = (await bake(image, rand(10))).replace(/data-pkc-db-image="0\/1"/, 'data-pkc-db-image');
    expect(legacy, '前提: 旧形に書き換わっている').toContain('data-pkc-db-image>');
    expect(same(readPortableHtml(legacy).image, image), '画像が違う').toBe(true);
  });

  it('🔴 小分けの単位(約 786 KB)を超える画像と添付(各 約 3 MiB)が、1 バイトも違わず戻る', async () => {
    const image = rand(3 * 1024 * 1024 + 1);
    const asset = rand(3 * 1024 * 1024 + 2);
    const html = await bake(image, asset);
    const got = readPortableHtml(html);
    expect(same(got.image, image), '画像が違う').toBe(true);
    const back = new Uint8Array(await got.assets.get('ast-big')!.arrayBuffer());
    expect(same(back, asset), '添付が違う').toBe(true);
  });

  it('改行・空白が混ざった base64 でも、同じ bytes に戻る', async () => {
    const image = rand(2 * 1024 * 1024 + 3);
    const asset = rand(2 * 1024 * 1024 + 5);
    const html = await bake(image, asset);
    // 要素の中身(base64)に、76 字ごとの改行と末尾の空白を混ぜる
    const spaced = html.replace(
      /(data-pkc-(?:db-image="[^"]*"|asset="ast-big"[^>]*)>)([A-Za-z0-9+/=]+)(<\/script>)/g,
      (_m, open: string, b64: string, close: string) =>
        open + b64.replace(/(.{76})/g, '$1\n') + ' \n' + close,
    );
    expect(spaced.length, '前提: 空白を混ぜられている').toBeGreaterThan(html.length);
    const got = readPortableHtml(spaced);
    expect(same(got.image, image), '画像が違う').toBe(true);
    expect(same(new Uint8Array(await got.assets.get('ast-big')!.arrayBuffer()), asset), '添付が違う').toBe(true);
  });

  describe('🔴 割って焼いた添付 (#1416 §7-4d)', () => {
    const asset3 = (html: string): RegExpMatchArray[] => [
      ...html.matchAll(/(<script [^>]*data-pkc-asset="ast-big"[^>]*>)([^<]*)(<\/script>)/g),
    ];

    it('3 要素(最後に端数)の添付が 1 バイトも違わず戻る', async () => {
      const asset = rand(IMAGE_PART_BYTES * 2 + 13);
      const html = await bake(rand(10), asset);
      expect(asset3(html), '前提: 3 要素に割れている').toHaveLength(3);
      const back = new Uint8Array(await readPortableHtml(html).assets.get('ast-big')!.arrayBuffer());
      expect(same(back, asset), '添付が違う').toBe(true);
    });

    it('ちょうど 2 × IMAGE_PART_BYTES の添付(端数なし。最後の要素に = が出ない)が 1 バイトも違わず戻る', async () => {
      const asset = rand(IMAGE_PART_BYTES * 2);
      const html = await bake(rand(10), asset);
      expect(asset3(html), '前提: 2 要素に割れている').toHaveLength(2);
      const back = new Uint8Array(await readPortableHtml(html).assets.get('ast-big')!.arrayBuffer());
      expect(back.length).toBe(asset.length);
      expect(same(back, asset), '添付が違う').toBe(true);
    });

    it('欠け・順の乱れ・途中の短い要素は、短い添付として読まず断る(key を名指し)', async () => {
      const html = await bake(rand(10), rand(IMAGE_PART_BYTES * 2 + 13));
      const els = asset3(html);
      const missing = html.replace(els[1]![0], '');
      expect(missing.length, '前提: 取り除けている').toBeLessThan(html.length);
      expect(() => readPortableHtml(missing)).toThrow(/添付「ast-big」.*番号が合いません/);
      const swapped = html.replace(els[0]![0], '@@A@@').replace(els[1]![0], els[0]![0]).replace('@@A@@', els[1]![0]);
      expect(swapped, '前提: 入れ替わっている').not.toBe(html);
      expect(() => readPortableHtml(swapped)).toThrow(/添付「ast-big」.*番号が合いません/);
      const body = els[1]![2]!;
      const cut = html.replace(els[1]![0], els[1]![1] + body.slice(0, body.length - 4) + els[1]![3]);
      expect(cut.length, '前提: 縮んでいる').toBeLessThan(html.length);
      expect(() => readPortableHtml(cut)).toThrow(/添付「ast-big」の中身の 2 個目が途中で欠けています/);
    });

    it('割った添付の一部が base64 でなくなったら、後ろの添付ごと黙って落とさず言う', async () => {
      const html = await bake(rand(10), rand(IMAGE_PART_BYTES + 13));
      const el = asset3(html)[1]!;
      const broken = html.replace(el[0], el[1] + el[2]!.slice(0, 8) + '!!!!' + el[2]!.slice(8) + el[3]);
      expect(broken, '前提: 書き換わっている').not.toBe(html);
      expect(() => readPortableHtml(broken)).toThrow(/添付「ast-big」の一部が読み取れません.*2 個目/);
    });

    it('割る前の版が焼いた 1 本物(印なしの大きい 1 要素)も、今も読める', async () => {
      const asset = rand(IMAGE_PART_BYTES * 2 + 13);
      const html = await bake(rand(10), asset);
      const els = asset3(html);
      // 3 要素の中身を 1 本に繋ぐ(途中の要素に = は出ないので、繋いでも正しい base64)
      const legacyOpen = els[0]![1]!.replace(/ data-pkc-asset-part="[^"]*"/, '');
      expect(legacyOpen, '前提: 印が外れている').not.toContain('data-pkc-asset-part');
      let legacy = html;
      els.forEach((e, i) => {
        legacy = legacy.replace(e[0], i === 0 ? legacyOpen + els.map((x) => x[2]).join('') + e[3] : '');
      });
      expect(asset3(legacy), '前提: 1 要素になっている').toHaveLength(1);
      const back = new Uint8Array(await readPortableHtml(legacy).assets.get('ast-big')!.arrayBuffer());
      expect(same(back, asset), '添付が違う').toBe(true);
    });

    it('同じ key が 2 度入っていたら、文書の後ろのものが残る(割る前の版と同じ)', async () => {
      const first = rand(IMAGE_PART_BYTES + 3);
      const second = rand(IMAGE_PART_BYTES + 9);
      const a = await bake(rand(10), first);
      const b = await bake(rand(10), second);
      // b の添付の要素(2 個)を a の添付の要素の直後へ移す
      const grab = (h: string): string => asset3(h).map((m) => m[0]).join('');
      const dup = a.replace(grab(a), grab(a) + grab(b));
      expect(asset3(dup), '前提: 4 要素になっている').toHaveLength(4);
      const back = new Uint8Array(await readPortableHtml(dup).assets.get('ast-big')!.arrayBuffer());
      expect(same(back, second), '後ろの添付が残っていない').toBe(true);
    });

    it('改行・空白が混ざった割った添付でも戻る / 0 バイトの添付は空のまま戻る', async () => {
      const asset = rand(IMAGE_PART_BYTES + 5);
      const html = await bake(rand(10), asset);
      const spaced = html.replace(
        /(data-pkc-asset="ast-big"[^>]*>)([A-Za-z0-9+/=]+)(<\/script>)/g,
        (_m, open: string, b64: string, close: string) => open + b64.replace(/(.{76})/g, '$1\n') + ' \n' + close,
      );
      expect(spaced.length, '前提: 空白を混ぜられている').toBeGreaterThan(html.length);
      const back = new Uint8Array(await readPortableHtml(spaced).assets.get('ast-big')!.arrayBuffer());
      expect(same(back, asset), '添付が違う').toBe(true);
      const empty = readPortableHtml(await bake(rand(10), new Uint8Array(0))).assets.get('ast-big');
      expect(empty, '0 バイトの添付が消えた').toBeDefined();
      expect(empty!.size).toBe(0);
    });
  });
});
