/** @vitest-environment happy-dom */
/**
 * asset の content addressing(user 指示 2026-08-01)。
 *
 * > 「ハッシュとって同一なら差分ができるまでリンク参照する ZFS と同じ発想でいい」
 *
 * 主題は「重複が**構造的に**起きない」こと ── 検出して避けるのではなく、
 * 同じ bytes が同じ key に落ちる結果としてそうなる。したがって網も
 * 「1 部しか書かれない」を**経路をまたいで**確かめる:
 * 取込 × 再取込 / 取込内の重複 / 取込 → 添付 / 添付 → 取込。
 */
import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import {
  identifyAsset,
  identifyBytes,
  isContentKey,
  generateAssetKey,
  HASH_MAX_BYTES,
} from '../../src/adapter/platform/storage/asset-key';
import { attachFiles, type AttachDeps } from '../../src/adapter/ui/actions/attach';
import {
  importPkc2File,
  consumeBase64,
  type ImportDeps,
} from '../../src/adapter/ui/actions/import-pkc2';
import { readAttachmentMeta } from '../../src/features/flavor/attachment-flavor';
import type { RevisionChain } from '../../src/features/import/pkc2-convert';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { stubRevisionOps } from '../helpers/revision-stub';

const b64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

function pkc2HtmlFile(assets: Record<string, string>, keys: string[]): File {
  const entries = keys.map((k, i) => ({
    lid: `att${i}`,
    title: `f${i}.txt`,
    archetype: 'attachment',
    body: JSON.stringify({ name: `f${i}.txt`, mime: 'text/plain', asset_key: k }),
  }));
  const payload = {
    container: { meta: {}, entries, assets },
    export_meta: { mode: 'full', asset_encoding: 'base64' },
  };
  const html = `<!doctype html><html><head>
    <script id="pkc-meta" type="application/json">{"app":"pkc2","schema":1}</script>
  </head><body>
    <script id="pkc-data" type="application/json">${JSON.stringify(payload)}</script>
  </body></html>`;
  return new File([html], 'c.html', { type: 'text/html' });
}

/** 取込と添付が**同じ倉庫**を見る harness(経路をまたぐ dedup を見るため)。 */
function shared() {
  const blobs = new Map<string, Blob>();
  const metas: Array<{ key: string; mime: string; size: number; hash: string | null }> =
    [];
  const putLog: string[] = [];
  const revChains: RevisionChain[] = [];
  let n = 0;

  const d = new Dispatcher();
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => null,
    /**
     * ⚠ **題名だけの口**(#178)── 本物は本文に触らない。
     *   だから fake も本文を持たない(触らないものは持たない)。
     */
    renameEntry: async () => stubStamps(),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });

  const put = async (key: string, blob: Blob) => {
    putLog.push(key);
    blobs.set(key, blob);
  };

  const importDeps: ImportDeps = {
    existingLids: async () => new Set(d.getState().entryMetas.keys()),
    existingRelationIds: () => new Set(),
    orderBase: () => 0,
    genLid: () => `lid-${++n}`,
    genAssetKey: () => `prov-${++n}`,
    genRelationId: () => `rel-${++n}`,
    bulkUpsertEntries: async () => {},
    bulkUpsertRelations: async () => {},
    listStoredBlobKeys: async () => new Set(blobs.keys()),
    restoreRevisionChains: async () => ({
      added: 0,
      skippedNoChange: 0,
      droppedOverLimit: 0,
      skippedEntries: [],
      brokenChains: [],
    }),
    importRevisionChains: async (chains) => {
      revChains.push(...chains);
      return {
        added: chains.reduce((n, c) => n + c.snapshots.length, 0),
        skippedNoChange: 0,
        droppedOverLimit: 0,
        skippedEntries: [],
      };
    },
    putBlob: put,
    putAssetMeta: async (m) => void metas.push(m),
    reload: async () => {},
  };

  const attachDeps: AttachDeps = {
    putBlob: put,
    putMeta: async (m) => void metas.push(m),
    listMetas: async () => metas.map((m) => ({ key: m.key, size: m.size, hash: m.hash })),
  };

  return { d, importDeps, attachDeps, blobs, metas, putLog, revChains };
}

describe('identifyAsset (content addressing)', () => {
  it('同じ bytes → 同じ key / 違う bytes → 違う key', async () => {
    const a = await identifyAsset(new Blob(['同じ中身']));
    const b = await identifyAsset(new Blob(['同じ中身']));
    const c = await identifyAsset(new Blob(['ちがう中身']));
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
    expect(isContentKey(a.key)).toBe(true);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mime / ファイル名が違っても中身が同じなら同じ key(中身だけで決まる)', async () => {
    const x = await identifyAsset(new Blob(['data'], { type: 'text/plain' }));
    const y = await identifyAsset(new Blob(['data'], { type: 'application/json' }));
    expect(x.key).toBe(y.key);
  });

  it('閾値超は採番へ落ちる ── その 1 件だけ dedupe されないことを観測できる', async () => {
    // 64MB を実際に確保しない(閾値の分岐だけを見る)
    const huge = { size: HASH_MAX_BYTES + 1 } as Blob;
    const got = await identifyAsset(huge);
    expect(got.hash).toBeNull(); // dedupe 対象外であることが hash===null で分かる
    expect(isContentKey(got.key)).toBe(false);
  });

  it('採番 key は content key と見分けがつく(旧データが混ざっても判別できる)', () => {
    expect(isContentKey(generateAssetKey())).toBe(false);
    expect(isContentKey('ast-' + 'f'.repeat(64))).toBe(true);
    expect(isContentKey('ast-' + 'F'.repeat(64))).toBe(false); // 小文字 hex のみ
  });
});

describe('重複は構造的に起きない', () => {
  it('同じファイルを 2 回取り込んでも bytes は 1 部だけ', async () => {
    const { d, importDeps, blobs, putLog } = shared();
    const assets = { 'pkc2-k1': b64('添付の中身') };

    await importPkc2File(d, importDeps, pkc2HtmlFile(assets, ['pkc2-k1']));
    await importPkc2File(d, importDeps, pkc2HtmlFile(assets, ['pkc2-k1']));

    expect(putLog).toHaveLength(1); // 2 回目は書かない
    expect(blobs.size).toBe(1);
  });

  it('1 回の取込の中に同一 bytes が 2 件あっても 1 部だけ', async () => {
    const { d, importDeps, blobs, putLog } = shared();
    const same = b64('まったく同じ bytes');

    await importPkc2File(
      d,
      importDeps,
      pkc2HtmlFile({ ka: same, kb: same }, ['ka', 'kb']),
    );

    expect(putLog).toHaveLength(1);
    expect(blobs.size).toBe(1);
  });

  it('取込 → 同じファイルを添付 でも 1 部だけ(経路をまたいで効く)', async () => {
    const { d, importDeps, attachDeps, blobs, putLog } = shared();
    const text = '経路をまたぐ中身';

    await importPkc2File(d, importDeps, pkc2HtmlFile({ k: b64(text) }, ['k']));
    expect(putLog).toHaveLength(1);

    // 取込済みの bytes と同一のファイルを後から添付する
    await attachFiles(d, attachDeps, [new File([text], 'same.txt', { type: 'text/plain' })]);

    expect(putLog).toHaveLength(1); // 増えない
    expect(blobs.size).toBe(1);
  });

  it('添付 → 同じ中身を取込 でも 1 部だけ(逆向きも効く)', async () => {
    const { d, importDeps, attachDeps, blobs, putLog } = shared();
    const text = '逆向きの中身';

    await attachFiles(d, attachDeps, [new File([text], 'a.txt', { type: 'text/plain' })]);
    expect(putLog).toHaveLength(1);

    await importPkc2File(d, importDeps, pkc2HtmlFile({ k: b64(text) }, ['k']));

    expect(putLog).toHaveLength(1);
    expect(blobs.size).toBe(1);
  });

  it('取り込んだ asset も hash 付きで台帳に載る(添付側から見える)', async () => {
    const { d, importDeps, metas } = shared();
    await importPkc2File(d, importDeps, pkc2HtmlFile({ k: b64('x') }, ['k']));
    // hash: null で書いていると、後から同じファイルを添付したとき 2 部目ができる
    expect(metas).toHaveLength(1);
    expect(metas[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(metas[0]!.key).toBe(`ast-${metas[0]!.hash}`);
  });
});

describe('body の参照が content key へ写る', () => {
  it('attachment frontmatter の asset_key が実際に書いた key と一致する', async () => {
    const written: Array<{ body: string }> = [];
    const { d, importDeps, blobs } = shared();
    const deps: ImportDeps = {
      ...importDeps,
      bulkUpsertEntries: async (es) => void written.push(...es),
    };

    await importPkc2File(d, deps, pkc2HtmlFile({ 'pkc2-key': b64('中身') }, ['pkc2-key']));

    const key = [...blobs.keys()][0]!;
    expect(isContentKey(key)).toBe(true);
    // 暫定 key(prov-*)や PKC2 の旧 key が残っていたら死んだ参照になる
    expect(readAttachmentMeta(written[0]!.body).assetKey).toBe(key);
    expect(written[0]!.body).not.toContain('prov-');
    expect(written[0]!.body).not.toContain('pkc2-key');
  });

  it('本文 markdown の `asset:` 参照も同じ key へ写る', async () => {
    const written: Array<{ lid: string; body: string }> = [];
    const { d, importDeps, blobs } = shared();
    const payload = {
      container: {
        meta: {},
        entries: [
          {
            lid: 'att',
            title: 'p.txt',
            archetype: 'attachment',
            body: JSON.stringify({ name: 'p.txt', mime: 'text/plain', asset_key: 'ok' }),
          },
          {
            lid: 'note',
            title: 'note',
            archetype: 'text',
            body: '![図](asset:ok)\n\n[DL](asset:ok)\n',
          },
        ],
        assets: { ok: b64('画像のつもり') },
      },
      export_meta: {},
    };
    const html = `<!doctype html><html><head>
      <script id="pkc-meta" type="application/json">{"app":"pkc2","schema":1}</script>
      </head><body>
      <script id="pkc-data" type="application/json">${JSON.stringify(payload)}</script>
      </body></html>`;

    await importPkc2File(
      d,
      { ...importDeps, bulkUpsertEntries: async (es) => void written.push(...es) },
      new File([html], 'c.html', { type: 'text/html' }),
    );

    const key = [...blobs.keys()][0]!;
    const note = written.find((e) => e.lid === 'note')!;
    expect(note.body).toContain(`asset:${key}`);
    expect(note.body).not.toContain('asset:ok');
    expect(note.body.match(new RegExp(`asset:${key}`, 'g'))).toHaveLength(2); // 2 箇所とも
  });
});

describe('生成物の寿命', () => {
  it('[M-15] base64 は取り出すと同時に手放す(参照を残さない)', () => {
    const a = { base64: 'QUJD' };
    expect(consumeBase64(a)).toBe('QUJD');
    // 参照が残ると、復号済み bytes と base64 文字列が同時生存して常駐が積み上がる
    expect(a.base64).toBe('');
  });

  it('[M-5] 取込は bytes から直接ハッシュを取る(Blob 経由でコピーを増やさない)', async () => {
    const bytes = new TextEncoder().encode('中身');
    const viaBytes = await identifyBytes(bytes as Uint8Array<ArrayBuffer>);
    const viaBlob = await identifyAsset(new Blob([bytes]));
    expect(viaBytes.key).toBe(viaBlob.key); // 経路が違っても同じ key
    expect(viaBytes.hash).toBe(viaBlob.hash);
  });
});
