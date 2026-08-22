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
import {
  frontmatterLineCount,
  frontmatterProblem,
  parseFrontmatter,
  spliceFrontmatterKeys,
} from '../../src/features/markdown/frontmatter';

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
    expect(parseFrontmatter('本文\n').warnings).toEqual([]);
    // ⚠ 空行のあとが `key:` に見えない行なら、これまでどおり黙る
    expect(parseFrontmatter('---\n\nこれは本文です\n').warnings).toEqual([]);
  });

  /**
   * 🔴 **「開きの直後が空行なら水平線」という除外を落とした**(2026-08-22)。
   *
   * ⚠ **この it は、直す前の稿が「無言であること」を正しいとして pin していた
   *   場所である**(`parseFrontmatter('---\n\ntags: [あ]\n').warnings` が
   *   `[]` であることを要求していた)。検査そのものの主張が間違っていた
   *   ── CLAUDE.md §1「主張そのものが成り立たない」の型。
   *
   * 🔑 **parse の規則と食い違っていた**のが理由である。実測:
   *
   * | 本文 | `parseFrontmatter` の答え |
   * |---|---|
   * | `---\n\ntags: [あ]\n---\n本文` | `found: true` / `meta: {tags:['あ']}` |
   * | `---\n\ntags: [あ]\n本文` | 直す前 `warnings: []`(完全に無言) |
   *
   * つまり**閉じさえ在れば読める形**なのに、閉じを失ったときだけ黙っていた。
   * ⚠ **対照群を同じ it に置く**(閉じ有りなら読める)── 置かないと
   *   「警告が出るようになったが、実は別の理由」を次に見抜けない。
   */
  it('🔴 開きの直後が空行でも、閉じを失ったら黙らない(対照群つき)', () => {
    // 対照群 ── 閉じが在れば、この形は**正規に読める**
    const ok = parseFrontmatter('---\n\ntags: [あ]\n---\n本文\n');
    expect(ok.found, '前提が崩れている(閉じ有りでも読めていない)').toBe(true);
    expect(ok.meta, '前提が崩れている').toEqual({ tags: ['あ'] });
    expect(ok.warnings, '正規の形に警告を足している').toEqual([]);

    // 本題 ── 同じ形で閉じだけ失うと、黙らずに理由を出す
    const bad = parseFrontmatter('---\n\ntags: [あ]\n本文\n');
    expect(bad.found).toBe(false);
    expect(bad.warnings.map((w) => w.kind), '読める形なのに黙っている').toEqual(['malformed']);
  });

  /**
   * 🔴 **key の見分けを `parseFlatYaml` と同じ規則に揃えた**(2026-08-22)。
   *
   * ⚠ 直す前は検出器だけ `^[A-Za-z0-9_.-]+$` で**数字始まりを許して**いたので、
   *   `12:30 に集合` という普通の 1 行が「壊れた frontmatter」に見えていた
   *   ── **読み手が読まない形を、検出器だけが frontmatter と呼んでいた**。
   */
  it('🔴 読み手が key と読まないものは、検出器も key と読まない', () => {
    // `parseFlatYaml` の key は `^[A-Za-z_][\w.-]*$` ── 数字始まりは key ではない
    expect(parseFrontmatter('---\n\n12:30 に集合\n').warnings, '時刻を壊れた情報と読んだ').toEqual(
      [],
    );
    // ⚠ 空振り防止 ── 英字始まりなら今までどおり拾う
    expect(parseFrontmatter('---\n\ntags: [あ]\n').warnings.length).toBe(1);
  });

  /**
   * ⚠ **承知のうえで残している誤警告**(2026-08-22 に測って決めた)。
   *
   * `---`・空行・**裸の URL** だけの文書は警告が出る ── `https://example.com/x` の
   * `https` が `parseFlatYaml` の key の規則を満たすためである。
   * 🔑 **わざと揃えている**:検出器を parser より厳しくすると
   *   「parser は読むのに検出器は黙る」という**逆向きの穴**ができる(§7
   *   「誤差の向きを決めて、両側に使い回さない」)。
   * ⚠ この形(先頭が水平線 / 他に `---` が 1 つも無い / 最初の行が裸の URL)は
   *   まれなので、**常在する警告にはならない**と判断した。
   *   これが覆るのは「実際に取込の画面が警告で埋まった」という報告が出たとき。
   */
  it('⚠ 裸の URL は key と同じ形なので警告が出る(承知のうえで揃えている)', () => {
    expect(parseFrontmatter('---\n\nhttps://example.com/x\n').warnings.length).toBe(1);
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


/**
 * 🔴 **閉じを失った本文へ書き込んでも、user の情報を壊さない**(#318)。
 *
 * ## 直す前に何が起きていたか(実測)
 *
 * ```
 * 元:   ---\ntags: [あ]\n本文…
 * 書込: ---\nstatus: done\n---\n---\ntags: [あ]\n本文…   ← 二重 fence
 * ```
 *
 * ⚠ 再 parse は `found: true` / `meta: {status}` / **`warnings: 0 件`** を返す ──
 * **user が書いた `tags` は読めない側へ落ちたのに、画面は「読めている」顔をする**。
 * 到達経路は**どちらも普通の操作**(カレンダーで日付を付ける / 印を切り替える)。
 *
 * ## 🔴 **byte で pin する**(着地前レビュー M2)
 *
 * `spliceFrontmatterKeys` の存在理由は **本文が byte 単位で無傷**であること
 * (この file 冒頭の規律)。⚠ 1 稿目は修理経路だけ `parseFrontmatter` 越しに
 * 見ていたので、**閉じの直後へ空行を 1 本挿す変異が素通り**した
 * (`parseFrontmatter` は閉じの直後の空行を 1 行食べる ── 同 file が自分で
 * 警告している癖)。**前置側は `toBe` で pin してあったのに、対称の反対側だけ
 * 空いていた。**
 *
 * ## ⚠ 走の文法は `parseFlatYaml` に合わせる(着地前レビュー B / C / D)
 *
 * 1 稿目は独自の文法を書いたので、**4 通りに user のデータが変質した**
 * ── 下の表がその全数である。
 */
describe('閉じを失った本文への書き込み(#318)', () => {
  /**
   * 🔴 **修理した全文を byte で pin する。**
   * ⚠ 期待値は**実測から起こす**(手で組むと、実装と同じ間違いを書ける)。
   */
  const REPAIRED: [string, string, string][] = [
    ['正規(対照群)', '---\ntags: [あ]\n本文\n', '---\ntags: [あ]\nstatus: done\n---\n本文\n'],
    [
      '🔴 A 末尾に改行が無い ── 直す前は `tags: [あ]status: done` と融合した',
      '---\ntags: [あ]',
      '---\ntags: [あ]\nstatus: done\n---\n',
    ],
    [
      '🔴 B 字下げ**無し**のブロック配列 ── 直す前は中身が本文へ落ちた',
      '---\ntags:\n- あ\n- い\n本文\n',
      '---\ntags:\n- あ\n- い\nstatus: done\n---\n本文\n',
    ],
    [
      'B2 字下げ有りのブロック配列',
      '---\ntags:\n  - あ\n  - い\n本文\n',
      '---\ntags:\n  - あ\n  - い\nstatus: done\n---\n本文\n',
    ],
    [
      '🔴 C1 先頭にコメント ── 直す前は二重 fence を作った(#318 が直っていなかった)',
      '---\n# メモ\ntags: [あ]\n本文\n',
      '---\n# メモ\ntags: [あ]\nstatus: done\n---\n本文\n',
    ],
    [
      '🔴 C2 途中にコメント ── 直す前は後続の key を本文へ追い出した',
      '---\ntags: [あ]\n# メモ\npriority: high\n本文\n',
      '---\ntags: [あ]\n# メモ\npriority: high\nstatus: done\n---\n本文\n',
    ],
    [
      '⚠ C4 末尾のコメントは走に入れない(本文側に残す)',
      '---\ntags: [あ]\n# メモ\n本文\n',
      '---\ntags: [あ]\nstatus: done\n---\n# メモ\n本文\n',
    ],
    [
      '🔴 D2 全角空白で字下げした段落 ── 直す前は本文から消えた',
      '---\ntags: [あ]\n　本文です\n続き\n',
      '---\ntags: [あ]\nstatus: done\n---\n　本文です\n続き\n',
    ],
    [
      '🔴 D3 タブで字下げした段落',
      '---\ntags: [あ]\n\t本文です\n続き\n',
      '---\ntags: [あ]\nstatus: done\n---\n\t本文です\n続き\n',
    ],
    [
      '⚠ CRLF ── 補う閉じの行末を混ぜない',
      '---\r\ntags: [あ]\r\n本文\r\n',
      '---\r\ntags: [あ]\r\nstatus: done\r\n---\r\n本文\r\n',
    ],
  ];

  it.each(REPAIRED)('🔴 %s', (_name, src, want) => {
    expect(spliceFrontmatterKeys(src, { status: 'done' })).toBe(want);
  });

  /**
   * 🔴 **user が書いた情報が、読める側に残っている**(byte の pin と対で見る)。
   * ⚠ byte が合っていても**意味が変わっている**ことがある(`tags` が配列から
   *   文字列に化ける等)ので、再 parse の中身も見る。
   */
  it('🔴 修理した後、user の key が読める側に残る', () => {
    for (const [name, src] of REPAIRED.map(([n, s]) => [n, s] as const)) {
      const r = parseFrontmatter(spliceFrontmatterKeys(src, { status: 'done' }));
      expect(r.found, `${name}: 修理したのに読めない`).toBe(true);
      if (src.includes('tags')) {
        expect(r.meta['tags'], `${name}: user の tags が壊れた`).toEqual(
          src.includes('[あ]') ? ['あ'] : ['あ', 'い'],
        );
      }
      expect(r.warnings, `${name}: 直したのに警告が残っている`).toEqual([]);
    }
  });

  /**
   * 🔴 **前置に落ちる側**(= frontmatter ではない普通の文書)。
   * ⚠ ここも byte で pin する ── 本文は 1 バイトも変わらない。
   */
  const PREPENDED: [string, string][] = [
    ['水平線 + 空行 + 散文', '---\n\nこれは本文です\n'],
    ['🔴 C3 水平線 + markdown 見出し(コメントに見えるが本文)', '---\n# 見出し\n本文\n'],
    ['🔴 D1 先頭が字下げの箇条書き ── 直す前は frontmatter へ飲まれた', '---\n  - りんご\n  - みかん\n'],
    ['本文が先に来る', '---\nこれは本文です\ntags: [あ]\n'],
  ];

  it.each(PREPENDED)('前置: %s', (_name, src) => {
    const out = spliceFrontmatterKeys(src, { status: 'done' });
    expect(out).toBe(`---\nstatus: done\n---\n${src}`);
    // ⚠ 本文は byte 無傷のまま後続する
    expect(parseFrontmatter(out).body).toBe(src);
  });

  /**
   * 🔴 **書くものが何も無いなら、直さない**(着地前レビュー ②)。
   * ⚠ 「無い key を消す」だけの空操作でも修理が走ると、**user が何もしていないのに
   *   文書の見え方が変わる**(水平線に見えていた 2 行が、以後は隠れた情報になる)。
   */
  it('🔴 空操作(無い key の削除)では、本文に触れない', () => {
    const src = '---\ntags: [あ]\n本文\n';
    expect(spliceFrontmatterKeys(src, { status: undefined })).toBe(src);
  });

  /** ⚠ **対照群** ── 在る key の削除なら、修理して消す。 */
  it('対照群: 在る key の削除は、修理してから消す', () => {
    expect(spliceFrontmatterKeys('---\ntags: [あ]\nstatus: open\n本文\n', { status: undefined })).toBe(
      '---\ntags: [あ]\n---\n本文\n',
    );
  });

  /**
   * 🔴 **空行を跨ぐ**(2 巡目レビュー A-1 / MUT-1)。
   *
   * ⚠ `parseFlatYaml` は**空行を読み飛ばして先を読む**ので、
   *   `---\ntitle: メモ\n\ntags: [買い物]\n---\n本文` は**今日の正規の frontmatter**。
   *   1・2 稿目は走を空行で切っていたので、閉じを失ったこの本文を「修理」すると
   *   **`tags` が読めない側へ落ち、しかも警告まで消えた** ── user から見ると
   *   「警告が出ていた → チェックを付けた → 警告が消えた」なので**直ったと読む**。
   *   **アプリ自身の修理が嘘を作っていた。**
   * ⚠ この規則は**どちら向きにも pin されていなかった**(docstring だけが
   *   「空行では切る」と書いていた)。
   */
  it('🔴 空行を含む frontmatter を修理しても、後半の key が落ちない', () => {
    const src = '---\ntitle: メモ\n\ntags: [買い物]\n本文\n';
    // 前提 ── 閉じさえ在れば、この形は正規に読める
    expect(parseFrontmatter(`${src.slice(0, -3)}---\n本文\n`).meta['tags'], '前提が崩れている')
      .toEqual(['買い物']);
    const out = spliceFrontmatterKeys(src, { status: 'done' });
    expect(out).toBe('---\ntitle: メモ\n\ntags: [買い物]\nstatus: done\n---\n本文\n');
    expect(parseFrontmatter(out).meta, 'user の key が落ちた').toEqual({
      title: 'メモ',
      tags: ['買い物'],
      status: 'done',
    });
    // ⚠ 直したのだから、警告も消えてよい(消えるのが嘘ではない状態)
    expect(frontmatterProblem(out), '直したのに理由が残っている').toBeNull();
  });

  /** ⚠ **対照群** ── 空行の先が散文なら、そこで切る(飲みすぎない)。 */
  it('対照群: 空行の先が散文なら、走はそこで止まる', () => {
    expect(spliceFrontmatterKeys('---\nk: 1\n\n散文です\nk2: 2\n本文\n', { status: 'done' })).toBe(
      '---\nk: 1\nstatus: done\n---\n\n散文です\nk2: 2\n本文\n',
    );
  });

  /**
   * 🔴 **ブロック配列の入口は「値の無い key の直後」だけ**(2 巡目レビュー MUT-2)。
   * ⚠ `inBlock` を常に真にする変異が生き延びていた ── その形では
   *   `---\ntags: [買い物]\n- 牛乳\n- 卵\n本文` の**箇条書き 2 行が frontmatter へ
   *   飲まれ、画面から消える**(`parseFlatYaml` はその 2 行を読まないので、
   *   どこにも出ない)。
   */
  it('🔴 値のある key の後ろの箇条書きは、本文のまま', () => {
    expect(
      spliceFrontmatterKeys('---\ntags: [買い物]\n- 牛乳\n- 卵\n本文\n', { status: 'done' }),
    ).toBe('---\ntags: [買い物]\nstatus: done\n---\n- 牛乳\n- 卵\n本文\n');
  });

  /**
   * 🔴 **空操作ガードが探すのは「走の中」だけ**(2 巡目レビュー MUT-3)。
   * ⚠ 探す範囲を本文まで広げる変異が生き延びていた ── その形では
   *   **本文中の `status:` に釣られて修理が走り**、user が何もしていないのに
   *   `tags: [あ]` が本文から消える。
   */
  it('🔴 本文中の同名の行に釣られて修理しない', () => {
    const src = '---\ntags: [あ]\n本文\nstatus: メモの話\n';
    expect(spliceFrontmatterKeys(src, { status: undefined }), '本文に釣られて修理した').toBe(src);
  });

  /**
   * 🔴 **字下げした key も、書き換えの対象にする**(2 巡目レビュー B-3)。
   * ⚠ 走は字下げを frontmatter に入れるのに、書き換えは行頭固定だったので、
   *   **同名 key が 2 本**になり(書くとき)、**無言の no-op** になっていた(消すとき)。
   */
  it('🔴 字下げした key を、二重にせず書き換える', () => {
    expect(spliceFrontmatterKeys('---\n  status: open\n---\n本文\n', { status: 'done' })).toBe(
      '---\n  status: done\n---\n本文\n',
    );
    expect(spliceFrontmatterKeys('---\n  status: open\n---\n本文\n', { status: undefined })).toBe(
      '---\n---\n本文\n',
    );
  });

  /**
   * 🔴 **「警告を出す形」と「閉じを補う形」が一致する**(CLAUDE.md §7)。
   * ⚠ 別々に数えると「**警告は出さないのに書込は壊す**」ができる ── #318 は
   *   その食い違いそのものだった。
   */
  /**
   * 🔴 **修理した結果が「理想形」と一致する**(2 巡目レビュー B-2)。
   *
   * ⚠ 下の「判定が 1 つ」は、左辺(警告)も右辺(前置したか)も
   *   **`frontmatterRunLength` から導かれる**ので、走の文法をどう変えても
   *   **両辺が一緒に動く** ── 守れているのは「呼び出し口が 2 か所とも同じ関数を
   *   使っている」ことだけで、**文法が正しいことは 1 件も守っていない**
   *   (実際、空行の扱いを裏返す変異が緑のまま通った)。
   *
   * 🔑 だから**期待値を独立に作る**:user が閉じの `---` を**書き足しただけ**の
   *   本文(= 理想形)を parse した `meta` と、**修理した本文**の `meta` が一致すること。
   *   ⚠ 理想形は `frontmatterRunLength` を 1 度も呼ばない ── そこが独立の要点である。
   */
  it('🔴 修理後の meta が、user が閉じを書き足した場合と一致する', () => {
    const CASES = [
      '---\ntags: [あ]\n本文\n',
      '---\ntitle: メモ\n\ntags: [買い物]\n本文\n',
      '---\ntags:\n- あ\n- い\n本文\n',
      '---\ntags:\n  - あ\n  - い\n本文\n',
      '---\n# メモ\ntags: [あ]\n本文\n',
      '---\ntags: [あ]\n# メモ\npriority: high\n本文\n',
      '---\ntags: [あ]',
    ];
    for (const src of CASES) {
      const repaired = parseFrontmatter(spliceFrontmatterKeys(src, { status: 'done' }));
      /**
       * 理想形 ── 走の行数を**使わずに**作る。user が「本文の直前」に閉じを
       * 書き足した姿を、**本文の側から**組む(先頭の非 frontmatter 行を探す)。
       */
      const lines = src.replace(/^---[ \t]*\r?\n/, '').split(/\r?\n/);
      const bodyAt = lines.findIndex(
        (l) => l.trim() !== '' && !l.trimStart().startsWith('#') && !/^\s*[A-Za-z_][\w.-]*\s*:/.test(l) && !/^\s*-\s+/.test(l),
      );
      const cut = bodyAt < 0 ? lines.length : bodyAt;
      const ideal = parseFrontmatter(
        `---\n${lines.slice(0, cut).join('\n')}\n---\n${lines.slice(cut).join('\n')}`,
      );
      expect(repaired.found, `修理したのに読めない: ${JSON.stringify(src)}`).toBe(true);
      expect(
        { ...repaired.meta, status: undefined },
        `修理の結果が、閉じを書き足した場合と違う: ${JSON.stringify(src)}`,
      ).toEqual({ ...ideal.meta, status: undefined });
    }
  });

  it('🔴 判定が 1 つ ── 警告が出る形 ⇔ 前置しない形', () => {
    const CASES = [
      ...REPAIRED.map(([, s]) => s),
      ...PREPENDED.map(([, s]) => s),
      '---\n\n12:30 に集合\n',
      '---\n| a | b |\n|---|---|\n',
    ];
    let warned = 0;
    for (const src of CASES) {
      const isBroken = parseFrontmatter(src).warnings.some((w) => w.kind === 'malformed');
      if (isBroken) warned += 1;
      const prepended =
        spliceFrontmatterKeys(src, { status: 'done' }) === `---\nstatus: done\n---\n${src}`;
      expect(prepended, `判定が食い違っている: ${JSON.stringify(src)}`).toBe(!isBroken);
    }
    // ⚠ 空振り防止 ── 両方の側が実際に出ていること
    expect(warned, '壊れた形が 1 件も無い(この検査は空振り)').toBeGreaterThan(0);
    expect(warned, '全部壊れた形になっている(この検査は空振り)').toBeLessThan(CASES.length);
  });
});

/**
 * 🔴 **「読めていない」理由を 1 か所から返す**(#284 の出口 / #318 の対)。
 *
 * ⚠ 画面ごとに `warnings.some(...)` を書くと、`kind` を足したとき片方だけ拾う(§7)。
 */
describe('frontmatterProblem ── 画面へ出す理由(#284 / #318)', () => {
  it('🔴 閉じを失った本文は理由を返す', () => {
    const r = frontmatterProblem('---\ntags: [あ]\n本文\n');
    expect(r?.kind, '種別が違う(1 組目が読めない)').toBe('unreadable');
    expect(r?.detail).toContain('閉じの ---');
  });

  /**
   * 🔴 **`meta` を空にする warning は全部拾う**(着地前レビュー E)。
   *
   * ⚠ 1 稿目は `malformed` しか見ていなかったので、**cap 超過のノートで
   *   #284 の嘘がそのまま残っていた** ── `found: true` / `meta: {}` /
   *   `warnings: ['size_limit']` なので、情報ペインは「タグ **無し**」と断定する。
   * ⚠ この関数の docstring 自身が「`kind` を足したとき片方だけ拾う」と
   *   戒めているのに、**いま実在する 2 つ目の kind を落としていた**。
   */
  it('🔴 cap を超えた frontmatter も「読めていない」と言う', () => {
    const big = `---\nk: ${'あ'.repeat(20000)}\n---\n本文\n`;
    const r = parseFrontmatter(big);
    // 前提 ── cap 超過は `found: true` で返る(だから malformed では拾えない)
    expect(r.found, '前提が崩れている').toBe(true);
    expect(r.warnings.map((w) => w.kind), '前提が崩れている').toEqual(['size_limit']);
    expect(r.meta, '前提が崩れている(meta が空でない)').toEqual({});
    const r2 = frontmatterProblem(big);
    expect(r2?.kind, 'cap 超過を見逃した').toBe('unreadable');
    // ⚠ **画面へ出す字は user の言葉**(2 巡目レビュー B-5)── 内部語を出さない
    expect(r2?.detail, '内部語がそのまま画面へ出ている').not.toMatch(/frontmatter|bytes|parse/);
    expect(r2?.detail).toContain('大きすぎて');
  });

  /**
   * 🔴 **既に二重 fence になっている本文も拾う**(#318 の「対で塞ぐもの」)。
   * ⚠ そちらは 1 本目が正しく読めるので `warnings` が **0 件**になり、上半分では拾えない。
   */
  it('🔴 既に二重 fence になっている本文も拾う', () => {
    for (const broken of [
      '---\nstatus: done\n---\n---\ntags: [あ]\n本文\n',
      // ⚠ コメント始まりの 2 本目 ── 走の文法を直すまで**拾えなかった**形
      '---\nstatus: done\n---\n---\n# メモ\ntags: [あ]\n本文\n',
    ]) {
      const r = parseFrontmatter(broken);
      expect(r.found, '前提が崩れている').toBe(true);
      expect(r.warnings, '前提が崩れている(1 本目で警告が出ている)').toEqual([]);
      const p2 = frontmatterProblem(broken);
      expect(p2?.kind, `二重 fence を見逃した: ${JSON.stringify(broken)}`).toBe('trailing');
      expect(p2?.detail).toContain('2 組目');
    }
  });

  it('🔴 読めている本文には理由を返さない(常在する警告を作らない)', () => {
    for (const ok of [
      '---\ntags: [あ]\n---\n本文\n',
      '本文だけ\n',
      '---\n本文\n',
      '---\n# 見出し\n本文\n', // ⚠ 水平線 + markdown 見出し
      '---\ntags: [あ]\n---\n\n---\n\n第 2 節\n',
      '---\ntitle: a\n---\n---\n  - りんご\n', // ⚠ 字下げの箇条書きは frontmatter ではない
      '',
    ]) {
      expect(frontmatterProblem(ok), `理由を作った: ${JSON.stringify(ok)}`).toBeNull();
    }
  });
});
