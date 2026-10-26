/** @vitest-environment node */
/**
 * 🔴 **書き出すとき、別のノートの章の参照を展開する**(#1459 段②「ノート部分参照の埋め込みで、帳票・レポート HTML を生成」)。
 *
 * 守る主張:
 * 1. 閲覧用 HTML(1 ノート / 選んだ N 件 / 全部)に、参照先の章の中身が入る(空の枠が残らない)
 * 2. 🔴 **他のノートの章の中の画像**も添付として入る(展開は絞り込みの前 ── 後ろだと添付が落ちる)
 * 3. 見つからない章は引用の 1 行で残り、件数は注意に出る / 展開した件数は結果の行で言う
 * 4. 対照群: バックアップ(zip)の本文は展開しない(原文のまま)
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { exportArchive, exportEntry, exportSelection, type ExportDeps } from '../../src/adapter/ui/actions/export-archive';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';

const META = (lid: string, title: string, order: number) => ({
  lid,
  title,
  archetype: 'text',
  created_at: null,
  updated_at: null,
  entry_order: order,
  status: null,
  date: null,
  archived: 0,
});

const REPORT =
  '# 週報\n\n![決定事項](entry:m1#h/決定事項)\n\n![ない章](entry:m1#h/ない)\n\n![秘密](entry:sys1#h/秘密)\n\n以上\n';
// 🔴 system 領域のノート ── 本文は読めるが、`listEntryMetas`(user 領域だけ)には居ない
const SYS = '# システム\n\n## 秘密\n\nひみつの中身\n';
const MEMO = '# メモ\n\n## 決定事項\n\n予算は承認された。\n\n![図](asset:img1)\n\n## 別の章\n\n関係ない話\n';

function source(): ArchiveSource {
  const bodies = new Map([
    ['r1', REPORT],
    ['m1', MEMO],
    ['sys1', SYS],
  ]);
  return {
    cid: 'c1',
    title: 'テスト',
    listEntryMetas: async () => [META('r1', '週報', 1), META('m1', 'メモ', 2)],
    getBody: async (lid) => bodies.get(lid) ?? null,
    listBodies: async () => ({
      rows: [...bodies].filter(([lid]) => lid !== 'sys1').map(([lid, body]) => ({ lid, body })),
      done: true,
    }),
    listRelations: async () => [],
    listAssetMetas: async () => [{ key: 'img1', mime: 'image/png', size: 4, hash: null }],
    getAssetBlob: async (key) => (key === 'img1' ? new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }) : null),
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
  };
}

function rig() {
  const asked: string[] = [];
  const base = source();
  const spied: ArchiveSource = Object.assign(Object.create(base) as ArchiveSource, {
    getBody: async (lid: string) => {
      asked.push(lid);
      return base.getBody!(lid);
    },
  });
  const downloaded: Array<{ name: string; blob: Blob }> = [];
  const notices: string[] = [];
  const reported: string[][] = [];
  const deps: ExportDeps = {
    source: spied,
    download: (name, blob) => downloaded.push({ name, blob }),
    report: (n) => reported.push([...n]),
    settle: async () => {},
    renderFigure: async () => null,
    renderFigureVector: async () => null,
    renderIcon: async () => null,
    askSql: async () => {
      throw new Error('この test では引かない');
    },
    notify: (m) => notices.push(m),
    now: () => new Date('2026-10-26T00:00:00.000Z'),
  };
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  return { deps, d, downloaded, notices, reported, asked };
}

const textOf = (b: Blob): Promise<string> => b.text();

describe('閲覧用 HTML に、別のノートの章が入る', () => {
  it('🔴 1 ノート ── 参照先の章の中身が入り、次の章は入らない / 章の中の画像が添付として入る', async () => {
    const r = rig();
    await exportEntry(r.d, r.deps, 'r1', 'html');
    const html = await textOf(r.downloaded[0]!.blob);
    expect(r.downloaded[0]!.name).toBe('週報-20261026.html');
    expect(html).toContain('予算は承認された');
    expect(html).not.toContain('関係ない話');
    // 🔴 他のノートの章の中の画像: 添付として入っている(展開は絞り込みの前)
    expect(html).toContain('"assets":[{"key":"img1"');
    expect(html).toContain('"assetData":{"img1":"');
    // 見つからない章は引用の 1 行(黙って空にしない)
    expect(html).toContain('「ない章」: 見出しが見つかりません');
    // 件数: 展開は結果の行で言い、見つからない 1 件は注意に出る
    expect(r.notices.join('\n')).toContain('別のノートの章 1 件を展開(元のノート: メモ)');
    expect(r.reported.flat().join('\n')).toContain('別のノートの章の参照 1 件は、章またはノートが見つからない');
    // 🔴 system 領域のノートの章は展開しない(中身は入らず、引用の 1 行と注意が出る)
    expect(html).not.toContain('ひみつの中身');
    expect(html).toContain('システムのノートは書き出しに入れません');
    expect(r.reported.flat().join('\n')).toContain('システムのノートを指していた');
  });

  it('選んだ N 件でも、全部でも展開される', async () => {
    const sel = rig();
    await exportSelection(sel.d, sel.deps, ['r1'], 'html');
    expect(await textOf(sel.downloaded[0]!.blob)).toContain('予算は承認された');
    // 🔴 件数は 2 重に数えない(選んだ N 件の絞り込みは本文を 2 周読む)
    expect(sel.notices.join('\n')).toContain('別のノートの章 1 件を展開');
    expect(sel.notices.join('\n')).not.toContain('別のノートの章 2 件');
    expect(sel.reported.flat().join('\n')).toContain('参照 1 件は、章またはノートが見つからない');
    const all = rig();
    await exportArchive(all.d, all.deps, 'html');
    const html = await textOf(all.downloaded[0]!.blob);
    // 全部の書き出しには参照元のノート(メモ)自身も入っているので、2 か所に出る
    expect(html.split('予算は承認された').length - 1).toBe(2);
    expect(all.notices.join('\n')).toContain('別のノートの章 1 件を展開');
    expect(all.notices.join('\n')).not.toContain('別のノートの章 2 件');
  });

  it('🔴 対照群 ── バックアップ(zip)は章を展開しない(参照先のノートを本文として読みにも行かない)', async () => {
    const r = rig();
    await exportEntry(r.d, r.deps, 'r1', 'archive');
    expect(r.downloaded[0]!.name).toMatch(/\.pkc3-notes\.zip$/u);
    expect(r.asked, '空振り(書き出すノート自身を読んでいない)').toContain('r1');
    expect(r.asked, 'バックアップが章の参照を展開した').not.toContain('m1');
    expect(r.notices.join('\n')).not.toContain('章');
    // 対照: 閲覧用 HTML は参照先を読みに行く
    const h = rig();
    await exportEntry(h.d, h.deps, 'r1', 'html');
    expect(h.asked).toContain('m1');
  });
});
