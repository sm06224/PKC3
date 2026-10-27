/** @vitest-environment happy-dom */
/**
 * 書き出しの見え方(台帳 #1852 束 K2 ── #1163 の依頼 53 / 116 / 124 / 142・143・144 / 278 / 280 / 281 / 282)。
 *
 * 守る主張(どれも「壊したら鳴る」形 ── 対照群を同じ it に置く):
 * 1. Word の 1 行目に題名が大きな見出しで入る / 本文が同じ題名の大見出しで始まるときは足さない
 * 2. チェックの項目は黒丸(numPr)を持たない / 普通の項目は持つ(対照)
 * 3. 表のマスの中の画像に「表の N 行目・M 列目の画像」が付く
 * 4. 本文が空のノートは Word / PowerPoint に書き出さずに断る / 画像があるときだけ枚数を言う
 * 5. 名前の無い変数・板に置いたノートの題名・`:::if{format=…}` の読み方
 * 6. 見出しで畳んだ章は刷る間だけ開き、刷り終えたら畳み直す
 * 7. フォルダは書き出しを押せない(情報ペインの説明 / PDF の入口)
 */
import { describe, expect, it } from 'vitest';
import { buildDocx, type DocxBlock } from '../../src/features/export/docx';
import { htmlToDocxBlocks } from '../../src/adapter/platform/export/html-blocks';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { insertPlacedNoteTitles, placedNoteLineForWord } from '../../src/features/export/placed-note-title';
import { undefinedVarNotice } from '../../src/features/export/undefined-var-notice';
import {
  exportEntryDocx,
  exportEntryPptx,
  type ExportDeps,
} from '../../src/adapter/ui/actions/export-archive';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';
import { applyHeadingFold } from '../../src/adapter/ui/render/heading-fold';
import {
  openHeadingFoldsForPrint,
  restoreHeadingFoldsAfterPrint,
} from '../../src/adapter/ui/render/print-editing';
import { entryActionHint, FOLDER_EXPORT_BLOCKED_ACTIONS, FOLDER_EXPORT_NOTE } from '../../src/features/entry-actions';
import { printNote, PRINT_GUIDE, type PrintNoteDeps } from '../../src/adapter/platform/print-note';
import { initialState, reduce, type AppState, type Dispatchable } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';

const parse = (html: string): Document => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
const blocksOf = (md: string): DocxBlock[] => htmlToDocxBlocks(parse(renderMarkdown(md))).blocks;
const docXml = (blocks: DocxBlock[], title: string): string =>
  buildDocx(blocks, title, '2026-10-17T00:00:00Z').parts.find((p) => p.name === 'word/document.xml')!.text;

describe('Word の 1 行目に題名(依頼 144 = ②)', () => {
  it('🔴 本文の前に、題名が見出し 1 として入る', () => {
    const xml = docXml(blocksOf('本文です'), 'ノートの題名');
    const head = xml.indexOf('Heading1');
    expect(head, '見出し 1 が無い').toBeGreaterThan(-1);
    expect(xml.indexOf('ノートの題名')).toBeGreaterThan(-1);
    expect(xml.indexOf('ノートの題名'), '題名が本文より後ろ').toBeLessThan(xml.indexOf('本文です'));
  });

  it('対照: 本文が同じ題名の大見出しで始まるなら足さない(題名が 2 回続かない)', () => {
    const xml = docXml(blocksOf('# ノートの題名\n\n本文'), 'ノートの題名');
    expect(xml.split('ノートの題名').length - 1, '題名が 2 回入った').toBe(1);
  });

  it('対照: 本文が違う大見出しで始まるなら足す', () => {
    const xml = docXml(blocksOf('# 別の見出し\n\n本文'), 'ノートの題名');
    expect(xml).toContain('ノートの題名');
    expect(xml).toContain('別の見出し');
  });
});

describe('チェックの項目は黒丸を出さない(依頼 280 = A)', () => {
  it('🔴 チェックの項目は numPr を持たず、☑ / ☐ の字を持つ。普通の項目は持つ(対照)', () => {
    const blocks = blocksOf('- [x] 済み\n- [ ] 未\n\n- 普通\n');
    const lis = blocks.filter((b): b is Extract<DocxBlock, { kind: 'li' }> => b.kind === 'li');
    expect(lis.map((l) => l.task === true)).toEqual([true, true, false]);
    const xml = docXml(blocks, 't');
    const paras = xml.split('<w:p>').filter((p) => p.includes('ListParagraph'));
    expect(paras).toHaveLength(3);
    expect(paras[0]!, 'チェックの項目に黒丸の指定').not.toContain('<w:numId');
    expect(paras[0]!).toContain('☑');
    expect(paras[1]!).not.toContain('<w:numId');
    expect(paras[1]!).toContain('☐');
    expect(paras[2]!, '普通の項目は黒丸のまま').toContain('<w:numId');
  });
});

describe('表のマスの中の画像(依頼 124-3 = A)', () => {
  it('🔴 表の後ろに「表の N 行目・M 列目の画像」を添えて、どのマスの画像か分かる', () => {
    const img = (k: string): string => `<img data-pkc-asset-key="${k}" alt="a">`;
    const doc = parse(
      `<table><tr><th>h1</th><th>h2</th></tr><tr><td>x</td><td>y ${img('k1')}</td></tr></table>`,
    );
    const { blocks, images } = htmlToDocxBlocks(doc);
    const caption = blocks.findIndex((b) => b.kind === 'p' && b.runs.map((r) => r.text).join('') === '表の 2 行目・2 列目の画像');
    expect(caption, '添え書きが無い').toBeGreaterThan(0);
    expect(blocks[0]!.kind).toBe('table');
    // 画像の予約は添え書きの直後
    expect(images.map((i) => i.at)).toEqual([caption + 1]);
  });
});

describe('板に置いたノートの題名(依頼 278 = A)', () => {
  const html = renderMarkdown(':::format{.pkc-place x=10 y=20 entry=abc123}\n:::\n');
  const titleOf = (id: string): string | null => (id === 'abc123' ? '置いた <ノート> & "題名"' : null);

  it('🔴 Word: 説明つきの 1 行が入り、HTML として差し込まれる字は escape される', () => {
    const out = insertPlacedNoteTitles(html, titleOf, 'word');
    expect(out).toContain('置いた &lt;ノート&gt; &amp; &quot;題名&quot;');
    const blocks = htmlToDocxBlocks(parse(out)).blocks;
    const lines = blocks.flatMap((b) => (b.kind === 'p' ? [b.runs.map((r) => r.text).join('')] : []));
    expect(lines).toEqual([placedNoteLineForWord('置いた <ノート> & "題名"')]);
    expect(lines[0]).toContain('の中身は入れていません');
  });

  it('閲覧用 HTML: 題名だけ(太字)。中身の説明は入れない', () => {
    const out = insertPlacedNoteTitles(html, titleOf, 'html');
    expect(out).toContain('<strong>置いた &lt;ノート&gt; &amp; &quot;題名&quot;</strong>');
    expect(out).not.toContain('入れていません');
  });

  it('対照: 引けない lid / 置いたノートの付箋でない塊には何も足さない', () => {
    expect(insertPlacedNoteTitles(html, () => null, 'word')).toBe(html);
    const plain = renderMarkdown(':::format{.pkc-place x=1 y=2}\n付箋\n:::\n');
    expect(insertPlacedNoteTitles(plain, titleOf, 'word')).toBe(plain);
  });
});

describe('名前の無い変数(依頼 281 = A)', () => {
  it('🔴 前書きに無い名前は字のまま残り、器の印で数えられる。件数つきの知らせが出る', () => {
    const html = renderMarkdown('値は {{vars.nope}} と {{vars.nope2}}\n', { vars: { ok: '1' } });
    const doc = parse(html);
    const n = doc.querySelectorAll('.pkc-variable-undefined').length;
    expect(n).toBe(2);
    expect(undefinedVarNotice(n)).toContain('名前の無い変数が 2 件');
    expect(JSON.stringify(htmlToDocxBlocks(doc).blocks)).toContain('{{vars.nope}}');
  });

  it('対照: 定義のある変数は数えない / 0 件なら何も言わない', () => {
    const doc = parse(renderMarkdown('値は {{vars.ok}}\n', { vars: { ok: '1' } }));
    expect(doc.querySelectorAll('.pkc-variable-undefined').length).toBe(0);
    expect(undefinedVarNotice(0)).toBeNull();
  });
});

describe(':::if{format=…} の読み方(依頼 282 = A)', () => {
  const md = (fmt: string): string => `:::if{format=${fmt}}\n中身\n:::\n`;
  const shows = (fmt: string, target: string): boolean =>
    renderMarkdown(md(fmt), { format: target }).includes('中身');

  it('🔴 大文字・小文字は区別しない', () => {
    expect(shows('DOCX', 'docx')).toBe(true);
    expect(shows('Html', 'html')).toBe(true);
  });
  it('🔴 カンマで並べると、どれかに当たれば出る', () => {
    expect(shows('docx,html', 'docx')).toBe(true);
    expect(shows('docx,html', 'html')).toBe(true);
    expect(shows('docx,html', 'pptx'), '並べていない形式には出ない').toBe(false);
  });
  it('🔴 pdf は印刷のとき = html と同じに出る', () => {
    expect(shows('pdf', 'html')).toBe(true);
    expect(shows('pdf', 'docx'), 'pdf は Word では出ない').toBe(false);
  });
  it('対照: 今までの書き方(別の形式)は出ない', () => {
    expect(shows('docx', 'html')).toBe(false);
    expect(shows('pptx', 'docx')).toBe(false);
  });
});

describe('Word / PowerPoint の書き出し(依頼 143・53-2)', () => {
  function source(body: string): ArchiveSource {
    return {
      cid: 'c1',
      title: 'T',
      listEntryMetas: async () => [
        { lid: 'n1', title: 'ノート', archetype: 'text', created_at: null, updated_at: null, entry_order: 1, status: null, date: null, archived: 0 },
      ],
      listBodies: async () => ({ rows: [{ lid: 'n1', body }], done: true }),
      getBody: async () => body,
      listRelations: async () => [],
      listAssetMetas: async () => [],
      getAssetBlob: async () => null,
      listRevisionLids: async () => [],
      getRevisionChain: async () => [],
    };
  }
  const run = async (
    body: string,
    exporter: typeof exportEntryDocx,
  ): Promise<{ ok: boolean; notices: string[]; fails: string[]; downloads: number }> => {
    const notices: string[] = [];
    const fails: string[] = [];
    let downloads = 0;
    const d: ExportDeps = {
      source: source(body),
      download: () => {
        downloads += 1;
      },
      report: () => {},
      notify: (m) => notices.push(m),
      askSql: async () => ({ columns: [], rows: [], truncated: false }),
      settle: async () => {},
      renderFigureVector: async () => null,
      renderIcon: async () => null,
      renderFigure: async () => null,
      renderBody: async (t, o) => renderMarkdown(t, o),
      now: () => new Date('2026-10-02T00:00:00Z'),
    };
    const dispatcher = {
      getState: () => ({ phase: 'ready' }),
      dispatch: (a: { type: string; error?: string }) => {
        if (a.type === 'OP_FAILED') fails.push(a.error ?? '');
      },
    } as unknown as Dispatcher;
    const ok = await exporter(dispatcher, d, 'n1');
    return { ok, notices, fails, downloads };
  };

  it('🔴 本文が空なら、ファイルを落とさずに断る(Word も PowerPoint も)', async () => {
    for (const [exporter, app] of [
      [exportEntryDocx, 'Word'],
      [exportEntryPptx, 'PowerPoint'],
    ] as const) {
      const r = await run('', exporter);
      expect(r.ok).toBe(false);
      expect(r.downloads, '空のファイルを落とした').toBe(0);
      expect(r.fails.join()).toContain('本文が空なので');
      expect(r.fails.join()).toContain(app);
      expect(r.notices.some((m) => m.includes('書き出しました')), '成功の知らせが出た').toBe(false);
    }
  });

  it('🔴 Word の知らせに「ブロック」は出ない / 画像が無ければ括弧ごと出さない(対照: 本文があれば書き出せる)', async () => {
    const r = await run('# 見出し\n\n本文\n', exportEntryDocx);
    expect(r.ok).toBe(true);
    expect(r.downloads).toBe(1);
    const done = r.notices.find((m) => m.includes('書き出しました'));
    expect(done).toBe('Word で書き出しました');
    expect(r.notices.join()).not.toContain('ブロック');
  });
});

describe('見出しで畳んだ章は、刷る間だけ開く(依頼 116-1 = A)', () => {
  function folded(): { host: HTMLElement; hiddenCount: () => number } {
    const host = document.createElement('div');
    host.setAttribute('data-pkc-field', 'detail-body');
    host.innerHTML = renderMarkdown('# 一\n\n本文一\n\n## 一の一\n\n本文一の一\n\n# 二\n\n本文二\n');
    document.body.append(host);
    applyHeadingFold(host); // 見出しにボタンを付ける
    host.querySelector('h1')!.setAttribute('data-pkc-folded', '');
    applyHeadingFold(host); // 畳んだ印を当てる
    return { host, hiddenCount: () => host.querySelectorAll('[hidden]').length };
  }

  it('🔴 刷る直前に畳みを開き、刷り終えたら開けた物だけ畳み直す。画面の畳みの印は触らない', () => {
    const { host, hiddenCount } = folded();
    const before = hiddenCount();
    expect(before, '前提: 畳んだ章が隠れている').toBeGreaterThan(0);
    expect(openHeadingFoldsForPrint(document)).toBe(before);
    expect(hiddenCount(), '紙に出る間は 1 つも隠れていない').toBe(0);
    expect(host.querySelector('h1')!.hasAttribute('data-pkc-folded'), '畳みの印を外した').toBe(true);
    restoreHeadingFoldsAfterPrint();
    expect(hiddenCount(), '畳み直していない').toBe(before);
    host.remove();
  });

  it('対照: 畳んでいない本文では何も開けない', () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown('# 一\n\n本文\n');
    document.body.append(host);
    applyHeadingFold(host);
    expect(openHeadingFoldsForPrint(document)).toBe(0);
    host.remove();
  });
});

describe('フォルダの書き出し(依頼 53-1 = A)', () => {
  it('🔴 フォルダのとき、書き出し 5 つの説明は理由になる。ノートのときは今までの説明(対照)', () => {
    // ⚠ 2026-10-26(#1459 段②): メール下書きのコピー(`copy-entry-mail`)も同じ理由で足した → 5 つ + 1 つ
    expect([...FOLDER_EXPORT_BLOCKED_ACTIONS].sort()).toEqual([
      'copy-entry-mail',
      'export-entry-docx',
      'export-entry-html',
      'export-entry-markdown',
      'export-entry-pdf',
      'export-entry-pptx',
      // ⚠ 2026-10-27(#1447): 字幕ファイル(`export-entry-srt`)も同じ理由で足した → 5 つ + 2 つ
      'export-entry-srt',
    ]);
    for (const a of FOLDER_EXPORT_BLOCKED_ACTIONS) {
      expect(entryActionHint(a, { archetype: 'folder', linkedFile: null }), a).toBe(FOLDER_EXPORT_NOTE);
      expect(entryActionHint(a, { archetype: 'text', linkedFile: null }), a).not.toBe(FOLDER_EXPORT_NOTE);
    }
    // フォルダでも、中身ごと出せる「このフォルダをバックアップ」の説明は変わらない
    expect(entryActionHint('export-folder', { archetype: 'folder', linkedFile: null })).not.toBe(FOLDER_EXPORT_NOTE);
  });

  it('🔴 右のペイン: フォルダを選ぶと書き出し 5 つが押せなくなり、理由が出る。「このフォルダをバックアップ」は押せる。ノートなら押せる(対照)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const inspector = new InspectorRenderer(buildShell(root).inspector);
    const m = (lid: string, archetype: string, order: number) => ({
      lid, title: `t-${lid}`, archetype, createdAt: null, updatedAt: null, entryOrder: order,
      status: null, date: null, archived: false, bodyChars: null,
    });
    const booted = reduce(initialState, {
      type: 'SYS_BOOTED', cid: 'c1', metas: [m('f1', 'folder', 1), m('n1', 'text', 2)], relations: [],
    }).state;
    const btn = (action: string): HTMLButtonElement =>
      root.querySelector<HTMLButtonElement>(`[data-pkc-action="${action}"]`)!;
    inspector.render(reduce(booted, { type: 'SELECT_ENTRY', lid: 'f1' }).state);
    for (const a of FOLDER_EXPORT_BLOCKED_ACTIONS) {
      expect(btn(a).disabled, `${a} が押せる`).toBe(true);
      expect(btn(a).title, `${a} の理由が読めない`).toBe(FOLDER_EXPORT_NOTE);
    }
    expect(btn('export-folder').disabled, 'フォルダごとのバックアップまで塞いだ').toBe(false);
    inspector.render(reduce(booted, { type: 'SELECT_ENTRY', lid: 'n1' }).state);
    for (const a of FOLDER_EXPORT_BLOCKED_ACTIONS) {
      expect(btn(a).disabled, `ノートで ${a} が押せない`).toBe(false);
      expect(btn(a).title).not.toBe(FOLDER_EXPORT_NOTE);
    }
    // フォルダ → ノート → フォルダと動かしても、前の状態を引きずらない
    inspector.render(reduce(booted, { type: 'SELECT_ENTRY', lid: 'f1' }).state);
    expect(btn('export-entry-docx').disabled).toBe(true);
    root.remove();
  });

  it('🔴 PDF の入口(右クリック・操作を探す)もフォルダは断る。印刷の画面は開かない', async () => {
    const sent: Dispatchable[] = [];
    let prints = 0;
    const deps: PrintNoteDeps = {
      getState: () =>
        ({
          phase: 'ready',
          viewMode: 'detail',
          selectedLid: 'f',
          openBody: { lid: 'f', body: '', baseline: '' },
          entryMetas: new Map([['f', { archetype: 'folder' }]]),
        }) as unknown as AppState,
      dispatch: (a) => {
        sent.push(a);
      },
      onState: () => () => {},
      print: () => {
        prints += 1;
      },
      setTimer: () => 0,
      clearTimer: () => {},
    };
    expect(await printNote(deps, 'f')).toBe('not-ready');
    expect(prints).toBe(0);
    expect(sent).toEqual([{ type: 'OP_FAILED', error: FOLDER_EXPORT_NOTE }]);
  });

  it('🔴 PDF: 押した直後に「印刷の画面で『PDF として保存』を選ぶ」案内を出す(対照: 断った回は出さない)', async () => {
    const notices: string[] = [];
    let prints = 0;
    const st = {
      phase: 'ready',
      viewMode: 'detail',
      selectedLid: 'a',
      openBody: { lid: 'a', body: '本文', baseline: '本文' },
      entryMetas: new Map([['a', { archetype: 'text' }]]),
    } as unknown as AppState;
    const deps: PrintNoteDeps = {
      getState: () => st,
      dispatch: () => {},
      onState: () => () => {},
      print: () => {
        prints += 1;
      },
      notify: (m) => notices.push(m),
      setTimer: () => 0,
      clearTimer: () => {},
    };
    expect(await printNote(deps, 'a')).toBe('printed');
    expect(prints).toBe(1);
    expect(notices).toEqual([PRINT_GUIDE]);
    expect(PRINT_GUIDE).toContain('PDF として保存');
  });
});
