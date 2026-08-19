/**
 * 🔴 **閉じの `---` が無い frontmatter を、黙って通さない**(#284)。
 *
 * 実測(直す前):タグを付けたノートの閉じの `---` を 1 行消すと、
 * `parseFrontmatter` は `found:false` / `meta:{}` / **`warnings:[]`** を返していた
 * ── 呼び側から見て「frontmatter が無い文書」と**区別が付かない**。
 * タグが警告 1 つ無く全部消える経路である。
 *
 * ⚠ **投げない**(soft warning のまま)── 先頭が水平線の普通の文書もここへ来る。
 * 🔑 だから守る主張は 2 つあり、**片方だけでは足りない**:
 *   ① 壊れた frontmatter では**警告が出る**
 *   ② ただの水平線では**警告が出ない**(常在する警告は、本物の警告を隠す)
 */
import { describe, expect, it } from 'vitest';
import { frontmatterLineCount, parseFrontmatter } from '../../src/features/markdown/frontmatter';

describe('閉じの --- が無いとき(#284)', () => {
  it('🔴 壊れた frontmatter は警告を積む(黙って「無い」ことにしない)', () => {
    const r = parseFrontmatter('---\ntags: [あ]\n# 見出し\n本文\n');
    expect(r.found, '前提が崩れている(読めてしまっている)').toBe(false);
    expect(r.meta, '読めていないのに meta が入っている').toEqual({});
    expect(r.warnings.map((w) => w.kind), '黙って通している').toEqual(['malformed']);
    expect(r.warnings[0]?.detail, '何が起きたか書かれていない').toContain('閉じの ---');
  });

  /**
   * 🔴 **常在する警告を作らない。** ⚠ `---` で始まる普通の文書(水平線)を
   *   毎回警告すると、取込の画面が警告で埋まり、**本物の警告がそこに紛れる**。
   */
  it('🔴 ただの水平線で始まる文書は警告を出さない', () => {
    expect(parseFrontmatter('---\n本文\n').warnings, '水平線を壊れた情報と読んだ').toEqual([]);
    expect(parseFrontmatter('---\n\ntags: [あ]\n').warnings, '空行の先は情報ではない').toEqual([]);
    expect(parseFrontmatter('本文\n').warnings).toEqual([]);
  });

  /** ⚠ 正しく閉じている文書に警告を足していない(空振り防止の反対側)。 */
  it('閉じている frontmatter は今までどおり(警告なしで読める)', () => {
    const r = parseFrontmatter('---\ntags: [あ, い]\n---\n# 見出し\n');
    expect(r.found).toBe(true);
    expect(r.meta).toEqual({ tags: ['あ', 'い'] });
    expect(r.warnings).toEqual([]);
    expect(r.body).toBe('# 見出し\n');
  });

  /**
   * ⚠ **見分けは「最初の空行までに `key:` の行が在るか」**。
   * 🔑 `key:` に見えない行(URL の `http://` など)で誤判定しないこと ──
   *   誤って警告するのも、誤って黙るのも、どちらも同じ穴である。
   */
  it('key: に見えるものだけを情報と読む', () => {
    // ⚠ 行頭が key でない(コロンは在るが左が語ではない)
    expect(parseFrontmatter('---\nこれは 大事: です\n本文\n').warnings).toEqual([]);
    // 🔴 key: の形なら拾う(_ や - や . を含む名前も key である)
    for (const key of ['tags', 'due_date', 'heading-number', 'x.y']) {
      expect(
        parseFrontmatter(`---\n${key}: 1\n本文\n`).warnings.length,
        `${key}: 壊れた情報を見逃した`,
      ).toBe(1);
    }
  });
});

/**
 * 🔴 **行数の数え方**(#284)。ライブエディタは「描く本文」と「原文」の行番号を
 * この値でずらすので、**1 行の取り違えが本文の書き換え先をずらす**
 * (user から見ると「別の行が消える」)。
 *
 * ⚠ **`parseFrontmatter().body` の行数差では数えられない** ── あちらは CRLF を
 *   LF へ正規化し、閉じの直後の空行を 1 行食べる。ここはその両方を含めて pin する。
 */
describe('frontmatter が占める行数(#284)', () => {
  it('閉じの行まで数える', () => {
    expect(frontmatterLineCount('---\ntags: [あ]\n---\n# 見出し\n')).toBe(3);
    expect(frontmatterLineCount('---\na: 1\nb: 2\n---\n本文\n')).toBe(4);
  });

  it('読めないときは 0(切ってはいけない)', () => {
    expect(frontmatterLineCount('---\ntags: [あ]\n# 見出し\n'), '閉じが無いのに切った').toBe(0);
    expect(frontmatterLineCount('# 見出し\n')).toBe(0);
    expect(frontmatterLineCount('')).toBe(0);
  });

  /**
   * 🔴 **切った残りが本文と一致する**(この 2 つが食い違うと行番号がずれる)。
   * ⚠ ここが `parseFrontmatter().body` と**違ってよい**所である ── あちらは
   *   閉じの直後の空行を食べるので、行数の基準には使えない。
   */
  it('🔴 数えた行数で切ると、本文の先頭行が合う', () => {
    for (const src of [
      '---\ntags: [あ]\n---\n# 見出し\n本文\n',
      '---\ntags: [あ]\n---\n\n# 見出し\n', // ⚠ 閉じの直後に空行
      '---\r\ntags: [あ]\r\n---\r\n# 見出し\r\n', // ⚠ CRLF
    ]) {
      const n = frontmatterLineCount(src);
      const rest = src.split(/\r?\n/).slice(n);
      expect(rest.find((l) => l.trim() !== ''), `切り出しがずれた: ${JSON.stringify(src)}`).toBe(
        '# 見出し',
      );
    }
  });

  /**
   * 🔴 **`parseFrontmatter` と必ず同じ答えを出す**(規則を 2 つ作らない)。
   *
   * ⚠ 実測して分かったこと:開きの正規表現は `---\s*\r?\n` なので、
   *   **`---` の直後の空行まで飲む** ── `---`・空行・`a: 1`・`---` は
   *   `parseFrontmatter` から見て**れっきとした frontmatter** である
   *   (直感には反するが、これが今日の意味論であり、既存のデータがこれに乗っている)。
   * 🔑 だから行数の側も **4 行**と答えなければならない ── ここで「0 行」と
   *   答えると、読める情報を本文として描き、行番号もずれる。
   * ⚠ 閉じが無い側だけは別扱いにしてある(警告の節を参照)── そちらは
   *   「壊れた情報」と「ただの水平線」を見分ける必要があるため。
   */
  it('🔴 開きの直後の空行も飲む(parseFrontmatter と同じ答えにする)', () => {
    const src = '---\n\ntags: [あ]\n---\n本文\n';
    expect(parseFrontmatter(src).found, '前提が崩れている').toBe(true);
    expect(frontmatterLineCount(src), 'parse と行数で答えが割れている').toBe(4);
    expect(src.split('\n').slice(4)[0], '切り出しがずれた').toBe('本文');
  });
});
