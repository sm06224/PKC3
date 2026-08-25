/** @vitest-environment happy-dom */
/**
 * #399 ①: **フォルダ 1 つだけを持ち出す**。
 *
 * > user の物語:「案件A」フォルダの中身だけを相手に渡したい。いまできるのは
 * > **①コンテナ全部**(渡してはいけない物まで入る)か **②ノート 1 件**
 * > (30 件あったら 30 回押す)だけである。
 *
 * だから見るのは 4 点:
 * ① フォルダの器と配下が**丸ごと**入るか(深い階層まで)
 * ② 🔴 **外のノートが 1 件も混ざらないか**(渡してはいけない物が入る = 実害)
 * ③ 中で閉じている関係は**残る**か / 外へ出る関係は**落として言う**か
 * ④ 添付は**中から参照されている物だけ**入るか
 *
 * ⚠ 形式はバックアップ(`.pkc3.zip`)と同じなので、**そのまま取り込み直せる**
 *   ことも見る(writer / reader を通す ── 絞り込みだけの実装であることの検算)。
 */
import { describe, expect, it } from 'vitest';
import { folderSource } from '../../src/features/export/folder-source';
import {
  writeArchive,
  readArchive,
  type ArchiveSource,
} from '../../src/features/export/pkc3-archive';

const enc = new TextEncoder();
const NOW = '2026-08-25T00:00:00.000Z';

interface FakeEntry {
  lid: string;
  title?: string;
  body: string;
  /** 既定は 'text'。フォルダは 'folder' と書く。 */
  archetype?: string;
}
interface Fake {
  entries: FakeEntry[];
  /** structural: `[親, 子]`。ここが木を作る。 */
  tree?: Array<[string, string]>;
  /** 構造ではない関係(link)。 */
  links?: Array<[string, string]>;
  assets?: Array<{ key: string; mime: string; bytes: Uint8Array }>;
  chains?: Record<string, Array<{ revOrder: number; kind: string; snapshot: string }>>;
  /** 🔑 `getBody` を**持たない**相手を作る(走査の道が生きているかを見る)。 */
  noGetBody?: boolean;
  /** `listBodies` が 1 回に返す件数(刻む道を通すため)。 */
  batch?: number;
}

/** ⚠ 読んだ回数を数える(2 周する設計であることを test 側から見るため)。 */
interface Counted {
  src: ArchiveSource;
  bodyReads: () => number;
}

function source(f: Fake): Counted {
  const entries = f.entries.map((e, i) => ({
    lid: e.lid,
    title: e.title ?? e.lid,
    archetype: e.archetype ?? 'text',
    created_at: null,
    updated_at: null,
    entry_order: i + 1,
    status: null,
    date: null,
    archived: 0,
    body: e.body,
  }));
  let bodyReads = 0;
  const relations = [
    ...(f.tree ?? []).map(([from, to], i) => ({
      id: `s${i}`,
      from_lid: from,
      to_lid: to,
      kind: 'structural',
      created_at: null,
      updated_at: null,
    })),
    ...(f.links ?? []).map(([from, to], i) => ({
      id: `l${i}`,
      from_lid: from,
      to_lid: to,
      kind: 'link',
      created_at: null,
      updated_at: null,
    })),
  ];
  const src: ArchiveSource = {
    cid: 'c1',
    title: 'コンテナ',
    listEntryMetas: async () =>
      entries.map((e) => {
        const { body, ...m } = e;
        void body;
        return m;
      }),
    ...(f.noGetBody
      ? {}
      : {
          getBody: async (lid: string) => {
            bodyReads++;
            return entries.find((e) => e.lid === lid)?.body ?? null;
          },
        }),
    listBodies: async (after) => {
      const rest = after
        ? entries.filter(
            (e) => e.entry_order > after.entryOrder || (e.entry_order === after.entryOrder && e.lid > after.lid),
          )
        : entries;
      const slice = rest.slice(0, Math.max(1, f.batch ?? entries.length));
      const last = slice[slice.length - 1];
      return {
        rows: slice.map((e) => ({ lid: e.lid, body: e.body })),
        done: slice.length >= rest.length,
        ...(last ? { next: { entryOrder: last.entry_order, lid: last.lid } } : {}),
      };
    },
    listRelations: async () => relations,
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
  return { src, bodyReads: () => bodyReads };
}

/** 深さ 3 の木 + 外のノート。⚠ どの test も**外が居る**状態で見る。 */
const NESTED: Fake = {
  entries: [
    { lid: 'f1', title: '案件A', archetype: 'folder', body: 'フォルダの覚書' },
    { lid: 'n1', title: '見積', body: '見積の本文' },
    { lid: 'f2', title: '資料', archetype: 'folder', body: '' },
    { lid: 'n2', title: '図面', body: '図面の本文' },
    { lid: 'out', title: '他社の秘密', body: '渡してはいけない' },
    { lid: 'fx', title: '案件B', archetype: 'folder', body: '' },
  ],
  tree: [
    ['f1', 'n1'],
    ['f1', 'f2'],
    ['f2', 'n2'],
    ['fx', 'out'],
  ],
};

describe('#399 ① フォルダ書出し — フォルダごと渡せる', () => {
  it('🔑 フォルダの器と、配下ぜんぶ(深い階層まで)が入る', async () => {
    const { source: s } = await folderSource(source(NESTED).src, 'f1');
    const got = await readArchive((await writeArchive(s, NOW)).blob);
    expect(got.entries.map((e) => e.lid).sort()).toEqual(['f1', 'f2', 'n1', 'n2']);
    // 🔑 **器が入る** ── 入らないと、取り込み直したとき中身だけ平置きで戻る
    expect(got.entries.find((e) => e.lid === 'f1')?.archetype).toBe('folder');
    expect(got.entries.find((e) => e.lid === 'n2')?.body).toBe('図面の本文');
  });

  it('🔴 外のノートが 1 件も混ざらない(これが入ると実害)', async () => {
    const { source: s } = await folderSource(source(NESTED).src, 'f1');
    const got = await readArchive((await writeArchive(s, NOW)).blob);
    expect(got.entries.some((e) => e.lid === 'out')).toBe(false);
    expect(JSON.stringify(got.entries)).not.toContain('渡してはいけない');
  });

  it('題名はフォルダの題名になる(ファイル名がそのままフォルダ名になる)', async () => {
    const { source: s } = await folderSource(source(NESTED).src, 'f1');
    expect(s.title).toBe('案件A');
  });

  it('件数を返す(帯に出すため ── 押した後で数が分かる)', async () => {
    const { count } = await folderSource(source(NESTED).src, 'f1');
    expect(count).toBe(4);
  });
});

describe('#399 ① 関係 — 中で閉じているものは残す', () => {
  it('🔑 両端が中に居る関係は残る(1 ノート書出しと違うところ)', async () => {
    const { source: s, warnings } = await folderSource(
      source({ ...NESTED, links: [['n1', 'n2']] }).src,
      'f1',
    );
    const got = await readArchive((await writeArchive(s, NOW)).blob);
    expect(got.relations.map((r) => [r.fromLid, r.toLid])).toContainEqual(['n1', 'n2']);
    // ⚠ 落ちていないので、落ちたとは言わない
    expect(warnings.join('')).not.toContain('外へ繋がる関連');
  });

  it('🔴 外へ出る関係は落とし、落ちたことを件数で言う', async () => {
    const { source: s, warnings } = await folderSource(
      source({ ...NESTED, links: [['n1', 'out']] }).src,
      'f1',
    );
    const got = await readArchive((await writeArchive(s, NOW)).blob);
    expect(got.relations.some((r) => r.toLid === 'out')).toBe(false);
    expect(warnings.some((w) => w.includes('外へ繋がる関連 1 件'))).toBe(true);
  });
});

describe('#399 ① 添付 — 中から参照されている物だけ', () => {
  it('中で参照している添付は入り、外だけが参照する添付は入らない', async () => {
    const { source: s } = await folderSource(
      source({
        ...NESTED,
        entries: NESTED.entries.map((e) =>
          e.lid === 'n2'
            ? { ...e, body: '図面 ![](asset:ast-in)' }
            : e.lid === 'out'
              ? { ...e, body: '秘密 ![](asset:ast-out)' }
              : e,
        ),
        assets: [
          { key: 'ast-in', mime: 'image/png', bytes: enc.encode('IN') },
          { key: 'ast-out', mime: 'image/png', bytes: enc.encode('OUT') },
        ],
      }).src,
      'f1',
    );
    const got = await readArchive((await writeArchive(s, NOW)).blob);
    expect(got.assets.map((a) => a.key)).toEqual(['ast-in']);
  });

  it('🔑 過去の版だけが参照している添付も入る(履歴を戻せる形で渡す)', async () => {
    const { source: s } = await folderSource(
      source({
        ...NESTED,
        chains: { n1: [{ revOrder: 1, kind: 'full', snapshot: '昔は ![](asset:ast-old) が在った' }] },
        assets: [{ key: 'ast-old', mime: 'image/png', bytes: enc.encode('OLD') }],
      }).src,
      'f1',
    );
    const got = await readArchive((await writeArchive(s, NOW)).blob);
    expect(got.assets.map((a) => a.key)).toEqual(['ast-old']);
    expect(got.revisions.map((r) => r.entryLid)).toEqual(['n1']);
  });

  it('🔴 外のノートの履歴は入らない(混ざる経路が 1 つ増えているので別に見る)', async () => {
    const { source: s } = await folderSource(
      source({
        ...NESTED,
        chains: {
          n1: [{ revOrder: 1, kind: 'full', snapshot: '中の古い版' }],
          out: [{ revOrder: 1, kind: 'full', snapshot: '外の古い版' }],
        },
      }).src,
      'f1',
    );
    const got = await readArchive((await writeArchive(s, NOW)).blob);
    expect(got.revisions.map((r) => r.entryLid)).toEqual(['n1']);
  });
});

describe('#399 ① 断り方と読み方', () => {
  it('居ないフォルダは断る(空のアーカイブを作らない)', async () => {
    await expect(folderSource(source(NESTED).src, 'nope')).rejects.toThrow(
      '書き出すフォルダが見つかりません',
    );
  });

  it('🔴 フォルダでないものは断る ── 押せるのに必ず失敗する形を作らない', async () => {
    await expect(folderSource(source(NESTED).src, 'n1')).rejects.toThrow('フォルダではない');
  });

  it('🔑 `getBody` を持たない相手でも読める(走査の道が生きている)', async () => {
    const { source: s } = await folderSource(source({ ...NESTED, noGetBody: true }).src, 'f1');
    const got = await readArchive((await writeArchive(s, NOW)).blob);
    expect(got.entries.find((e) => e.lid === 'n2')?.body).toBe('図面の本文');
  });

  it('🔴 本文を heap に溜めない ── だから 2 周読む(1 周で済ませていない)', async () => {
    /**
     * ⚠ **添付を 1 件置く**(2 稿目)。1 稿目は添付 0 件の fixture で見ていたので、
     *   1 周目が**そもそも走らず** `0 → 4` で通っていた ── 「2 周した」ではなく
     *   「1 周しかしていない」でも緑になる空振りだった(CLAUDE.md §1)。
     * 🔑 拾えない鍵(どの本文にも書いていない)にして、**早期打ち切りも塞ぐ**。
     */
    const counted = source({
      ...NESTED,
      assets: [{ key: 'ast-nowhere', mime: 'image/png', bytes: enc.encode('N') }],
    });
    const { source: s } = await folderSource(counted.src, 'f1');
    const afterScan = counted.bodyReads();
    // 1 周目: 添付を探して部分木の 4 件を読み、**捨てている**
    expect(afterScan).toBe(4);
    await writeArchive(s, NOW);
    // 🔑 **書き出しでもう一度読んでいる**(= 1 周目の本文を持ち続けていない)
    expect(counted.bodyReads()).toBe(8);
  });

  it('⚠ 添付が 1 件も無ければ 1 周目は走らない(要らない読みをしない)', async () => {
    const counted = source(NESTED);
    await folderSource(counted.src, 'f1');
    expect(counted.bodyReads()).toBe(0);
  });

  it('🔴 予算どおりに刻んでも全件そろう(空 batch で止まらない)', async () => {
    const counted = source({
      ...NESTED,
      assets: [{ key: 'ast-x', mime: 'image/png', bytes: enc.encode('X') }],
    });
    const { source: s } = await folderSource(counted.src, 'f1');
    /**
     * 🔴 **まず「刻んでいること」を見る**(2 稿目)。
     * ⚠ 1 稿目は最後に全件そろうことしか見ておらず、**一括で返す実装でも緑**だった
     *   ── それは `writeArchive` の「バッチぶんを Blob にして手放す」規律を
     *   こちらから壊す形なので、緑にしてはいけない(CLAUDE.md §1)。
     */
    const first = await s.listBodies(undefined, 1);
    expect(first.rows, '予算 1 バイトなのに 2 件以上返した(刻んでいない)').toHaveLength(1);
    expect(first.done, '1 件で終わったことにしている').toBe(false);
    // ⚠ **1 件が予算を超える**大きさで刻む(1 件も入らずに回り続ける形を潰す)
    const seen: string[] = [];
    let after: { entryOrder: number; lid: string } | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const { rows, done, next } = await s.listBodies(after, 1);
      for (const r of rows) seen.push(r.lid);
      if (done) break;
      expect(next).toBeDefined();
      after = next;
    }
    expect(seen.sort()).toEqual(['f1', 'f2', 'n1', 'n2']);
  });
});
