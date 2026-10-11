/** @vitest-environment happy-dom */
/**
 * 🔴 **カレンダー形式(.ics)の取込**(#855 段 D)── 実行部と振り分け。
 *
 * 網の狙い(`import-vcf.test.ts` と同じ型):
 * ① 取り込んだ予定が **state に現れ**、予定表の**実物の読み手**(`taskCardsOf`)で札になる
 * ② 断る入力で **書込が 1 件も起きない**(部分的に書かない)
 * ③ 読めなかった物は**種類ごとに数えて user に言う**(黙って落とさない)
 * ④ 振り分けが .ics を他の種類と取り違えない(混在は断る)。ピッカーの accept と揃う
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { importFiles } from '../../src/adapter/ui/actions/import-file';
import { importIcsFiles } from '../../src/adapter/ui/actions/import-ics';
import type { ImportDeps } from '../../src/adapter/ui/actions/import-pkc2';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { taskCardsOf } from '../../src/features/schedule/task-cards';
import { isIcsFileName } from '../../src/features/schedule/ics-import';

const icsFile = (body: string, name = 'work.ics'): File => new File([body], name, { type: '' });

const wrap = (...events: string[][]): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']),
    'END:VCALENDAR',
  ].join('\r\n');

// 端末の時刻帯に依らない入力(浮動の時刻 / 終日)だけで作る
const MEETING = [
  'DTSTART:20260831T140000',
  'DTEND:20260831T150000',
  'RRULE:FREQ=WEEKLY',
  'SUMMARY:定例会議',
  'LOCATION:会議室 A',
];
const TRIP = ['DTSTART;VALUE=DATE:20260901', 'DTEND;VALUE=DATE:20260904', 'SUMMARY:出張'];

function harness(opts: { failWrite?: boolean } = {}) {
  const written: EntryUpsert[] = [];
  const notices: string[] = [];
  let reported: readonly string[] = [];
  let n = 0;
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  const deps = {
    orderBase: () => 0,
    genLid: () => `ics-lid-${++n}`,
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

describe('importIcsFiles ── 実行部', () => {
  it('🔴 1 file = 1 ノート。題名は「取り込んだ予定 <file 名>」で、予定表の実物の読み手が札にする', async () => {
    const h = harness();
    const got = await importIcsFiles(h.d, h.deps, [icsFile(wrap(MEETING, TRIP))]);
    expect(got).toBe(2);
    expect(h.written).toHaveLength(1);
    const row = h.written[0]!;
    expect(row.title).toBe('取り込んだ予定 work.ics');
    expect(row.archetype).toBe('text');
    // 🔑 綴りの共有ではなく、予定表の読み手で検算する
    const cards = taskCardsOf(row.lid, row.body);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      text: '定例会議', date: '2026-08-31', time: '14:00', timeEnd: '15:00', repeat: 'week', until: null,
    });
    expect(cards[1]).toMatchObject({ text: '出張', date: '2026-09-01', until: '2026-09-03', time: null, repeat: null });
    expect(row.body).toContain('  - 場所: 会議室 A');
    expect(h.d.getState().entryMetas.has(row.lid)).toBe(true);
    expect(h.notices.join('')).toBe('予定 2 件を取り込みました');
  });

  it('🔴 読めなかった物は種類ごとに数えて言う(予定は落とさない)', async () => {
    const h = harness();
    const ics = wrap(
      ['DTSTART;VALUE=DATE:20260901', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:回数指定'],
      ['DTSTART;VALUE=DATE:20260902', 'SUMMARY:取り消し', 'STATUS:CANCELLED'],
      ['SUMMARY:日付なし'],
      ['DTSTART;VALUE=DATE:20260903', 'SUMMARY:普通'],
    );
    const got = await importIcsFiles(h.d, h.deps, [icsFile(ics)]);
    expect(got).toBe(2);
    const said = h.notices.join('');
    expect(said).toContain('予定 2 件を取り込みました');
    expect(said).toContain('1 件は繰り返しを読めず 1 回目だけ入れました');
    expect(said).toContain('1 件は取り消された予定なので入れていません');
    expect(said).toContain('1 件は日付を読めず入れていません');
    // 回数指定の予定は 1 回目として入っている
    expect(h.written[0]!.body).toContain('- [ ] @2026-09-01 回数指定');
  });

  it('複数 file は file ごとに 1 ノート', async () => {
    const h = harness();
    await importIcsFiles(h.d, h.deps, [icsFile(wrap(TRIP), 'a.ics'), icsFile(wrap(MEETING), 'b.ics')]);
    expect(h.written.map((r) => r.title)).toEqual(['取り込んだ予定 a.ics', '取り込んだ予定 b.ics']);
    expect(h.written.map((r) => r.entryOrder)).toEqual([1, 2]);
  });

  it('🔴 予定が 1 件も読めない file は書込なしで断る(ノートを作らない)', async () => {
    const h = harness();
    const got = await importIcsFiles(h.d, h.deps, [icsFile('これはカレンダーではない')]);
    expect(got).toBeNull();
    expect(h.written).toHaveLength(0);
    expect(h.d.getState().error ?? '').toContain('取り込める予定が 1 件もありませんでした');
  });

  it('🔴 大きすぎる file は読まずに断る(書込なし)', async () => {
    const h = harness();
    const big = icsFile('x', 'big.ics');
    Object.defineProperty(big, 'size', { value: 9 * 1024 * 1024 });
    const got = await importIcsFiles(h.d, h.deps, [icsFile(wrap(TRIP), 'ok.ics'), big]);
    expect(got).toBeNull();
    expect(h.written, '先の file だけ書いた(部分的な成功)').toHaveLength(0);
    expect(h.d.getState().error ?? '').toContain('大きすぎて取り込めません');
  });

  it('🔴 予定が多すぎる file は断る(書込なし)', async () => {
    const h = harness();
    const ev = ['DTSTART;VALUE=DATE:20260901', 'SUMMARY:x'];
    const got = await importIcsFiles(h.d, h.deps, [icsFile(wrap(...Array.from({ length: 5001 }, () => ev)))]);
    expect(got).toBeNull();
    expect(h.written).toHaveLength(0);
    expect(h.d.getState().error ?? '').toContain('多すぎて取り込めません');
  });

  it('編集中・file 0 件は断る(書込なし)', async () => {
    const h = harness();
    expect(await importIcsFiles(h.d, h.deps, [])).toBeNull();
    expect(h.d.getState().error ?? '').toContain('取り込むファイルがありません');
    h.d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [{ lid: 'e1', title: 'a', archetype: 'text', entryOrder: 1, status: null, date: null, archived: false, bodyChars: null } as never],
      relations: [],
    });
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    h.d.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: '本文\n' });
    h.d.dispatch({ type: 'START_EDIT' });
    expect(await importIcsFiles(h.d, h.deps, [icsFile(wrap(TRIP))])).toBeNull();
    expect(h.d.getState().error ?? '').toContain('編集を終了してから');
    expect(h.written).toHaveLength(0);
    expect(h.written).toHaveLength(0);
  });

  it('🔴 読んでいる間に編集が始まったら、書かずに断る(書く直前にもう一度門を通す)', async () => {
    const h = harness();
    h.d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [{ lid: 'e1', title: 'a', archetype: 'text', entryOrder: 1, status: null, date: null, archived: false, bodyChars: null } as never],
      relations: [],
    });
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    h.d.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: '本文\n' });
    const f = icsFile(wrap(TRIP));
    // 読み込みの最中に user が編集を始めた、を作る
    f.text = async () => {
      h.d.dispatch({ type: 'START_EDIT' });
      return wrap(TRIP);
    };
    expect(await importIcsFiles(h.d, h.deps, [f])).toBeNull();
    expect(h.written, '編集中に書いた').toHaveLength(0);
    expect(h.d.getState().error ?? '').toContain('編集を終了してから');
  });

  it('書込が失敗したら可視の失敗で終える', async () => {
    const h = harness({ failWrite: true });
    expect(await importIcsFiles(h.d, h.deps, [icsFile(wrap(TRIP))])).toBeNull();
    expect(h.d.getState().error ?? '').toContain('取り込みに失敗しました');
  });
});

describe('振り分け(importFiles)', () => {
  it('全部 .ics なら予定の取込に入る', async () => {
    const h = harness();
    const got = await importFiles(h.d, h.deps as unknown as ImportDeps, [icsFile(wrap(TRIP))]);
    expect(got).toBe(1);
    expect(h.written[0]!.title).toBe('取り込んだ予定 work.ics');
  });

  it('🔴 .ics と他の種類の混在は断る(片方だけ入って黙って落ちる形を作らない)', async () => {
    const h = harness();
    const got = await importFiles(h.d, h.deps as unknown as ImportDeps, [icsFile(wrap(TRIP)), new File(['# a'], 'a.md')]);
    expect(got).toBeNull();
    expect(h.written).toHaveLength(0);
    expect(h.d.getState().error ?? '').toContain('分けて取り込んでください');
  });

  it('🔴 .ics と PKC2 の書き出し(html)の混在も「分けて」と断る(「1 つずつ」では、何を分けるか伝わらない)', async () => {
    const h = harness();
    const got = await importFiles(h.d, h.deps as unknown as ImportDeps, [icsFile(wrap(TRIP)), new File(['<html></html>'], 'a.html')]);
    expect(got).toBeNull();
    expect(h.written).toHaveLength(0);
    expect(h.d.getState().error ?? '').toContain('分けて取り込んでください');
  });

  it('🔴 ピッカーの accept が .ics を選べる(受理器と食い違わない)', () => {
    const shell = readFileSync('src/adapter/ui/render/shell.ts', 'utf-8');
    const m = /impInput\.accept =\s*'([^']+)'/.exec(shell);
    expect(m, 'accept の宣言を読めていない(空振り防止)').not.toBeNull();
    const exts = m![1]!.split(',').filter((x) => x.startsWith('.'));
    expect(isIcsFileName('a.ics')).toBe(true);
    expect(exts, '.ics をピッカーで選べない').toContain('.ics');
    expect(m![1]).toContain('text/calendar');
  });

  it('🔴 「取り込む」の説明が .ics を名乗る', async () => {
    const { COLLECTION_COMMANDS } = await import('../../src/adapter/ui/render/commands');
    const imp = COLLECTION_COMMANDS.find((c) => c.action === 'import-file');
    expect(imp!.title, '受けられるのに、入口が名乗っていない').toContain('.ics');
  });
});
