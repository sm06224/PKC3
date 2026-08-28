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
import { isVcfFileName } from '../../src/features/contact/vcard';
import { readFileSync } from 'node:fs';

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

  /**
   * 🔴 **「取り込んだ数」と「連絡先に並ぶ数」は別**(着地前レビュー 2026-08-28)。
   *
   * ⚠ 1 稿目は作ったノートの数を「連絡先 N 件」と出していた。ところが
   *   連絡先の面に並ぶ条件は**電話かメールが 1 つ以上**なので、住所だけの
   *   カードは**ノートにはなるが面には出ない** ── user は「2 件取り込んだのに
   *   1 件しか無い。残りは消えた」と読む(実際はノートとして在る)。
   * 🔑 数える規則は面と**同じ 1 つ**(`contactOf`)である ── ここでも
   *   実物の読み手で検算する(§7)。
   */
  it('🔴 連絡先に並ばないカードは、数を分けて言い、在り処まで言う', async () => {
    const h = harness();
    const adrOnly = 'BEGIN:VCARD\r\nFN:住所だけ\r\nADR:;;東京都;;;;\r\nEND:VCARD';
    await importVcfFiles(h.d, h.deps, [vcfFile(`${CARD}\r\n${adrOnly}`)]);
    expect(h.written, '書けた数が違う').toHaveLength(2);
    // 面に並ぶのは 1 件だけ ── 実物の読み手で確かめる(前提の検算)
    expect(h.written.filter((r) => contactOf(r.lid, r.title, r.body) !== null)).toHaveLength(1);
    const said = h.notices.join('');
    expect(said, '取り込んだ数を言っていない').toContain('ノート 2 件');
    expect(said, '面に並ぶ数を言っていない').toContain('連絡先に並ぶのは 1 件');
    expect(h.reported().join(''), '出ない理由と在り処を言っていない').toContain(
      '連絡先の一覧には出ません',
    );
  });

  it('⚠ 対照群 ── 全部が連絡先なら 1 つの数で言う(ノートと連絡先を並べない)', async () => {
    const h = harness();
    await importVcfFiles(h.d, h.deps, [vcfFile(CARD)]);
    const said = h.notices.join('');
    expect(said).toContain('取込完了: 連絡先 1 件');
    expect(said, '分ける必要が無いのに 2 つの数を並べた').not.toContain('ノート');
  });

  /**
   * 🔴 **同じ注意を並べない**(2 巡目の動線レビュー 2026-08-28)。
   * ⚠ スマホの .vcf はほぼ全件が写真つきなので、畳まないと注意欄が
   *   **同一文の壁**になり、行動が要る注意がその中に埋もれる。
   */
  it('🔴 同じ理由の注意は 1 行に畳んで枚数で言う(壁を作らない)', async () => {
    const h = harness();
    const withPhoto = (n: string): string =>
      `BEGIN:VCARD\r\nFN:${n}\r\nTEL:090\r\nPHOTO;ENCODING=B:QUJD\r\nEND:VCARD`;
    const many = Array.from({ length: 12 }, (_, i) => withPhoto(`人${i}`)).join('\r\n');
    await importVcfFiles(h.d, h.deps, [vcfFile(many)]);
    const said = h.reported();
    const photo = said.filter((w) => w.includes('写真'));
    expect(photo, '12 枚ぶん並べた(壁になる)').toHaveLength(1);
    expect(photo[0], '枚数を言っていない').toContain('(12 枚)');
  });

  it('⚠ 対照群 ── 理由が違う注意は畳まない(別の行のまま残る)', async () => {
    const h = harness();
    const v =
      'BEGIN:VCARD\r\nFN:A\r\nTEL:090\r\nPHOTO;ENCODING=B:QUJD\r\nEND:VCARD\r\n' +
      'BEGIN:VCARD\r\nTEL:091\r\nEND:VCARD';
    await importVcfFiles(h.d, h.deps, [vcfFile(v)]);
    const said = h.reported().join('\n');
    expect(said).toContain('写真');
    expect(said, '別の理由まで畳んだ').toContain('名前の無いカード');
  });

  it('🔴 名前の無いカードの番号は飛ばない(取り込んだ通し番号を使わない)', async () => {
    const h = harness();
    const named = 'BEGIN:VCARD\r\nFN:山田\r\nTEL:090\r\nEND:VCARD';
    const anon = 'BEGIN:VCARD\r\nTEL:091\r\nEND:VCARD';
    await importVcfFiles(h.d, h.deps, [vcfFile([named, anon, named, anon].join('\r\n'))]);
    expect(
      h.written.map((r) => r.title),
      '番号が飛んで「1〜N はどこへ行った」と読める',
    ).toEqual(['山田', '連絡先 1', '山田', '連絡先 2']);
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
  /**
   * 🔴 **ピッカーが受ける綴りと、受理器が受ける綴りを揃える**
   * (2 巡目の着地前レビュー 2026-08-28)。
   *
   * ⚠ `accept`(`shell.ts`)と `isVcfFileName`(`vcard.ts`)は**別々の宣言**である。
   *   smoke は `.vcf` しか見ていないので、`accept` から `.vcard` を落としても緑 ──
   *   つまり **user はピッカーで `.vcard` を選べなくなるのに、誰も鳴らない**(§7)。
   */
  /**
   * 🔴 **入口が「受けられる物」を名乗る**(2 巡目の動線レビュー 2026-08-28)。
   * ⚠ vCard を足したのに「取り込む」の説明が 1 文字も変わっておらず、
   *   user は**対応していないと結論する**(「在るのに見つけられないのは、
   *   こちらの動線の不備」── CLAUDE.md 2026-08-27)。
   */
  /**
   * 🔴 **選ばせる前に断る**(#535 ③)。
   * ⚠ 直す前は picker を開き、user が file を選び終わった**後で**断っていた ──
   *   選ぶ手間が丸ごと無駄になる。#513 で右ペインの日付ピッカーについて直したのと
   *   **同じ形**である。
   */
  it('🔴 編集中は、ファイルを選ばせる前に断る(picker を開かない)', async () => {
    const { bindActions } = await import('../../src/adapter/ui/actions/binder');
    const { buildShell } = await import('../../src/adapter/ui/render/shell');
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    buildShell(root);
    const d = new Dispatcher();
    bindActions(root, d);
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        {
          lid: 'e1',
          title: 'a',
          archetype: 'text',
          entryOrder: 1,
          status: null,
          date: null,
          archived: false,
          bodyChars: null,
        } as never,
      ],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: '本文\n' });
    d.dispatch({ type: 'START_EDIT' });

    const input = root.querySelector<HTMLInputElement>('[data-pkc-field="import-input"]')!;
    let opened = 0;
    input.click = () => {
      opened += 1;
    };
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'import-file');
    root.querySelector('[data-pkc-region="shell"]')!.append(btn);
    btn.click();
    expect(opened, '編集中なのにファイル選択を開いた(選ぶ手間が無駄になる)').toBe(0);
    expect(d.getState().error ?? '', '黙って開かなかった').toContain('編集を終了してから');

    // ⚠ 対照群 ── 編集を終えれば開く(片道にしない)
    d.dispatch({ type: 'CANCEL_EDIT' });
    btn.click();
    expect(opened, '編集を終えたのに開かない').toBe(1);
  });

  it('🔴 「取り込む」の説明が vCard を名乗る', async () => {
    const { COLLECTION_COMMANDS } = await import('../../src/adapter/ui/render/commands');
    const imp = COLLECTION_COMMANDS.find((c) => c.action === 'import-file');
    expect(imp, '取り込むの口が消えた(空振り防止)').toBeDefined();
    expect(imp!.title, '受けられるのに、入口が名乗っていない').toContain('.vcf');
  });

  it('🔴 ピッカーの accept と、受理する拡張子が食い違わない', () => {
    const shell = readFileSync('src/adapter/ui/render/shell.ts', 'utf-8');
    const m = /impInput\.accept =\s*'([^']+)'/.exec(shell);
    expect(m, 'accept の宣言を読めていない(空振り防止)').not.toBeNull();
    const exts = m![1]!.split(',').filter((x) => x.startsWith('.'));
    // 受理器が vCard と認める拡張子は、全部ピッカーからも選べること
    for (const ext of exts.filter((x) => isVcfFileName(`a${x}`)))
      expect(exts, `${ext} を受けるのに選べない`).toContain(ext);
    for (const ext of ['.vcf', '.vcard']) {
      expect(isVcfFileName(`a${ext}`), `${ext} を受理器が受けない`).toBe(true);
      expect(exts, `${ext} をピッカーで選べない`).toContain(ext);
    }
  });

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
          { lid: 'a', name: '山田', org: '', orgParts: [], tels: ['090'], emails: [], birthday: '', overlong: false },
          {
            lid: 'b',
            name: '別人',
            org: '',
            orgParts: [],
            tels: [],
            emails: ['b@x.jp'],
            birthday: '',
            overlong: false,
          },
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
      /**
       * 🔴 **押した後の帯が「全部出た」と読ませない**(2 巡目の動線レビュー 2026-08-28)。
       * ⚠ 断りが在るのは**マウスを乗せたときだけ出るボタンの説明**だけだったので、
       *   触る画面や字だけ見て押した user には届かない ── そのまま
       *   **元の .vcf を捨てる**恐れがある(取り返しがつかない側)。
       */
      expect(
        d.getState().notice ?? '',
        '何が入っていないかを、押した後に言っていない',
      ).toContain('名前・所属・電話・メール・誕生日だけ');
      // ⚠ 対照群 ── 切っていないので「途中まで」とは言わない
      expect(d.getState().notice ?? '', '切っていないのに断りを出した').not.toContain('途中まで');

      /**
       * 🔴 **途中までしか集めていないなら、押した後の帯でも言う**(#536 ①)。
       * ⚠ ボタンの字と帯は**別の読み手**である(字を見ずに押す人・帯だけ見る人)──
       *   片方だけ言うと、もう片方は「全部出た」と読む。
       */
      d.dispatch({
        type: 'SET_CONTACT_SCAN',
        scan: {
          cards: [
            { lid: 'a', name: '山田', org: '', orgParts: [], tels: ['090'], emails: [], birthday: '', overlong: false },
          ],
          totalNotes: 9999,
          scannedNotes: 9999,
          truncated: true,
        },
      });
      btn.click();
      await new Promise((r) => setTimeout(r, 10));
      expect(d.getState().notice ?? '', '切ったのに帯が黙っている').toContain('途中まで');

      /**
       * 🔴 **外した宛先は、件数で言う**(#536 ③、2026-08-28)。
       *
       * ⚠ 長すぎる値(1,000 字超)は **card に入る前に外れている**(`contactOf`)──
       *   途中で切った宛先を相手の端末へ「在るもの」として保存させないためである。
       * 🔴 **だが黙って外すと「静かに失う」そのもの**で、user は宛先の欠けた
       *   連絡先を渡し、相手が連絡できないことに後で気づく。
       * 🔑 **同じ人の本物の宛先は残る**(外れたのはその値だけ)── ここも一緒に見る。
       */
      d.dispatch({
        type: 'SET_CONTACT_SCAN',
        scan: {
          cards: [
            {
              lid: 'a',
              name: '山田',
              org: '',
              orgParts: [],
              // 🔑 長い落書きは既に外れており、本物の 090 だけが残っている形
              tels: ['090-1234-5678'],
              emails: [],
              birthday: '',
              overlong: true,
            },
          ],
          totalNotes: 1,
          scannedNotes: 1,
          truncated: false,
        },
      });
      btn.click();
      await new Promise((r) => setTimeout(r, 10));
      expect(d.getState().notice ?? '', '宛先を外したのに黙っている').toContain(
        '1 件で、長すぎる電話・メール',
      );
      // 🔴 **残った本物の宛先は書く**(巻き添えで消さない ── 1 稿目はここで壊れていた)
      expect(blobText!, '🔴 本物の電話が .vcf から消えた').toContain(
        'TEL;TYPE=voice:090-1234-5678',
      );
      expect(blobText!, '名前まで落としている').toContain('FN:山田');
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
