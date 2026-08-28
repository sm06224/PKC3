/** @vitest-environment happy-dom */
/**
 * 🔴 **vCard の取込**(#278 段③)── 実行部と振り分け。
 *
 * 網の狙い(`import-markdown.test.ts` と同じ型):
 * ① 取り込んだものが **state に現れる**(書いたつもりを作らない)
 * ② 🔴 取り込んだノートを**連絡先タブの実物の読み手**が読める(綴りの共有ではなく
 *    別の観測 ── §1)
 * ③ 断る入力で **書込が 1 件も起きない**
 * ④ 振り分けが .vcf を md / PKC2 と取り違えない(混在は断る)
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { importFiles } from '../../src/adapter/ui/actions/import-file';
import { importVcfFiles } from '../../src/adapter/ui/actions/import-vcf';
import type { ImportDeps } from '../../src/adapter/ui/actions/import-pkc2';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { contactOf } from '../../src/features/contact/contact-card';

/** ⚠ MIME は空が既定(md の取込と同じ理由 ── OS のピッカーは付けないことが多い)。 */
const vcfFile = (body: string, name = '連絡先.vcf', type = ''): File =>
  new File([body], name, { type });

const CARD = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:山田太郎',
  'ORG:例の会社',
  'TEL;TYPE=CELL:090-1234-5678',
  'EMAIL:taro@example.com',
  'END:VCARD',
].join('\r\n');

function harness(opts: { failWrite?: boolean } = {}) {
  const written: EntryUpsert[] = [];
  const notices: string[] = [];
  let reported: readonly string[] = [];
  let n = 0;
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  const deps = {
    orderBase: () => 0,
    genLid: () => `vcf-lid-${++n}`,
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
          createdAt: '2026-08-28T00:00:00Z',
          updatedAt: '2026-08-28T00:00:00Z',
        })),
        relations: [],
      });
    },
    notify: (m: string) => void notices.push(m),
    report: (notes: readonly string[]) => void (reported = notes),
  };
  return { d, deps, written, notices, reported: () => reported };
}

describe('importVcfFiles ── 実行部', () => {
  it('🔴 1 枚 = 1 ノートになり、連絡先タブの実物の読み手が読める', async () => {
    const h = harness();
    const got = await importVcfFiles(h.d, h.deps, [vcfFile(CARD)]);
    expect(got).toBe(1);
    expect(h.written).toHaveLength(1);
    const row = h.written[0]!;
    expect(row.title).toBe('山田太郎');
    // 🔑 綴りではなく実物の読み手(contactOf)で検算する
    const card = contactOf(row.lid, row.title, row.body);
    expect(card).not.toBeNull();
    expect(card!.tels).toEqual(['090-1234-5678']);
    expect(card!.emails).toEqual(['taro@example.com']);
    expect(card!.org).toBe('例の会社');
    // state にも現れている(reload 経由)
    expect(h.d.getState().entryMetas.has(row.lid)).toBe(true);
    expect(h.notices.join('')).toContain('連絡先 1 件');
  });

  it('名前の無いカードには番号名を振り、注意で言う(黙って捨てない)', async () => {
    const h = harness();
    const noName = 'BEGIN:VCARD\r\nTEL:090\r\nEND:VCARD';
    await importVcfFiles(h.d, h.deps, [vcfFile(noName, 'a.vcf')]);
    expect(h.written[0]!.title).toBe('連絡先 1');
    expect(h.reported().join('')).toContain('名前の無いカード');
  });

  it('🔴 1 枚も読めなければ断り、書込は 1 件も起きない', async () => {
    const h = harness();
    const got = await importVcfFiles(h.d, h.deps, [vcfFile('ただの文章')]);
    expect(got).toBeNull();
    expect(h.written).toHaveLength(0);
    expect(h.d.getState().error ?? '').toContain('読めませんでした');
  });

  it('編集中は断る(裏で書かない)', async () => {
    const h = harness();
    h.d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        {
          lid: 'e1',
          title: 't',
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
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    h.d.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: '' });
    h.d.dispatch({ type: 'START_EDIT' });
    const got = await importVcfFiles(h.d, h.deps, [vcfFile(CARD)]);
    expect(got).toBeNull();
    expect(h.written).toHaveLength(0);
  });
});

describe('振り分け(importFiles)', () => {
  it('全部 .vcf なら vCard 経路に入る', async () => {
    const h = harness();
    const got = await importFiles(h.d, h.deps as unknown as ImportDeps, [vcfFile(CARD)]);
    expect(got).toBe(1);
    expect(h.written[0]!.title).toBe('山田太郎');
  });

  it('🔴 md と .vcf の混在は断る(片方だけ入って黙って落ちる形を作らない)', async () => {
    const h = harness();
    const got = await importFiles(h.d, h.deps as unknown as ImportDeps, [
      vcfFile(CARD),
      new File(['# a'], 'a.md'),
    ]);
    expect(got).toBeNull();
    expect(h.written).toHaveLength(0);
    expect(h.d.getState().error ?? '').toContain('分けて取り込んでください');
  });
});

describe('書き出し(binder の export-vcards)── §7: 画面と同じ 1 つの規則', () => {
  it('🔴 絞り込み中は、絞った分だけが .vcf に入る(全件を静かに出さない)', async () => {
    const { bindActions } = await import('../../src/adapter/ui/actions/binder');
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    d.dispatch({
      type: 'SET_CONTACT_SCAN',
      scan: {
        cards: [
          { lid: 'a', name: '山田', org: '', tels: ['090'], emails: [] },
          { lid: 'b', name: '別人', org: '', tels: [], emails: ['b@x.jp'] },
        ],
        totalNotes: 2,
        scannedNotes: 2,
        truncated: false,
      },
    });
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '山田' });

    // ⚠ URL を丸ごと差し替えない(コンストラクタを壊す ── 2026-07-26 の教訓)。
    //   静的メソッドだけを与え、渡された Blob の中身を読む
    let blobText: string | null = null;
    const orig = URL.createObjectURL;
    URL.createObjectURL = ((b: Blob) => {
      void b.text().then((t) => (blobText = t));
      return 'blob:probe';
    }) as typeof URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    try {
      const btn = document.createElement('button');
      btn.setAttribute('data-pkc-action', 'export-vcards');
      root.append(btn);
      btn.click();
      await new Promise((r) => setTimeout(r, 10));
      expect(blobText, '書き出しが走っていない').not.toBeNull();
      expect(blobText!).toContain('FN:山田');
      // 🔴 絞りの外の連絡先は入らない
      expect(blobText!, '絞ったのに全件が出た').not.toContain('別人');
    } finally {
      URL.createObjectURL = orig;
      URL.revokeObjectURL = origRevoke;
    }
  });
});

describe('書き出し ── 空の門', () => {
  it('連絡先が 1 件も見えていなければ断る(無言で空の file を落とさない)', async () => {
    const { bindActions } = await import('../../src/adapter/ui/actions/binder');
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'export-vcards');
    root.append(btn);
    btn.click();
    expect(d.getState().error ?? '').toContain('書き出せる連絡先がありません');
  });
});
