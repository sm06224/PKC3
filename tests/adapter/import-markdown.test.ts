/** @vitest-environment happy-dom */
/**
 * P7 段②: 素の `.md` の取込(実行部)と**振り分け**。
 *
 * 網の狙い:
 * ① 取り込んだものが **state に現れる**(「書いたつもり」を検出できない unit にしない)
 * ② **原文のまま**書かれる(frontmatter を parse し直して再構築しない)
 * ③ 断る入力で **書込が 1 件も起きない**(半端に書いてから失敗する経路を作らない)
 * ④ 振り分けが md と PKC2 を取り違えない
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { importFiles } from '../../src/adapter/ui/actions/import-file';
import { importMarkdownFiles } from '../../src/adapter/ui/actions/import-markdown';
import type { ImportDeps } from '../../src/adapter/ui/actions/import-pkc2';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';

/**
 * ⚠ MIME は **空**が既定。OS のピッカーや `launchQueue` は `.md` に MIME を
 * 付けないことが多く、`text/plain` を付ける環境もある ── ここを
 * `text/markdown` で埋めると「MIME で振り分ける」実装でも test が通ってしまい、
 * 実機だけ PKC2 経路に落ちて断られる(変異試験で実際に生き残った)
 */
const mdFile = (body: string, name = 'note.md', type = ''): File =>
  new File([body], name, { type });

function harness(opts: { failWrite?: boolean; orderBase?: number } = {}) {
  const written: EntryUpsert[] = [];
  const opLog: string[] = [];
  const notices: string[] = [];
  let reported: readonly string[] = [];
  let reloads = 0;
  let n = 0;
  const importedLids: string[][] = [];

  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });

  const deps: ImportDeps = {
    existingLids: async () => new Set(d.getState().entryMetas.keys()),
    existingRelationIds: () => new Set(),
    orderBase: () => opts.orderBase ?? 0,
    genLid: () => `md-lid-${++n}`,
    genAssetKey: () => `ast-${++n}`,
    genRelationId: () => `rel-${++n}`,
    bulkUpsertEntries: async (entries) => {
      opLog.push('entries');
      if (opts.failWrite) throw new Error('書込に失敗(注入)');
      written.push(...entries);
    },
    bulkUpsertRelations: async () => void opLog.push('relations'),
    listStoredBlobKeys: async () => new Set(),
    importRevisionChains: async () => ({
      added: 0,
      skippedNoChange: 0,
      droppedOverLimit: 0,
      skippedEntries: [],
    }),
    restoreRevisionChains: async () => ({
      added: 0,
      skippedNoChange: 0,
      droppedOverLimit: 0,
      skippedEntries: [],
      brokenChains: [],
    }),
    putBlob: async () => void opLog.push('blob'),
    putAssetMeta: async () => void opLog.push('meta'),
    reload: async () => {
      reloads++;
      d.dispatch({
        type: 'SYS_BOOTED',
        cid: 'c1',
        metas: written.map((e) => ({
          lid: e.lid,
          title: e.title,
          archetype: e.archetype,
          entryOrder: e.entryOrder,
          status: e.status,
          date: e.date,
          archived: e.archived,
          createdAt: '2026-08-02T00:00:00Z',
          updatedAt: '2026-08-02T00:00:00Z',
        })),
        relations: [],
      });
    },
    notify: (m) => void notices.push(m),
    report: (notes) => void (reported = notes),
    imported: (lids) => void importedLids.push([...lids]),
  };

  return {
    d,
    deps,
    written,
    opLog,
    notices,
    reloads: () => reloads,
    reported: () => reported,
    importedLids,
  };
}

describe('取り込んだ lid を files の順で返す(2026-08-05)', () => {
  /**
   * 🔴 **紐づけの土台**(user 報告「スポットの編集プレビュー導線も存在しない」)。
   * `main.ts` は「**何番目のファイルが何になったか**」で handle を結ぶ ──
   * ここが落ちると書き戻す導線が出ず、順が狂うと **別のファイルへ書く**。
   */
  it('🔴 1 件でも報告する(無いと書き戻す導線が永久に出ない)', async () => {
    const h = harness();
    await importMarkdownFiles(h.d, h.deps, [mdFile('# 一\n', 'a.md')]);
    expect(h.importedLids).toEqual([[h.written[0]!.lid]]);
  });

  it('🔴 並びは files と同じ(逆になると別のファイルに紐づく)', async () => {
    const h = harness();
    await importMarkdownFiles(h.d, h.deps, [
      mdFile('# 一\n', 'a.md'),
      mdFile('# 二\n', 'b.md'),
      mdFile('# 三\n', 'c.md'),
    ]);
    // 書いた順 = files の順(題名で裏を取る)
    expect(h.written.map((e) => e.title)).toEqual(['一', '二', '三']);
    expect(h.importedLids).toEqual([h.written.map((e) => e.lid)]);
  });

  it('書込が失敗したら報告しない(紐づけを作らない)', async () => {
    const h = harness({ failWrite: true });
    await importMarkdownFiles(h.d, h.deps, [mdFile('# 一\n', 'a.md')]);
    expect(h.importedLids).toEqual([]);
  });
});

describe('素の md を取り込む', () => {
  it('1 件が state に現れる(題名は先頭見出し)', async () => {
    const h = harness();
    const count = await importMarkdownFiles(h.d, h.deps, [mdFile('# 買い物\n\n牛乳\n')]);
    expect(count).toBe(1);
    expect(h.written).toHaveLength(1);
    expect(h.written[0]!.title).toBe('買い物');
    expect(h.written[0]!.archetype).toBe('text');
    // ② state に現れる ── 「書いたつもり」で終わらない
    expect([...h.d.getState().entryMetas.values()].map((m) => m.title)).toEqual(['買い物']);
    expect(h.reloads()).toBe(1);
  });

  it('🔴 本文は原文のまま(frontmatter ごと)', async () => {
    const src = '---\ntitle: 正本\nnested:\n  a: 1\n---\n本文\n';
    const h = harness();
    await importMarkdownFiles(h.d, h.deps, [mdFile(src)]);
    expect(h.written[0]!.body).toBe(src);
    expect(h.written[0]!.title).toBe('正本');
  });

  it('複数を 1 件ずつ entry にし、entryOrder は既存の続きから振る', async () => {
    const h = harness({ orderBase: 10 });
    const count = await importMarkdownFiles(h.d, h.deps, [
      mdFile('# 一\n', 'a.md'),
      mdFile('# 二\n', 'b.markdown'),
    ]);
    expect(count).toBe(2);
    expect(h.written.map((e) => e.entryOrder)).toEqual([11, 12]);
    expect(h.written.map((e) => e.title)).toEqual(['一', '二']);
    // ⚠ 1 回の bulk で書く(1 行ずつ書かない ── journal 増幅の教訓)
    expect(h.opLog.filter((o) => o === 'entries')).toHaveLength(1);
  });

  it('🔴 抽出列が flavor を通って入る(値まで見る)', async () => {
    // ⚠ 「undefined ではない」で見ると、`status: null` を素通しする実装でも通る
    // ── 抽出を殺したときに鳴らない(空振り)。**値そのもの**を pin する
    const h = harness();
    await importMarkdownFiles(h.d, h.deps, [
      mdFile('---\narchetype: todo\nstatus: done\ndate: 2026-08-02\narchived: true\n---\nやること\n'),
    ]);
    expect(h.written[0]!.archetype).toBe('todo');
    expect(h.written[0]!.status).toBe('done');
    expect(h.written[0]!.date).toBe('2026-08-02');
    expect(h.written[0]!.archived).toBe(true);
  });

  it('🔴 注意は**どのファイルのものか**を言い、全件が report へ行く', async () => {
    const h = harness();
    await importMarkdownFiles(h.d, h.deps, [
      mdFile('![図](images/a.png)\n', '写真.md'),
      mdFile('---\narchetype: nope\n---\n', 'b.md'),
    ]);
    const notes = h.reported().join('\n');
    expect(notes).toContain('写真.md:');
    expect(notes).toContain('b.md:');
    expect(h.reported().length).toBe(2);
    // 1 行の status には件数だけ
    expect(h.notices.at(-1)).toContain('注意 2 件');
  });

  it('注意が無ければ report は空で、status も静か', async () => {
    const h = harness();
    await importMarkdownFiles(h.d, h.deps, [mdFile('# 静か\n')]);
    expect(h.reported()).toEqual([]);
    expect(h.notices.at(-1)).toBe('取込完了: 1 件');
  });
});

describe('🔴 断るときは 1 件も書かない', () => {
  it('編集中は断る', async () => {
    const h = harness();
    h.d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'edit-1', title: '編集中' });
    expect(h.d.getState().phase).not.toBe('ready');
    expect(await importMarkdownFiles(h.d, h.deps, [mdFile('# x\n')])).toBe(null);
    expect(h.opLog).toEqual([]);
    expect(h.d.getState().error).toContain('編集を終了');
  });

  it('ファイルが 0 件なら断る', async () => {
    const h = harness();
    expect(await importMarkdownFiles(h.d, h.deps, [])).toBe(null);
    expect(h.opLog).toEqual([]);
  });

  it('🔴 途中で読めなくなったら **bulk を呼ばない**(読めた分も書かない)', () => {
    // review M-4: catch を丸ごと `void e` にしても 834 件が全部緑だった ──
    // この file がいちばん強く宣言している規律が誰にも守られていなかった。
    // ⚠ `written.length === 0` だけを見ると、**空配列を書く実装でも通る** ──
    // 呼ばれたこと自体(opLog)を見る
    const h = harness();
    const broken = mdFile('# 二\n', 'b.md');
    Object.defineProperty(broken, 'text', {
      value: () => Promise.reject(new Error('読めない')),
    });
    return importMarkdownFiles(h.d, h.deps, [mdFile('# 一\n', 'a.md'), broken]).then((r) => {
      expect(r).toBe(null);
      expect(h.opLog).toEqual([]); // ← bulkUpsertEntries が**呼ばれていない**
      expect(h.written).toEqual([]);
      expect(h.d.getState().error).toContain('書込は行われていません');
    });
  });

  it('書込に失敗したら可視で終え、再読込する', async () => {
    const h = harness({ failWrite: true });
    expect(await importMarkdownFiles(h.d, h.deps, [mdFile('# x\n')])).toBe(null);
    expect(h.d.getState().error).toContain('取込に失敗');
    expect(h.reloads()).toBe(1); // 画面を実態に戻す
  });
});

describe('振り分け(import-file)', () => {
  const pkc2Html = (): File =>
    new File(
      [
        `<!doctype html><html><head>
    <script id="pkc-meta" type="application/json">{"app":"pkc2","schema":1}</script>
  </head><body>
    <script id="pkc-data" type="application/json">${JSON.stringify({
      container: { meta: {}, entries: [{ lid: 'e1', title: 'PKC2 の記事', archetype: 'text', body: '中身' }], assets: {} },
      export_meta: { mode: 'full', asset_encoding: 'base64' },
    })}</script>
  </body></html>`,
      ],
      'c.html',
      { type: 'text/html' },
    );

  it('md は md 経路へ', async () => {
    const h = harness();
    await importFiles(h.d, h.deps, [mdFile('# md 経路\n')]);
    expect(h.written.map((e) => e.title)).toEqual(['md 経路']);
  });

  it('PKC2 の書出しは PKC2 経路へ', async () => {
    const h = harness();
    await importFiles(h.d, h.deps, [pkc2Html()]);
    expect(h.written.map((e) => e.title)).toEqual(['PKC2 の記事']);
  });

  it('🔴 混在は断る(md だけ入って PKC2 が黙って落ちる、を作らない)', async () => {
    const h = harness();
    expect(await importFiles(h.d, h.deps, [mdFile('# a\n'), pkc2Html()])).toBe(null);
    expect(h.opLog).toEqual([]);
    expect(h.d.getState().error).toContain('分けて');
  });

  it('PKC2 の書出しが複数なら断る(1 件目だけ黙って取り込まない)', async () => {
    const h = harness();
    expect(await importFiles(h.d, h.deps, [pkc2Html(), pkc2Html()])).toBe(null);
    expect(h.opLog).toEqual([]);
    expect(h.d.getState().error).toContain('1 つずつ');
  });

  it('0 件は何もしない(⚠ エラーも出さない ── user は何も選んでいない)', () => {
    const h = harness();
    return importFiles(h.d, h.deps, []).then((r) => {
      expect(r).toBe(null);
      expect(h.opLog).toEqual([]);
      expect(h.d.getState().error).toBe(null);
    });
  });

  it.each([
    ['MIME 無し', ''],
    ['text/plain', 'text/plain'],
    ['text/markdown', 'text/markdown'],
    ['嘘の MIME(application/zip)', 'application/zip'],
  ])('🔴 MIME に関わらず拡張子で決める(%s)', async (_label, type) => {
    const h = harness();
    await importFiles(h.d, h.deps, [mdFile('# 拡張子で決まる\n', 'x.md', type)]);
    expect(h.written.map((e) => e.title)).toEqual(['拡張子で決まる']);
  });

  it('拡張子だけで決める(中身が HTML でも .md なら md として原文のまま入る)', async () => {
    // ⚠ どんなテキストも markdown として妥当なので、中身判定は必ず誤る。
    // `file_handlers` も拡張子で宣言している ── 宣言と実体を同じ規則で揃える
    const h = harness();
    await importFiles(h.d, h.deps, [mdFile('<div>これは md</div>\n', 'x.md')]);
    expect(h.written[0]!.body).toBe('<div>これは md</div>\n');
    expect(h.written[0]!.title).toBe('x');
  });
});
