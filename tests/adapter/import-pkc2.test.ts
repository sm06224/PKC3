/** @vitest-environment happy-dom */
/**
 * PKC2 取込の**実行部** unit(判別 → 抽出 → 変換 → 書込 → 再読込)。
 * P6b(単一 HTML)と P6c 段②(.pkc2.zip)の**両経路**を同じ網で見る ──
 * 入力の違いは「container をどう得るか」「bytes をどこから取るか」だけで、
 * それ以降は 1 本に合流するという設計そのものが検証対象。
 *
 * 網の狙いは 2 つ:
 * ① 取り込めたものが**実際に state へ現れる**こと(変換 core の unit だけでは
 *    「書いたつもり」を検出できない)
 * ② 取り込めない入力で**書込が 1 件も起きない**こと(半端に書いてから失敗する
 *    経路を作らない ── PKC2 で実際にデータを壊した形)
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { importPkc2File, type ImportDeps } from '../../src/adapter/ui/actions/import-pkc2';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import type { RevisionChain } from '../../src/features/import/pkc2-convert';
import { readAttachmentMeta } from '../../src/features/flavor/attachment-flavor';
import { buildZip, bytesOf } from '../features/zip-fixture';

/** PKC2 の export と同じ骨格(slot id と `<\/script` 退避)。 */
function pkc2Html(payload: unknown): string {
  const data = JSON.stringify(payload).replace(/<\/script>/gi, '<\\/script>');
  return `<!doctype html><html><head>
    <script id="pkc-meta" type="application/json">{"app":"pkc2","schema":1}</script>
  </head><body>
    <script id="pkc-data" type="application/json">${data}</script>
  </body></html>`;
}

function htmlFile(payload: unknown, name = 'container.html'): File {
  return new File([pkc2Html(payload)], name, { type: 'text/html' });
}

async function gzipBase64(text: string): Promise<string> {
  const gz = new Blob([new TextEncoder().encode(text)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(gz).arrayBuffer());
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const base64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

interface HarnessOptions {
  /** 既存 lid(ゴミ箱 lid を含む ── 実配線は revisions からも集める)。 */
  existingLids?: Set<string>;
  orderBase?: number;
  /** relations の書込を失敗させる(entries を書いた**後**で落ちる経路の再現)。 */
  failRelations?: boolean;
  /** bulkUpsertEntries が呼ばれた瞬間に走る副作用(取込中の user 操作の再現)。 */
  onBulkEntries?(d: Dispatcher): void;
  /** 履歴の書込を失敗させる(段の取り違えを検出する)。 */
  failRevisions?: boolean;
}

function harness(opts: HarnessOptions = {}) {
  const written: EntryUpsert[] = [];
  const relations: Array<{ id: string; fromLid: string; toLid: string; kind: string }> = [];
  const blobs = new Map<string, Blob>();
  // ⚠ **hash まで記録する**(review M-1)── 捨てていたせいで「content key を
  // 使っているか / 巨大 asset だけ採番 key に落ちるか」を観測できず、
  // HASH_MAX_BYTES 分岐を削っても反転させても 405 test 全部が通っていた
  const metas: Array<{ key: string; mime: string; size: number; hash: string | null }> = [];
  const notices: string[] = [];
  // ⚠ **注意の全件**はこちらに来る(review H-2)── notify の 1 行には件数しか
  // 載らない。notes[0] だけを見る test は「2 件目以降が消えている」を検知できない
  let reported: readonly string[] = [];
  // 🔑 **書込の順序**そのものを記録する ── 「bytes を先に、参照を後に」は
  // この commit の規約 1 番なのに、順序を反転しても全 test が通っていた
  // (review mutation M25)。別配列に積むだけでは順序が pin されない
  const opLog: string[] = [];
  const revChains: RevisionChain[] = [];
  let reloads = 0;
  let n = 0;

  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });

  const deps: ImportDeps = {
    existingLids: async () =>
      new Set([...d.getState().entryMetas.keys(), ...(opts.existingLids ?? [])]),
    existingRelationIds: () => new Set(d.getState().relations.map((r) => r.id)),
    orderBase: () => opts.orderBase ?? 0,
    genLid: () => `gen-lid-${++n}`,
    genAssetKey: () => `ast-gen-${++n}`,
    genRelationId: () => `rel-gen-${++n}`,
    bulkUpsertEntries: async (entries) => {
      opLog.push('entries');
      opts.onBulkEntries?.(d);
      written.push(...entries);
    },
    bulkUpsertRelations: async (rels) => {
      opLog.push('relations');
      if (opts.failRelations) throw new Error('relations の書込に失敗(注入)');
      relations.push(...rels);
    },
    listStoredBlobKeys: async () => new Set(blobs.keys()),
    importRevisionChains: async (chains) => {
      if (opts.failRevisions) throw new Error('履歴の書込に失敗(注入)');
      // 実配線と同じく、送られた鎖は呼び出し側が手放す ── 記録は deep copy で
      revChains.push(
        ...chains.map((c) => ({ entryLid: c.entryLid, snapshots: c.snapshots.map((s) => ({ ...s })) })),
      );
      return {
        added: chains.reduce((n, c) => n + c.snapshots.length, 0),
        skippedNoChange: 0,
        droppedOverLimit: 0,
        skippedEntries: [],
      };
    },
    putBlob: async (key, blob) => {
      opLog.push(`blob:${key}`);
      blobs.set(key, blob);
    },
    putAssetMeta: async (m) => {
      opLog.push(`meta:${m.key}`);
      metas.push({ key: m.key, mime: m.mime, size: m.size, hash: m.hash });
    },
    // 実配線と同じく「書けたものを読み直して SYS_BOOTED」── 取込結果が
    // state に現れることまでを 1 本の網で見る
    reload: async () => {
      reloads++;
      // 実配線と同じく editing 中は state を差し替えない(H-4 の門)
      if (d.getState().phase !== 'ready') {
        d.dispatch({
          type: 'OP_FAILED',
          error: '取込は完了しました。編集を終了すると一覧に反映されます',
        });
        return;
      }
      d.dispatch({
        type: 'SYS_BOOTED',
        cid: 'c1',
        metas: written.map((e) => ({
          lid: e.lid,
          title: e.title,
          archetype: e.archetype,
          entryOrder: e.entryOrder,
          status: e.status ?? null,
          date: e.date ?? null,
          archived: e.archived ?? false,
          createdAt: null,
          updatedAt: null,
        })),
        relations: relations.map((r) => ({
          id: r.id,
          fromLid: r.fromLid,
          toLid: r.toLid,
          kind: r.kind,
          createdAt: null,
          updatedAt: null,
        })),
      });
    },
    notify: (m) => notices.push(m),
    report: (n) => { reported = n; },
  };
  return {
    d,
    deps,
    written,
    relations,
    blobs,
    metas,
    notices,
    reportedNotes: () => reported,
    opLog,
    revChains,
    reloadCount: () => reloads,
  };
}

describe('importPkc2File (P6b 実行部)', () => {
  it('HTML full export: entries / relations が書かれ、state に現れる', async () => {
    const { d, deps, written, relations, reloadCount } = harness();
    const file = htmlFile({
      container: {
        meta: { entry_order: ['b', 'a'] },
        entries: [
          { lid: 'a', title: 'ノート', archetype: 'text', body: '# 本文\n' },
          {
            lid: 'b',
            title: 'やること',
            archetype: 'todo',
            body: JSON.stringify({ status: 'done', description: '買い物', date: '2026-08-01' }),
          },
          // system entry は取り込まない(PKC2 の内部 entry を持ち込まない)
          { lid: '__settings__', title: 'x', archetype: 'system-settings', body: '{}' },
        ],
        relations: [{ id: 'r1', from: 'a', to: 'b', kind: 'structural' }],
      },
      export_meta: { mode: 'full', asset_encoding: 'base64' },
    });

    const count = await importPkc2File(d, deps, file);

    expect(count).toBe(2);
    expect(written.map((e) => e.lid)).toEqual(['b', 'a']); // meta.entry_order 優先
    expect(written.map((e) => e.entryOrder)).toEqual([1, 2]);
    // todo は JSON body でなく PKC-Markdown + 抽出済み列(JSON 文字列 body を作らない)
    const todo = written.find((e) => e.lid === 'b')!;
    expect(todo.body).not.toContain('"status"');
    expect(todo.status).toBe('done');
    expect(todo.date).toBe('2026-08-01');
    expect(relations).toHaveLength(1);

    expect(reloadCount()).toBe(1);
    const s = d.getState();
    expect(s.phase).toBe('ready');
    expect([...s.entryMetas.keys()].sort()).toEqual(['a', 'b']);
    expect(s.error).toBeNull(); // 警告なしなら可視エラーを出さない
  });

  it('gzip+base64 の添付を復号して Blob + meta で書く', async () => {
    const { d, deps, blobs, metas, written } = harness();
    const payload = 'attachment bytes 添付';
    const file = htmlFile({
      container: {
        meta: {},
        entries: [
          {
            lid: 'att',
            title: 'file.txt',
            archetype: 'attachment',
            body: JSON.stringify({
              name: 'file.txt',
              mime: 'text/plain',
              size: 20,
              asset_key: 'old-key',
            }),
          },
        ],
        assets: { 'old-key': await gzipBase64(payload) },
      },
      export_meta: { mode: 'full', asset_encoding: 'gzip+base64' },
    });

    await importPkc2File(d, deps, file);

    expect(blobs.size).toBe(1);
    const [key, blob] = [...blobs.entries()][0]!;
    expect(await blob.text()).toBe(payload); // 展開されている(gzip のまま入れない)
    expect(metas).toEqual([
      {
        key,
        mime: 'text/plain',
        size: new TextEncoder().encode(payload).length,
        hash: key.slice('ast-'.length),
      },
    ]);
    // entry 側の参照も同じ新 key を指す(旧 key が残ると死んだ参照になる)
    expect(key).not.toBe('old-key');
    expect(readAttachmentMeta(written[0]!.body).assetKey).toBe(key);
  });

  it('gzip でない base64(旧 export)もそのまま復号できる', async () => {
    const { d, deps, blobs } = harness();
    const file = htmlFile({
      container: {
        meta: {},
        entries: [
          {
            lid: 'att',
            title: 'a.txt',
            archetype: 'attachment',
            body: JSON.stringify({ name: 'a.txt', mime: 'text/plain', asset_key: 'k' }),
          },
        ],
        assets: { k: base64('plain bytes') },
      },
      export_meta: { asset_encoding: 'base64' },
    });

    await importPkc2File(d, deps, file);
    expect(await [...blobs.values()][0]!.text()).toBe('plain bytes');
  });

  it('light export(assets が空オブジェクト)は bytes を書かず light と明言する', async () => {
    const { d, deps, blobs, written, notices, reportedNotes } = harness();
    const file = htmlFile({
      container: {
        meta: {},
        entries: [{ lid: 'a', title: 'n', archetype: 'text', body: '本文\n' }],
        assets: {}, // PKC2 の light export は key ごと落とす({...c, assets: {}})
      },
      export_meta: { mode: 'light' },
    });

    await importPkc2File(d, deps, file);
    expect(blobs.size).toBe(0);
    expect(written).toHaveLength(1);
    // mode を parse しているのに黙っていると、user は添付が入った気になる
    expect(notices.at(-1)).toMatch(/注意 1 件/);
    expect(reportedNotes().join('\n')).toMatch(/添付の中身は含まれていない/);
  });

  it('0 バイトの添付は「中身が無い」ではない ── 空ファイルとして取り込む', async () => {
    // review M-3: base64 の空文字を light export と同一視して skip していたため、
    // 空ファイルの添付が**無警告で死んだ参照**になっていた(実証済み)。
    // content addressing なら空 bytes にも正当な key(sha256 of empty)がある
    const { d, deps, blobs, written } = harness();
    const file = htmlFile({
      container: {
        meta: {},
        entries: [
          {
            lid: 'att',
            title: 'empty.txt',
            archetype: 'attachment',
            body: JSON.stringify({ name: 'empty.txt', mime: 'text/plain', asset_key: 'k0' }),
          },
        ],
        assets: { k0: '' }, // 0 バイトのファイル
      },
      export_meta: { mode: 'full' },
    });

    await importPkc2File(d, deps, file);

    expect(blobs.size).toBe(1);
    const [key, blob] = [...blobs.entries()][0]!;
    expect(blob.size).toBe(0);
    // 空 bytes の SHA-256 は既知の定数 ── 採番 key に落ちていないことの証拠
    expect(key).toBe(
      'ast-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(readAttachmentMeta(written[0]!.body).assetKey).toBe(key); // 参照が生きている
  });

  it('light export の attachment は「中身が無い」と件数で言う(開くまで気づかせない)', async () => {
    const { d, deps, notices, reportedNotes } = harness();
    const file = htmlFile({
      container: {
        meta: {},
        entries: [
          {
            lid: 'att',
            title: '請求書.pdf',
            archetype: 'attachment',
            body: JSON.stringify({
              name: '請求書.pdf',
              mime: 'application/pdf',
              asset_key: 'pkc2-old-key',
            }),
          },
        ],
        assets: {}, // light export ── keyMap が空なので旧 key のまま残る
      },
      export_meta: { mode: 'light' },
    });

    expect(await importPkc2File(d, deps, file)).toBe(1);
    expect(notices.at(-1)).toMatch(/注意 2 件/); // light 本体 + 個別の欠損
    // 🔑 **2 件目以降も届く**(H-2 の前は notes[0] しか出力されていなかった)
    expect(reportedNotes()).toHaveLength(2);
    expect(reportedNotes().join('\n')).toMatch(/請求書\.pdf/);
  });

  it('bytes を先に、参照を後に書く(順序そのものを pin する)', async () => {
    const { d, deps, opLog } = harness();
    const file = htmlFile({
      container: {
        meta: {},
        entries: [
          {
            lid: 'att',
            title: 'a.txt',
            archetype: 'attachment',
            body: JSON.stringify({ name: 'a.txt', mime: 'text/plain', asset_key: 'k' }),
          },
          { lid: 'n', title: 'n', archetype: 'text', body: 'x\n' },
        ],
        relations: [{ id: 'r1', from: 'n', to: 'att', kind: 'structural' }],
        assets: { k: base64('bytes') },
      },
      export_meta: {},
    });

    await importPkc2File(d, deps, file);
    // 逆順は「参照はあるが bytes が無い」entry を残す ── 逆向きの orphan bytes は
    // 明示 purge で回収できる。この非対称が順序を規約にしている理由
    const blobAt = opLog.findIndex((o) => o.startsWith('blob:'));
    expect(blobAt).toBeGreaterThanOrEqual(0);
    expect(blobAt).toBeLessThan(opLog.indexOf('entries'));
    expect(opLog.indexOf('entries')).toBeLessThan(opLog.indexOf('relations'));
  });

  it('ZIP のふりをした壊れた入力は可視で断る ── 書込は 1 件も起きない', async () => {
    const { d, deps, written, blobs } = harness();
    const zip = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])], 'pkg.zip');

    expect(await importPkc2File(d, deps, zip)).toBeNull();
    expect(written).toHaveLength(0);
    expect(blobs.size).toBe(0);
    expect(d.getState().error).toMatch(/取込に失敗しました/);
    expect(d.getState().phase).toBe('ready'); // 非致命
  });

  it('PKC2 でない入力は可視で断る(読めたつもりで 0 件にしない)', async () => {
    const { d, deps, written } = harness();
    const stray = new File(['<html><body>ただの HTML</body></html>'], 'x.html', {
      type: 'text/html',
    });
    expect(await importPkc2File(d, deps, stray)).toBeNull();
    expect(d.getState().error).toMatch(/取込に失敗しました/);
    expect(written).toHaveLength(0);

    const binary = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'photo.html');
    expect(await importPkc2File(d, deps, binary)).toBeNull();
    expect(d.getState().error).toMatch(/取り込めない形式/);
    expect(written).toHaveLength(0);
  });

  it('編集中は読む前に可視ブロック ── draft は無傷', async () => {
    const { d, deps, written } = harness();
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'draft', title: 'draft' });
    expect(d.getState().phase).toBe('editing');

    const file = htmlFile({
      container: { meta: {}, entries: [{ lid: 'a', title: 'n', archetype: 'text', body: 'x\n' }] },
      export_meta: {},
    });
    expect(await importPkc2File(d, deps, file)).toBeNull();

    expect(written).toHaveLength(0);
    expect(d.getState().phase).toBe('editing');
    expect(d.getState().error).toMatch(/編集を終了/);
  });

  it('警告(端点不在の relation 等)は握りつぶさず可視化する ── ただし成功をエラーに見せない', async () => {
    const { d, deps, relations, notices, reportedNotes } = harness();
    const file = htmlFile({
      container: {
        meta: {},
        entries: [{ lid: 'a', title: 'n', archetype: 'text', body: 'x\n' }],
        relations: [{ id: 'r1', from: 'a', to: 'missing', kind: 'structural' }],
      },
      export_meta: {},
    });

    expect(await importPkc2File(d, deps, file)).toBe(1);
    expect(relations).toHaveLength(0);
    expect(notices.at(-1)).toMatch(/取込完了: 1 件 ⚠ 注意 1 件/);
    expect(reportedNotes()).toEqual(['端点不在の relation を除外: r1']);
    // state.error に載せると status が「⚠ エラー:」で始まる ── 成功が失敗に見える
    expect(d.getState().error).toBeNull();
  });

  it('lid 衝突は再採番して既存 entry を上書きしない', async () => {
    const { d, deps, written } = harness();
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        {
          lid: 'a',
          title: '既存',
          archetype: 'text',
          entryOrder: 1,
          status: null,
          date: null,
          archived: false,
          createdAt: null,
          updatedAt: null,
        },
      ],
      relations: [],
    });

    const file = htmlFile({
      container: { meta: {}, entries: [{ lid: 'a', title: '取込', archetype: 'text', body: '新\n' }] },
      export_meta: {},
    });
    await importPkc2File(d, deps, file);

    expect(written).toHaveLength(1);
    expect(written[0]!.lid).not.toBe('a'); // 既存 'a' を潰さない
    expect(written[0]!.title).toBe('取込');
  });

  it('壊れた添付が 1 件あっても取込全体は止まらない(欠損は可視)', async () => {
    const { d, deps, written, blobs, reportedNotes } = harness();
    const file = htmlFile({
      container: {
        meta: {},
        entries: [{ lid: 'a', title: 'n', archetype: 'text', body: 'x\n' }],
        assets: { k: 'これは gzip ではない' },
      },
      export_meta: { asset_encoding: 'gzip+base64' },
    });

    expect(await importPkc2File(d, deps, file)).toBe(1);
    expect(written).toHaveLength(1); // entry は取り込まれる
    expect(blobs.size).toBe(0); // 壊れた添付は書かれない
    expect(reportedNotes().join('\n')).toMatch(/添付を復元できませんでした/);
  });

  // ── review で実証された 4 経路(H-1〜H-4)の pin ──

  it('[H-1] ゴミ箱の lid とも衝突判定する ── 削除済み entry の履歴を奪わない', async () => {
    // 実配線の existingLids は entries ∪ revisions。ゴミ箱 = 「entries に居ないが
    // revisions を持つ lid」なので、生存 entry だけで判定すると素通りする
    const { d, deps, written } = harness({ existingLids: new Set(['trashed-lid']) });
    const file = htmlFile({
      container: {
        meta: {},
        entries: [
          { lid: 'trashed-lid', title: '取込', archetype: 'text', body: '新\n' },
        ],
      },
      export_meta: {},
    });

    await importPkc2File(d, deps, file);
    expect(written).toHaveLength(1);
    // 同じ lid で書くと ① ゴミ箱からその item が消え ② 履歴に他人の版が並ぶ
    expect(written[0]!.lid).not.toBe('trashed-lid');
  });

  it('[H-2] relation id は既存と衝突したら再採番する(upsert の後勝ちで潰さない)', async () => {
    const { d, deps, relations } = harness();
    // 既存 relation r1 が居る状態(1 回目の取込の後、と同じ形)
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [],
      relations: [
        {
          id: 'r1',
          fromLid: 'x',
          toLid: 'y',
          kind: 'structural',
          createdAt: null,
          updatedAt: null,
        },
      ],
    });
    const file = htmlFile({
      container: {
        meta: {},
        entries: [
          { lid: 'a', title: 'a', archetype: 'text', body: 'a\n' },
          { lid: 'b', title: 'b', archetype: 'text', body: 'b\n' },
          { lid: 'c', title: 'c', archetype: 'text', body: 'c\n' },
        ],
        // id 衝突 / id 欠落 の両方 ── どちらも既存を上書きしてはいけない
        relations: [
          { id: 'r1', from: 'a', to: 'b', kind: 'structural' },
          { from: 'b', to: 'c', kind: 'semantic' },
        ],
      },
      export_meta: {},
    });

    await importPkc2File(d, deps, file);
    expect(relations).toHaveLength(2);
    expect(relations.map((r) => r.id)).not.toContain('r1'); // 既存を潰さない
    expect(relations.map((r) => r.id)).not.toContain(''); // id 欠落も潰さない
    expect(new Set(relations.map((r) => r.id)).size).toBe(2); // 取込内でも一意
  });

  it('[H-3] entries を書いた後で失敗したら「書けた事実」を隠さない + 画面へ出す', async () => {
    const { d, deps, written, reloadCount } = harness({ failRelations: true });
    const file = htmlFile({
      container: {
        meta: {},
        entries: [
          { lid: 'a', title: 'a', archetype: 'text', body: 'a\n' },
          { lid: 'b', title: 'b', archetype: 'text', body: 'b\n' },
        ],
        relations: [{ id: 'r1', from: 'a', to: 'b', kind: 'structural' }],
      },
      export_meta: {},
    });

    expect(await importPkc2File(d, deps, file)).toBeNull();
    expect(written).toHaveLength(2); // disk には残っている
    // 「失敗しました」とだけ言うと、素直な再取込が二重取込になる
    expect(d.getState().error).toMatch(/2 件まで書き込まれました/);
    expect(d.getState().error).toMatch(/二重になります/);
    expect(reloadCount()).toBe(1); // 書けた分は必ず画面へ出す
    expect(d.getState().entryMetas.size).toBe(2);
  });

  it('[H-4] 取込中に編集が始まったら draft を殺さない(再読込を延期する)', async () => {
    const { d, deps, written } = harness({
      onBulkEntries: (dd) => {
        // 取込の await 中に user が編集を始める(UI に gate は無い)
        dd.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'draft', title: 'd' });
        dd.dispatch({ type: 'UPDATE_OPEN_BODY', body: '# 失いたくない下書き\n' });
      },
    });
    const file = htmlFile({
      container: { meta: {}, entries: [{ lid: 'a', title: 'n', archetype: 'text', body: 'x\n' }] },
      export_meta: {},
    });

    await importPkc2File(d, deps, file);

    expect(written).toHaveLength(1); // 取込自体は成功している
    expect(d.getState().phase).toBe('editing'); // editor から蹴り出さない
    expect(d.getState().openBody?.body).toBe('# 失いたくない下書き\n'); // draft 無傷
    expect(d.getState().error).toMatch(/編集を終了すると一覧に反映されます/); // 無言にしない
  });

  // ── 履歴の配線(review H-2 / M-5 / M-6 / M-25: adapter 層で 1 件も見ていなかった)──

  it('[H-2] 履歴が鎖のまま storage へ届く(1 entry = 1 鎖・古い順)', async () => {
    const { d, deps, revChains } = harness();
    const file = htmlFile({
      container: {
        meta: {},
        entries: [{ lid: 'e1', title: 'n', archetype: 'text', body: 'いま\n' }],
        revisions: [
          { id: 'r3', entry_lid: 'e1', created_at: '2026-07-03T00:00:00Z', snapshot: 'v3\n' },
          { id: 'r1', entry_lid: 'e1', created_at: '2026-07-01T00:00:00Z', snapshot: 'v1\n' },
          { id: 'r2', entry_lid: 'e1', created_at: '2026-07-02T00:00:00Z', snapshot: 'v2\n' },
        ],
      },
      export_meta: {},
    });

    await importPkc2File(d, deps, file);

    // 鎖を割ると worker は「既に履歴を持つ entry」として残りを丸ごと捨てる ──
    // 1 entry = 1 鎖であることが、無音のデータ欠損を防ぐ条件
    expect(revChains).toHaveLength(1);
    expect(revChains[0]!.entryLid).toBe('e1');
    expect(revChains[0]!.snapshots.map((s) => s.body)).toEqual(['v1\n', 'v2\n', 'v3\n']);
    expect(revChains[0]!.snapshots.map((s) => s.createdAt)).toEqual([
      '2026-07-01T00:00:00Z',
      '2026-07-02T00:00:00Z',
      '2026-07-03T00:00:00Z',
    ]);
  });

  it('[H-2] 履歴が巨大でも鎖は割らない(batch 予算より鎖の完全性が優先)', async () => {
    const big = 'x'.repeat(200_000) + '\n';
    const { d, deps, revChains } = harness();
    const file = htmlFile({
      container: {
        meta: {},
        entries: [{ lid: 'e1', title: 'n', archetype: 'text', body: 'tip\n' }],
        revisions: Array.from({ length: 40 }, (_, i) => ({
          id: `r${i}`,
          entry_lid: 'e1',
          created_at: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
          snapshot: `${i}${big}`,
        })),
      },
      export_meta: {},
    });

    await importPkc2File(d, deps, file);
    // 8MB 相当 = 予算(4MB)超だが、鎖は 1 本のまま届く
    expect(revChains).toHaveLength(1);
    expect(revChains[0]!.snapshots).toHaveLength(40);
  });

  it('[H-2] 履歴の版数が完了通知に出る(黙って落とさない)', async () => {
    const { d, deps, notices } = harness();
    const file = htmlFile({
      container: {
        meta: {},
        entries: [{ lid: 'e1', title: 'n', archetype: 'text', body: 'いま\n' }],
        revisions: [
          { id: 'r1', entry_lid: 'e1', created_at: '2026-07-01T00:00:00Z', snapshot: 'v1\n' },
        ],
      },
      export_meta: {},
    });
    await importPkc2File(d, deps, file);
    expect(notices.at(-1)).toMatch(/履歴 1 版/);
  });

  it('[M-30] 再取込でも body の参照が実在 key を指す(dedupe の本題)', async () => {
    const { d, deps, written, blobs } = harness();
    const mk = () =>
      htmlFile({
        container: {
          meta: {},
          entries: [
            {
              lid: 'att',
              title: 'a.txt',
              archetype: 'attachment',
              body: JSON.stringify({ name: 'a.txt', mime: 'text/plain', asset_key: 'k' }),
            },
          ],
          assets: { k: base64('同じ中身') },
        },
        export_meta: {},
      });

    await importPkc2File(d, deps, mk());
    written.length = 0;
    await importPkc2File(d, deps, mk()); // 2 回目は put を省く経路

    // put を省いた側で暫定 key が残ると、2 部目の entry が死んだ参照を持つ
    expect(readAttachmentMeta(written[0]!.body).assetKey).toBe([...blobs.keys()][0]);
    expect(blobs.size).toBe(1);
  });

  it('[M-27] asset は bytes → meta の順で書く(逆だと dedupe 毒を自分で作る)', async () => {
    const { d, deps, opLog, metas } = harness();
    await importPkc2File(
      d,
      deps,
      htmlFile({
        container: {
          meta: {},
          entries: [
            {
              lid: 'att',
              title: 'a.txt',
              archetype: 'attachment',
              body: JSON.stringify({ name: 'a.txt', mime: 'text/plain', asset_key: 'k' }),
            },
          ],
          assets: { k: base64('bytes') },
        },
        export_meta: {},
      }),
    );
    // meta が先に入ると、putBlob 失敗時に「meta あり / bytes なし」が残る
    expect(opLog.findIndex((o) => o.startsWith('blob:'))).toBeLessThan(
      opLog.indexOf(`meta:${metas[0]!.key}`),
    );
  });

  it('[M-9] gzip export でも legacy 内蔵 data は素の base64 として読む', async () => {
    // gzip は **export 単位**の符号化で、body 内蔵の data には掛かっていない
    const { d, deps, blobs, written } = harness();
    const file = htmlFile({
      container: {
        meta: {},
        entries: [
          {
            lid: 'old',
            title: 'legacy.txt',
            archetype: 'attachment',
            body: JSON.stringify({
              name: 'legacy.txt',
              mime: 'text/plain',
              data: base64('body 内蔵だった bytes'),
            }),
          },
        ],
      },
      export_meta: { mode: 'full', asset_encoding: 'gzip+base64' },
    });

    await importPkc2File(d, deps, file);

    expect(blobs.size).toBe(1);
    expect(await [...blobs.values()][0]!.text()).toBe('body 内蔵だった bytes');
    expect(readAttachmentMeta(written[0]!.body).assetKey).toBe([...blobs.keys()][0]);
  });

  it('[H-1] bytes が消えている key は meta があっても書き直す(GC 途中失敗の自己修復)', async () => {
    const { d, deps, blobs, opLog } = harness();
    const mk = () =>
      htmlFile({
        container: {
          meta: {},
          entries: [
            {
              lid: 'att',
              title: 'a.txt',
              archetype: 'attachment',
              body: JSON.stringify({ name: 'a.txt', mime: 'text/plain', asset_key: 'k' }),
            },
          ],
          assets: { k: base64('取り戻したい bytes') },
        },
        export_meta: {},
      });

    await importPkc2File(d, deps, mk());
    const key = [...blobs.keys()][0]!;
    blobs.delete(key); // GC が deleteBlob 後 deleteMeta で失敗した状態
    opLog.length = 0;

    await importPkc2File(d, deps, mk());
    expect(opLog).toContain(`blob:${key}`); // 省かずに書き直す
    expect(blobs.has(key)).toBe(true);
  });

  it('[L-11] 履歴の書込で落ちたら「履歴」と言う(関連と混同しない)', async () => {
    const { d, deps } = harness({ failRevisions: true });
    const file = htmlFile({
      container: {
        meta: {},
        entries: [{ lid: 'e1', title: 'n', archetype: 'text', body: 'いま\n' }],
        revisions: [
          { id: 'r1', entry_lid: 'e1', created_at: '2026-07-01T00:00:00Z', snapshot: 'v1\n' },
        ],
      },
      export_meta: {},
    });

    expect(await importPkc2File(d, deps, file)).toBeNull();
    expect(d.getState().error).toMatch(/履歴の書込で失敗/);
  });

  // ── P6c 段②: .pkc2.zip(バックアップ正本)の取込 ──

  it('[P6c] .pkc2.zip を取り込む ── bytes は ZIP から直接流れる(base64 を経由しない)', async () => {
    const { d, deps, written, blobs, opLog, metas } = harness();
    const container = {
      meta: { container_id: 'c-old' },
      entries: [
        { lid: 'n1', title: 'ノート', archetype: 'text', body: '# 本文 ![図](asset:ast-x1)\n' },
        {
          lid: 'a1',
          title: 'dot.png',
          archetype: 'attachment',
          body: JSON.stringify({ name: 'dot.png', mime: 'image/png', asset_key: 'ast-x1' }),
        },
      ],
      relations: [],
      revisions: [],
      assets: {}, // ← PKC2 の writer は assets を空にする(bytes は ZIP entry へ)
    };
    const zip = await buildZip([
      {
        name: 'manifest.json',
        bytes: bytesOf(
          JSON.stringify({
            format: 'pkc2-package',
            version: 1,
            entry_count: 2,
            relation_count: 0,
            revision_count: 0,
            asset_count: 1,
          }),
        ),
      },
      { name: 'container.json', bytes: bytesOf(JSON.stringify(container)) },
      { name: 'assets/ast-x1.bin', bytes: bytesOf('生バイナリ') },
    ]);
    const file = new File([zip], 'backup.pkc2.zip');

    expect(await importPkc2File(d, deps, file)).toBe(2);

    expect(blobs.size).toBe(1);
    const key = [...blobs.keys()][0]!;
    expect(await blobs.get(key)!.text()).toBe('生バイナリ');
    // 🔑 ZIP 経路でも **key は中身の SHA-256**(content addressing / ZFS の発想)。
    // これを見ていなかったので、HASH_MAX_BYTES 分岐を消しても反転させても
    // 全 test が通っていた(review M-1)── 反転すると採番 key + hash:null になる
    // ⚠ ハッシュは**べた書き**(実装から借りない ── 借りると実装が壊れても一致する)
    expect(key).toBe('ast-df08ff17d4afa4ad9d950178b2fdbbd203ce98cf0ce5f04fe567e6342550c10e');
    expect(metas).toEqual([
      { key, mime: 'image/png', size: 15, hash: key.slice('ast-'.length) },
    ]);
    // 参照は content key へ写っている(frontmatter と本文 markdown の両方)
    const att = written.find((e) => e.archetype === 'attachment')!;
    expect(readAttachmentMeta(att.body).assetKey).toBe(key);
    expect(written.find((e) => e.lid === 'n1')!.body).toContain(`asset:${key}`);
    // 規約は HTML 経路と同じ ── bytes が先、参照が後
    expect(opLog.findIndex((o) => o.startsWith('blob:'))).toBeLessThan(
      opLog.indexOf('entries'),
    );
  });

  /** 内側の `.text.zip` を組む(batch fixture 用)。 */
  async function innerTextBundle(
    lid: string,
    body: string,
    assetBytes: Uint8Array | null,
  ): Promise<Uint8Array> {
    const zip = await buildZip([
      {
        name: 'manifest.json',
        bytes: bytesOf(
          JSON.stringify({
            format: 'pkc2-text-bundle',
            version: 1,
            source_lid: lid,
            source_title: lid,
            assets: assetBytes ? { 'ast-shared': { name: 'dot.png', mime: 'image/png' } } : {},
            compacted: false,
          }),
        ),
      },
      { name: 'body.md', bytes: bytesOf(body) },
      ...(assetBytes ? [{ name: 'assets/ast-shared.png', bytes: assetBytes }] : []),
    ]);
    return new Uint8Array(await zip.arrayBuffer());
  }

  it('[P6c 段④] batch: 内側 ZIP を再入し、共有添付を 1 本の blob に畳む', async () => {
    // 🔴 この PR の目玉。**内側 entry を外側 Blob から読む** mutation は
    // typecheck も lint も通り、smoke でしか落ちなかった(review M-3)──
    // ブラウザ無しで 1 秒未満に殺せるのに網が無かった
    const { d, deps, written, blobs, metas, opLog } = harness();
    const png = bytesOf('共有 PNG');
    const zip = await buildZip([
      {
        name: 'manifest.json',
        bytes: bytesOf(
          JSON.stringify({
            format: 'pkc2-mixed-container-bundle',
            version: 1,
            text_count: 2,
            textlog_count: 0,
            entries: [
              { lid: 'n1', title: 'n1', archetype: 'text', filename: 'a.text.zip' },
              { lid: 'n2', title: 'n2', archetype: 'text', filename: 'b.text.zip' },
            ],
          }),
        ),
      },
      {
        name: 'a.text.zip',
        bytes: await innerTextBundle('n1', '# A\n![図](asset:ast-shared)\n', png),
      },
      {
        name: 'b.text.zip',
        bytes: await innerTextBundle('n2', '# B\n![図](asset:ast-shared)\n', png),
      },
    ]);

    expect(await importPkc2File(d, deps, new File([zip], 'c.zip'))).toBe(3);

    // 添付は **1 本**(content addressing + attachment の畳み込み)
    expect(blobs.size).toBe(1);
    const key = [...blobs.keys()][0]!;
    expect(await blobs.get(key)!.text()).toBe('共有 PNG');
    expect(metas).toEqual([
      { key, mime: 'image/png', size: png.length, hash: key.slice('ast-'.length) },
    ]);
    // 両ノートの本文が**同じ content key** を指す
    for (const lid of ['n1', 'n2']) {
      expect(written.find((e) => e.lid === lid)!.body).toContain(`asset:${key}`);
    }
    // 規約は他経路と同じ ── bytes が先、参照が後
    expect(opLog.findIndex((o) => o.startsWith('blob:'))).toBeLessThan(opLog.indexOf('entries'));
  });

  it('[P6c 段⑤] folder-export: 階層が relation として実際に入る', async () => {
    // 🔑 unit(reader)は「合成 container の形」までしか見ない ── **convert を
    // 通って relation が実際に書かれる**ところまでを 1 本の網で見る
    const { d, deps, written, relations } = harness();
    const inner = async (lid: string, title: string): Promise<Uint8Array> => {
      const z = await buildZip([
        {
          name: 'manifest.json',
          bytes: bytesOf(
            JSON.stringify({
              format: 'pkc2-text-bundle',
              version: 1,
              source_lid: lid,
              source_title: title,
              assets: {},
              compacted: false,
            }),
          ),
        },
        { name: 'body.md', bytes: bytesOf(`# ${title}\n`) },
      ]);
      return new Uint8Array(await z.arrayBuffer());
    };
    const zip = await buildZip([
      {
        name: 'manifest.json',
        bytes: bytesOf(
          JSON.stringify({
            format: 'pkc2-folder-export-bundle',
            version: 1,
            source_folder_lid: 'root',
            source_folder_title: '仕事',
            text_count: 1,
            textlog_count: 0,
            entries: [
              {
                lid: 'n1',
                title: 'メモ',
                archetype: 'text',
                filename: 'n1.text.zip',
                parent_folder_lid: 'sub',
              },
            ],
            folders: [
              { lid: 'root', title: '仕事', parent_lid: null },
              { lid: 'sub', title: '2026', parent_lid: 'root' },
            ],
          }),
        ),
      },
      { name: 'n1.text.zip', bytes: await inner('n1', 'メモ') },
    ]);

    // folder 2 件 + 本体 1 件
    expect(await importPkc2File(d, deps, new File([zip], 'f.zip'))).toBe(3);

    const byTitle = new Map(written.map((e) => [e.title, e.lid]));
    expect(written.filter((e) => e.archetype === 'folder')).toHaveLength(2);
    // 🔑 relation が **structural / fromLid = 親** で入っている
    const t = new Map(relations.map((r) => [r.toLid, r.fromLid]));
    expect(relations.every((r) => r.kind === 'structural')).toBe(true);
    expect(t.get(byTitle.get('2026')!)).toBe(byTitle.get('仕事'));
    expect(t.get(byTitle.get('メモ')!)).toBe(byTitle.get('2026'));
    // ⚠ relation id が全部同じだと worker の upsert で 1 本しか残らない
    expect(new Set(relations.map((r) => r.id)).size).toBe(relations.length);
  });

  it('[P6c 段⑥] `.entry.zip` の base64 添付が **実バイト**として保存される', async () => {
    // 🔴 base64 のまま putBlob すると「開けないのに壊れて見えない」添付ができる。
    // 実物(PKC2 の writer が吐いた attachment.entry.zip)で end-to-end に確かめる
    const { d, deps, written, blobs, metas } = harness();
    const zip = readFileSync(`${process.cwd()}/tests/fixtures/pkc2/attachment.entry.zip`);

    expect(await importPkc2File(d, deps, new File([zip], 'a.entry.zip'))).toBe(1);

    expect(blobs.size).toBe(1);
    const key = [...blobs.keys()][0]!;
    const bytes = new Uint8Array(await blobs.get(key)!.arrayBuffer());
    // 🔑 PNG の署名が立っている = base64 が復号されている
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // content addressing も効く(key は復号後の bytes のハッシュ)
    expect(metas[0]!.hash).toBe(key.slice('ast-'.length));
    expect(written[0]!.archetype).toBe('attachment');
  });

  it('[P6c 段⑥] 🔴 控えから復元するとき **控え自身の符号化**で復号する', async () => {
    // 生バイト側(先頭)を壊し、base64 の控えから復元させる。先頭のフラグで
    // 解釈すると base64 の文字列がそのまま保存される(開けないのに壊れて見えない)
    const png = bytesOf('PNGBYTES');
    const b64 = bytesOf(btoa('PNGBYTES'));
    const inner = async (
      name: string,
      files: Array<{ name: string; bytes: Uint8Array; corruptCrc?: boolean }>,
      manifest: Record<string, unknown>,
      payload: { name: string; bytes: Uint8Array },
    ): Promise<Uint8Array> => {
      const z = await buildZip([
        { name: 'manifest.json', bytes: bytesOf(JSON.stringify(manifest)) },
        payload,
        ...files,
      ]);
      return new Uint8Array(await z.arrayBuffer());
    };
    const textZip = await inner(
      'a',
      [{ name: 'assets/k.png', bytes: png, corruptCrc: true }], // 🔴 壊す
      {
        format: 'pkc2-text-bundle',
        version: 1,
        source_lid: 'n1',
        source_title: 'A',
        assets: { k: { name: 'dot.png', mime: 'image/png' } },
      },
      { name: 'body.md', bytes: bytesOf('# A\n![図](asset:k)\n') },
    );
    const entryZip = await inner(
      'b',
      [{ name: 'assets/k', bytes: b64 }], // base64 の控え(健全)
      { format: 'pkc2-entry-bundle', version: 1, archetype: 'attachment', lid: 'a1', title: 'dot.png' },
      {
        name: 'entry.json',
        bytes: bytesOf(
          JSON.stringify({
            lid: 'a1',
            title: 'dot.png',
            archetype: 'attachment',
            body: JSON.stringify({ name: 'dot.png', mime: 'image/png', asset_key: 'k' }),
          }),
        ),
      },
    );
    const zip = await buildZip([
      {
        name: 'manifest.json',
        bytes: bytesOf(
          JSON.stringify({
            format: 'pkc2-folder-export-bundle',
            version: 2,
            entries: [
              { lid: 'n1', title: 'A', archetype: 'text', filename: 'n.text.zip' },
              { lid: 'a1', title: 'dot.png', archetype: 'attachment', filename: 'a.entry.zip' },
            ],
            folders: [{ lid: 'root', title: 'R', parent_lid: null }],
          }),
        ),
      },
      { name: 'n.text.zip', bytes: textZip },
      { name: 'a.entry.zip', bytes: entryZip },
    ]);

    const { d, deps, blobs } = harness();
    await importPkc2File(d, deps, new File([zip], 'f.zip'));

    expect(blobs.size).toBe(1);
    const bytes = await blobs.get([...blobs.keys()][0]!)!.text();
    // 🔑 控えは base64 なので、復号されて 'PNGBYTES' になる
    expect(bytes).toBe('PNGBYTES');
  });

  it('[P6d] 🔴 アーカイブ復元で添付の mime が落ちない(preview が死ぬ)', async () => {
    // mime を落とすと Blob の type と meta.mime が空になり、画像が preview されない
    // ── 無言で(review M-4)
    const { ZipWriter } = await import('../../src/features/export/zip-writer');
    const { d, deps, metas, blobs } = harness();
    const w = new ZipWriter();
    await w.add('manifest.json', ['{"format":"pkc3-archive","version":1}']);
    await w.add('container.json', [
      JSON.stringify({
        meta: {},
        entries: [
          {
            lid: 'a1',
            title: 'dot.png',
            archetype: 'attachment',
            body: '---\nattachment:\n  asset_key: k1\n---\n',
            entryOrder: 1,
            createdAt: null,
            updatedAt: null,
            status: null,
            date: null,
            archived: false,
          },
        ],
        relations: [],
        revisions: [],
        assets: [{ key: 'k1', mime: 'image/png', size: 4, hash: null }],
      }),
    ]);
    await w.add('assets/k1', [new Blob([bytesOf('PNGX')])]);

    expect(await importPkc2File(d, deps, new File([w.finish()], 'a.pkc3.zip'))).toBe(1);
    expect(metas[0]!.mime).toBe('image/png');
    expect([...blobs.values()][0]!.type).toBe('image/png');
  });

  it('[P6c 段⑥] 🔴 base64 の添付は**閾値超でも**直流ししない', async () => {
    // 閾値超の経路は「Blob をそのまま putBlob」なので、base64 の在り処を
    // 乗せると **base64 の文字列が添付として保存される**(開けないのに
    // 壊れて見えない)。ここだけ除外していることを閾値を下げて確かめる
    const { d, deps, blobs } = harness();
    deps.hashMaxBytes = 4; // 96 バイトの base64 は余裕で超える
    const zip = readFileSync(`${process.cwd()}/tests/fixtures/pkc2/attachment.entry.zip`);

    expect(await importPkc2File(d, deps, new File([zip], 'a.entry.zip'))).toBe(1);

    const bytes = new Uint8Array(await blobs.get([...blobs.keys()][0]!)!.arrayBuffer());
    // 🔑 base64 のままなら先頭は 'i'(0x69)── PNG 署名が立っていること
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('[P6c] 閾値超の添付は heap に載せず、採番 key + hash なしで入る', async () => {
    // ⚠ この分岐は既定 64MB なので fixture では踏めない ── 閾値を下げて観測する。
    // 分岐を丸ごと消す mutation が生存していた(review M-1 / MUTANT-2)
    const { d, deps, written, blobs, metas } = harness();
    deps.hashMaxBytes = 4; // 「生バイナリ」= 15 バイト > 4
    const container = {
      meta: {},
      entries: [
        {
          lid: 'a1',
          title: 'big.bin',
          archetype: 'attachment',
          body: JSON.stringify({ name: 'big.bin', mime: 'image/png', asset_key: 'ast-x1' }),
        },
      ],
      relations: [],
      revisions: [],
      assets: {},
    };
    const zip = await buildZip([
      {
        name: 'manifest.json',
        bytes: bytesOf(JSON.stringify({ format: 'pkc2-package', version: 1 })),
      },
      { name: 'container.json', bytes: bytesOf(JSON.stringify(container)) },
      { name: 'assets/ast-x1.bin', bytes: bytesOf('生バイナリ') },
    ]);

    expect(await importPkc2File(d, deps, new File([zip], 'b.pkc2.zip'))).toBe(1);

    const key = [...blobs.keys()][0]!;
    // content key ではなく**採番 key**(= 重複排除の対象外)
    expect(key).not.toBe('ast-df08ff17d4afa4ad9d950178b2fdbbd203ce98cf0ce5f04fe567e6342550c10e');
    expect(metas).toEqual([{ key, mime: 'image/png', size: 15, hash: null }]);
    // 破損検査は落としていない(CRC は stream で確かめている)ので中身は正しい
    expect(await blobs.get(key)!.text()).toBe('生バイナリ');
    expect(readAttachmentMeta(written[0]!.body).assetKey).toBe(key);
  });

  it('[P6c] .pkc2.zip の履歴も HTML 経路と同じ鎖へ合流する', async () => {
    const { d, deps, revChains } = harness();
    const container = {
      meta: {},
      entries: [{ lid: 'n1', title: 'n', archetype: 'text', body: 'いま\n' }],
      relations: [],
      revisions: [
        { id: 'r1', entry_lid: 'n1', created_at: '2026-07-01T00:00:00Z', snapshot: 'v1\n' },
        { id: 'r2', entry_lid: 'n1', created_at: '2026-07-02T00:00:00Z', snapshot: 'v2\n' },
      ],
      assets: {},
    };
    const zip = await buildZip([
      {
        name: 'manifest.json',
        bytes: bytesOf(JSON.stringify({ format: 'pkc2-package', version: 1 })),
      },
      { name: 'container.json', bytes: bytesOf(JSON.stringify(container)) },
    ]);

    await importPkc2File(d, deps, new File([zip], 'b.pkc2.zip'));

    // 経路ごとに履歴の入り方が違う状態を作らない
    expect(revChains).toHaveLength(1);
    expect(revChains[0]!.snapshots.map((s) => s.body)).toEqual(['v1\n', 'v2\n']);
  });

  it('[P6c] 未対応の ZIP 形式は**名指しで**断る ── 書込は 1 件も起きない', async () => {
    const { d, deps, written, blobs } = harness();
    const zip = await buildZip([
      {
        name: 'manifest.json',
        // 全 8 形式は受理済み ── 未知の形式は名指しで断る
        bytes: bytesOf(JSON.stringify({ format: 'pkc2-future-format', version: 1 })),
      },
    ]);
    expect(await importPkc2File(d, deps, new File([zip], 'b.zip'))).toBeNull();
    expect(written).toHaveLength(0);
    expect(blobs.size).toBe(0);
    // 「不明」に混ぜず、何が未対応なのかを言う
    expect(d.getState().error).toMatch(/pkc2-future-format/);
  });

  it('[P6c] manifest.json の無い ZIP は可視で断る', async () => {
    const { d, deps, written } = harness();
    const zip = await buildZip([{ name: 'body.md', bytes: bytesOf('# x\n') }]);
    expect(await importPkc2File(d, deps, new File([zip], 'x.zip'))).toBeNull();
    expect(written).toHaveLength(0);
    expect(d.getState().error).toMatch(/manifest\.json が無い/);
  });

  it('[P6c 段③] .text.zip を取り込む ── 合成 container が本経路に合流する', async () => {
    const { d, deps, written, blobs } = harness();
    const zip = await buildZip([
      {
        name: 'manifest.json',
        bytes: bytesOf(
          JSON.stringify({
            format: 'pkc2-text-bundle',
            version: 1,
            source_lid: 'n1',
            source_title: '単体ノート',
            assets: { 'ast-k': { name: 'dot.png', mime: 'image/png' } },
          }),
        ),
      },
      { name: 'body.md', bytes: bytesOf('# 単体ノート\n![図](asset:ast-k)\n') },
      { name: 'assets/ast-k.png', bytes: bytesOf('PNG bytes') },
    ]);

    expect(await importPkc2File(d, deps, new File([zip], 'note.text.zip'))).toBe(2);

    // attachment + text の 2 件。JSON 文字列 body は**残らない**
    expect(written.map((e) => e.archetype).sort()).toEqual(['attachment', 'text']);
    const text = written.find((e) => e.archetype === 'text')!;
    expect(text.title).toBe('単体ノート');
    const att = written.find((e) => e.archetype === 'attachment')!;
    expect(att.body).not.toContain('"asset_key"'); // PKC-Markdown へ変換済み

    // bytes は ZIP から直接流れ、body の参照は content key へ写る
    expect(blobs.size).toBe(1);
    const key = [...blobs.keys()][0]!;
    expect(await blobs.get(key)!.text()).toBe('PNG bytes');
    expect(text.body).toContain(`asset:${key}`);
    expect(readAttachmentMeta(att.body).assetKey).toBe(key);
  });

  it('[P6c] Office 文書は名指しで断る(不明に混ぜない)', async () => {
    const { d, deps } = harness();
    const zip = await buildZip([{ name: '[Content_Types].xml', bytes: bytesOf('<Types/>') }]);
    expect(await importPkc2File(d, deps, new File([zip], 'sheet.xlsx'))).toBeNull();
    expect(d.getState().error).toMatch(/Office 文書/);
  });

  it('[P6c] 壊れた ZIP(CRC 不一致)は取り込まず可視で断る', async () => {
    const { d, deps, blobs } = harness();
    const container = {
      meta: {},
      entries: [
        {
          lid: 'a1',
          title: 'x.bin',
          archetype: 'attachment',
          body: JSON.stringify({ name: 'x.bin', mime: 'application/octet-stream', asset_key: 'k' }),
        },
      ],
      relations: [],
      assets: {},
    };
    const zip = await buildZip([
      {
        name: 'manifest.json',
        bytes: bytesOf(JSON.stringify({ format: 'pkc2-package', version: 1 })),
      },
      { name: 'container.json', bytes: bytesOf(JSON.stringify(container)) },
      { name: 'assets/k.bin', bytes: bytesOf('壊れた中身'), corruptCrc: true },
    ]);

    // 1 件の添付が壊れていても取込全体は止めない(欠損は可視化する)── HTML 経路と同じ
    expect(await importPkc2File(d, deps, new File([zip], 'b.pkc2.zip'))).toBe(1);
    expect(blobs.size).toBe(0);
  });

  it('[P6c 段③] .textlog.zip を取り込む ── CSV が PKC-Markdown へ変換される', async () => {
    const { d, deps, written } = harness();
    const zip = await buildZip([
      {
        name: 'manifest.json',
        bytes: bytesOf(
          JSON.stringify({
            format: 'pkc2-textlog-bundle',
            version: 1,
            source_lid: 'log1',
            source_title: '作業ログ',
            entry_count: 2,
            assets: {},
          }),
        ),
      },
      {
        name: 'textlog.csv',
        bytes: bytesOf(
          [
            '"log_id","timestamp_iso","timestamp_display","important","text_markdown","text_plain","asset_keys","flags"',
            '"l1","2026-07-01T09:00:00Z","7/1","false","朝の記録","","",""',
            '"l2","2026-07-01T18:00:00Z","7/1","true","夜の記録","","","important"',
          ].join('\r\n'),
        ),
      },
    ]);

    expect(await importPkc2File(d, deps, new File([zip], 'log.textlog.zip'))).toBe(1);

    const e = written[0]!;
    expect(e.archetype).toBe('textlog');
    expect(e.title).toBe('作業ログ');
    // 🔑 JSON 文字列 body は**残らない** ── fromPkc2 が PKC-Markdown へ変換する
    expect(e.body).not.toContain('"log_id"');
    expect(e.body).not.toContain('"createdAt"');
    expect(e.body).toContain('朝の記録');
    expect(e.body).toContain('夜の記録');
    expect(e.body).toContain('★'); // important は見出しの印になる
  });
});
