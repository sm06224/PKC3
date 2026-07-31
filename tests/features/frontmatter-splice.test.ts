import { describe, expect, it } from 'vitest';
import {
  spliceFrontmatterKeys,
  parseFrontmatter,
} from '../../src/features/markdown/frontmatter';
import { withTodoStatus } from '../../src/features/flavor/todo-flavor';

describe('spliceFrontmatterKeys(原文 splice ── P3-4 review #5 の規律)', () => {
  it('既存 key の行だけを差し替え、本文と他 key は byte 無傷', () => {
    const body = '---\nstatus: open\ndate: 2026-08-01\n---\n\n本文の前に空行がある';
    const out = spliceFrontmatterKeys(body, { status: 'done' });
    // setFrontmatter(parse view)なら先頭空行が落ちる ── splice は残す
    expect(out).toBe('---\nstatus: done\ndate: 2026-08-01\n---\n\n本文の前に空行がある');
  });

  it('無い key は閉じ fence 直前に追加、undefined は行ごと除去', () => {
    const body = '---\nstatus: open\n---\nx';
    expect(spliceFrontmatterKeys(body, { date: '2026-08-02' })).toBe(
      '---\nstatus: open\ndate: 2026-08-02\n---\nx',
    );
    expect(spliceFrontmatterKeys(body, { status: undefined })).toBe('---\n---\nx');
  });

  it('frontmatter が無ければ fence を前置(本文は無傷)', () => {
    expect(spliceFrontmatterKeys('# 見出し\n本文', { status: 'open' })).toBe(
      '---\nstatus: open\n---\n# 見出し\n本文',
    );
  });

  it('CRLF 本文の行末記号を壊さない', () => {
    const body = '---\r\nstatus: open\r\n---\r\n本文\r\n次行';
    const out = spliceFrontmatterKeys(body, { status: 'done' });
    expect(out).toBe('---\r\nstatus: done\r\n---\r\n本文\r\n次行');
  });

  it('本文中の 2 つ目の fence(hr 等)を frontmatter と誤認しない', () => {
    const body = '---\nstatus: open\n---\n段落\n\n---\n\n下の段落';
    const out = spliceFrontmatterKeys(body, { status: 'done' });
    expect(out).toBe('---\nstatus: done\n---\n段落\n\n---\n\n下の段落');
  });

  it('prefix が重なる key(date / date-done)を取り違えない', () => {
    const body = '---\ndate-done: 2026-01-01\ndate: 2026-08-01\n---\nx';
    const out = spliceFrontmatterKeys(body, { date: '2026-09-01' });
    expect(out).toBe('---\ndate-done: 2026-01-01\ndate: 2026-09-01\n---\nx');
  });
});

describe('withTodoStatus(かんばんトグルの構造化操作)', () => {
  it('status だけを書き換え、extract と一貫する', () => {
    const body = '---\nstatus: open\ndate: 2026-08-01\n---\n買い物\n- 牛乳';
    const done = withTodoStatus(body, 'done');
    expect(parseFrontmatter(done).meta).toEqual({
      status: 'done',
      date: '2026-08-01',
    });
    expect(parseFrontmatter(done).body).toBe(parseFrontmatter(body).body);
    // 往復
    expect(withTodoStatus(done, 'open')).toBe(body);
  });

  it('frontmatter の無い todo(素の本文)にも安全に付く', () => {
    expect(withTodoStatus('やること', 'done')).toBe('---\nstatus: done\n---\nやること');
  });
});
