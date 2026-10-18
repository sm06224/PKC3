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
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { importPkc2File, type ImportDeps } from '../../src/adapter/ui/actions/import-pkc2';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import type { EncodedChainInput } from '../../src/adapter/platform/storage/protocol';
import type { RevisionChain } from '../../src/features/import/pkc2-convert';
import { readAttachmentMeta } from '../../src/features/flavor/attachment-flavor';
import { buildZip, bytesOf } from '../features/zip-fixture';
import { SECTION_DRAFT_NOTE } from '../../src/adapter/state/app-state';
import { readTags } from '../../src/features/flavor/tags';

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
  /** 失敗の面の口(`reportFailure`)を渡す ── 渡さない harness は従来どおり OP_FAILED に出る。 */
  captureFailure?: boolean;
  /**
   * 🔴 既に在るノートの本文(#399 ②)。⚠ **渡さない harness では数えない** ──
   *   口が無い配線でも取込が壊れないことを、既存 41 件がそのまま見ている。
   */
  existingBodies?: ReadonlyMap<string, string>;
  /** 添付の bytes の書込を、この例外で失敗させる(空き容量が無い端末の再現。I-3)。 */
  failBlob?: Error;
  /** 添付の bytes を書く直前に走る(I-2: 取り込みが飛んでいる間の「書いている」を見る)。 */
  onBlob?(): void | Promise<void>;
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
  const restoredChains: EncodedChainInput[] = [];
  let reloads = 0;
  let n = 0;
  const importedCalls: string[][] = [];
  const importedOpts: Array<{ readonly tagColors?: boolean } | undefined> = [];
  const failures: Array<{ message: string; undoable: boolean | undefined }> = [];
  /** `onWriting` に来た値の記録(I-2)と、`report` が呼ばれた回数(I-5)。 */
  const writingLog: boolean[] = [];
  let reportCalls = 0;

  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });

  const deps: ImportDeps = {
    existingLids: async () =>
      new Set([...d.getState().entryMetas.keys(), ...(opts.existingLids ?? [])]),
    existingRelationIds: () => new Set(d.getState().relations.map((r) => r.id)),
    // 🔴 重なりの検出(#399 ②)。⚠ 渡さない harness では**数えないだけ**
    ...(opts.existingBodies === undefined
      ? {}
      : {
          existingHeads: () =>
            [...opts.existingBodies!].map(([lid, body]) => ({ lid, bodyChars: body.length })),
          readBodies: async (lids: readonly string[]) =>
            new Map(
              [...opts.existingBodies!].filter(([lid]) => lids.includes(lid)),
            ),
        }),
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
    restoreRevisionChains: async (chains) => {
      restoredChains.push(...chains); // ⚠ 引数を捨てると「呼ばれた」ことすら pin できない
      return { added: 0, skippedNoChange: 0, droppedOverLimit: 0, skippedEntries: [], brokenChains: [] };
    },
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
      await opts.onBlob?.();
      if (opts.failBlob) throw opts.failBlob;
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
          error: '取り込みは完了しました。編集を終了すると一覧に反映されます',
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
          bodyChars: null,
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
    report: (n) => { reported = n; reportCalls++; },
    onWriting: (w) => { writingLog.push(w); },
    imported: (lids, o) => { importedCalls.push([...lids]); importedOpts.push(o); },
    ...(opts.captureFailure
      ? { reportFailure: (message: string, undoable?: boolean) => void failures.push({ message, undoable }) }
      : {}),
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
    restoredChains,
    reloadCount: () => reloads,
    importedCalls,
    importedOpts,
    failures,
    writingLog,
    reportCalls: () => reportCalls,
  };
}

describe('importPkc2File (P6b 実行部)', () => {
  it('HTML full export: entries / relations が書かれ、state に現れる', async () => {
    const { d, deps, written, relations, reloadCount, notices } = harness();
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
    // 対照群(#1017 C5):成功した回は最後が完了の字で、進行中を消す字は撃たない
    expect(notices.at(-1)).toContain('取り込み完了');
    expect(notices, '成功なのに消す字を撃った').not.toContain('');
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

  it('ZIP のふりをした壊れた入力は可視で断る ── 書き込みは 1 件も起きない', async () => {
    const { d, deps, written, blobs } = harness();
    const zip = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])], 'pkg.zip');

    expect(await importPkc2File(d, deps, zip)).toBeNull();
    expect(written).toHaveLength(0);
    expect(blobs.size).toBe(0);
    expect(d.getState().error).toMatch(/取り込みに失敗しました/);
    expect(d.getState().phase).toBe('ready'); // 非致命
  });

  it('PKC2 でない入力は可視で断る(読めたつもりで 0 件にしない)', async () => {
    const { d, deps, written, notices } = harness();
    const stray = new File(['<html><body>ただの HTML</body></html>'], 'x.html', {
      type: 'text/html',
    });
    expect(await importPkc2File(d, deps, stray)).toBeNull();
    // 🔑 対象外のファイルは壊れていない ──「失敗しました」ではなく断りとして出す(#1087)
    expect(d.getState().error).toMatch(/PKC2 の書き出しではない HTML なので、取り込めません/);
    expect(d.getState().error).not.toMatch(/取り込みに失敗しました/);
    // 🔴 PKC3 の閲覧用 HTML もここに来る ── 使える方法(バックアップ)を 1 行添える(依頼 341)
    expect(d.getState().error).toContain('PKC3 のバックアップは .pkc3-full.zip です');
    expect(written).toHaveLength(0);
    // 🔴 「取込中…」を出した後で落ちたので、進行中の字を消す(#1017 C5)。⚠ 残ると「まだ続いている」と読める
    expect(notices[0], '前提が崩れた(進行中の字が先に出ていない)').toContain('取り込み中…');
    expect(notices.at(-1), '失敗したのに「取り込み中…」が残る').toBe('');
    const before = notices.length;

    const binary = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'photo.html');
    expect(await importPkc2File(d, deps, binary)).toBeNull();
    expect(d.getState().error).toMatch(/取り込めない形式/);
    expect(written).toHaveLength(0);
    // 🔴 進行中の字を出す前の断りは、消す字を撃たない(別の知らせを巻き込まない)
    expect(notices.length, '出していない進行中の字を消す字を撃った').toBe(before);
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
    expect(d.getState().error).toMatch(/編集を保存するか/);
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
    expect(notices.at(-1)).toMatch(/取り込み完了: 1 件\(注意 1 件\)/);
    // 🔴 内部の ID(r1)ではなく、残っている側のノートの題名で言う(#1087)
    expect(reportedNotes()).toEqual(['「n」から、つなぐ先のノートが無いつながりを除きました']);
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
          bodyChars: null,
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
    const { d, deps, written, reloadCount, notices } = harness({ failRelations: true });
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
    expect(d.getState().error).toMatch(/2 件のノートまで取り込みました/);
    expect(d.getState().error).toMatch(/二重になります/);
    expect(reloadCount()).toBe(1); // 書けた分は必ず画面へ出す
    expect(d.getState().entryMetas.size).toBe(2);
    // 🔴 書込の途中で落ちたとき、「取込中…(N 件を書き込んでいます)」を消す(#1017 C5)
    expect(notices.some((n) => n.includes('件を書き込んでいます')), '前提が崩れた(書込の進行中を出していない)').toBe(true);
    expect(notices.at(-1), '失敗したのに進行中の字が残る').toBe('');
  });

  it('🔴 F1: 途中で失敗しても、書けた分の lid だけを憶え、失敗の面から取り消せる', async () => {
    const { d, deps, written, importedCalls, failures } = harness({ failRelations: true, captureFailure: true });
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
    expect(written.length, '前提: 2 件は書けている').toBe(2);
    expect(importedCalls, '書けた分を憶えていない(片道)').toEqual([written.map((e) => e.lid)]);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.undoable, '失敗の面に取り消しを付けていない').toBe(true);
    expect(failures[0]!.message).toContain('取り込みを取り消す');
    expect(failures[0]!.message).toContain('二重になります');
  });

  it('F1 対照群: 1 件も書けなかった失敗は何も憶えず、取り消しも付けない', async () => {
    const { d, deps, importedCalls, failures } = harness({ captureFailure: true });
    const file = new File(['<html>これは PKC2 の書き出しではない</html>'], 'x.html');
    expect(await importPkc2File(d, deps, file)).toBeNull();
    expect(importedCalls).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.undoable).toBe(false);
  });

  it('[H-4] 取り込み中に編集が始まったら draft を殺さない(再読込を延期する)', async () => {
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

  it('[L-11] 履歴の書き込みで落ちたら「履歴」と言う(関連と混同しない)', async () => {
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
    expect(d.getState().error).toMatch(/履歴の取り込みで失敗/);
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

  it('[P6e] 🔴 アーカイブの履歴が**復元経路へ渡る**(捨てられない)', async () => {
    // ⚠ 呼び出し自体を消す変異が生き残っていた(review M-4 の MUT11)──
    // stub が引数を捨てていて「呼ばれたか」すら pin できなかった
    const { ZipWriter } = await import('../../src/features/export/zip-writer');
    const { d, deps, restoredChains } = harness();
    const w = new ZipWriter();
    await w.add('manifest.json', ['{"format":"pkc3-archive","version":2}']);
    await w.add('container.json', [
      JSON.stringify({
        meta: {},
        entries: [
          {
            lid: 'n1',
            title: 'ノート',
            archetype: 'text',
            body: 'いま',
            entryOrder: 1,
            createdAt: null,
            updatedAt: null,
            status: null,
            date: null,
            archived: false,
          },
        ],
        relations: [],
        revisions: [
          { id: 'r2', entryLid: 'n1', revOrder: 2, createdAt: null, title: null, archetype: null, kind: 'patch', snapshot: 'p2', contentHash: null },
          { id: 'r1', entryLid: 'n1', revOrder: 1, createdAt: null, title: null, archetype: null, kind: 'full', snapshot: '最初', contentHash: null },
        ],
        assets: [],
      }),
    ]);

    expect(await importPkc2File(d, deps, new File([w.finish()], 'a.pkc3.zip'))).toBe(1);
    expect(restoredChains).toHaveLength(1);
    // **新しい → 古い**の向きで渡っている(worker が tip から遡る向き)
    expect(restoredChains[0]!.rows.map((r) => r.revOrder)).toEqual([2, 1]);
    expect(restoredChains[0]!.entryLid).toBe('n1');
  });

  /**
   * 🔴 **タグの色(#1457)**: バックアップの色が取り込みの口(`importTagColors`)へ渡り、
   * 戻せなくても取り込みは失敗にしない(色は本文ではない)。色の無いバックアップでは呼ばない。
   */
  describe('タグの色', () => {
    async function archiveWith(tagColors: unknown): Promise<File> {
      const { ZipWriter } = await import('../../src/features/export/zip-writer');
      const w = new ZipWriter();
      await w.add('manifest.json', ['{"format":"pkc3-archive","version":2}']);
      await w.add('container.json', [
        JSON.stringify({
          meta: {},
          entries: [
            { lid: 'n1', title: 'ノート', archetype: 'text', body: 'x', entryOrder: 1,
              createdAt: null, updatedAt: null, status: null, date: null, archived: false },
          ],
          relations: [],
          revisions: [],
          assets: [],
          ...(tagColors === undefined ? {} : { tagColors }),
        }),
      ]);
      return new File([w.finish()], 'a.pkc3-full.zip');
    }

    it('色が importTagColors へ渡る(検めた後の綴りで)', async () => {
      const { d, deps } = harness();
      const got: unknown[] = [];
      deps.importTagColors = async (incoming) => {
        got.push(...incoming);
        return { added: incoming.length, kept: 0, overLimit: 0 };
      };
      const file = await archiveWith([
        { tag: '買い物', color: '#FF8800' },
        { tag: 'bad', color: 'red' },
      ]);
      expect(await importPkc2File(d, deps, file)).toBe(1);
      expect(got).toEqual([{ tag: '買い物', color: '#ff8800' }]);
    });

    it('色が無いバックアップでは呼ばない', async () => {
      const { d, deps } = harness();
      let called = 0;
      deps.importTagColors = async () => {
        called++;
        return { added: 0, kept: 0, overLimit: 0 };
      };
      expect(await importPkc2File(d, deps, await archiveWith(undefined))).toBe(1);
      expect(called).toBe(0);
    });

    it('色を戻せなくても取り込みは成功し、注意として言う', async () => {
      const { d, deps, reportedNotes } = harness();
      deps.importTagColors = async () => {
        throw new Error('壊れた');
      };
      expect(
        await importPkc2File(d, deps, await archiveWith([{ tag: 'a', color: '#123456' }])),
      ).toBe(1);
      expect(reportedNotes().join('\n')).toContain('タグの色を戻せませんでした');
    });

    it('🔴 上限で戻せなかった色は件数つきで言う(黙って捨てない)。戻せたときは言わない', async () => {
      const { d, deps, reportedNotes } = harness();
      deps.importTagColors = async () => ({ added: 3, kept: 0, overLimit: 7 });
      await importPkc2File(d, deps, await archiveWith([{ tag: 'a', color: '#123456' }]));
      expect(reportedNotes().join('\n')).toContain('上限のため 7 件の色を戻せませんでした');
      const h2 = harness();
      h2.deps.importTagColors = async () => ({ added: 1, kept: 0, overLimit: 0 });
      await importPkc2File(h2.d, h2.deps, await archiveWith([{ tag: 'a', color: '#123456' }]));
      expect(h2.reportedNotes().join('\n')).not.toContain('上限のため');
    });

    it('🔴 色を 1 件でも足したら、取り消しにそれを伝える(取り消しは色を戻さない)。足さなければ伝えない', async () => {
      const h = harness();
      h.deps.importTagColors = async () => ({ added: 1, kept: 0, overLimit: 0 });
      await importPkc2File(h.d, h.deps, await archiveWith([{ tag: 'a', color: '#123456' }]));
      expect(h.importedOpts).toEqual([{ tagColors: true }]);
      // 対照群: 色が既に付いていて 1 件も足さなかった / 口が無い配線
      const kept = harness();
      kept.deps.importTagColors = async () => ({ added: 0, kept: 1, overLimit: 0 });
      await importPkc2File(kept.d, kept.deps, await archiveWith([{ tag: 'a', color: '#123456' }]));
      expect(kept.importedOpts).toEqual([{ tagColors: false }]);
    });

    it('🔴 足した色そのものを取り消しへ渡す(依頼 119-5 A。前から在った色は含めない)', async () => {
      const h = harness();
      h.deps.importTagColors = async () => ({
        added: 1,
        kept: 1,
        overLimit: 0,
        addedColors: [{ tag: 'new', color: '#123456' }],
      });
      await importPkc2File(
        h.d,
        h.deps,
        await archiveWith([
          { tag: 'new', color: '#123456' },
          { tag: 'old', color: '#abcdef' },
        ]),
      );
      expect(h.importedOpts).toEqual([{ tagColors: true, addedColors: [{ tag: 'new', color: '#123456' }] }]);
    });
  });

  /**
   * 🔴 **判定は末尾ではなく中身**(#1017 段④b)。⚠ ここが「新しい 3 種の末尾を
   *   足したら、判定を末尾で書いてしまった」を捕まえる ── 3 種 + 旧形式を
   *   受けるようにした変更のついでに、`file.name` を見る分岐を紛れ込ませても
   *   **上の一連の `a.pkc3.zip` を使う test は 1 つも落ちない**(名前を変えていない
   *   ので)。ここは**わざと末尾を外す**ことで、その変異を狙い撃つ。
   */
  it('🔴 末尾が `.pkc3.zip` 系のどれでもない名前でも、中身が pkc3-archive なら取り込む', async () => {
    const { ZipWriter } = await import('../../src/features/export/zip-writer');
    const { d, deps } = harness();
    const w = new ZipWriter();
    await w.add('manifest.json', ['{"format":"pkc3-archive","version":1}']);
    await w.add('container.json', [
      JSON.stringify({
        meta: {},
        entries: [
          {
            lid: 'n1',
            title: 'ノート',
            archetype: 'text',
            body: '本文',
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
        assets: [],
      }),
    ]);
    // 🔑 拡張子は `.bin`(3 種の末尾のどれでもなく `.zip`ですらない)
    expect(await importPkc2File(d, deps, new File([w.finish()], 'weird-name.bin'))).toBe(1);
  });

  /**
   * 🔴 **#1017 段④b 追補: 取込前に中身を言う確認**。
   * ⚠ `writeArchive` が書く manifest には `counts` が在る(上の一連の hand-built
   * fixture には無いので、それらは確認を出さずに素通る ── 回帰無し)。
   */
  describe('取込前の確認(#1017 段④b 追補)', () => {
    async function pkc3ArchiveFile(
      name: string,
      stamps: { created: string | null; updated: string | null } = { created: null, updated: null },
    ): Promise<File> {
      const { writeArchive } = await import('../../src/features/export/pkc3-archive');
      const src = {
        cid: 'c1',
        title: 'テスト',
        listEntryMetas: async () => [
          {
            lid: 'n1',
            title: 'ノート',
            archetype: 'text',
            created_at: stamps.created,
            updated_at: stamps.updated,
            entry_order: 1,
            status: null,
            date: null,
            archived: 0,
          },
        ],
        listBodies: async () => ({ rows: [{ lid: 'n1', body: '本文' }], done: true }),
        listRelations: async () => [],
        listAssetMetas: async () => [],
        getAssetBlob: async () => null,
        listRevisionLids: async () => [],
        getRevisionChain: async () => [],
      };
      const blob = (await writeArchive(src, '2026-09-21T00:00:00.000Z')).blob;
      return new File([blob], name);
    }

    it('🔴 バックアップのノートの作成・更新時刻が、書き込みへ運ばれる(取り込んだ時刻にならない) (#1087)', async () => {
      const { d, deps, written } = harness();
      const file = await pkc3ArchiveFile('a.pkc3-full.zip', {
        created: '2020-01-02 03:04:05',
        updated: '2021-02-03 04:05:06',
      });
      await importPkc2File(d, deps, file);
      expect(written, '前提: 1 件書いている').toHaveLength(1);
      expect(written[0]!.createdAt).toBe('2020-01-02 03:04:05');
      expect(written[0]!.updatedAt).toBe('2021-02-03 04:05:06');
    });

    it('🔴 `confirmArchiveImport` が `false` を返すと、1 件も書かずに終える(OP_FAILED も出さない)', async () => {
      const { d, deps, written, reloadCount, notices } = harness();
      deps.confirmArchiveImport = async () => false;
      const file = await pkc3ArchiveFile('a.pkc3-full.zip');

      const result = await importPkc2File(d, deps, file);

      expect(result).toBeNull();
      expect(written).toHaveLength(0);
      expect(reloadCount()).toBe(0);
      // ⚠ やめるのは失敗ではない ── OP_FAILED 相当の notify(取込に失敗…)は出ない
      expect(notices.some((n) => n.includes('失敗'))).toBe(false);
      expect(d.getState().error).toBeNull();
      // 🔴 やめたら「取込中…」を消す(#1017 C5)── もう進まないのに残ると「まだ続いている」と読める
      expect(notices[0], '前提が崩れた(確認の前に進行中の字を出していない)').toContain('取り込み中…');
      expect(notices.at(-1), 'やめたのに進行中の字が残る').toBe('');
    });

    it('🔑 `confirmArchiveImport` に渡る中身が、書いた archive と一致する', async () => {
      const { d, deps } = harness();
      const seen: unknown[] = [];
      deps.confirmArchiveImport = async (preview) => {
        seen.push(preview);
        return true;
      };
      const file = await pkc3ArchiveFile('a.pkc3-notes.zip');

      await importPkc2File(d, deps, file);

      expect(seen).toEqual([
        { noteCount: 1, assetCount: 0, hasRelations: false, hasRevisions: false, exportedAt: expect.any(String), partial: false },
      ]);
    });

    /** n 件のノートを持つバックアップ(題名は `ノート k`)。 */
    async function pkc3ArchiveFileOf(name: string, n: number): Promise<File> {
      const { writeArchive } = await import('../../src/features/export/pkc3-archive');
      const ids = Array.from({ length: n }, (_, i) => `n${String(i + 1)}`);
      const src = {
        cid: 'c1',
        title: 'テスト',
        listEntryMetas: async () =>
          ids.map((lid, i) => ({
            lid,
            title: `ノート ${String(i + 1)}`,
            archetype: 'text',
            created_at: null,
            updated_at: null,
            entry_order: i + 1,
            status: null,
            date: null,
            archived: 0,
          })),
        listBodies: async () => ({ rows: ids.map((lid) => ({ lid, body: '本文' })), done: true }),
        listRelations: async () => [],
        listAssetMetas: async () => [],
        getAssetBlob: async () => null,
        listRevisionLids: async () => [],
        getRevisionChain: async () => [],
      };
      const blob = (await writeArchive(src, '2026-09-21T00:00:00.000Z')).blob;
      return new File([blob], name);
    }

    it('🔴 1 件のノートのバックアップは、取り込んだノートを開く(#1643 依頼 38-1)', async () => {
      const { d, deps, written } = harness();
      const focused: string[] = [];
      deps.focus = (lid) => void focused.push(lid);
      await importPkc2File(d, deps, await pkc3ArchiveFileOf('a.pkc3-full.zip', 1));
      expect(written, '前提: 1 件書いている').toHaveLength(1);
      expect(focused, '開いたのは取り込んだノート(書き込み後の ID)').toEqual([written[0]!.lid]);
    });

    it('対照群: 2 件以上のバックアップは開かない(どれを開くのが正しいか決められない)', async () => {
      const { d, deps, written } = harness();
      const focused: string[] = [];
      deps.focus = (lid) => void focused.push(lid);
      await importPkc2File(d, deps, await pkc3ArchiveFileOf('a.pkc3-full.zip', 2));
      expect(written, '前提: 2 件書いている').toHaveLength(2);
      expect(focused).toEqual([]);
    });

    it('🔑 確認の窓にファイル名が渡る(#1643 依頼 38-3)', async () => {
      const { d, deps } = harness();
      const names: Array<string | undefined> = [];
      deps.confirmArchiveImport = async (_p, fileName) => {
        names.push(fileName);
        return true;
      };
      await importPkc2File(d, deps, await pkc3ArchiveFileOf('メモ-20261010.pkc3-full.zip', 1));
      expect(names).toEqual(['メモ-20261010.pkc3-full.zip']);
    });

    it('`true` を返すと、これまでどおり取り込む(旧 `.pkc3.zip` でも同じ)', async () => {
      const { d, deps, written } = harness();
      deps.confirmArchiveImport = async () => true;
      const file = await pkc3ArchiveFile('a.pkc3.zip'); // 旧形式の名前

      const result = await importPkc2File(d, deps, file);

      expect(result).toBe(1);
      expect(written.map((e) => e.lid)).toEqual(['n1']);
    });

    it('`confirmArchiveImport` を渡さない配線では、確認せずにこれまでどおり取り込む', async () => {
      const { d, deps, written } = harness(); // confirmArchiveImport は既定で未設定
      const file = await pkc3ArchiveFile('a.pkc3-full.zip');

      const result = await importPkc2File(d, deps, file);

      expect(result).toBe(1);
      expect(written).toHaveLength(1);
    });
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

  it('[P6c] 未対応の ZIP 形式は**名指しで**断る ── 書き込みは 1 件も起きない', async () => {
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

  it('[#1087] Markdown の zip は、更新では直らないと分かる字で断る(未知の形式は更新を案内する)', async () => {
    const { d, deps, written } = harness();
    const zip = await buildZip([
      { name: 'manifest.json', bytes: bytesOf(JSON.stringify({ format: 'pkc3-markdown', version: 1 })) },
    ]);
    expect(await importPkc2File(d, deps, new File([zip], 'a.md.zip'))).toBeNull();
    expect(written).toHaveLength(0);
    const err = d.getState().error ?? '';
    expect(err).toMatch(/Markdown の zip はそのままでは取り込めません/);
    expect(err).toMatch(/\.md を選んでください/);
    // 更新しても直らないものに「新しくしてから」と言わない / 形式名も出さない
    expect(err).not.toMatch(/新しくしてから|pkc3-markdown/);
    // 対照群:未知の形式は従来どおり更新を案内する
    const d2 = harness();
    const z2 = await buildZip([
      { name: 'manifest.json', bytes: bytesOf(JSON.stringify({ format: 'pkc2-future-format', version: 1 })) },
    ]);
    await importPkc2File(d2.d, d2.deps, new File([z2], 'b.zip'));
    expect(d2.d.getState().error).toMatch(/新しくしてから/);
  });

  it('[P6c] manifest.json の無い ZIP は可視で断る', async () => {
    const { d, deps, written } = harness();
    const zip = await buildZip([{ name: 'body.md', bytes: bytesOf('# x\n') }]);
    expect(await importPkc2File(d, deps, new File([zip], 'x.zip'))).toBeNull();
    expect(written).toHaveLength(0);
    expect(d.getState().error).toMatch(/PKC の書き出しではない zip/);
    // ⚠ 内部のファイル名を出さない(#1087)
    expect(d.getState().error).not.toMatch(/manifest/);
  });

  it('[B3] 途中で切れた(CRC が合わない)zip は「PKC の書き出しではない」と言わず、ダウンロードし直しを案内する', async () => {
    const { d, deps, written } = harness();
    const zip = await buildZip([
      {
        name: 'manifest.json',
        bytes: bytesOf(JSON.stringify({ format: 'pkc3-archive', version: 2, counts: { entries: 1 } })),
        corruptCrc: true,
      },
      { name: 'container.json', bytes: bytesOf('{"entries":[]}') },
    ]);
    expect(await importPkc2File(d, deps, new File([zip], 'broken.pkc3-full.zip'))).toBeNull();
    expect(written).toHaveLength(0);
    const err = d.getState().error ?? '';
    expect(err).toMatch(/ダウンロードが途中で切れた可能性/);
    expect(err).not.toMatch(/PKC の書き出しではない/);
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
    // 🔑 断りであって失敗ではない / pptx は取り込めることを言う(#1087)
    expect(d.getState().error).not.toMatch(/取り込みに失敗しました/);
    expect(d.getState().error).toContain('.pptx のファイルなら「取り込む」から取り込めます');
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

describe('同じものを 2 回取り込んだと気づく (#399 ②)', () => {
  const body = '# 買い物\n\n- 牛乳';

  /**
   * 🔴 **取込は止めない。言うだけ。**
   * ⚠ 止める側へ倒すと「**黙って取り込まれない**」になり、いまより悪い
   *   (増えたのは見えるが、入らなかったのは見えない)。
   */
  it('🔴 中身が同じなら注意を出す ── ただし取り込みは止めない', async () => {
    const { d, deps, written, reportedNotes } = harness({
      existingBodies: new Map([['old-1', body]]),
    });
    const file = htmlFile({
      container: { meta: {}, entries: [{ lid: 'n1', title: '買い物', body, archetype: 'text' }] },
    });
    await importPkc2File(d, deps, file);
    expect(reportedNotes().join('\n'), '重なりを黙っている').toContain('同じ内容のノートが 1 件');
    expect(reportedNotes().join('\n')).toContain('「買い物」');
    // 🔑 **止めていない** ── 書き込まれていることまで見る
    expect(written, '注意を出すために取込を止めている').toHaveLength(1);
  });

  /** ⚠ 対照群 ── 中身が違えば黙る(何にでも出す実装を殺す)。 */
  it('中身が違えば黙る', async () => {
    const { d, deps, written, reportedNotes } = harness({
      existingBodies: new Map([['old-1', '# ぜんぜん違う本文です']]),
    });
    const file = htmlFile({
      container: { meta: {}, entries: [{ lid: 'n1', title: '買い物', body, archetype: 'text' }] },
    });
    await importPkc2File(d, deps, file);
    expect(reportedNotes().join('\n')).not.toContain('同じ内容');
    expect(written).toHaveLength(1);
  });

  /** ⚠ 口が無い配線(旧い版)では、数えないだけで取込は今までどおり。 */
  it('口が無い配線でも取り込みは壊れない', async () => {
    const { d, deps, written, reportedNotes } = harness();
    const file = htmlFile({
      container: { meta: {}, entries: [{ lid: 'n1', title: '買い物', body, archetype: 'text' }] },
    });
    await importPkc2File(d, deps, file);
    expect(written).toHaveLength(1);
    expect(reportedNotes().join('\n')).not.toContain('同じ内容');
  });
});

/**
 * 🔴 **取り込んだ id を憶える**(#535 ② の漏れ)── md / 連絡先 / 予定 / pptx は憶えていたのに、
 *   PKC2 の書き出し・PKC3 のバックアップの取り込みだけ憶えていなかった。
 *   ⚠ 憶えないと「取り込みを取り消す」が出ないうえ、前の取り込みの取り消しが残っていればそれが出る。
 */
describe('取り込みの戻り道(バックアップ / PKC2)', () => {
  it('🔴 書いたノートの id を、面を組む(report)より先に憶える', async () => {
    const { d, deps, written } = harness();
    const order: string[] = [];
    let remembered: readonly string[] = [];
    const withUndo = {
      ...deps,
      imported: (lids: readonly string[]) => {
        remembered = lids;
        order.push('imported');
      },
      report: () => void order.push('report'),
    };
    const file = htmlFile({
      container: {
        meta: {},
        entries: [
          { lid: 'a', title: 'いち', archetype: 'text', body: '本文\n' },
          { lid: 'b', title: 'に', archetype: 'text', body: '本文 2\n' },
        ],
        assets: {},
      },
    });
    await importPkc2File(d, withUndo, file);
    expect(written.length, '前提: 2 件書けていない').toBe(2);
    expect([...remembered].sort(), '憶えた id が書いたノートと違う').toEqual(written.map((w) => w.lid).sort());
    expect(order, '面を組んだ後に憶えている(取り消しが出ない)').toEqual(['imported', 'report']);
  });
});

/**
 * 🔴 **バックアップを取り込み直すと lid が衝突して付け替わる ── 本文のリンクと履歴も付け替える**
 * (#1087、バックアップ往復の見直し)。
 * 直す前: つながりは複製を指すのに、本文の `entry:<lid>` は**既存の原本**を指したまま。
 * しかも本文を書き換えると履歴の起点がずれるので、書き換えるなら鎖にも同じ付け替えを添える必要がある。
 */
describe('取り込みで付け替えた lid を、本文と履歴へ当てる', () => {
  async function archiveWithLink(): Promise<File> {
    const { writeArchive } = await import('../../src/features/export/pkc3-archive');
    const meta = (lid: string, order: number) => ({
      lid,
      title: lid,
      archetype: 'text',
      created_at: null,
      updated_at: null,
      entry_order: order,
      status: null,
      date: null,
      archived: 0,
    });
    const src = {
      cid: 'c-src',
      title: 'T',
      listEntryMetas: async () => [meta('a1', 1), meta('b1', 2)],
      listBodies: async () => ({
        rows: [
          { lid: 'a1', body: '[B へ](entry:b1)\n' },
          { lid: 'b1', body: 'B の本文\n' },
        ],
        done: true,
      }),
      listRelations: async () => [],
      listAssetMetas: async () => [],
      getAssetBlob: async () => null,
      listRevisionLids: async () => ['a1', 'b1'],
      getRevisionChain: async () => [
        { revOrder: 1, createdAt: null, title: null, archetype: null, kind: 'full', snapshot: '古い版\n', contentHash: null },
      ],
    };
    return new File([(await writeArchive(src, '2026-10-14T00:00:00.000Z')).blob], 'b.pkc3-full.zip');
  }

  it('🔴 衝突した lid を指すリンクは複製を指し、その鎖には書き出したときの本文と付け替えが添う', async () => {
    // b1 だけが既存と衝突する(a1 は空いている)
    const { d, deps, written, restoredChains } = harness({ existingLids: new Set(['b1']) });
    expect(await importPkc2File(d, deps, await archiveWithLink())).toBe(2);

    const b = written.find((w) => w.title === 'b1')!;
    expect(b.lid, '前提: b1 が付け替わっていない').not.toBe('b1');
    const a = written.find((w) => w.title === 'a1')!;
    expect(a.body).toBe(`[B へ](entry:${b.lid})\n`);

    const chainA = restoredChains.find((c) => c.entryLid === a.lid)!;
    expect(chainA.rewrite?.tip, '鎖の起点が書き出したときの本文でない').toBe('[B へ](entry:b1)\n');
    expect(chainA.rewrite?.remap.lids).toEqual([['b1', b.lid]]);
    // 🔴 いまの本文が変わらないノートの鎖にも添える ── **古い版だけ**が旧 lid を指していることがある
    //    (b1 の今の本文に `entry:` は無いが、古い版が `entry:b1` を持っていても写せるように。着地前レビュー)
    const chainB = restoredChains.find((c) => c.entryLid === b.lid)!;
    expect(chainB.rewrite?.tip).toBe('B の本文\n');
    expect(chainB.rewrite?.remap.lids).toEqual([['b1', b.lid]]);
  });

  it('対照群: 衝突しなければリンクも鎖もそのまま', async () => {
    const { d, deps, written, restoredChains } = harness();
    await importPkc2File(d, deps, await archiveWithLink());
    expect(written.find((w) => w.lid === 'a1')!.body).toBe('[B へ](entry:b1)\n');
    expect(restoredChains.every((c) => c.rewrite === undefined)).toBe(true);
  });
});

describe('大きすぎて読み込めないとき(#1087)', () => {
  const TOO_LARGE = 'ファイルが大きすぎて読み込めませんでした';

  it('🔴 PKC2 の HTML を文字列にできない(RangeError)── 英語の例外の字を出さず、平らな字で断る', async () => {
    const { d, deps, written, failures } = harness({ captureFailure: true });
    const file = htmlFile({ container: { meta: {}, entries: [] }, export_meta: {} }, 'big.html');
    file.text = async () => {
      throw new RangeError('Invalid string length');
    };
    expect(await importPkc2File(d, deps, file)).toBeNull();
    expect(written).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toBe(`「big.html」: ${TOO_LARGE}(ノートは 1 件も追加されていません)`);
    expect(failures[0]!.message).not.toContain('Invalid string length');
    expect(failures[0]!.message, '失敗の前置きが付いた').not.toContain('取り込みに失敗');
  });

  it('対照群: 大きさと関係の無い RangeError は「大きすぎる」と言わない', async () => {
    const { d, deps, failures } = harness({ captureFailure: true });
    const file = htmlFile({ container: { meta: {}, entries: [] }, export_meta: {} }, 'x.html');
    file.text = async () => {
      throw new RangeError('Maximum call stack size exceeded');
    };
    expect(await importPkc2File(d, deps, file)).toBeNull();
    expect(failures[0]!.message).not.toContain(TOO_LARGE);
    expect(failures[0]!.message).toContain('Maximum call stack size exceeded');
  });

  it('🔴 バックアップの中身を文字列にできない(RangeError)── 「JSON として読めません」と言い換えず、同じ平らな字で断る', async () => {
    const { writeArchive } = await import('../../src/features/export/pkc3-archive');
    const src = {
      cid: 'c-src',
      title: 'T',
      listEntryMetas: async () => [
        { lid: 'a1', title: 'a1', archetype: 'text', created_at: null, updated_at: null, entry_order: 1, status: null, date: null, archived: 0 },
      ],
      listBodies: async () => ({ rows: [{ lid: 'a1', body: '本文\n' }], done: true }),
      listRelations: async () => [],
      listAssetMetas: async () => [],
      getAssetBlob: async () => null,
      listRevisionLids: async () => [],
      getRevisionChain: async () => [],
    };
    const file = new File([(await writeArchive(src, '2026-10-14T00:00:00.000Z')).blob], 'b.pkc3-full.zip');
    // ⚠ 形式の見分け(manifest)は通し、ノートのデータ(container)を読むところだけ落とす ── 全部落とすと別の断りに化ける
    const realParse = JSON.parse.bind(JSON);
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((text: string, reviver?: (k: string, v: unknown) => unknown) => {
      if (text.includes('"a1"') && !text.includes('"format"')) throw new RangeError('Invalid string length');
      return realParse(text, reviver);
    });
    try {
      const { d, deps, written, failures } = harness({ captureFailure: true });
      expect(await importPkc2File(d, deps, file)).toBeNull();
      expect(written).toHaveLength(0);
      expect(failures.map((f) => f.message).join('\n')).toContain(TOO_LARGE);
      expect(failures.map((f) => f.message).join('\n')).not.toContain('JSON として読めません');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('PKC2 の取り込み: 入口の断りとタグ・日時(#1087)', () => {
  it('🔴 章の欄が開いている間も断る(md / 連絡先 / 予定 / pptx と同じ判定・同じ字)', async () => {
    const { d, deps, written } = harness();
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        { lid: 'e1', title: 't', archetype: 'text', entryOrder: 1, status: null, date: null, archived: false, bodyChars: null, createdAt: null, updatedAt: null },
      ],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: '## 見出し\n\n中身\n' });
    d.dispatch({ type: 'OPEN_SECTION_DRAFT', lid: 'e1', line: 0 });
    expect(d.getState().phase, '前提が崩れている(phase が ready でない)').toBe('ready');
    expect(d.getState().sectionDraft, '前提が崩れている(開けていない)').not.toBeNull();

    const file = htmlFile({
      container: { meta: {}, entries: [{ lid: 'a', title: 'n', archetype: 'text', body: 'x\n' }] },
      export_meta: {},
    });
    expect(await importPkc2File(d, deps, file)).toBeNull();
    expect(written, '章の欄が開いているのに書込が起きた').toHaveLength(0);
    expect(d.getState().error).toBe(SECTION_DRAFT_NOTE);
    expect(d.getState().sectionDraft, '断ったのに章の欄が消えた').not.toBeNull();
  });

  it('🔴 タグと作成・更新日時が、書込の行まで届く(PKC2 の書き出し)', async () => {
    const { d, deps, written } = harness();
    const file = htmlFile({
      container: {
        meta: {},
        entries: [
          { lid: 'a', title: 'n', archetype: 'text', body: '本文\n', tags: ['請求', '家事'], created_at: '2025-03-04T05:06:07.000Z', updated_at: '2025-03-05T00:00:00.000Z' },
        ],
      },
      export_meta: {},
    });
    expect(await importPkc2File(d, deps, file)).toBe(1);
    expect(written[0]!.createdAt).toBe('2025-03-04 05:06:07');
    expect(written[0]!.updatedAt).toBe('2025-03-05 00:00:00');
    expect(readTags(written[0]!.body)).toEqual(['請求', '家事']);
  });
});

describe('[B6] 添付が多いバックアップの取り込みは、進み具合(N / M)を出す', () => {
  it('45 件の添付: 20 件ごとに「添付を書き込んでいます N / M」が出て、最後は完了の知らせになる', async () => {
    const { d, deps, notices } = harness();
    const keys = Array.from({ length: 45 }, (_, i) => `ast-${String(i).padStart(4, '0')}`);
    const zip = await buildZip([
      {
        name: 'manifest.json',
        bytes: bytesOf(JSON.stringify({ format: 'pkc3-archive', version: 2, counts: { entries: 1 } })),
      },
      {
        name: 'container.json',
        bytes: bytesOf(
          JSON.stringify({
            entries: [
              {
                lid: 'n1', title: 'ノート', archetype: 'text', createdAt: null, updatedAt: null,
                entryOrder: 1, status: null, date: null, archived: false, body: '本文',
              },
            ],
            relations: [],
            revisions: [],
            assets: keys.map((k) => ({ key: k, mime: 'image/png', size: 1, hash: null })),
          }),
        ),
      },
      ...keys.map((k, i) => ({ name: `assets/${k}`, bytes: bytesOf(`bytes-${i}`) })),
    ]);
    expect(await importPkc2File(d, deps, new File([zip], 'a.pkc3-full.zip'))).toBe(1);
    const progress = notices.filter((m) => /添付を書き込んでいます \d+ \/ \d+/.test(m));
    expect(progress).toContain('取り込み中(添付を書き込んでいます 20 / 45)');
    expect(progress).toContain('取り込み中(添付を書き込んでいます 40 / 45)');
    expect(progress.some((m) => m.includes('45 / 45'))).toBe(false);
    expect(notices.at(-1)).toMatch(/^取り込み完了: 1 件/);
  });
});

describe('取り込みの取りこぼし(I-2 / I-3 / I-5)', () => {
  const oneNote = (assets?: Record<string, string>) =>
    htmlFile({
      container: {
        meta: {},
        entries: [{ lid: 'a', title: 'ノート', archetype: 'text', body: 'x\n' }],
        ...(assets ? { assets } : {}),
      },
      export_meta: { asset_encoding: 'base64' },
    });

  it('[I-2] 取り込みが飛んでいる間は「書いている」で、成功しても終われば戻す', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const seen: boolean[][] = [];
    const h = harness({
      onBlob: async () => {
        seen.push([...h.writingLog]); // 添付を書いている最中の記録
        await gate;
      },
    });
    const file = htmlFile({
      container: {
        meta: {},
        entries: [
          { lid: 'att', title: 'a', archetype: 'attachment', body: JSON.stringify({ name: 'a.txt', mime: 'text/plain', asset_key: 'k' }) },
        ],
        assets: { k: base64('bytes') },
      },
      export_meta: { asset_encoding: 'base64' },
    });
    const running = importPkc2File(h.d, h.deps, file);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0], '書込が飛んでいる間に「書いている」になっていない').toEqual([true]);
    release();
    expect(await running).toBe(1);
    expect(h.writingLog, '終わっても戻していない').toEqual([true, false]);
  });

  it('[I-2] 断った取り込み・書込が失敗した取り込みでも戻す(戻し忘れで確認が出続けない)', async () => {
    const refused = harness();
    expect(await importPkc2File(refused.d, refused.deps, new File(['<html>PKC2 ではない</html>'], 'x.html'))).toBeNull();
    expect(refused.writingLog).toEqual([true, false]);

    const failed = harness({ failRelations: true });
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
    expect(await importPkc2File(failed.d, failed.deps, file)).toBeNull();
    expect(failed.writingLog).toEqual([true, false]);
  });

  it('[I-3] 空き容量が無くて添付が書けないときは、ノートを 1 件も書かずに 1 つの断りで終える', async () => {
    const h = harness({ failBlob: Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' }), captureFailure: true });
    const file = htmlFile({
      container: {
        meta: {},
        entries: ['a', 'b', 'c'].map((k) => ({
          lid: `att-${k}`,
          title: `添付${k}`,
          archetype: 'attachment',
          body: JSON.stringify({ name: `${k}.txt`, mime: 'text/plain', asset_key: `k-${k}` }),
        })),
        assets: { 'k-a': base64('A'), 'k-b': base64('B'), 'k-c': base64('C') },
      },
      export_meta: { asset_encoding: 'base64' },
    });
    expect(await importPkc2File(h.d, h.deps, file)).toBeNull();
    expect(h.written, '空きが無いのにノートだけ書いた').toEqual([]);
    expect(h.importedCalls).toEqual([]);
    expect(h.reportCalls()).toBe(0);
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]!.message).toContain('空きが足りないため取り込めませんでした');
    expect(h.failures[0]!.message).toContain('ノートは 1 件も追加されていません');
    expect(h.notices.at(-1), '進行中の字が残る').toBe('');
  });

  it('[I-3] 対照群: 空き容量以外の理由で添付が落ちたときは、従来どおりノートは入って注意が出る', async () => {
    const h = harness({ failBlob: new Error('別の理由') });
    expect(
      await importPkc2File(
        h.d,
        h.deps,
        htmlFile({
          container: {
            meta: {},
            entries: [{ lid: 'att', title: 'a', archetype: 'attachment', body: JSON.stringify({ name: 'a.txt', mime: 'text/plain', asset_key: 'k' }) }],
            assets: { k: base64('A') },
          },
          export_meta: { asset_encoding: 'base64' },
        }),
      ),
    ).toBe(1);
    expect(h.reportedNotes().join('\n')).toContain('「a」の添付を復元できませんでした');
  });

  it('[I-3] 同じ文の注意は 1 行にして件数を添える', async () => {
    // 同じ題名のノートに付いた添付 3 本が、同じ理由で落ちる → 同じ文が 3 本できる
    const h = harness({ failBlob: new Error('別の理由') });
    const file = htmlFile({
      container: {
        meta: {},
        entries: ['a', 'b', 'c'].map((k) => ({
          lid: `att-${k}`,
          title: '同じ題名',
          archetype: 'attachment',
          body: JSON.stringify({ name: `${k}.txt`, mime: 'text/plain', asset_key: `k-${k}` }),
        })),
        assets: { 'k-a': base64('A'), 'k-b': base64('B'), 'k-c': base64('C') },
      },
      export_meta: { asset_encoding: 'base64' },
    });
    expect(await importPkc2File(h.d, h.deps, file)).toBe(3);
    const lines = h.reportedNotes().filter((n) => n.includes('の添付を復元できませんでした'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('(3 件)');
  });

  it('[I-5] ノートが 1 件も入っていない書き出しは成功にしない ── 前の取り込みの取り消しを空で上書きしない', async () => {
    const h = harness({ captureFailure: true });
    const empty = htmlFile({
      container: {
        meta: {},
        // システム用のノートしか無い(取り込む物が 0 件)
        entries: [{ lid: '__settings__', title: 'x', archetype: 'system-settings', body: '{}' }],
      },
      export_meta: {},
    });
    expect(await importPkc2File(h.d, h.deps, empty)).toBeNull();
    expect(h.failures.map((f) => f.message)).toEqual(['取り込めるノートが 1 件も入っていませんでした']);
    expect(h.importedCalls, '空の一覧で「取り消し」の記憶を上書きした').toEqual([]);
    expect(h.reportCalls()).toBe(0);
    expect(h.notices.some((n) => n.includes('取り込み完了')), '0 件を成功と言った').toBe(false);
    // 対照群: 1 件でも入っていれば今までどおり憶える
    const ok = harness();
    expect(await importPkc2File(ok.d, ok.deps, oneNote())).toBe(1);
    expect(ok.importedCalls).toEqual([['a']]);
  });
});
