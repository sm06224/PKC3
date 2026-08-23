import { describe, expect, it } from 'vitest';
import {
  spliceFrontmatterKeys,
  parseFrontmatter,
  extractVars,
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
    /**
     * 🔴 **最後の 1 つを外したら、空の囲みごと畳む**(#343、2026-08-23)。
     * ⚠ 直す前は `'---\n---\nx'` を返し、それを**見たまま pin していた** ──
     *   画面には「この文書の情報 **(空)**」の札が常駐し、user は何も書いていないのに
     *   書いた物の入れ物を見せられていた。
     * 🔑 いまは**本文だけ**が残る(往復しても 1 バイトも増えない)。
     */
    expect(spliceFrontmatterKeys(body, { status: undefined })).toBe('x');
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

  it('重複 key は最後の一致行を書く(parseFlatYaml の last-wins に一致 ── review #5)', () => {
    const body = '---\nstatus: open\nstatus: done\n---\nx';
    const out = spliceFrontmatterKeys(body, { status: 'open' });
    // 先頭行に書くと再抽出(last-wins)が変わらず永久 no-op になる
    expect(parseFrontmatter(out).meta['status']).toBe('open');
    expect(out).toBe('---\nstatus: open\nstatus: open\n---\nx');
  });

  /**
   * 🔴 **入れ子(`vars:`)の子行を書き換えない**(3 巡目レビュー 1-C)。
   *
   * ⚠ **1 本の行を 2 人が別々に読んでいる**(CLAUDE.md §7)── 実測:
   *   `parseFlatYaml` は `  status: open` を**トップレベルの `status`** として読み、
   *   `extractVars` は**`vars.status`** として読む。だから当ててしまうと
   *   **本文の `{{vars.status}}` の表示が黙って変わる**(消す操作なら行ごと消える)。
   *
   * 🔑 直す向きは §7 の「**書き換え先は誤爆しない側(狭く当てる)**」──
   *   子行は外し、無ければ**末尾に足す**。`parseFlatYaml` は last-wins なので
   *   足すだけで `meta` は正しくなり、`vars` は 1 バイトも動かない。
   */
  it('🔴 vars: の子行は書き換えない(足して last-wins で効かせる)', () => {
    const body = '---\nvars:\n  status: open\ntitle: メモ\n---\n進捗は {{vars.status}} です\n';
    const out = spliceFrontmatterKeys(body, { status: 'done' });
    // ① user の `vars` は 1 バイトも動かない
    expect(out, 'vars の子行を書き換えた').toContain('vars:\n  status: open\n');
    expect(extractVars(out), '本文の {{vars.status}} の表示が変わった').toEqual({
      status: 'open',
    });
    // ② それでも meta は要求どおり(last-wins)
    expect(parseFrontmatter(out).meta['status'], 'meta に届いていない').toBe('done');
    // ③ 消す操作でも子行を消さない(取り消せない側へ倒さない)
    const del = spliceFrontmatterKeys(body, { status: undefined });
    expect(extractVars(del), '消す操作が vars を壊した').toEqual({ status: 'open' });
  });

  /**
   * ⚠ **対照群** ── 「字下げされているが入れ子ではない」行は、**書き換える**
   *   (2 巡目レビュー B-3。上の直しで巻き添えにしていないことを見る)。
   */
  it('字下げだけの key(入れ子ではない)は、字下げを保って書き換える', () => {
    expect(spliceFrontmatterKeys('---\n  status: open\n---\n本文\n', { status: 'done' })).toBe(
      '---\n  status: done\n---\n本文\n',
    );
    // ⚠ 字下げした 1 つきりの key を外した場合も、空の囲みは残さない(#343)
    expect(spliceFrontmatterKeys('---\n  status: open\n---\n本文\n', { status: undefined })).toBe(
      '本文\n',
    );
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
