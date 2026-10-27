/**
 * 🔴 **CRLF の本文へ足した・書き換えた行が、CRLF のまま**(#1384。`detectEol` へ寄せた 8 経路それぞれ)。
 * ⚠ 判定を寄せた経路が、実際にその判定を通って CRLF を保つことを見る
 *   (`BARE_LF` = 単独の LF が 1 つも無い)。期待値は手書きの literal。
 */
import { describe, expect, it } from 'vitest';
import { planFormRow } from '../../src/features/markdown/form-table';
import { openCodeFenceAt, replaceCodeFenceContent } from '../../src/features/markdown/code-fence-edit';
import { spliceFrontmatterKeys } from '../../src/features/markdown/frontmatter';
import { sliceLines } from '../../src/features/markdown/source-blocks';
import {
  appendIntoSection,
  listAppendTargets,
  replaceSectionByHeading,
} from '../../src/features/markdown/append-target';
import { renumberLists } from '../../src/features/markdown/list-renumber';
import { flattenSectionEmbeds } from '../../src/features/export/section-flatten';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';

const BARE_LF = /(?<!\r)\n/;

describe('CRLF 本文 → 足した / 書き換えた行も CRLF(経路ごと)', () => {
  it('① form-table: 表を新しく作る回の行が CRLF', () => {
    const r = planFormRow('# 帳簿\r\n本文\r\n', {
      mode: 'add',
      table: 't',
      fields: [{ name: '品名' } as never],
      cells: { 品名: 'りんご' },
    });
    expect(r.ok).toBe(true);
    const body = r.ok ? r.body : '';
    expect(body).toContain('```csv name=t\r\n');
    expect(body).toContain('りんご');
    expect(body).not.toMatch(BARE_LF);
  });

  it('② code-fence-edit: 枠の中身を差し替えても CRLF', () => {
    const body = ['# x', '', '```js', 'a', '```', '終わり'].join('\r\n');
    const id = openCodeFenceAt(body, 2);
    expect(id, '前提: 枠の身元が取れる').not.toBeNull();
    const r = replaceCodeFenceContent(body, id!, 'b\nc');
    expect(r.ok).toBe(true);
    const out = r.ok ? r.body : '';
    expect(out).toBe(['# x', '', '```js', 'b', 'c', '```', '終わり'].join('\r\n'));
  });

  it('③ frontmatter: 前置きの fence と足した key の行が CRLF', () => {
    const none = spliceFrontmatterKeys('# 見出し\r\n本文', { status: 'open' });
    expect(none).toBe('---\r\nstatus: open\r\n---\r\n# 見出し\r\n本文');
    const has = spliceFrontmatterKeys('---\r\na: 1\r\n---\r\n本文', { b: 'x' });
    expect(has).not.toMatch(BARE_LF);
    expect(has).toContain('b: ');
  });

  it('④ source-blocks: 行を取り出して繋ぐ改行が CRLF', () => {
    expect(sliceLines('a\r\nb\r\nc', { start: 0, end: 1 })).toBe('a\r\nb');
  });

  it('⑤ append-target: 章へ挟んだ行と、章の差し替えが CRLF', () => {
    const base = '# 題\r\n\r\n## 章A\r\n本文A\r\n\r\n## 章B\r\n本文B';
    const slug = listAppendTargets(base).find((t) => t.text === '章A')!.slug;
    const inserted = appendIntoSection(base, slug, null, '追記1\n追記2');
    expect(inserted, '前提: 挟めた').not.toBeNull();
    expect(inserted).toContain('追記1\r\n追記2');
    expect(inserted).not.toMatch(BARE_LF);
    const replaced = replaceSectionByHeading(base, '章A', '## 章A\n本文A\n', '## 章A\n新1\n新2\n');
    expect(replaced.ok).toBe(true);
    const out = replaced.ok ? replaced.body : '';
    expect(out).toContain('新1\r\n新2');
    expect(out).not.toMatch(BARE_LF);
  });

  it('⑥ list-renumber: 振り直した行の改行が CRLF', () => {
    expect(renumberLists('1. a\r\n1. b', 'sequential')).toBe('1. a\r\n2. b');
  });

  it('⑦ body-rewrite: 行を増やす書き換え(表の行追加)と、升の書き換えの改行が CRLF', () => {
    const body = '```csv\r\na,b\r\nc,d\r\n```\r\n';
    const added = applyBodyRewrite(body, {
      kind: 'csv-shape',
      line: 2,
      openLine: 'c,d',
      col: 0,
      what: 'row',
      mode: 'add',
    });
    expect(added, '前提: 行が増えた').not.toBeNull();
    expect((added ?? '').split('\r\n').length).toBe(body.split('\r\n').length + 1);
    expect(added).not.toMatch(BARE_LF);
    const cell = applyBodyRewrite(body, { kind: 'csv-cell', line: 2, openLine: 'c,d', col: 0, value: 'x' });
    // 升の中身は書き換わり、行の区切りは CRLF のまま(引用符の中の改行は値の一部なので見ない)
    expect(cell).toBe('```csv\r\na,b\r\nx,d\r\n```\r\n');
  });

  it('⑧ section-flatten: 章を展開した行の改行が CRLF', async () => {
    const other = '# 他\r\n\r\n## 章\r\n中身1\r\n中身2\r\n';
    const r = await flattenSectionEmbeds(
      '# 本\r\n\r\n![章](entry:other#h/章)\r\n\r\n以上\r\n',
      'self',
      async (lid) => (lid === 'other' ? other : null),
    );
    expect(r.expanded, '前提: 展開できた').toBe(1);
    expect(r.body).toContain('中身1\r\n中身2');
    expect(r.body).not.toMatch(BARE_LF);
  });
});
