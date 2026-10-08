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

  /**
   * 🔴 **ブロック配列の key を書き換えたら、その key の `- item` 行も一緒に差し替える**
   * (#641 ②)。
   *
   * ⚠ 直す前は key の行だけを差し替えたので、`- 買い物` / `- 家事` が
   *   **閉じの内側に残ったまま、誰も読まない行**になっていた。
   * 🔴 危ないのは**その後**である ── user が inline の `tags:` 行を消すと、
   *   残っていた 2 行が**復活する**(消したはずのタグが戻る)。
   * 🔑 範囲の採り方は `parseFlatYaml` のブロック配列の走査と**同じ規則**
   *   (値の無い key の直後の、連続する `- item` 行。§7)。
   */
  it('🔴 ブロック配列の key を書き換えると、子の `- item` 行が孤児にならない(#641 ②)', () => {
    const body = '---\ntags:\n  - 買い物\n  - 家事\n---\n本文\n';
    const out = spliceFrontmatterKeys(body, { tags: ['買い物', '家事', '掃除'] });
    expect(out, '子の - item 行が残った').toBe('---\ntags: [買い物, 家事, 掃除]\n---\n本文\n');
    /**
     * 🔑 **不変量で見る**(実装と同じ綴りで期待値を組まない ── CLAUDE.md §1):
     *   「**隠した行は、必ず誰かが読んでいる**」── frontmatter の実のある行を
     *   1 行消したら `meta` が変わるはずである。
     */
    const fm = out.split('---\n')[1] ?? '';
    const kept = fm.split('\n').filter((l) => l.trim() !== '');
    for (let i = 0; i < kept.length; i++) {
      const without = ['---', ...kept.filter((_, j) => j !== i), '---', '本文', ''].join('\n');
      expect(
        JSON.stringify(parseFrontmatter(without).meta),
        `誰も読んでいない行が残っている: ${kept[i]}`,
      ).not.toBe(JSON.stringify(parseFrontmatter(out).meta));
    }
  });

  it('🔴 消す操作でも、子の `- item` 行ごと消える(復活させない ── #641 ②)', () => {
    const body = '---\ntags:\n  - 買い物\n  - 家事\n---\n本文\n';
    // 最後の key を外したので、空の囲みごと畳む(#343)
    expect(spliceFrontmatterKeys(body, { tags: undefined }), '孤児が残った').toBe('本文\n');
    // 他の key が在れば囲みは残り、tags の 3 行だけが消える
    const withOther = '---\ntitle: メモ\ntags:\n  - 買い物\n---\n本文\n';
    expect(spliceFrontmatterKeys(withOther, { tags: undefined })).toBe(
      '---\ntitle: メモ\n---\n本文\n',
    );
  });

  it('字下げの無い `- item`(parseFlatYaml が読む形)も一緒に差し替える', () => {
    const body = '---\ntags:\n- 牛乳\n- 卵\n---\n本文\n';
    expect(parseFrontmatter(body).meta['tags'], '前提: この形は読めている').toEqual(['牛乳', '卵']);
    expect(spliceFrontmatterKeys(body, { tags: ['牛乳'] })).toBe(
      '---\ntags: [牛乳]\n---\n本文\n',
    );
  });

  /**
   * ⚠ **対照群 3 つ** ── 「一緒に消す」を広げすぎていないこと。
   */
  it('⚠ 対照群: 値のある key の後ろの `- item` / 空行で切れた先 / 他 key の子は触らない', () => {
    // ① 値のある key の直後の `- 牛乳` は、その key の値ではない(誰も読んでいない)
    const a = '---\ntags: [あ]\n- 牛乳\n---\n本文\n';
    expect(spliceFrontmatterKeys(a, { tags: ['い'] })).toBe('---\ntags: [い]\n- 牛乳\n---\n本文\n');
    // ② 空行でブロックは閉じる(parseFlatYaml と同じ)── 空行の先は触らない
    const b = '---\ntags:\n  - 買い物\n\n  - 家事\n---\n本文\n';
    expect(parseFrontmatter(b).meta['tags'], '前提: 空行で切れている').toEqual(['買い物']);
    expect(spliceFrontmatterKeys(b, { tags: ['買い物'] })).toBe(
      '---\ntags: [買い物]\n\n  - 家事\n---\n本文\n',
    );
    // ③ 別の key を書いても、tags の子行は 1 バイトも動かない
    const c = '---\ntags:\n  - 買い物\nstatus: open\n---\n本文\n';
    expect(spliceFrontmatterKeys(c, { status: 'done' })).toBe(
      '---\ntags:\n  - 買い物\nstatus: done\n---\n本文\n',
    );
  });

  it('prefix が重なる key(date / date-done)を取り違えない', () => {
    const body = '---\ndate-done: 2026-01-01\ndate: 2026-08-01\n---\nx';
    const out = spliceFrontmatterKeys(body, { date: '2026-09-01' });
    expect(out).toBe('---\ndate-done: 2026-01-01\ndate: 2026-09-01\n---\nx');
  });

  it('CRLF 本文で frontmatter が新規作成されたとき改行コードが CRLF で統一される (#1367)', () => {
    const body = '# 見出し\r\n本文\r\n次行';
    const out = spliceFrontmatterKeys(body, { status: 'open' });
    expect(out).toBe('---\r\nstatus: open\r\n---\r\n# 見出し\r\n本文\r\n次行');
  });

  it('⚠ CRLF 本文に複数の key を足すと、key 同士の間も CRLF (#1367)', () => {
    // key が 1 本だと key 同士の区切りが無く、`join` の改行を取り違えても見えない
    const body = '# 見出し\r\n本文\r\n';
    const out = spliceFrontmatterKeys(body, { a: '1', b: '2' });
    expect(out).toBe('---\r\na: "1"\r\nb: "2"\r\n---\r\n# 見出し\r\n本文\r\n');
    // 対照群: LF 本文は LF のまま
    expect(spliceFrontmatterKeys('# 見出し\n本文\n', { a: '1', b: '2' })).toBe(
      '---\na: "1"\nb: "2"\n---\n# 見出し\n本文\n',
    );
  });

  it('⚠ CRLF の水平線で始まる文書(閉じも key も無い)にも、前置する fence は CRLF (#1367)', () => {
    // `---` で始まるが key の行が 1 つも無い = ただの水平線。fence を前置する枝
    const body = '---\r\n本文\r\n';
    const out = spliceFrontmatterKeys(body, { status: 'open' });
    expect(out).toBe('---\r\nstatus: open\r\n---\r\n---\r\n本文\r\n');
    // 対照群: LF の水平線は LF
    expect(spliceFrontmatterKeys('---\n本文\n', { status: 'open' })).toBe(
      '---\nstatus: open\n---\n---\n本文\n',
    );
  });

  describe('vars: の途中に空行があるとき、書く側も読む側と同じに読む (#1371)', () => {
    // extractVars は空行を跨いで vars の子行を読む。書く側がそこで閉じると
    // 空行の先の子行を「トップレベルの key」と見て vars.status を書き換えてしまう
    const src = '---\nvars:\n  x: 1\n\n  status: open\n---\n進捗は {{vars.status}}\n';

    it('🔴 空行の先の `vars.status` を書き換えず、トップに足す', () => {
      expect(extractVars(src), '前提: 空行の先も vars の子').toEqual({ x: '1', status: 'open' });
      const out = spliceFrontmatterKeys(src, { status: 'done' });
      expect(out).toBe(
        '---\nvars:\n  x: 1\n\n  status: open\nstatus: done\n---\n進捗は {{vars.status}}\n',
      );
      expect(extractVars(out), 'vars.status が動いた').toEqual({ x: '1', status: 'open' });
      expect(parseFrontmatter(out).meta['status']).toBe('done');
    });

    it('🔴 消す操作でも、空行の先の子行は消えない', () => {
      expect(spliceFrontmatterKeys(src, { status: undefined })).toBe(src);
    });

    it('⚠ 対照群: 空行の先でも、字下げの無いトップレベルの key は書き換わる', () => {
      const b = '---\nvars:\n  x: 1\n\nstatus: open\n---\n本文\n';
      expect(spliceFrontmatterKeys(b, { status: 'done' })).toBe(
        '---\nvars:\n  x: 1\n\nstatus: done\n---\n本文\n',
      );
    });
  });

  describe('他の呼び手 duplicateTopLevelKeys(parseFrontmatter の warnings)も空行を跨ぐ子行を数えない (#1371)', () => {
    const dups = (b: string) =>
      parseFrontmatter(b).warnings.filter((w) => w.kind === 'duplicate_key');

    it('🔴 vars の子行(空行の先)と同名のトップ key は、重複と誤報しない', () => {
      const b = '---\nvars:\n  a: 1\n\n  status: open\nstatus: done\n---\n本文\n';
      expect(parseFrontmatter(b).meta['status'], '前提: 後勝ちで done').toBe('done');
      expect(dups(b)).toHaveLength(0);
    });

    it('⚠ 対照群: 本物の重複は、空行を挟んでいても言う', () => {
      expect(dups('---\nstatus: open\n\nstatus: done\n---\n本文\n')).toHaveLength(1);
      // vars の子の後ろに空行があって、字下げの無い key が重なる形
      expect(dups('---\nvars:\n  a: 1\n\nstatus: open\nstatus: done\n---\n本文\n')).toHaveLength(1);
    });
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

/**
 * 読む側の回帰 pin(splice の describe の外)。
 * ⚠ #1372 は main で再現せず閉じた issue ── ここは「再現しない」ことの固定だけで、
 *   PR #1417 の変更を守る test ではない。
 */
describe('frontmatter の読み取り(extractVars / parseFrontmatter)', () => {
  it('vars ブロック内に空行があっても後続の変数が読み飛ばされない (#1371)', () => {
    const src = '---\nvars:\n  x: 1\n\n  y: 2\n---\n本文';
    expect(extractVars(src)).toEqual({ x: '1', y: '2' });
  });

  it('⚠ 対照群: 空行のあとに字下げの無い非 key 行が来たら vars はそこで閉じる (#1371)', () => {
    // 終端を pin する ── 空行のあとの非 key 行を skip して読み進める変異を殺す
    expect(extractVars('---\nvars:\n  x: 1\n\nnote: a\n  y: 2\n---\nb')).toEqual({ x: '1' });
  });

  it('⚠ 対照群: 空白だけの行も空行として跨ぐ (#1371)', () => {
    expect(extractVars('---\nvars:\n  x: 1\n   \n  y: 2\n---\nb')).toEqual({ x: '1', y: '2' });
  });

  it('シングルクォートエスケープを含む文字列と末尾コメント(#1372 は再現せず。回帰 pin のみ)', () => {
    const src = "---\ntitle: 'It''s a note' # メモ\ntags: ['It''s a tag'] # タグ\n---\n本文";
    const r = parseFrontmatter(src);
    expect(r.meta['title']).toBe("It's a note");
    expect(r.meta['tags']).toEqual(["It's a tag"]);
  });
});
