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
import {
  openPortableHtmlBlob,
  readPortableHtml,
  readPortableHtmlBlob,
  WINDOW_CHARS,
  sniffPortableHtml,
} from '../../src/features/import/portable-html';

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

/** 読んだ範囲(`slice` の [from, to))を控える File ── 「どこを、いつ読んだか」を見る。 */
class SliceLog extends File {
  readonly reads: Array<[number, number]> = [];
  override slice(start?: number, end?: number, type?: string): Blob {
    this.reads.push([start ?? 0, end ?? this.size]);
    return super.slice(start, end, type);
  }
}

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

  it('🔴 添付の中身は確認の窓の後に読む ── やめれば添付の範囲は 1 度も読まれず、進めれば取り込みの中で 1 度だけ読まれる', async () => {
    const { html } = shared;
    // 添付の中身(base64)の範囲 = 差し込まれた添付の要素の中身
    const open = html.indexOf('data-pkc-asset="' + ASSET_KEY + '"');
    const from = html.indexOf('>', open) + 1;
    const to = html.indexOf('</script>', from);
    expect(open, '前提: 添付の要素が見つかる').toBeGreaterThan(0);
    // ⚠ 文字数 = bytes 数(差し込み領域は ASCII)── 雛形の日本語は添付の前に無い
    expect(new TextEncoder().encode(html.slice(0, from)).length, '前提: 位置が bytes と一致する').toBe(from);
    const readsOfAsset = (f: SliceLog): number =>
      f.reads.filter(([a, b]) => a === from && b === to).length;

    // やめる
    const cancel = new SliceLog([html], 'cancel.pkc3.html');
    let askedWith = -1;
    const c = deps({
      confirmArchiveImport: async (p) => {
        askedWith = p.assetCount;
        expect(readsOfAsset(cancel), '確認の前に添付の中身を読んだ').toBe(0);
        return false;
      },
    });
    expect(await importPkc2File(c.d, c.deps, cancel)).toBeNull();
    expect(askedWith, '確認には添付の件数が出る').toBe(1);
    expect(readsOfAsset(cancel), 'やめたのに添付の中身を読んだ').toBe(0);
    expect(c.seen.blobs.size).toBe(0);
    expect(c.seen.errors, 'やめるのは失敗ではない').toEqual([]);

    // 対照群: 進めれば、確認の後に添付の中身を 1 度だけ読んで保存する
    const go = new SliceLog([html], 'go.pkc3.html');
    const g = deps({
      confirmArchiveImport: async () => {
        expect(readsOfAsset(go), '確認の前に添付の中身を読んだ').toBe(0);
        return true;
      },
    });
    await importPkc2File(g.d, g.deps, go);
    expect(readsOfAsset(go), '進めたのに添付の中身を読んでいない / 2 度読んだ').toBe(1);
    expect(g.seen.blobs.size).toBe(1);
    expect([...new Uint8Array(await [...g.seen.blobs.values()][0]!.arrayBuffer())]).toEqual([...ASSET_BYTES]);
  });

  describe('🔴 ハッシュを取る上限(HASH_MAX_BYTES = 64MB)を超える添付も、遅延の在り処から入る (#1416)', () => {
    // ⚠ 64MB の fixture は unit では作らない ── `hashMaxBytes` の口を添付(8 バイト)より下げて、
    //   本物と同じ分岐(`import-pkc2.ts` の「閾値超は heap に載せず putBlob に Blob を直に渡す」)を踏む。
    //   既存の閾値超の test(`import-pkc2.test.ts`)は zip の在り処と Blob の在り処しか通らず、
    //   PKC3 入り HTML の遅延の在り処(`open` を呼んで初めて Blob になる)は 1 度も通っていなかった。
    const range = (html: string): { from: number; to: number } => {
      const open = html.indexOf('data-pkc-asset="' + ASSET_KEY + '"');
      const from = html.indexOf('>', open) + 1;
      const to = html.indexOf('</script>', from);
      expect(open, '前提: 添付の要素が見つかる').toBeGreaterThan(0);
      return { from, to };
    };
    const HASHED = /^ast-[0-9a-f]{64}$/;

    async function runWith(hashMaxBytes: number | undefined) {
      const { html } = shared;
      const { from, to } = range(html);
      const file = new SliceLog([html], 'over.pkc3.html');
      const metas: Array<{ key: string; mime: string; size: number; hash: string | null }> = [];
      const reported: string[] = [];
      const r = deps({
        ...(hashMaxBytes === undefined ? {} : { hashMaxBytes }),
        putAssetMeta: async (m) => {
          metas.push({ key: m.key, mime: m.mime ?? '', size: m.size, hash: m.hash ?? null });
        },
        report: (notes) => reported.push(...notes),
      });
      await importPkc2File(r.d, r.deps, file);
      return {
        seen: r.seen,
        metas,
        reported,
        assetReads: file.reads.filter(([a, b]) => a === from && b === to).length,
      };
    }

    it('閾値を超えると、採番 key・hash なしで入る。中身は 1 バイトも違わず、添付の範囲は 1 度だけ読む', async () => {
      const o = await runWith(ASSET_BYTES.length - 1);

      expect(o.seen.errors, '取り込みが失敗した').toEqual([]);
      expect(o.seen.blobs.size).toBe(1);
      const [key, blob] = [...o.seen.blobs.entries()][0]!;
      // 🔑 content key(SHA-256)ではなく採番 key ── 重複排除の対象外の印
      expect(key, '閾値超なのに content key で入った').not.toMatch(HASHED);
      expect(key).toMatch(/^ast-/);
      expect([...new Uint8Array(await blob.arrayBuffer())], '中身が違う').toEqual([...ASSET_BYTES]);
      expect(o.metas).toEqual([
        { key, mime: 'application/octet-stream', size: ASSET_BYTES.length, hash: null },
      ]);
      // 読むのは 1 度だけ(閾値超の道が「大きさを測るために開く」を足していない)
      expect(o.assetReads, '添付の範囲を 0 回 / 2 回以上読んだ').toBe(1);
      // 参照は採番 key へ写っている(本文の asset: が元の key のまま残っていない)
      const n3 = o.seen.entries.find((e) => e.body.includes('asset:'))!;
      expect(n3.body).toContain('asset:' + key);
      expect(n3.body).not.toContain(ASSET_KEY);
      // 「まとめる対象から外した」は注意として user に届く(黙って外さない)
      // 🔴 どの添付かは**ノートの題名**で言う。内部の key は出さない(#1087)
      const note = o.reported.find((n) => n.includes('同じ添付をまとめる対象から外しました'));
      expect(note, '注意が届いていない').toBeDefined();
      expect(note, 'どのノートの添付か言っていない').toContain(`「${n3.title}」の添付`);
      expect(note, '内部の key が出ている').not.toContain(ASSET_KEY);
    });

    it('対照群: 閾値ちょうど(以下)・既定の閾値では、content key + hash で入り、注意は出ない', async () => {
      const exact = await runWith(ASSET_BYTES.length);
      const dflt = await runWith(undefined);
      for (const [name, o] of [['ちょうど', exact], ['既定', dflt]] as const) {
        expect(o.seen.blobs.size, name).toBe(1);
        const [key] = [...o.seen.blobs.keys()];
        expect(key, `${name}: 閾値以下なのに採番 key で入った`).toMatch(HASHED);
        expect(o.metas, name).toEqual([
          { key, mime: 'application/octet-stream', size: ASSET_BYTES.length, hash: key!.slice('ast-'.length) },
        ]);
        expect(o.reported.some((n) => n.includes('同じ添付をまとめる対象から外しました')), name).toBe(false);
        expect(o.assetReads, name).toBe(1);
      }
    });
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

  /**
   * 🔴 **窓で読む読み方(`readPortableHtmlBlob`)は、全文を字にして読む読み方と同じ結果を返す**(#1416 の残件)。
   *
   * 取り込みの道は `file.text()`(全文を UTF-16 に復号 = 実測でファイルの約 4.5 倍の常駐)をやめて窓で読む。
   * 両者は `scanStep` / `decodeAssetRun` / `decodeImage` を共有するが、**窓の継ぎ目・位置の数え方**だけが別なので、
   * 「同じファイルに同じ答え(取り出す物も、断り文も)」を見る。
   */
  describe('🔴 窓で読む読み方が、全文で読む読み方と同じ答えを返す', () => {
    const WINDOW = WINDOW_CHARS;

    /** 日本語を含む雛形(UTF-8 の多バイト字が差し込み領域の前に在っても、位置がずれない)。 */
    const JP_TEMPLATE = TEMPLATE.replace(
      '<div data-pkc-slot="root"></div>',
      '<div data-pkc-slot="root">ノートを読み込んでいます…</div><script>var m="日本語の文字列 ✓";</script>',
    );

    async function bakeMany(
      template: string,
      image: Uint8Array,
      assets: ReadonlyArray<{ key: string; bytes: Uint8Array }>,
    ): Promise<string> {
      const out = await writePortableBundle({
        template,
        bundle: { id: 'pkcb-bigdecode01', exportedAt: 1 },
        image,
        assets: (async function* () {
          for (const a of assets)
            yield { key: a.key, mime: 'application/octet-stream', blob: new Blob([a.bytes as BlobPart]) };
        })(),
      });
      return out.blob.text();
    }

    /** bytes の指紋(長さ + FNV-1a)。⚠ 数百万要素の配列を `toEqual` に渡すと、食い違った回の差分の描画で終わらなくなる。 */
    const digest = (b: Uint8Array): string => {
      let h = 0x811c9dc5;
      for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193) >>> 0;
      return `${b.length}:${h.toString(16)}`;
    };

    type Outcome =
      | { ok: true; image: string; assets: Array<[string, string]> }
      | { ok: false; message: string };

    async function outcome(read: () => Promise<ReturnType<typeof readPortableHtml>>): Promise<Outcome> {
      try {
        const p = await read();
        const assets: Array<[string, string]> = [];
        for (const [k, b] of p.assets) assets.push([k, digest(new Uint8Array(await b.arrayBuffer()))]);
        return { ok: true, image: digest(p.image), assets };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    }

    /** 同じ html に、2 つの読み方が同じ答えを返す。返った答えを返す(呼び側が「期待した形か」を見る)。 */
    async function bothAgree(html: string): Promise<Outcome> {
      const whole = await outcome(async () => readPortableHtml(html));
      const windowed = await outcome(() => readPortableHtmlBlob(new Blob([html])));
      expect(windowed, '窓で読む読み方と全文で読む読み方の答えが違う').toEqual(whole);
      return whole;
    }

    it('🔴 窓(8 MiB)を何度もまたぐ大きさ(添付 5 件 + 画像)が、全文と同じ bytes で戻る', async () => {
      const assets = [0, 1, 2, 3, 4].map((i) => ({ key: `ast-${i}`, bytes: rand(IMAGE_PART_BYTES + 100 + i) }));
      const html = await bakeMany(JP_TEMPLATE, rand(IMAGE_PART_BYTES + 7), assets);
      // 前提: 差し込み領域が窓より大きい(= 窓の継ぎ目を本当にまたぐ)
      expect(html.length, '前提: 窓を 2 つ以上またぐ大きさ').toBeGreaterThan(WINDOW * 2);
      const got = await readPortableHtmlBlob(new Blob([html]));
      expect([...got.assets.keys()].sort()).toEqual(assets.map((a) => a.key));
      for (const a of assets) {
        const back = new Uint8Array(await got.assets.get(a.key)!.arrayBuffer());
        expect(same(back, a.bytes), `${a.key} の中身が違う`).toBe(true);
      }
      const o = await bothAgree(html);
      expect(o.ok, '前提: 読めている').toBe(true);
    }, 60_000);

    it('🔴 窓より大きい 1 要素(割る前の版の 1 本物)も、窓を広げて読める', async () => {
      const asset = rand(Math.floor(WINDOW * 0.8)); // base64 で窓の約 1.07 倍
      const html = await bake(rand(10), asset);
      const els = [...html.matchAll(/(<script [^>]*data-pkc-asset="ast-big"[^>]*>)([^<]*)(<\/script>)/g)];
      const legacyOpen = els[0]![1]!.replace(/ data-pkc-asset-part="[^"]*"/, '');
      let legacy = html;
      els.forEach((e, i) => {
        legacy = legacy.replace(e[0], i === 0 ? legacyOpen + els.map((x) => x[2]).join('') + e[3] : '');
      });
      expect(els.length, '前提: 割ってある').toBeGreaterThan(1);
      expect(legacy.match(/data-pkc-asset="ast-big"/g), '前提: 1 要素になっている').toHaveLength(1);
      expect(legacy.length, '前提: 1 要素が窓より大きい').toBeGreaterThan(WINDOW);
      const back = new Uint8Array(
        await (await readPortableHtmlBlob(new Blob([legacy]))).assets.get('ast-big')!.arrayBuffer(),
      );
      expect(same(back, asset), '添付が違う').toBe(true);
    });

    it('🔴 壊れたファイルは、全文で読む読み方と同じ断り文で断る(欠け・順の乱れ・途中の短い要素・base64 でない・同じ key の二重)', async () => {
      const html = await bake(rand(IMAGE_PART_BYTES * 2 + 11), rand(IMAGE_PART_BYTES * 2 + 13));
      const img = (i: number): RegExp => new RegExp(`<script [^>]*data-pkc-db-image="${i}/3">[^<]*</script>`);
      const ast = [...html.matchAll(/(<script [^>]*data-pkc-asset="ast-big"[^>]*>)([^<]*)(<\/script>)/g)];
      const cases: Array<[string, string, RegExp]> = [
        ['画像の中が欠け', html.replace(img(1), ''), /番号が合いません/],
        ['添付の中が欠け', html.replace(ast[1]![0], ''), /添付「ast-big」.*番号が合いません/],
        [
          '画像の途中が短い',
          html.replace(
            html.match(/(<script [^>]*data-pkc-db-image="1\/3">)([^<]*)(<\/script>)/)![0],
            (m) => m.replace(/(.{4})<\/script>$/, '</script>'),
          ),
          /2 個目が途中で欠けています/,
        ],
        [
          '添付が base64 でない',
          html.replace(ast[1]![0], ast[1]![1] + ast[1]![2]!.slice(0, 8) + '!!!!' + ast[1]![2]!.slice(8) + ast[1]![3]),
          /添付「ast-big」の一部が読み取れません/,
        ],
        ['終わりの </body> が無い', html.replace(/<\/body>(?![\s\S]*<\/body>)/, ''), /最後まで書き込まれていません/],
        ['印が無い', html.replace('data-pkc-bundle', 'data-x'), /PKC3 入り HTML ではありません/],
      ];
      for (const [name, broken, expected] of cases) {
        expect(broken, `前提(${name}): 書き換わっている`).not.toBe(html);
        const o = await bothAgree(broken);
        expect(o.ok, `${name}: 読めてしまった`).toBe(false);
        expect(o.ok ? '' : o.message, name).toMatch(expected);
      }
    });

    it('🔴 最後の </body> が窓の継ぎ目にまたがっていても見つかる(後ろに窓 1 つぶんの余白が続くファイル)', async () => {
      const asset = rand(1000);
      const html = await bake(rand(10), asset);
      const at = html.lastIndexOf('</body>');
      // </body> が、末尾の窓の手前 3 字から始まる位置に来る余白(窓の継ぎ目を 7 字のうち 3 字がまたぐ)
      const tail = html.length - at - '</body>'.length;
      const padded = html.slice(0, at + '</body>'.length) + ' '.repeat(WINDOW - 4 - tail) + html.slice(at + '</body>'.length);
      expect(padded.length - padded.lastIndexOf('</body>'), '前提: 継ぎ目をまたぐ位置にある').toBe(WINDOW + 3);
      const back = new Uint8Array(
        await (await readPortableHtmlBlob(new Blob([padded]))).assets.get('ast-big')!.arrayBuffer(),
      );
      expect(same(back, asset), '添付が違う').toBe(true);
    });

    /**
     * 🔴 **復号を確認の後まで遅らせても、壊れ方の判定は遅らせない**(#1416)。
     * 窓で読む方は、辿りの間に base64 の形(字数・`=` の位置)だけを測り、復号が断る形を**その場で**同じ文で断る。
     * ここは「復号が `atob` で落ちる形」を全文で読む方(= 復号する方)と突き合わせる ── 断り文も、断る順番も、通る形の bytes も同じ。
     */
    describe('壊れた base64 の形は、復号を遅らせても同じ所で同じ文で断る', () => {
      const astEls = (html: string): RegExpMatchArray[] => [
        ...html.matchAll(/(<script [^>]*data-pkc-asset="ast-big"[^>]*>)([^<]*)(<\/script>)/g),
      ];
      const withBody = (html: string, nth: number, edit: (b64: string) => string): string => {
        const e = astEls(html)[nth]!;
        const out = html.replace(e[0], e[1] + edit(e[2]!) + e[3]);
        expect(out, '前提: 書き換わっている').not.toBe(html);
        return out;
      };
      const GENERIC = /埋め込まれた添付が読み取れない形になっています: ast-big/;

      it('🔴 atob が断る形(途中の `=` / 字数 / 末尾の `=` の位置)と、通ってしまう形(途中の要素の末尾の `=`)', { timeout: 120_000 }, async () => {
        const html = await bake(rand(10), rand(IMAGE_PART_BYTES * 2 + 13));
        expect(astEls(html), '前提: 3 要素').toHaveLength(3);
        const cases: Array<[string, string, RegExp | null]> = [
          ['途中の要素の中ほどに =', withBody(html, 0, (b) => b.slice(0, 100) + '=' + b.slice(101)), GENERIC],
          ['途中の要素の中ほどに ==(字数は合う)', withBody(html, 1, (b) => b.slice(0, 100) + '==' + b.slice(102)), GENERIC],
          // 🔑 通ってしまう形: 字数がちょうどで、末尾が = ── 全文で読む方は短く復号して残りを 0 のままにする。同じ bytes を返す
          ['途中の要素の末尾が =(通る)', withBody(html, 0, (b) => b.slice(0, -1) + '='), null],
          ['最後の要素が 1 字足りない(字数が 4 の倍数でない)', withBody(html, 2, (b) => b.slice(0, -1)), GENERIC],
          ['最後の要素の中ほどに =', withBody(html, 2, (b) => b.slice(0, 4) + '=' + b.slice(5)), GENERIC],
          ['最後の要素が ==== で終わる', withBody(html, 2, (b) => b.slice(0, -4) + '===='), GENERIC],
          ['最後の要素が空', withBody(html, 2, () => ''), /空の部分/],
          ['途中の要素が空白だけ', withBody(html, 1, () => '  \n '), /2 個目が途中で欠けています/],
          ['最後の要素が空白だけ', withBody(html, 2, () => ' \n'), /空の部分/],
        ];
        for (const [name, broken, expected] of cases) {
          const o = await bothAgree(broken);
          if (expected === null) expect(o.ok, `${name}: 通る形が断られた`).toBe(true);
          else {
            expect(o.ok, `${name}: 読めてしまった`).toBe(false);
            expect(o.ok ? '' : o.message, name).toMatch(expected);
          }
        }
      });

      it('1 要素だけの添付(割る前の版)の壊れ方も同じ: 字数が合わない / 末尾の = の位置 / 空', async () => {
        const html = await bake(rand(10), rand(100));
        expect(astEls(html), '前提: 1 要素').toHaveLength(1);
        for (const [name, broken, expected] of [
          ['字数が合わない', withBody(html, 0, (b) => b.slice(0, -1)), GENERIC],
          ['中ほどに =', withBody(html, 0, (b) => b.slice(0, 8) + '=' + b.slice(9)), GENERIC],
        ] as const) {
          const o = await bothAgree(broken);
          expect(o.ok, `${name}: 読めてしまった`).toBe(false);
          expect(o.ok ? '' : o.message, name).toMatch(expected);
        }
        // 空の 1 要素 = 0 バイトの添付(どちらの読み方も同じ)
        const o = await bothAgree(withBody(html, 0, () => ''));
        expect(o.ok && o.assets).toEqual([['ast-big', digest(new Uint8Array(0))]]);
      });

      it('改行・空白が混ざった添付 / 画像は、窓で読んでも同じ bytes(字数は空白を除いて測る)', async () => {
        const asset = rand(IMAGE_PART_BYTES + 5);
        const image = rand(IMAGE_PART_BYTES + 9);
        const html = await bake(image, asset);
        const spaced = html.replace(
          /(data-pkc-(?:db-image="[^"]*"|asset="ast-big"[^>]*)>)([A-Za-z0-9+/=]+)(<\/script>)/g,
          (_m, open: string, b64: string, close: string) =>
            open + b64.replace(/(.{76})/g, '$1\n') + ' \n' + close,
        );
        expect(spaced.length, '前提: 空白を混ぜられている').toBeGreaterThan(html.length);
        const o = await bothAgree(spaced);
        expect(o.ok, '前提: 読めている').toBe(true);
        const got = await readPortableHtmlBlob(new Blob([spaced]));
        expect(same(got.image, image), '画像').toBe(true);
        expect(same(new Uint8Array(await got.assets.get('ast-big')!.arrayBuffer()), asset), '添付').toBe(true);
      }, 60_000);

      it('空白の集合は字で読む方と同じ(latin1 の NBSP・VT は空白、NEL は空白でない)', async () => {
        const html = await bake(rand(10), rand(300));
        const at = html.indexOf('data-pkc-asset="ast-big"');
        const bodyAt = html.indexOf('>', at) + 1;
        const enc = new TextEncoder();
        const withByte = (b: number): Uint8Array => {
          const head = enc.encode(html.slice(0, bodyAt + 8));
          const tail = enc.encode(html.slice(bodyAt + 8));
          const out = new Uint8Array(head.length + 1 + tail.length);
          out.set(head, 0);
          out[head.length] = b;
          out.set(tail, head.length + 1);
          return out;
        };
        // 字で読む方の入力は、窓で読む方と同じ見方(latin1)で字にしたもの
        for (const [name, b, spaceLike] of [
          ['NBSP(0xA0)', 0xa0, true],
          ['NEL(0x85)', 0x85, false],
          ['VT(0x0B)', 0x0b, true],
        ] as const) {
          const bytes = withByte(b);
          const whole = await outcome(async () => readPortableHtml(new TextDecoder('latin1').decode(bytes)));
          const windowed = await outcome(() => readPortableHtmlBlob(new Blob([bytes as BlobPart])));
          expect(windowed, `${name}: 字で読む方と答えが違う`).toEqual(whole);
          expect(whole.ok, `${name}: 空白として読めるか`).toBe(spaceLike);
        }
      });

      it('断る順番も同じ: 後ろの塊の壊れが先、画像の壊れは添付の後(2 つ壊れていれば、全文で読む方と同じ方の文が出る)', async () => {
        const html = await bake(rand(IMAGE_PART_BYTES + 11), rand(IMAGE_PART_BYTES + 13));
        const brokenAsset = withBody(html, 0, (b) => b.slice(0, 100) + '=' + b.slice(101));
        const m = brokenAsset.match(/(<script [^>]*data-pkc-db-image="1\/2">)([^<]*)(<\/script>)/)!;
        const both = brokenAsset.replace(m[0], m[1]! + m[2]!.slice(0, -4) + m[3]!);
        expect(both, '前提: 画像も壊れている').not.toBe(brokenAsset);
        const o = await bothAgree(both);
        expect(o.ok).toBe(false);
        // 添付が先(全文で読む方が添付を先に復号する)
        expect(o.ok ? '' : o.message).toMatch(GENERIC);
      });
    });

    describe('🔴 添付は開くまで復号しない / 開いたら 1 バイトも違わない', () => {
      it('目録は読まずに大きさが分かり、開いた Blob は全文で読む方と同じ bytes・同じ型', async () => {
        const assets = [
          { key: 'ast-0', bytes: rand(IMAGE_PART_BYTES * 2 + 13) }, // 3 要素(端数)
          { key: 'ast-1', bytes: rand(IMAGE_PART_BYTES * 2) }, // ちょうど 2 要素(端数なし)
          { key: 'ast-2', bytes: rand(7) }, // 1 要素
          { key: 'ast-3', bytes: new Uint8Array(0) }, // 0 バイト
        ];
        const html = await bakeMany(JP_TEMPLATE, rand(IMAGE_PART_BYTES + 5), assets);
        const lazy = await openPortableHtmlBlob(new Blob([html]));
        const whole = readPortableHtml(html);
        expect([...lazy.assets.keys()].sort()).toEqual(assets.map((a) => a.key));
        for (const a of assets) {
          const l = lazy.assets.get(a.key)!;
          expect(l.size, `${a.key}: 大きさ`).toBe(a.bytes.length);
          const blob = await l.open();
          expect(blob.size).toBe(a.bytes.length);
          expect(blob.type).toBe(whole.assets.get(a.key)!.type);
          expect(same(new Uint8Array(await blob.arrayBuffer()), a.bytes), `${a.key}: 中身`).toBe(true);
          // 開き直しても同じ(呼ぶたびに作り直す)
          expect(same(new Uint8Array(await (await l.open()).arrayBuffer()), a.bytes), `${a.key}: 2 回目`).toBe(true);
        }
        expect(same(lazy.image, whole.image), '画像').toBe(true);
      }, 60_000);

      it('🔴 開くまで添付の範囲を読まない ── 開いた分だけ、要素ごとに 1 度ずつ読む', async () => {
        const html = await bake(rand(10), rand(IMAGE_PART_BYTES * 2 + 5));
        const els = [...html.matchAll(/<script [^>]*data-pkc-asset="ast-big"[^>]*>([^<]*)<\/script>/g)];
        expect(els, '前提: 3 要素').toHaveLength(3);
        const ranges = els.map((m) => {
          const from = m.index! + m[0].indexOf('>') + 1;
          return [from, from + m[1]!.length] as [number, number];
        });
        const f = new SliceLog([html], 'x.pkc3.html');
        const lazy = await openPortableHtmlBlob(f);
        const hit = (): number => ranges.filter(([a, b]) => f.reads.some(([x, y]) => x === a && y === b)).length;
        expect(hit(), '目録を作っただけで添付の中身を読んだ').toBe(0);
        await lazy.assets.get('ast-big')!.open();
        expect(hit(), '開いたら 3 要素とも読む').toBe(3);
      });
    });

    it('同じ key が 2 度入っていたら、窓で読んでも文書の後ろのものが残る', async () => {
      const first = rand(IMAGE_PART_BYTES + 3);
      const second = rand(IMAGE_PART_BYTES + 9);
      const a = await bake(rand(10), first);
      const b = await bake(rand(10), second);
      const grab = (h: string): string =>
        [...h.matchAll(/(<script [^>]*data-pkc-asset="ast-big"[^>]*>)([^<]*)(<\/script>)/g)].map((m) => m[0]).join('');
      const dup = a.replace(grab(a), grab(a) + grab(b));
      const o = await bothAgree(dup);
      expect(o.ok).toBe(true);
      const back = new Uint8Array(
        await (await readPortableHtmlBlob(new Blob([dup]))).assets.get('ast-big')!.arrayBuffer(),
      );
      expect(same(back, second), '後ろの添付が残っていない').toBe(true);
    });
  });
});
