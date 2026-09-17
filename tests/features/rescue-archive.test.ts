/**
 * 🔴 **拾い出したものが、本当にノートとして戻るか**(#986)。
 *
 * ⚠ 直す前の拾い出しは **`## 題名` を並べた .md 1 枚**だったので、
 *   取り込むと**ノートは 1 件**にしかならなかった(4000 件拾って 1 件になる)。
 * 🔑 だからここで見るのは「書けたか」ではなく **往復して件数と中身が戻るか**である
 *   ── `pkc3-archive.test.ts` と同じ規律:
 *   **復元できないバックアップはバックアップではない**。
 */
import { describe, expect, it } from 'vitest';
import { writeArchive, readArchive, ARCHIVE_FORMAT } from '../../src/features/export/pkc3-archive';
import { readZipEntry } from '../../src/features/import/zip-reader';
import {
  rescueArchiveSource,
  rescueArchiveSummary,
  type RescuePageLike,
} from '../../src/features/storage/rescue-archive';

const NOW = '2026-09-16T00:00:00.000Z';

/**
 * 壊れた DB の代わり ── **区画ごとに「読める / 読めない / 空」**を作れる台。
 * ⚠ 本物の `rescueEntries` と同じく、読めない区画は**例外ではなく `skipped`** で返る。
 */
function fakePick(opts: {
  rows: Array<{ rowid: number; lid: string; title: string; archetype?: string; body: string }>;
  maxRowid?: number;
  /** ⚠ 2 周目だけ挙動を変えたいとき(壊れ方が回ごとに違う場合を作る)。 */
  onPass?: (pass: number, rows: RescuePageLike['rows']) => RescuePageLike['rows'];
  skippedPerPage?: number;
  emptyPerPage?: number;
  pageSize?: number;
}): { pick: (after: number, chunks: number) => Promise<RescuePageLike>; passes: () => number } {
  const max = opts.maxRowid ?? Math.max(0, ...opts.rows.map((r) => r.rowid));
  const size = opts.pageSize ?? 2;
  let pass = 0;
  let lastAfter = Number.POSITIVE_INFINITY;
  return {
    passes: () => pass,
    pick: async (after: number) => {
      // ⚠ `after` が巻き戻ったら「次の周回」と数える(2 周舐める作りの検算に使う)
      if (after < lastAfter) pass += 1;
      lastAfter = after;
      const hi = Math.min(after + size, max);
      let rows: RescuePageLike['rows'] = opts.rows
        .filter((r) => r.rowid > after && r.rowid <= hi)
        .map((r) => ({
          rowid: r.rowid,
          lid: r.lid,
          title: r.title,
          archetype: r.archetype ?? 'text',
          body: r.body,
        }));
      if (opts.onPass) rows = opts.onPass(pass, rows);
      return {
        rows,
        lastRowid: hi,
        skipped: opts.skippedPerPage ?? 0,
        empty: opts.emptyPerPage ?? 0,
        maxRowid: max,
        done: hi >= max,
      };
    },
  };
}

const THREE = [
  { rowid: 1, lid: 'a1', title: '牛乳を買う', body: '# 牛乳を買う\n\n近所のスーパーで\n' },
  { rowid: 2, lid: 'b2', title: '会議のメモ', body: '# 会議のメモ\n\n- 決めたこと\n' },
  { rowid: 3, lid: 'c3', title: '日本語の題', body: '# 日本語の題\n\nあいうえお\n' },
];

describe('🔴 拾い出しが「戻せる形」で出る(#986)', () => {
  it('🔴 拾った 3 件が、3 件のノートとして戻る', async () => {
    const f = fakePick({ rows: THREE });
    const { source, stats } = rescueArchiveSource({ cid: 'c1', title: '拾い出し', pick: f.pick });
    const out = await writeArchive(source, NOW);
    const got = await readArchive(out.blob);

    expect(got.manifest.format, 'アーカイブとして読めない').toBe(ARCHIVE_FORMAT);
    // 🔴 ここが本題 ── **1 件に潰れていないこと**
    expect(got.entries, '3 件が 1 件に潰れている(直す前の症状)').toHaveLength(3);
    expect(got.entries.map((e) => e.title)).toEqual(['牛乳を買う', '会議のメモ', '日本語の題']);
    // ⚠ 件数だけ見ると中身が入れ替わっていても通る ── 本文まで見る
    expect(got.entries.map((e) => e.body)).toEqual(THREE.map((r) => r.body));
    expect(stats().entries).toBe(3);
    expect(stats().bodyMissing, '本文が落ちている').toBe(0);
  });

  /**
   * 🔴 **壊れた DB でも、添付の bytes は zip に入る**（#1005。user 指摘 2026-09-17）。
   *
   * ⚠ 直す前は `listAssetMetas` が `[]` を返しており、理由は
   *   「索引を使う形でしか引けない」だった ── 🔴 **bytes には当たっていない**。
   *   添付の実体は **IndexedDB**（`pkc3-assets`）に在り、**sqlite を 1 度も通らない**。
   * 🔑 だからここの台は、**拾い出しは壊れているのに添付の口は無傷**という
   *   実際の形にする（区画が読めず `skipped` が立つのに、Blob は全部戻る）。
   */
  it('🔴 壊れた DB でも、添付の bytes が zip に入って戻る', async () => {
    const idb = new Map<string, Blob>([
      ['k1', new Blob(['PNGBYTES'], { type: 'image/png' })],
      ['k2', new Blob(['0123456789'], { type: '' })],
    ]);
    const assets = {
      // ⚠ 鍵は 3 つ在るが、**k3 の bytes は取れない**（数える側の次元）
      listKeys: async (cid: string) => (cid === 'c1' ? ['k1', 'k2', 'k3'] : []),
      get: async (cid: string, key: string) => (cid === 'c1' ? (idb.get(key) ?? null) : null),
    };
    const f = fakePick({
      rows: [{ rowid: 1, lid: 'a1', title: '図のノート', body: '![図](asset:k1)\n' }],
      // ⚠ **DB は本当に壊れている**（読めない区画が在る）
      skippedPerPage: 2,
    });
    const { source, stats } = rescueArchiveSource({
      cid: 'c1',
      title: '拾い出し',
      pick: f.pick,
      assets,
    });
    const out = await writeArchive(source, NOW);
    const got = await readArchive(out.blob);

    // ⚠ 前提の検算 ── 壊れていない台で測っていないことを確かめる
    expect(stats().skipped, '壊れていない台で測っている（前提が崩れている）').toBeGreaterThan(0);

    // 🔴 ここが本題 ── **bytes が戻る**
    expect([...got.assetSources.keys()].sort(), '添付が zip に 1 件も入っていない').toEqual([
      'k1',
      'k2',
    ]);
    const b1 = await readZipEntry(out.blob, got.assetSources.get('k1')!.entry);
    expect(await b1.text(), '添付の中身が別物になっている').toBe('PNGBYTES');

    /**
     * 🔑 **meta は Blob 自身から組み直す**（`assets` 表は読めない）。
     * ⚠ `hash` は**持てないので `null`** ── でっち上げてはいけない。
     * ⚠ `type` が空の Blob は「分からない」なので、書出し側の既定へ委ねる。
     */
    const metaOf = new Map(got.assets.map((a) => [a.key, a]));
    expect(metaOf.get('k1'), 'mime / size が Blob から組めていない').toMatchObject({
      mime: 'image/png',
      size: 8,
    });
    expect(metaOf.get('k2')?.size, '大きさを 0 で埋めている').toBe(10);

    // 🔴 本文の参照が生きている（拾った bytes と繋がる）
    expect(got.entries[0]?.body, '本文の添付参照が消えている').toContain('asset:k1');

    expect(stats().assets, '入れた件数を数えていない').toBe(2);
    expect(stats().assetBytes, '量を数えていない').toBe(18);
    // 🔴 鍵は在るのに取れなかった 1 件を、黙って 0 に混ぜない
    expect(stats().assetMissing, '取れなかった添付を数えていない').toBe(1);
  });

  /**
   * ⚠ **対照群** ── 口を渡さなければ、今までどおり 0 件。
   * 🔑 これが無いと、上の test が「別の経路が添付を入れている」場合と見分けられない。
   */
  it('⚠ 添付の口を渡さなければ 0 件のまま（対照群）', async () => {
    const f = fakePick({ rows: THREE });
    const { source, stats } = rescueArchiveSource({ cid: 'c1', title: 't', pick: f.pick });
    const got = await readArchive((await writeArchive(source, NOW)).blob);
    expect(got.assetSources.size, '渡していないのに添付が入っている').toBe(0);
    expect(stats().assets).toBe(0);
    expect(stats().assetMissing).toBe(0);
  });

  /** ⚠ **2 周舐める作り**そのものを留める ── 1 周に変えると本文が空で戻る。 */
  it('⚠ 一覧と本文で 2 周する(1 周に変えると本文が落ちる)', async () => {
    const f = fakePick({ rows: THREE });
    const { source } = rescueArchiveSource({ cid: 'c1', title: 't', pick: f.pick });
    await writeArchive(source, NOW);
    expect(f.passes(), '2 周していない').toBe(2);
  });

  /**
   * 🔴 **2 周目で読めなくなった本文を、黙って空で埋めない**。
   * ⚠ 壊れ方は回ごとに変わりうるので、これは想定内の形である。
   */
  it('🔴 本文が来なかった件数を数えて外へ出す', async () => {
    const f = fakePick({
      rows: THREE,
      // 2 周目(本文)で b2 だけ読めなくなる
      onPass: (pass, rows) => (pass >= 2 ? rows.filter((r) => r.lid !== 'b2') : rows),
    });
    const { source, stats } = rescueArchiveSource({ cid: 'c1', title: 't', pick: f.pick });
    const got = await readArchive((await writeArchive(source, NOW)).blob);

    expect(got.entries, '一覧からも消えてしまっている').toHaveLength(3);
    expect(stats().bodyMissing, '本文が落ちたことを数えていない').toBe(1);
    expect(rescueArchiveSummary(stats())).toContain('本文が読めなかったノート 1 件');
    // ⚠ 残りの 2 件は無事であること(1 件落ちたら全部捨てる、にしない)
    const byLid = new Map(got.entries.map((e) => [e.lid, e.body]));
    expect(byLid.get('a1')).toBe(THREE[0]!.body);
    expect(byLid.get('c3')).toBe(THREE[2]!.body);
    /**
     * 🔴 **空本文で埋めない** ── 空だと
     *   「中身が無いノート」と「本文が失われたノート」を user が見分けられない。
     * ⚠ 題名は残す(何が失われたのかが分かる唯一の手がかりである)。
     */
    expect(byLid.get('b2'), '本文が読めなかったことを言っていない').toContain(
      '読み出せませんでした',
    );
    expect(byLid.get('b2'), '題名まで失っている').toContain('会議のメモ');
  });

  /** 🔴 **拾えなかった区画を、必ず字にする**(「拾えた件数」を「全部」と読ませない)。 */
  it('🔴 読めなかった区画・空の区画を字に出す', () => {
    const s = {
      entries: 10,
      skipped: 4,
      empty: 38,
      bodyMissing: 0,
      assets: 0,
      assetBytes: 0,
      assetMissing: 0,
    };
    const line = rescueArchiveSummary(s);
    expect(line).toContain('読めなかった区画 4');
    expect(line).toContain('空だった区画 38');
    // 🔴 つながりと履歴が戻らないことは**必ず**書く（黙って 0 件にしない）
    expect(line, 'つながりと履歴が戻らないことを言っていない').toContain(
      'ノート同士のつながりと履歴は、この方法では戻せません',
    );
    /**
     * 🔴 **「添付は戻せません」を二度と書かない**（#1005）。
     *
     * ⚠ 直す前の字は「つながり・**添付**・履歴は戻せません」だったが、
     *   🔴 **その字のとおりに進むと添付を失う**実害が出ていた
     *   （拾い出しが 1 バイトも出さないまま、「中身を捨てる」がその bytes を消していた）。
     * 🔑 だから**断り文の側に門を置く** ── 添付を拾わない実装へ戻した日に
     *   この行が落ちる（字だけ戻しても黙って通らない）。
     */
    const lost = line.slice(line.indexOf('⚠'));
    expect(
      lost,
      '戻せない側に添付が残っている（拾えるのに戻せないと言っている）',
    ).not.toContain('添付');
  });

  /**
   * 🔴 **添付を入れたなら、入れたと言う**（#1005）。
   *
   * ⚠ 件数だけでは「足りているか」を user が判断できないので、**量も出す**。
   * 🔴 **鍵は在るのに中身が取れなかった分を、黙って減らさない**。
   */
  it('🔴 入れた添付の件数と量を出し、取れなかった分も字にする', () => {
    const line = rescueArchiveSummary({
      entries: 3,
      skipped: 0,
      empty: 0,
      bodyMissing: 0,
      assets: 2,
      assetBytes: 3072,
      assetMissing: 1,
    });
    expect(line, '入れた添付の件数が出ていない').toContain('添付も 2 件');
    expect(line, '入れた量が出ていない').toContain('3.0 KB');
    expect(line, '取れなかった添付を黙って減らしている').toContain(
      '中身が取れなかった添付 1 件',
    );
    // ⚠ 対照群 ── 0 件の人に「添付も 0 件入れました」と書かない
    const none = rescueArchiveSummary({
      entries: 3,
      skipped: 0,
      empty: 0,
      bodyMissing: 0,
      assets: 0,
      assetBytes: 0,
      assetMissing: 0,
    });
    expect(none, '添付 0 件なのに添付の話をしている').not.toContain('添付も');
  });

  /**
   * 🔴 **本文を途中で切って、続きから取る経路**(#986)。
   *
   * ⚠ `writeArchive` は本文を **4MB ずつ**取りに来るので、中身が多いと
   *   `listBodies` は**何度も呼ばれる**。🔴 続きの位置を持っていないと、
   *   2 回目以降が**毎回はじめから舐め直し**て、既に出した行しか返さない
   *   ── **2 回目以降の本文が丸ごと落ちる**。
   * ⚠ 直す前の test はどれも本文が小さく、`listBodies` が **1 回しか
   *   呼ばれていなかった**(変異試験 M3 が SURVIVED で教えた ── §2 未実行の経路)。
   */
  it('🔴 本文が 4MB を超えても、続きから取って全部戻る', async () => {
    /**
     * ⚠ **区切り(4MiB)を、最後の行より手前で跨がせる** ── 1 稿目は
     *   1 件 750K 字 × 6 = 4.5M 字で、**最後の 1 行でしか越えなかった**ので
     *   `done` が先に立ち、続きから取る経路を**やはり 1 度も通らなかった**
     *   (変異 M3 / M7 が 2 度とも SURVIVED で教えた)。
     * 🔑 1 件 150 万字 × 6 = 900 万字 ── **3 件目で越える**ので、
     *   `listBodies` は必ず 2 回以上呼ばれる。
     */
    const big = Array.from({ length: 6 }, (_, i) => ({
      rowid: i + 1,
      lid: `big-${i}`,
      title: `大きいノート ${i}`,
      body: `# 大きいノート ${i}\n\n${'あ'.repeat(1_500_000)}\n`,
    }));
    const f = fakePick({ rows: big, pageSize: 1 });
    const { source, stats } = rescueArchiveSource({ cid: 'c1', title: 't', pick: f.pick });
    const got = await readArchive((await writeArchive(source, NOW)).blob);

    expect(got.entries, '途中から落ちている').toHaveLength(6);
    // 🔴 中身まで見る ── 件数だけだと「印だけ入った空」でも通る
    for (const b of big) {
      const e = got.entries.find((x) => x.lid === b.lid);
      expect(e?.body, `${b.lid} の本文が落ちている`).toBe(b.body);
    }
    expect(stats().bodyMissing, '印で埋めた物が混ざっている').toBe(0);
  }, 60_000);

  /**
   * 🔴 **前へ進まない相手でも、止まらずに終わる**(2026-09-16)。
   *
   * ⚠ `writeArchive` は `done` が立つまで呼び続けるので、**1 行も返さずに
   *   `done: false`** を返すと**永久に回る**。壊れた DB は「同じ所を返し続ける」
   *   形もありうるので、ここは**起こらなくする**側で守る(§7 の規律)。
   * 🔴 変異試験で実際に `HUNG` した ── CLAUDE.md §3:
   *   「`SURVIVED` より `HUNG` のほうが重い(製品が壊れうる形をしている)」。
   * ⚠ **timeout を短く置く** ── 戻ったときに「固まる」ではなく「落ちる」で出したい。
   */
  it('🔴 同じ所を返し続ける相手でも、回り続けない', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      rowid: i + 1,
      lid: `s-${i}`,
      title: `止まらない ${i}`,
      // ⚠ `archetype` は必須 ── 抜くと tsc が落ちる(1 稿目で落とした)
      archetype: 'text',
      body: `# 止まらない ${i}\n\n${'あ'.repeat(1_500_000)}\n`,
    }));
    /** ⚠ **進まない台** ── `lastRowid` を動かさず、`done` も立てない。 */
    const stuck = async (): Promise<RescuePageLike> => ({
      rows,
      lastRowid: 1,
      skipped: 0,
      empty: 0,
      maxRowid: 999,
      done: false,
    });
    const { source, stats } = rescueArchiveSource({ cid: 'c1', title: 't', pick: stuck });
    const got = await readArchive((await writeArchive(source, NOW)).blob);
    // 🔑 終わること自体が本題(ここへ到達できれば回り続けていない)
    expect(got.entries, '拾えた物が出ていない').toHaveLength(4);
    expect(stats().entries).toBe(4);
  }, 30_000);

  /** ⚠ 対照群 ── 何も拾えなければ**断る**(「書き出したつもりで空」を作らない)。 */
  it('⚠ 1 件も拾えなければ断る', async () => {
    const f = fakePick({ rows: [], maxRowid: 4, emptyPerPage: 2 });
    const { source } = rescueArchiveSource({ cid: 'c1', title: 't', pick: f.pick });
    await expect(writeArchive(source, NOW)).rejects.toThrow(/1 件もありません/);
  });

  /** ⚠ 同じ lid が 2 度来ても、ノートは 1 件にする(壊れた DB では起こりうる)。 */
  it('⚠ 同じ id が 2 度来ても 1 件にまとめる', async () => {
    const f = fakePick({
      rows: [
        { rowid: 1, lid: 'a1', title: '一つ目', body: 'A\n' },
        { rowid: 2, lid: 'a1', title: '同じ id', body: 'B\n' },
        { rowid: 3, lid: 'z9', title: '別の', body: 'C\n' },
      ],
    });
    const { source, stats } = rescueArchiveSource({ cid: 'c1', title: 't', pick: f.pick });
    const got = await readArchive((await writeArchive(source, NOW)).blob);
    expect(got.entries).toHaveLength(2);
    expect(got.entries.map((e) => e.lid)).toEqual(['a1', 'z9']);
    expect(stats().entries).toBe(2);
  });

  /** ⚠ **壊れていない DB でも同じ口が通る**(壊れたときだけ動く道にしない)。 */
  it('⚠ 壊れていなくても同じ口で書き出せる', async () => {
    const f = fakePick({ rows: THREE, skippedPerPage: 0, emptyPerPage: 0 });
    const { source, stats } = rescueArchiveSource({ cid: 'c1', title: 't', pick: f.pick });
    const got = await readArchive((await writeArchive(source, NOW)).blob);
    expect(got.entries).toHaveLength(3);
    expect(rescueArchiveSummary(stats())).toContain('3 件を拾って');
  });
});
