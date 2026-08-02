/** @vitest-environment node */
/**
 * P7 段②: 素の `.md` 受理器(`readPlainMarkdown`)。
 *
 * 🔴 **宣言と実体の parity をここで縛る**。`manifest.webmanifest` の
 * `file_handlers` は `.md` / `.markdown` を宣言している ── 受理器がそれを
 * 受けなければ **manifest が嘘をついている**(この期間だけで宣言と実体のずれを
 * 2 回踏んでいる)。規則そのものに対して assert する。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MARKDOWN_EXTENSIONS,
  firstHeading,
  isMarkdownFileName,
  readPlainMarkdown,
  titleFromFileName,
} from '../../src/features/import/plain-markdown';

describe('🔴 manifest の宣言と受理器の parity', () => {
  // ⚠ cwd に依存させない(相対 path だと root 以外から vitest を起動すると壊れる)
  const manifest = JSON.parse(
    readFileSync(new URL('../../public/manifest.webmanifest', import.meta.url), 'utf-8'),
  ) as {
    file_handlers?: Array<{ accept?: Record<string, string[]> }>;
  };
  const declared = (manifest.file_handlers ?? []).flatMap((h) =>
    Object.values(h.accept ?? {}).flat(),
  );

  it('manifest が拡張子を宣言している(空なら parity 検査が空振りする)', () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it('manifest が宣言する拡張子は、受理器が**実際に受ける**', () => {
    for (const ext of declared) {
      expect(isMarkdownFileName(`note${ext}`), `${ext} を受けない`).toBe(true);
    }
  });

  it('受理器が受ける拡張子は、manifest が**宣言している**(逆向き)', () => {
    // ⚠ 片側だけだと「宣言していないものを勝手に受ける」が通る ──
    // それは file_handlers から開けないのに受理器だけが対応している状態
    expect([...MARKDOWN_EXTENSIONS].sort()).toEqual([...declared].sort());
  });
});

describe('拡張子の判定', () => {
  it.each([
    ['note.md', true],
    ['note.markdown', true],
    ['NOTE.MD', true],
    ['dir/sub/note.md', true],
    ['note.txt', false],
    ['note.md.zip', false],
    ['md', false],
    ['', false],
  ])('%s → %s', (name, expected) => {
    expect(isMarkdownFileName(name)).toBe(expected);
  });
});

describe('題名の決まり方(frontmatter title → 先頭 # 見出し → ファイル名)', () => {
  it('frontmatter の title が最優先', () => {
    const r = readPlainMarkdown('---\ntitle: 正本\n---\n# 見出し\n', 'file.md');
    expect(r.title).toBe('正本');
  });

  it('title が無ければ先頭の ATX 見出し', () => {
    expect(readPlainMarkdown('# 見出し\n本文\n', 'file.md').title).toBe('見出し');
  });

  it('🔴 CRLF の md でも先頭見出しを題名にする', () => {
    // review H-1: `split('\\n')` が残す `\\r` に `.` も `$` もマッチせず、
    // **CRLF の md では題名の 2 段目が丸ごと死んでいた**(ファイル名に落ちていた)。
    // ⚠ frontmatter を付けると `parseFrontmatter` の正規化に救われて素通りする
    expect(firstHeading('# 見出し\r\n本文\r\n')).toBe('見出し');
    expect(readPlainMarkdown('# 会議メモ\r\n本文\r\n', '2026-08-02.md').title).toBe('会議メモ');
  });

  it('見出しも無ければファイル名(拡張子とディレクトリを落とす)', () => {
    expect(readPlainMarkdown('本文だけ\n', 'dir/sub/私のノート.md').title).toBe('私のノート');
  });

  it('どれも無ければ「無題」', () => {
    expect(readPlainMarkdown('', '.md').title).toBe('無題');
  });

  it('空の title / 空白だけの title は採用しない(次の候補へ落ちる)', () => {
    expect(readPlainMarkdown('---\ntitle: "  "\n---\n# 見出し\n', 'f.md').title).toBe('見出し');
  });

  it('長すぎる題名は切り詰める(本文は原文のまま)', () => {
    const long = 'あ'.repeat(500);
    const r = readPlainMarkdown(`# ${long}\n`, 'f.md');
    expect(r.title).toHaveLength(200);
    expect(r.title.endsWith('…')).toBe(true);
    expect(r.body).toContain(long); // ⚠ 切り詰めたのは題名だけ
  });
});

describe('先頭見出しの拾い方', () => {
  it('🔴 fence の中の `#` は見出しではない', () => {
    // ⚠ ここが無いと、shell script を貼った md が全部「!/bin/bash」になる
    expect(firstHeading('```sh\n# !/bin/bash\n```\n# 本物\n')).toBe('本物');
  });

  it('~~~ の fence も閉じる', () => {
    expect(firstHeading('~~~\n# にせもの\n~~~\n# 本物\n')).toBe('本物');
  });

  it('違う印の fence は閉じない(``` の中の ~~~ は本文)', () => {
    expect(firstHeading('```\n~~~\n# にせもの\n```\n# 本物\n')).toBe('本物');
  });

  it('🔴 閉じ fence は**開き以上の長さ**が要る(4 個で開いて 3 個で閉じない)', () => {
    // review M-1: 1 文字比較だと markdown を説明する文書(``` を ```` で囲む)で
    // **コードブロックの中の見出しが題名になる** ── 当のコメントが防いだはずの故障
    expect(firstHeading('````\n```\n# にせもの\n```\n````\n# 本物\n')).toBe('本物');
  });

  it('長い開きは長い閉じで閉じる', () => {
    expect(firstHeading('````\n# にせもの\n````\n# 本物\n')).toBe('本物');
  });

  it('見出しの `#` は 6 個まで(7 個は見出しではない)', () => {
    expect(firstHeading('####### 七つ\n# 本物\n')).toBe('本物');
    expect(firstHeading('###### 六つ\n')).toBe('六つ');
  });

  it('閉じ `#` を落とす', () => {
    expect(firstHeading('# 題名 ###\n')).toBe('題名');
  });

  it('`#` だけの行は題名にしない', () => {
    expect(firstHeading('#\n本文\n')).toBe(null);
  });

  it('`#本文`(空白なし)は見出しではない', () => {
    expect(firstHeading('#hashtag\n')).toBe(null);
  });

  it('3 空白までの字下げは見出し / 4 空白はコードブロック', () => {
    expect(firstHeading('   # 見出し\n')).toBe('見出し');
    expect(firstHeading('    # コード\n')).toBe(null);
  });

  it('見出しが無ければ null', () => {
    expect(firstHeading('本文だけ\n')).toBe(null);
  });

  it('🔴 frontmatter の中の `#` は題名にしない(走査対象は本文)', () => {
    // ⚠ YAML のコメントは `#` で始まる ── 原文を走査すると
    // `# メモ` が題名になる。走査対象がどちらかを test で宣言しておく
    const r = readPlainMarkdown('---\n# メモ: 内部用\ntitle: ""\n---\n# 本物\n', 'f.md');
    expect(r.title).toBe('本物');
  });
});

describe('archetype', () => {
  // 🔴 **専用フレーバーの有無で決めてはいけない**(review M-2)。`folder` /
  // `generic` / `opaque` は一級の archetype だがフレーバーは text にフォールバック
  // するので、「登録されているか」で判定すると**自分の md ZIP export を
  // 取り込み直したときにフォルダがノートに化ける**
  it.each(['text', 'todo', 'textlog', 'form', 'spreadsheet', 'folder', 'generic', 'opaque'])(
    '%s は受ける',
    (archetype) => {
      const r = readPlainMarkdown(`---\narchetype: ${archetype}\n---\n`, 'f.md');
      expect(r.archetype).toBe(archetype);
      expect(r.warnings).toEqual([]);
    },
  );

  it('🔴 `attachment` は受けない(単一 md は bytes を持ってこられない)', () => {
    // 受けると**中身の無い添付 entry**ができる ── 開けないのに壊れて見えない
    const r = readPlainMarkdown('---\narchetype: attachment\n---\n', 'f.md');
    expect(r.archetype).toBe('text');
    expect(r.warnings.join('\n')).toContain('attachment');
  });

  it('🔴 受けられない archetype は text にして**言う**(黙って嘘を残さない)', () => {
    const r = readPlainMarkdown('---\narchetype: nonexistent\n---\n', 'f.md');
    expect(r.archetype).toBe('text');
    expect(r.warnings.join('\n')).toContain('nonexistent');
  });

  it('指定が無ければ text', () => {
    expect(readPlainMarkdown('本文\n', 'f.md').archetype).toBe('text');
  });
});

describe('🔴 本文は原文のまま', () => {
  it('frontmatter ごと丸ごと残す(再構築しない)', () => {
    const src = '---\ntitle: T\nnested:\n  a: 1\n# コメント\n---\n本文\n';
    expect(readPlainMarkdown(src, 'f.md').body).toBe(src);
  });

  it('CRLF を正規化しない', () => {
    // ⚠ `parseFrontmatter` は body の CRLF を LF に潰す ── その戻り値を body に
    // 使うと「原文のまま」が嘘になる
    const src = '---\r\ntitle: T\r\n---\r\n本文\r\n';
    expect(readPlainMarkdown(src, 'f.md').body).toBe(src);
  });

  it('🔴 frontmatter **無し**の CRLF も原文のまま', () => {
    // ⚠ frontmatter があると `parseFrontmatter` の正規化に救われる ── ここが
    // 本当の観測点(review H-1 はこの次元がゼロだったせいで見逃されていた)
    const src = '# 見出し\r\n本文\r\n';
    expect(readPlainMarkdown(src, 'f.md').body).toBe(src);
  });

  it('frontmatter が無くてもそのまま', () => {
    const src = '# 見出し\n\n本文\n';
    expect(readPlainMarkdown(src, 'f.md').body).toBe(src);
  });
});

describe('解決しない参照は件数で言う', () => {
  it('相対パス参照を数える', () => {
    const r = readPlainMarkdown('![図](images/a.png)\n[資料](docs/b.pdf)\n', 'f.md');
    expect(r.unresolvedRefs).toEqual(['images/a.png', 'docs/b.pdf']);
    expect(r.warnings.join('\n')).toContain('2 件');
  });

  it('外部 URL / anchor / 既に解決済みの添付参照は数えない', () => {
    const r = readPlainMarkdown(
      '[a](https://example.com/x.png)\n[b](#section)\n![c](asset:ast-1)\n[d](mailto:x@y.z)\n[e](//cdn/x.js)\n',
      'f.md',
    );
    expect(r.unresolvedRefs).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('同じ参照は 1 件として数える', () => {
    const r = readPlainMarkdown('![a](img/x.png)\n![b](img/x.png)\n', 'f.md');
    expect(r.unresolvedRefs).toEqual(['img/x.png']);
  });

  it('`<...>` 形の destination も拾う', () => {
    const r = readPlainMarkdown('[a](<my file.png>)\n', 'f.md');
    expect(r.unresolvedRefs).toEqual(['my file.png']);
  });

  // 🔴 ここが**いちばん数えたい形**(黙って画像が壊れる)。review M-3 まで
  // 取りこぼしていた ── 誤差が「言い過ぎ」ではなく「黙る」側に出ていた
  it('🔴 参照形式リンクの定義行を拾う', () => {
    const r = readPlainMarkdown('![図][a]\n\n[a]: images/a.png\n', 'f.md');
    expect(r.unresolvedRefs).toEqual(['images/a.png']);
  });

  it('🔴 HTML の `src` / `href` を拾う', () => {
    expect(readPlainMarkdown('<img src="images/a.png" alt="図">\n', 'f.md').unresolvedRefs).toEqual([
      'images/a.png',
    ]);
    expect(readPlainMarkdown('<a href=docs/b.pdf>x</a>\n', 'f.md').unresolvedRefs).toEqual([
      'docs/b.pdf',
    ]);
  });

  // 🔴 こちらは**嘘の警告**を出していた側
  it.each([
    ['fence の中', '```md\n![例](images/example.png)\n```\n'],
    ['行内コード', 'a `](foo.png)` b\n'],
    ['エスケープ', 'a \\](notalink.png) b\n'],
  ])('%s は数えない', (_label, src) => {
    expect(readPlainMarkdown(src, 'f.md').unresolvedRefs).toEqual([]);
  });

  it('題名つきリンクは宛先だけを数える(`"題名"` を混ぜない)', () => {
    expect(readPlainMarkdown('[a](path.png "題名")\n', 'f.md').unresolvedRefs).toEqual([
      'path.png',
    ]);
  });

  it('宛先の括弧 1 段は宛先の一部', () => {
    expect(readPlainMarkdown('[a](path_(1).png)\n', 'f.md').unresolvedRefs).toEqual([
      'path_(1).png',
    ]);
  });

  it('参照が 5 件を超えたら先頭 5 件だけ名前を出す(全件は件数で言う)', () => {
    const src = Array.from({ length: 7 }, (_, i) => `![](img/${i}.png)`).join('\n');
    const r = readPlainMarkdown(src, 'f.md');
    expect(r.unresolvedRefs).toHaveLength(7);
    const w = r.warnings.join('\n');
    expect(w).toContain('7 件');
    expect(w).toContain('…');
    // 件数の規則そのものを pin(5 件目まで名前が出て、6 件目は出ない)
    expect(w).toContain('img/4.png');
    expect(w).not.toContain('img/5.png');
  });

  it('ちょうど 5 件なら省略しない', () => {
    const src = Array.from({ length: 5 }, (_, i) => `![](img/${i}.png)`).join('\n');
    const w = readPlainMarkdown(src, 'f.md').warnings.join('\n');
    expect(w).toContain('img/4.png');
    expect(w).not.toContain('…');
  });
});

describe('frontmatter を読めなかったとき', () => {
  it('🔴 cap 超過で諦めたら**言う**(題名が黙ってファイル名に落ちない)', () => {
    // 既定の soft cap は 16KB
    const huge = `---\ntitle: 正本\npad: "${'x'.repeat(20_000)}"\n---\n# 見出し\n`;
    const r = readPlainMarkdown(huge, 'f.md');
    expect(r.warnings.join('\n')).toContain('frontmatter');
    expect(r.body).toBe(huge); // 本文は無傷
  });
});

describe('ファイル名 → 題名', () => {
  it.each([
    ['note.md', 'note'],
    ['note.markdown', 'note'],
    ['dir/sub/note.md', 'note'],
    ['dir\\sub\\note.md', 'note'],
    ['NOTE.MD', 'NOTE'],
    ['note.txt', 'note.txt'],
    ['  spaced .md', 'spaced'],
  ])('%s → %s', (name, expected) => {
    expect(titleFromFileName(name)).toBe(expected);
  });
});
