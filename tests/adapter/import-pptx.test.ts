/** @vitest-environment happy-dom */
/**
 * 🔴 **PowerPoint(.pptx)の取込**(#530 C)── 実 zip を通した実行部と振り分け。
 *
 * 網の狙い:
 * ① 🔴 **書き出した .pptx を実物の zip として読み戻し**、板のノートが state に現れる
 * ② 🔴 **戻せなかったものは件数で言う**(0 件のときは言わない ── 対照群)
 * ③ 🔴 **壊れた zip / .pptx でない zip は断り、書込が 1 件も起きない**
 * ④ 振り分けが .pptx を md / vCard / PKC2 と取り違えない(混在は断る)
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { importFiles } from '../../src/adapter/ui/actions/import-file';
import { importPptxFiles } from '../../src/adapter/ui/actions/import-pptx';
import type { ImportDeps } from '../../src/adapter/ui/actions/import-pkc2';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { buildPptx, type ExportBlock } from '../../src/features/export/pptx';
import { ZipWriter } from '../../src/features/export/zip-writer';
import { markName } from '../../src/features/message/message-log';

const p = (text: string): ExportBlock => ({ kind: 'p', runs: [{ text }] });
const place = (x: number, y: number, w: number, h: number, name: string | null = null): ExportBlock =>
  ({ kind: 'place', x, y, w, h, shape: 'rect', name, span: 1 });

/** 部品の列 → 実 zip の File。 */
async function zipFile(
  parts: readonly { name: string; text: string }[],
  fileName = '板.pptx',
): Promise<File> {
  const z = new ZipWriter();
  for (const part of parts) await z.add(part.name, [part.text]);
  return new File([z.finish()], fileName);
}

const exported = (blocks: readonly ExportBlock[], title = 'T') =>
  buildPptx(blocks, { title }).parts;

function harness(opts: { failWrite?: boolean } = {}) {
  const written: EntryUpsert[] = [];
  const notices: string[] = [];
  let reported: readonly string[] = [];
  let n = 0;
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  const deps = {
    orderBase: () => 0,
    genLid: () => `pptx-lid-${++n}`,
    bulkUpsertEntries: async (entries: EntryUpsert[]) => {
      if (opts.failWrite) throw new Error('書込に失敗(注入)');
      written.push(...entries);
    },
    reload: async () => {
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
          bodyChars: null,
          createdAt: '2026-10-11T00:00:00Z',
          updatedAt: '2026-10-11T00:00:00Z',
        })),
        relations: [],
      });
    },
    notify: (m: string) => void notices.push(m),
    report: (notes: readonly string[]) => void (reported = notes),
  };
  return { d, deps, written, notices, reported: () => reported };
}

describe('importPptxFiles ── 実行部', () => {
  it('🔴 書き出した板を実 zip で読み戻すと、板のノートが 1 件できて state に現れる', async () => {
    const h = harness();
    const f = await zipFile(exported([place(0, 0, 200, 100), p('左'), place(400, 100, 200, 100), p('右')]));
    const got = await importPptxFiles(h.d, h.deps, [f]);
    expect(got).toBe(1);
    expect(h.written).toHaveLength(1);
    const row = h.written[0]!;
    // スライド 1 枚・題名の図形なし → file 名が題名
    expect(row.title).toBe('板');
    expect(row.archetype).toBe('text');
    expect((row.body.match(/\.pkc-place/g) ?? []).length, '枠の数').toBe(2);
    expect(h.d.getState().entryMetas.has(row.lid)).toBe(true);
    expect(h.notices.join('')).toContain('取り込み完了: 板 1 件');
    // 対照群 ── 戻せなかったものが無いときは、件数を言わない
    expect(h.notices.join('')).not.toContain('取り込めなかった');
    expect(h.reported()).toEqual([]);
  });

  it('🔴 複数のスライドは板を複数に分ける(1 枚 = 1 件)。題名の無い板は「file 名 N」', async () => {
    const h = harness();
    const f = await zipFile(
      exported([
        { kind: 'h', level: 2, runs: [{ text: '体制図' }] }, place(0, 0, 200, 100), p('a'),
        { kind: 'pagebreak' } as ExportBlock,
        place(0, 0, 200, 100), p('b'),
      ]),
      '資料.pptx',
    );
    const got = await importPptxFiles(h.d, h.deps, [f]);
    expect(got).toBe(2);
    expect(h.written.map((r) => r.title)).toEqual(['体制図', '資料 2']);
  });

  it('🔴 戻せなかった物（図）は件数で言う: 「取り込めなかったものが N 件ありました」', async () => {
    const h = harness();
    const parts = exported([place(0, 0, 200, 100), p('左')]).map((x) =>
      x.name === 'ppt/slides/slide1.xml'
        ? { ...x, text: x.text.replace('</p:spTree>', '<p:pic><p:nvPicPr/></p:pic><p:graphicFrame/></p:spTree>') }
        : x,
    );
    const got = await importPptxFiles(h.d, h.deps, [await zipFile(parts)]);
    expect(got).toBe(1);
    expect(h.reported()).toEqual(['取り込めなかったものが 2 件ありました']);
    expect(h.notices.join('')).toContain('取り込めなかったもの 2 件');
  });

  it('🔴 文字の大きさを近い段に丸めた付箋は枚数で言う(#530 段⑤a)。丸めなかった付箋・自分が書いた file は数えない', async () => {
    const two = [place(0, 0, 200, 100), p('左'), place(400, 100, 200, 100), p('右')];
    const rewrite = (to: string, nth: number) =>
      exported(two).map((x) => {
        if (x.name !== 'ppt/slides/slide1.xml') return x;
        // 2 枚目の付箋(nth=2)の run だけを書き換える ── 1 枚目は段の値(18pt)のまま
        let seen = 0;
        return { ...x, text: x.text.replace(/ sz="1800"/g, (m) => (++seen === nth ? ` sz="${to}"` : m)) };
      });
    const h = harness();
    const got = await importPptxFiles(h.d, h.deps, [await zipFile(rewrite('2400', 2))]);
    expect(got).toBe(1);
    expect(h.written[0]!.body).toContain('size=large');
    expect(h.reported()).toEqual(['文字の大きさを近い段(小 / 標準 / 大 / 特大)に丸めた付箋が 1 枚ありました']);
    expect(h.notices.join('')).toContain('文字の大きさを丸めた付箋 1 枚');
    // 対照群 ── 自分が書き出した file(段の値のまま)は何も言わない
    const clean = harness();
    await importPptxFiles(clean.d, clean.deps, [await zipFile(exported(two))]);
    expect(clean.reported()).toEqual([]);
    expect(clean.notices.join('')).not.toContain('丸め');
    // 取り込めなかった物と丸めた物が同時のとき、取り込み完了の 1 行に両方が出る
    const both = harness();
    const parts = rewrite('2400', 2).map((x) =>
      x.name === 'ppt/slides/slide1.xml'
        ? { ...x, text: x.text.replace('</p:spTree>', '<p:pic><p:nvPicPr/></p:pic></p:spTree>') }
        : x,
    );
    await importPptxFiles(both.d, both.deps, [await zipFile(parts)]);
    expect(both.notices.join('')).toContain('(取り込めなかったもの 1 件、文字の大きさを丸めた付箋 1 枚)');
  });

  it('🔴 壊れた zip は断り、書込が 1 件も起きない', async () => {
    const h = harness();
    const got = await importPptxFiles(h.d, h.deps, [new File(['PK\u0003\u0004これは壊れている'.repeat(5)], 'x.pptx')]);
    expect(got).toBeNull();
    expect(h.written).toHaveLength(0);
    // 🔑 断り文は「zip として壊れている」専用の文言で見る（どの枝で断ったかを区別する）
    expect(h.d.getState().error ?? '').toContain('PowerPoint のファイルではないか、中身を読み込めません');
    expect(h.d.getState().error ?? '').toContain('ノートは 1 件も追加されていません');
  });

  it('🔴 zip だが .pptx でない（スライドが無い）ものは断る', async () => {
    const h = harness();
    const f = await zipFile([{ name: 'readme.txt', text: 'x' }], 'ふつうの.pptx');
    const got = await importPptxFiles(h.d, h.deps, [f]);
    expect(got).toBeNull();
    expect(h.written).toHaveLength(0);
    expect(h.d.getState().error ?? '').toContain('PowerPoint のファイルではありません');
  });

  it('図形が 1 つも読めない file は断る（空のノートを作らない）', async () => {
    const h = harness();
    const parts = exported([p('字だけ')]).map((x) => x);
    // 字だけのスライドは「本文」の図形 1 つ ── 題名も板も無い pptx を作る
    const slim = parts.map((x) =>
      x.name === 'ppt/slides/slide1.xml'
        ? { ...x, text: x.text.replace(/<p:sp>[\s\S]*<\/p:sp>/, '') }
        : x,
    );
    const got = await importPptxFiles(h.d, h.deps, [await zipFile(slim)]);
    expect(got).toBeNull();
    expect(h.written).toHaveLength(0);
  });

  it('書込に失敗したら可視で断る', async () => {
    const h = harness({ failWrite: true });
    const f = await zipFile(exported([place(0, 0, 200, 100), p('a')]));
    expect(await importPptxFiles(h.d, h.deps, [f])).toBeNull();
    expect(h.d.getState().error ?? '').toContain('取り込みに失敗しました');
  });
});

describe('importPptxFiles ── 読んでいる間に編集が始まった', () => {
  it('🔴 書込の直前に門を通し直し、書かずに断る', async () => {
    const h = harness();
    h.d.dispatch({
      type: 'SYS_BOOTED', cid: 'c1',
      metas: [{ lid: 'e1', title: 't', archetype: 'text', entryOrder: 1, status: null, date: null,
        archived: false, bodyChars: null, createdAt: null, updatedAt: null }],
      relations: [],
    });
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    h.d.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: '' });
    // 読んでいる最中（lid を配るとき）に user が編集を始める
    const genLid = h.deps.genLid;
    h.deps.genLid = () => {
      h.d.dispatch({ type: 'START_EDIT' });
      return genLid();
    };
    const f = await zipFile(exported([place(0, 0, 200, 100), p('a')]));
    expect(await importPptxFiles(h.d, h.deps, [f])).toBeNull();
    expect(h.written).toHaveLength(0);
    expect(h.d.getState().error ?? '').toContain('取り込んでください');
  });
});

describe('importFiles ── 振り分け', () => {
  const asDeps = (h: ReturnType<typeof harness>): ImportDeps => h.deps as unknown as ImportDeps;

  it('.pptx は PowerPoint の経路へ入る（PKC2 の経路へ落ちない）', async () => {
    const h = harness();
    const f = await zipFile(exported([place(0, 0, 200, 100), p('a')]));
    expect(await importFiles(h.d, asDeps(h), [f])).toBe(1);
    expect(h.written).toHaveLength(1);
  });

  it('種類の違うファイルが混ざっていたら断る（PowerPoint だけ入って他が落ちない）', async () => {
    const h = harness();
    const f = await zipFile(exported([place(0, 0, 200, 100), p('a')]));
    const md = new File(['# a'], 'a.md');
    expect(await importFiles(h.d, asDeps(h), [f, md])).toBeNull();
    expect(h.written).toHaveLength(0);
    expect(h.d.getState().error ?? '').toContain('PowerPoint');
  });
});

describe('importPptxFiles ── 順番・上限・file 名の目印(#1087)', () => {
  const titled = (): readonly { name: string; text: string }[] =>
    exported([
      { kind: 'h', level: 2, runs: [{ text: 'A' }] }, place(0, 0, 200, 100), p('a'),
      { kind: 'pagebreak' } as ExportBlock,
      { kind: 'h', level: 2, runs: [{ text: 'B' }] }, place(0, 0, 200, 100), p('b'),
    ]);

  it('🔴 スライドの順番は presentation.xml が決める(並べ替えた file は、番号の順と違う)', async () => {
    const swapped = titled().map((x) => {
      if (x.name !== 'ppt/presentation.xml') return x;
      const ids = [...x.text.matchAll(/<p:sldId [^>]*\/>/g)].map((m) => m[0]);
      expect(ids, '前提: スライドは 2 枚').toHaveLength(2);
      return { ...x, text: x.text.replace(ids.join(''), [...ids].reverse().join('')) };
    });
    const h = harness();
    expect(await importPptxFiles(h.d, h.deps, [await zipFile(swapped)])).toBe(2);
    expect(h.written.map((r) => r.title)).toEqual(['B', 'A']);
    // 対照群: 触らない file は番号の順のまま
    const c = harness();
    await importPptxFiles(c.d, c.deps, [await zipFile(titled())]);
    expect(c.written.map((r) => r.title)).toEqual(['A', 'B']);
  });

  it('🔴 200 枚を超えたスライドは、図形の「取り込めなかったもの」と分けて言う', async () => {
    const base = titled();
    const slide1 = base.find((x) => x.name === 'ppt/slides/slide1.xml')!.text;
    // presentation を外す(番号順に倒れる)── 201 枚を同じ中身で並べる
    const parts = base.filter((x) => !/^ppt\/slides\/slide\d+\.xml$|presentation/.test(x.name));
    for (let i = 1; i <= 201; i++) parts.push({ name: `ppt/slides/slide${i}.xml`, text: slide1 });
    const h = harness();
    expect(await importPptxFiles(h.d, h.deps, [await zipFile(parts)])).toBe(200);
    expect(h.reported()).toEqual(['スライドが多いため、先頭の 200 枚だけ取り込みました(残り 1 枚は取り込んでいません)']);
    const said = h.notices.join('');
    expect(said).toContain('取り込まなかったスライド 1 枚');
    expect(said, 'スライドの超過を「取り込めなかったもの」に混ぜない').not.toContain('取り込めなかったもの');
  });

  it('対照群: 図形が取り込めなかったときは従来の字(スライドの超過は言わない)', async () => {
    const parts = titled().map((x) =>
      x.name === 'ppt/slides/slide1.xml'
        ? { ...x, text: x.text.replace('</p:spTree>', '<p:pic><p:nvPicPr/></p:pic></p:spTree>') }
        : x,
    );
    const h = harness();
    await importPptxFiles(h.d, h.deps, [await zipFile(parts)]);
    expect(h.reported()).toEqual(['取り込めなかったものが 1 件ありました']);
    expect(h.notices.join('')).not.toContain('取り込まなかったスライド');
  });

  it('🔴 断り文の file 名には目印を付ける(名前に」が入っても、後半が画面の字に残らない)', async () => {
    const name = '【重要】「A社との契約」について.pptx';
    const broken = harness();
    await importPptxFiles(broken.d, broken.deps, [new File(['PK\u0003\u0004これは壊れている'.repeat(5)], name)]);
    expect(broken.d.getState().error ?? '').toContain(markName(name));
    const noSlides = harness();
    await importPptxFiles(noSlides.d, noSlides.deps, [await zipFile([{ name: 'readme.txt', text: 'x' }], name)]);
    expect(noSlides.d.getState().error ?? '').toContain(markName(name));
  });
});
