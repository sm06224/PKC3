/** @vitest-environment happy-dom */
/**
 * P6f: 1 ノートだけのアーカイブ。
 *
 * user 指示 2026-08-02:
 * 「そういうのは削除じゃなくて**アーカイブエクスポートの導線**を用意すればいいのでは?」
 *
 * ── **消す前に手元へ出せる**ことが目的なので、見るのは
 * ① そのノートが丸ごと入るか(本文 / 履歴 / 添付)
 * ② **他のノートが混ざらないか**
 * ③ 落ちるもの(関連)を言うか
 * の 3 点。形式はバックアップと同じなので、そのまま取り込み直せる。
 */
import { describe, expect, it } from 'vitest';
import { singleEntrySource } from '../../src/features/export/single-entry-source';
import { scanAssetRefsInto } from '../../src/features/asset/asset-ref-scan';
import {
  writeArchive,
  readArchive,
  restoreArchive,
  type ArchiveSource,
} from '../../src/features/export/pkc3-archive';

const enc = new TextEncoder();
const NOW = '2026-08-02T00:00:00.000Z';

interface Fake {
  entries: Array<{ lid: string; title?: string; body: string }>;
  assets?: Array<{ key: string; mime: string; bytes: Uint8Array }>;
  chains?: Record<string, Array<{ revOrder: number; kind: string; snapshot: string }>>;
  relations?: Array<{ from: string; to: string }>;
  batch?: number;
}

function source(f: Fake): ArchiveSource {
  const entries = f.entries.map((e, i) => ({
    lid: e.lid,
    title: e.title ?? e.lid,
    archetype: 'text',
    created_at: null,
    updated_at: null,
    entry_order: i + 1,
    status: null,
    date: null,
    archived: 0,
    body: e.body,
  }));
  return {
    cid: 'c1',
    title: 'コンテナ',
    listEntryMetas: async () =>
      entries.map((e) => {
        const { body, ...m } = e;
        void body;
        return m;
      }),
    listBodies: async (after) => {
      const rest = after ? entries.filter((e) => e.entry_order > after.entryOrder) : entries;
      const slice = rest.slice(0, Math.max(1, f.batch ?? entries.length));
      const last = slice[slice.length - 1];
      return {
        rows: slice.map((e) => ({ lid: e.lid, body: e.body })),
        done: slice.length >= rest.length,
        ...(last ? { next: { entryOrder: last.entry_order, lid: last.lid } } : {}),
      };
    },
    listRelations: async () =>
      (f.relations ?? []).map((r, i) => ({
        id: `r${i}`,
        from_lid: r.from,
        to_lid: r.to,
        kind: 'link',
        created_at: null,
        updated_at: null,
      })),
    listAssetMetas: async () =>
      (f.assets ?? []).map((a) => ({
        key: a.key,
        mime: a.mime,
        size: a.bytes.length,
        hash: null,
      })),
    getAssetBlob: async (key) => {
      const a = (f.assets ?? []).find((x) => x.key === key);
      return a ? new Blob([a.bytes as unknown as BlobPart]) : null;
    },
    listRevisionLids: async () => Object.keys(f.chains ?? {}),
    getRevisionChain: async (lid) =>
      (f.chains?.[lid] ?? []).map((r) => ({
        revOrder: r.revOrder,
        createdAt: null,
        title: null,
        archetype: null,
        kind: r.kind,
        snapshot: r.snapshot,
        contentHash: null,
      })),
  };
}

describe('1 ノートの書出し — そのノートが丸ごと入る', () => {
  it('本文と履歴が入る', async () => {
    const { source: one } = await singleEntrySource(
      source({
        entries: [
          { lid: 'n1', title: '議事録', body: 'いまの本文' },
          { lid: 'n2', title: 'ほか', body: '別のノート' },
        ],
        chains: { n1: [{ revOrder: 1, kind: 'full', snapshot: '古い本文' }] },
      }),
      'n1',
    );
    const got = await readArchive((await writeArchive(one, NOW)).blob);
    expect(got.entries.map((e) => [e.lid, e.body])).toEqual([['n1', 'いまの本文']]);
    expect(got.revisions.map((r) => [r.entryLid, r.snapshot])).toEqual([['n1', '古い本文']]);
  });

  it('🔴 他のノートが混ざらない(本文も履歴も添付も)', async () => {
    const { source: one } = await singleEntrySource(
      source({
        entries: [
          { lid: 'n1', body: 'こっち ![](asset:ast-mine)' },
          { lid: 'n2', body: 'あっち ![](asset:ast-other)' },
        ],
        chains: {
          n1: [{ revOrder: 1, kind: 'full', snapshot: 'こっちの古い版' }],
          n2: [{ revOrder: 1, kind: 'full', snapshot: 'あっちの古い版' }],
        },
        assets: [
          { key: 'ast-mine', mime: 'image/png', bytes: enc.encode('MINE') },
          { key: 'ast-other', mime: 'image/png', bytes: enc.encode('OTHER') },
        ],
      }),
      'n1',
    );
    const got = await readArchive((await writeArchive(one, NOW)).blob);
    expect(got.entries).toHaveLength(1);
    expect(got.revisions.every((r) => r.entryLid === 'n1')).toBe(true);
    expect(got.assets.map((a) => a.key)).toEqual(['ast-mine']);
    expect([...got.assetSources.keys()]).toEqual(['ast-mine']);
  });

  it('🔑 **過去の版だけが参照していた添付**も入る(逆向きパッチを走査する)', async () => {
    // パッチは「古い版の行」を*挿入する*形で持つので、materialize しなくても
    // 文字列として現れる ── ここを取りこぼすと、書き出したノートを戻したときに
    // 履歴の画像だけリンク切れになる
    const { source: one } = await singleEntrySource(
      source({
        entries: [{ lid: 'n1', body: 'いまは画像なし' }],
        chains: {
          n1: [{ revOrder: 1, kind: 'patch', snapshot: '{"v":1,"ops":[["![](asset:ast-old)\\n"]]}' }],
        },
        assets: [{ key: 'ast-old', mime: 'image/png', bytes: enc.encode('OLD') }],
      }),
      'n1',
    );
    const got = await readArchive((await writeArchive(one, NOW)).blob);
    expect([...got.assetSources.keys()]).toEqual(['ast-old']);
  });

  /**
   * 🔴 **GC が keep する添付は、1 ノート書出しにも必ず入る**。
   *
   * この parity が無かったので、判定を「key らしき token の exact 一致」に
   * 書いたときに**生きた参照を無警告で落とした**(review H-1)。
   * user はそれを見て安心してノートを消す ── 導線としては最悪の壊れ方。
   * 規則が 1 つであることを、**規則そのもの**に対して assert する。
   */
  it.each([
    ['素の参照', '![図](asset:ast-aaa)'],
    ['文末の句読点', '詳しくは asset:ast-aaa。'],
    ['直後が英数字で終わる形', '`asset:ast-aaa` を見よ'],
    ['backslash escape', '![図](asset:ast\\-aaa)'],
    ['数値実体', '![図](asset:ast&#45;aaa)'],
    ['frontmatter の asset_key', '---\nattachment.asset_key: ast-aaa\n---\n'],
    ['extra の JSON に埋もれた参照', '---\nattachment.extra: {"icon":"ast-aaa"}\n---\n'],
  ])('🔴 GC が keep する形は全部入る(%s)', async (_label, body) => {
    const key = 'ast-aaa';
    // ① GC の規則(正本)が keep するか
    const remaining = new Set([key]);
    const kept: string[] = [];
    scanAssetRefsInto(body, remaining, (k) => kept.push(k));
    expect(kept).toEqual([key]); // 前提: これは「生きた参照」である

    // ② 1 ノート書出しも同じものを入れるか
    const { source: one } = await singleEntrySource(
      source({
        entries: [{ lid: 'n1', body }],
        assets: [{ key, mime: 'image/png', bytes: enc.encode('PNG') }],
      }),
      'n1',
    );
    const got = await readArchive((await writeArchive(one, NOW)).blob);
    expect([...got.assetSources.keys()]).toEqual([key]);
  });

  it('🔴 履歴のパッチにだけ現れる escape 済み参照も拾う(JSON で二重化する)', async () => {
    // patch の snapshot は JSON テキストなので backslash が二重化する ──
    // unescape を 1 パスにすると、古い版にしか無い参照を落とす
    const key = 'ast-bbb';
    const { source: one } = await singleEntrySource(
      source({
        entries: [{ lid: 'n1', body: 'いまは画像なし' }],
        chains: {
          n1: [
            { revOrder: 1, kind: 'patch', snapshot: JSON.stringify({ v: 1, ops: [['![](asset:ast\\-bbb)\n']] }) },
          ],
        },
        assets: [{ key, mime: 'image/png', bytes: enc.encode('OLD') }],
      }),
      'n1',
    );
    const got = await readArchive((await writeArchive(one, NOW)).blob);
    expect([...got.assetSources.keys()]).toEqual([key]);
  });

  it('meta も 1 件だけ(全 entry の一覧を流さない)', async () => {
    const { source: one } = await singleEntrySource(
      source({ entries: [{ lid: 'n1', body: 'a' }, { lid: 'n2', body: 'b' }] }),
      'n1',
    );
    expect(await one.listEntryMetas()).toHaveLength(1);
  });

  it('題名がファイル名の元になる(コンテナ名ではなく)', async () => {
    const { source: one } = await singleEntrySource(
      source({ entries: [{ lid: 'n1', title: '打ち合わせメモ', body: 'x' }] }),
      'n1',
    );
    expect(one.title).toBe('打ち合わせメモ');
  });

  it('題名が空でも空文字にしない(ファイル名が壊れる)', async () => {
    const { source: one } = await singleEntrySource(
      source({ entries: [{ lid: 'n1', title: '', body: 'x' }] }),
      'n1',
    );
    expect(one.title).toBe('n1');
  });

  it('履歴の無いノートも書き出せる', async () => {
    const { source: one } = await singleEntrySource(
      source({ entries: [{ lid: 'n1', body: 'x' }] }),
      'n1',
    );
    const got = await readArchive((await writeArchive(one, NOW)).blob);
    expect(got.revisions).toEqual([]);
  });

  it('🔴 `getBody` があれば `listBodies` を舐めない(1 件のために全部読まない)', async () => {
    // 実測: 300 件 × 100KB の container で、対象の **300 倍**の本文が worker 境界を
    // 越えていた(review M-1)。「1 ノートだけ」の操作としては論外
    let listCalls = 0;
    const base = source({ entries: [{ lid: 'n1', body: 'x' }, { lid: 'n2', body: 'y' }] });
    const withGetBody: ArchiveSource = {
      ...base,
      getBody: async (lid) => (lid === 'n2' ? 'y' : null),
      listBodies: async (...args) => {
        listCalls++;
        return base.listBodies(...args);
      },
    };
    const { source: one } = await singleEntrySource(withGetBody, 'n2');
    expect(listCalls).toBe(0);
    const got = await readArchive((await writeArchive(one, NOW)).blob);
    expect(got.entries[0]!.body).toBe('y');
  });

  it('`getBody` が無い source でも動く(走査へ落ちる)', async () => {
    const { source: one } = await singleEntrySource(
      source({ entries: [{ lid: 'n1', body: 'a' }, { lid: 'n2', body: 'b' }] }),
      'n2',
    );
    const got = await readArchive((await writeArchive(one, NOW)).blob);
    expect(got.entries[0]!.body).toBe('b');
  });

  it('本文がバッチに割れていても見つける', async () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ lid: `n${i}`, body: `本文 ${i}` }));
    const { source: one } = await singleEntrySource(source({ entries, batch: 2 }), 'n9');
    const got = await readArchive((await writeArchive(one, NOW)).blob);
    expect(got.entries[0]!.body).toBe('本文 9');
  });
});

describe('1 ノートの書出し — 落ちるものを言う', () => {
  it('🔴 繋がっている関連は入らない ── その場で言う', async () => {
    // 相手のノートが入らないので端点が片方しかない ── 黙って落とすと、
    // 戻したときに「関連が消えた」ことに気づけない
    const { warnings } = await singleEntrySource(
      source({
        entries: [{ lid: 'n1', body: 'x' }, { lid: 'n2', body: 'y' }],
        relations: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n1' }],
      }),
      'n1',
    );
    expect(warnings).toEqual([
      'このノートに繋がる関連 2 件は含まれません(相手のノートが入らないため)',
    ]);
  });

  it('関連が無いなら黙る', async () => {
    const { warnings } = await singleEntrySource(
      source({ entries: [{ lid: 'n1', body: 'x' }] }),
      'n1',
    );
    expect(warnings).toEqual([]);
  });

  it('🔴 居ない entry は断る(空のアーカイブを作らない)', async () => {
    await expect(
      singleEntrySource(source({ entries: [{ lid: 'n1', body: 'x' }] }), 'いない'),
    ).rejects.toThrow(/見つかりません/);
  });
});

describe('1 ノートの書出し — バックアップと同じ形', () => {
  it('🔴 書き出したものが**そのまま取り込み直せる**(形式が同じ)', async () => {
    // 別形式にすると「1 件書出しだけ読めない」が起きる ── 復元まで通す
    const { source: one } = await singleEntrySource(
      source({
        entries: [{ lid: 'n1', title: '消す前に', body: '大事な本文' }],
        chains: { n1: [{ revOrder: 1, kind: 'full', snapshot: '前の版' }] },
      }),
      'n1',
    );
    const archive = await readArchive((await writeArchive(one, NOW)).blob);
    const restored = restoreArchive(archive, {
      existingLids: new Set(['n1']), // 元が残っていても衝突しない
      existingRelationIds: new Set(),
      orderBase: 0,
      genLid: () => 'new-1',
      genRelationId: () => 'rel-1',
    });
    expect(restored.entries[0]).toMatchObject({ lid: 'new-1', body: '大事な本文' });
    // 履歴も写し先の lid へ付け替わっている
    expect(restored.revisionChains).toEqual([
      {
        entryLid: 'new-1',
        rows: [
          {
            revOrder: 1,
            createdAt: null,
            title: null,
            archetype: null,
            kind: 'full',
            snapshot: '前の版',
            contentHash: null,
          },
        ],
      },
    ]);
  });
});
