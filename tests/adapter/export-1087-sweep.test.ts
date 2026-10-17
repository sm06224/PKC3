/** @vitest-environment happy-dom */
/**
 * 書き出しの点検(#1087)で見つかった欠けを塞ぐ。
 *
 * 守る主張:
 * 1. 🔴 Word / PowerPoint でもタスクの済 / 未が字として残る(☑ / ☐)
 * 2. 🔴 脚注の戻りリンク(↩︎)は文書の字に混ざらない
 * 3. 🔴 Windows の予約名は「最初の `.` より前」で見る(`CON.memo` も避ける)
 * 4. 🔴 アプリで刷るとき、畳んだ折りたたみを開き、刷り終えたら開けた物だけ畳み直す
 * 5. 🔴 1 ノートのバックアップに、そのノートが使うタグの色だけが入る
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { htmlToDocxBlocks } from '../../src/adapter/platform/export/html-blocks';
import { safeName } from '../../src/features/export/file-name';
import {
  installEditorPrint,
  openDetailsForPrint,
  restoreDetailsAfterPrint,
} from '../../src/adapter/ui/render/print-editing';
import { tagColorsUsedBy, tagColorKey } from '../../src/features/tag-color';
import { singleEntrySource } from '../../src/features/export/single-entry-source';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';

function docxText(md: string): string {
  const doc = new DOMParser().parseFromString(
    `<body>${renderMarkdown(md, { sourceLineAnchors: false })}</body>`,
    'text/html',
  );
  return JSON.stringify(htmlToDocxBlocks(doc).blocks);
}

describe('Word / PowerPoint の字', () => {
  it('🔴 タスクの済 / 未が ☑ / ☐ で残る', () => {
    const t = docxText('- [x] 済んだ\n- [ ] まだ\n');
    expect(t).toContain('☑');
    expect(t).toContain('☐');
    expect(t.indexOf('☑')).toBeLessThan(t.indexOf('済んだ'));
    expect(t.indexOf('☐')).toBeLessThan(t.indexOf('まだ'));
  });

  it('対照群:ただの箇条書きには印が付かない', () => {
    const t = docxText('- 牛乳\n- 卵\n');
    expect(t).not.toContain('☑');
    expect(t).not.toContain('☐');
  });

  it('🔴 脚注の戻りリンクの字が入らない', () => {
    const t = docxText('本文[^a]\n\n[^a]: 脚注の中身\n');
    expect(t).toContain('脚注の中身');
    expect(t).not.toContain('↩');
  });
});

describe('ファイル名の予約名', () => {
  it('🔴 最初の `.` より前が予約名なら、そこへ接尾辞を入れる', () => {
    expect(safeName('CON.memo')).toBe('CON-file.memo');
    expect(safeName('aux.txt')).toBe('aux-file.txt');
    expect(safeName('CON')).toBe('CON-file');
  });

  it('対照群:予約名を含むだけの名前はそのまま', () => {
    expect(safeName('CONTENTS.memo')).toBe('CONTENTS.memo');
    expect(safeName('memo.CON')).toBe('memo.CON');
  });
});

describe('刷るときの折りたたみ', () => {
  it('🔴 畳んだ物だけ開き、刷り終えたらそれだけ畳み直す', () => {
    document.body.innerHTML =
      '<details class="pkc-details"><summary>a</summary>中身A</details>' +
      '<details class="pkc-details" open><summary>b</summary>中身B</details>';
    const [a, b] = [...document.querySelectorAll('details')];
    expect(openDetailsForPrint(document)).toBe(1);
    expect(a!.open).toBe(true);
    expect(b!.open).toBe(true);
    restoreDetailsAfterPrint();
    expect(a!.open).toBe(false);
    expect(b!.open, 'もとから開いていた物は開いたまま').toBe(true);
  });

  it('🔴 窓に張った口で、刷る前に開き刷り終えたら戻す', () => {
    document.body.innerHTML = '<details class="pkc-details"><summary>a</summary>中身</details>';
    const d = document.querySelector('details')!;
    const off = installEditorPrint(window);
    try {
      window.dispatchEvent(new Event('beforeprint'));
      expect(d.open).toBe(true);
      window.dispatchEvent(new Event('afterprint'));
      expect(d.open).toBe(false);
    } finally {
      off();
    }
  });
});

describe('一部のバックアップのタグの色', () => {
  const colors = [
    { tag: '仕事', color: '#ff0000' },
    { tag: '家', color: '#00ff00' },
  ];

  it('使われているタグの色だけ残す(大小は無視)', () => {
    const used = new Set([tagColorKey('仕事')!]);
    expect(tagColorsUsedBy(colors, used)).toEqual([{ tag: '仕事', color: '#ff0000' }]);
  });

  it('🔴 1 ノートのバックアップに、そのノートのタグの色が入る', async () => {
    const body = '---\ntags: [仕事]\n---\n本文';
    const meta = {
      lid: 'n1',
      title: 'ノート',
      archetype: 'text',
      created_at: null,
      updated_at: null,
      entry_order: 1,
      status: null,
      date: null,
      archived: 0,
    };
    const base = {
      cid: 'c1',
      title: 'コンテナ',
      listEntryMetas: async () => [meta],
      getBody: async () => body,
      listBodies: async () => ({ rows: [], done: true }),
      listRelations: async () => [],
      listAssetMetas: async () => [],
      getAssetBlob: async () => null,
      listTagColors: async () => colors,
      listRevisionLids: async () => [],
      getRevisionChain: async () => [],
    } as unknown as ArchiveSource;
    const { source } = await singleEntrySource(base, 'n1');
    expect(await source.listTagColors?.()).toEqual([{ tag: '仕事', color: '#ff0000' }]);
  });
});

describe('Word / PowerPoint の字(ルビ・目次。#1087)', () => {
  it('🔴 E3 ルビは「親字（よみ）」で書く(漢字かんじ と続けない)', () => {
    const t = docxText('[[ruby:漢字|かんじ]]\n');
    expect(t).toContain('漢字');
    expect(t).toContain('（かんじ）');
    expect(t).not.toContain('漢字かんじ');
  });

  it('🔴 E10 目次の見出しの段が箇条書きの深さに残る', () => {
    const doc = new DOMParser().parseFromString(
      '<body><nav class="pkc-toc"><ul class="pkc-toc-list">' +
        '<li data-pkc-toc-level="1"><a href="#a">A</a></li>' +
        '<li data-pkc-toc-level="2"><a href="#b">B</a></li>' +
        '<li data-pkc-toc-level="3"><a href="#c">C</a></li>' +
        '</ul></nav></body>',
      'text/html',
    );
    const lis = htmlToDocxBlocks(doc).blocks.filter((b) => b.kind === 'li') as unknown as { depth: number }[];
    expect(lis.map((b) => b.depth)).toEqual([0, 1, 2]);
  });
});
