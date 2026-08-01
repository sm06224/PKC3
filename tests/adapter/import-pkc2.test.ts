/** @vitest-environment happy-dom */
/**
 * P6b: PKC2 取込の**実行部** unit(判別 → 抽出 → 変換 → 書込 → 再読込)。
 *
 * 網の狙いは 2 つ:
 * ① 取り込めたものが**実際に state へ現れる**こと(変換 core の unit だけでは
 *    「書いたつもり」を検出できない)
 * ② 取り込めない入力で**書込が 1 件も起きない**こと(半端に書いてから失敗する
 *    経路を作らない ── PKC2 で実際にデータを壊した形)
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { importPkc2File, type ImportDeps } from '../../src/adapter/ui/actions/import-pkc2';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import type { RevisionChain } from '../../src/features/import/pkc2-convert';
import { readAttachmentMeta } from '../../src/features/flavor/attachment-flavor';

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
}

function harness(opts: HarnessOptions = {}) {
  const written: EntryUpsert[] = [];
  const relations: Array<{ id: string; fromLid: string; toLid: string; kind: string }> = [];
  const blobs = new Map<string, Blob>();
  const metas: Array<{ key: string; mime: string; size: number }> = [];
  const notices: string[] = [];
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
    listAssetKeys: async () => new Set(blobs.keys()),
    importRevisionChains: async (chains) => {
      revChains.push(...chains);
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
      metas.push({ key: m.key, mime: m.mime, size: m.size });
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
  };
  return {
    d,
    deps,
    written,
    relations,
    blobs,
    metas,
    notices,
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
      { key, mime: 'text/plain', size: new TextEncoder().encode(payload).length },
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

  it('light export(assets 空)は bytes を書かず entry だけ取り込む + light と明言する', async () => {
    const { d, deps, blobs, written, notices } = harness();
    const file = htmlFile({
      container: {
        meta: {},
        entries: [{ lid: 'a', title: 'n', archetype: 'text', body: '本文\n' }],
        assets: { k: '' },
      },
      export_meta: { mode: 'light' },
    });

    await importPkc2File(d, deps, file);
    expect(blobs.size).toBe(0);
    expect(written).toHaveLength(1);
    // mode を parse しているのに黙っていると、user は添付が入った気になる
    expect(notices.at(-1)).toMatch(/添付の中身は含まれていない/);
  });

  it('light export の attachment は「中身が無い」と件数で言う(開くまで気づかせない)', async () => {
    const { d, deps, notices } = harness();
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
    expect(notices.at(-1)).toMatch(/請求書\.pdf/);
    expect(notices.at(-1)).toMatch(/注意 2 件/); // light 本体 + 個別の欠損
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

  it('ZIP 形式は「まだ未実装」と可視で断る ── 書込は 1 件も起きない', async () => {
    const { d, deps, written, blobs } = harness();
    const zip = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])], 'pkg.zip');

    expect(await importPkc2File(d, deps, zip)).toBeNull();
    expect(written).toHaveLength(0);
    expect(blobs.size).toBe(0);
    expect(d.getState().error).toMatch(/まだ実装されていません/);
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
    const { d, deps, relations, notices } = harness();
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
    const { d, deps, written, blobs, notices } = harness();
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
    expect(notices.at(-1)).toMatch(/添付を復元できませんでした/);
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
});
