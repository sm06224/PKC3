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
 * 🔴 **閉じを失った本文へ書き込んでも、2 本目の fence を前置しない**(#318)。
 *
 * ## 直す前に何が起きていたか(実測)
 *
 * ```
 * 元:   ---\ntags: [あ]\n本文…
 * 書込: ---\nstatus: done\n---\n---\ntags: [あ]\n本文…   ← 二重 fence
 * ```
 *
 * ⚠ **そのあとが本当に悪い** ── 二重になると再 parse は
 * `found: true` / `meta: {status:'done'}` / **`warnings: 0 件**` を返す。つまり
 * **user が書いた `tags` は読めない側へ落ちたのに、画面は「読めている」顔をする**。
 * いちばん壊れた状態で、いちばん安心させる形である。
 *
 * ⚠ 到達経路は**どちらも普通の操作**:カレンダーで日付を付ける / 印を切り替える
 * (`app-state.ts` → `body-rewrite.ts` → ここ)。
 *
 * ## ⚠ ここが「ゼロ件の次元」だった
 *
 * 直す前の `frontmatter-malformed.test.ts` は **読む側しか見ていなかった**
 * ── 「閉じ無しへ**書き込む**」場合が 1 件も無い。だからこの壊し方は、
 * 全 test 緑のまま出荷されていた(CLAUDE.md §2)。
 */
describe('閉じを失った本文への書き込み(#318)', () => {
  it('🔴 二重 fence を作らず、閉じを補って user の key を残す', () => {
    const out = spliceFrontmatterKeys('---\ntags: [あ]\n本文\n', { status: 'done' });
    // ⚠ 直す前はここが `---\nstatus: done\n---\n---\ntags: [あ]\n本文\n` だった
    expect(out, '二重 fence が残っている').not.toMatch(/^---\n[\s\S]*?\n---\n---\n/);
    const r = parseFrontmatter(out);
    expect(r.found, '書いたのに読めない').toBe(true);
    expect(r.meta, 'user が書いた key を落とした(いちばん静かな壊れ方)').toEqual({
      tags: ['あ'],
      status: 'done',
    });
    expect(r.body, '本文が変わった').toBe('本文\n');
    expect(r.warnings, '直したのに警告が残っている').toEqual([]);
  });

  it('🔴 key が複数行あっても、全部残る', () => {
    const out = spliceFrontmatterKeys('---\ntags: [あ]\nstatus: open\n本文\n', {
      status: 'done',
    });
    const r = parseFrontmatter(out);
    expect(r.meta, '既にある key を書き換えられていない').toEqual({
      tags: ['あ'],
      status: 'done',
    });
    expect(r.body).toBe('本文\n');
  });

  /**
   * ⚠ **開きの直後が空行の形も同じ**(読む側と揃える)── `OPEN_FENCE` が
   *   空行まで飲むので、閉じさえ在れば読める形である。
   */
  it('🔴 開きの直後が空行でも、閉じを補って直す', () => {
    const out = spliceFrontmatterKeys('---\n\ntags: [あ]\n本文\n', { status: 'done' });
    const r = parseFrontmatter(out);
    expect(r.meta).toEqual({ tags: ['あ'], status: 'done' });
    expect(r.body).toBe('本文\n');
  });

  /**
   * 🔴 **ブロック配列の中身を本文へ落とさない**(1 稿目で実際に落とした)。
   *
   * ⚠ 走の終わりを「最初の空行」で決めていたら、`tags:` の**次の行から本文まで**が
   *   走に入り、閉じが本文の後ろへ入った。逆に「key の行だけ」で決めると、
   *   今度は `  - あ` が**本文へ落ちる** ── どちらも user のデータの意味が変わる。
   * 🔑 だから **key の行 + それに続く字下げの行**を走とする。
   */
  it('🔴 ブロック配列の続き(字下げ)も frontmatter 側に残す', () => {
    const out = spliceFrontmatterKeys('---\ntags:\n  - あ\n  - い\n本文\n', {
      status: 'done',
    });
    const r = parseFrontmatter(out);
    expect(r.meta, '配列の中身が本文へ落ちた').toEqual({ tags: ['あ', 'い'], status: 'done' });
    expect(r.body, '本文が変わった').toBe('本文\n');
  });

  /**
   * ⚠ **走は「先頭から」である** ── 本文が先に来て、あとから `key:` に見える行が
   *   出てくる文書は frontmatter ではない(水平線で始まる普通の文書)。
   */
  it('本文が先に来る文書は、frontmatter と読まない', () => {
    const src = '---\nこれは本文です\ntags: [あ]\n';
    expect(parseFrontmatter(src).warnings, '本文が先なのに壊れた情報と読んだ').toEqual([]);
    expect(spliceFrontmatterKeys(src, { status: 'done' }), '前置していない').toBe(
      `---\nstatus: done\n---\n${src}`,
    );
  });

  /**
   * 🔴 **対照群** ── `key:` の行が 1 つも無ければ**ただの水平線で始まる文書**なので、
   * これまでどおり前置する。⚠ 本文は byte 無傷のまま後続すること。
   */
  it('対照群: 水平線で始まる普通の文書は、これまでどおり前置する', () => {
    const src = '---\n\nこれは本文です\n';
    const out = spliceFrontmatterKeys(src, { status: 'done' });
    expect(out, '前置していない').toBe(`---\nstatus: done\n---\n${src}`);
    // ⚠ 本文は 1 バイトも変わらない(水平線もそのまま残る)
    expect(parseFrontmatter(out).body, '本文を書き換えた').toBe(src);
  });

  /** 対照群: 正規の frontmatter と、frontmatter が無い本文は今までどおり。 */
  it('対照群: 正規の形と、frontmatter が無い本文は変わらない', () => {
    expect(spliceFrontmatterKeys('---\ntags: [あ]\n---\n本文\n', { status: 'done' })).toBe(
      '---\ntags: [あ]\nstatus: done\n---\n本文\n',
    );
    expect(spliceFrontmatterKeys('本文だけ\n', { status: 'done' })).toBe(
      '---\nstatus: done\n---\n本文だけ\n',
    );
  });

  /**
   * ⚠ **CRLF の本文で行末記号を混ぜない** ── 補う閉じの行末は原文に合わせる。
   * 🔑 混ぜると、次に読んだとき閉じが見つからない形が生まれうる。
   */
  it('CRLF の本文でも、補う閉じの行末を混ぜない', () => {
    const out = spliceFrontmatterKeys('---\r\ntags: [あ]\r\n本文\r\n', { status: 'done' });
    expect(out, 'LF が混ざった').not.toMatch(/[^\r]\n---\n/);
    expect(parseFrontmatter(out).meta).toEqual({ tags: ['あ'], status: 'done' });
  });

  /**
   * 🔴 **警告と書き込みが、同じ 1 つの判定から出ている**(CLAUDE.md §7)。
   *
   * ⚠ 別々に数えると「**警告は出さないのに書込は壊す**」(あるいはその逆)が
   *   できる ── #318 はその食い違いそのものだった。
   * 🔑 だから**両方向で突き合わせる**:警告が出る形は必ず直され、
   *   警告が出ない形は必ず前置される。
   */
  it('🔴 「警告を出す形」と「閉じを補う形」が一致する', () => {
    const CASES = [
      '---\ntags: [あ]\n本文\n',
      '---\n\ntags: [あ]\n本文\n',
      '---\nこれは本文です\n',
      '---\n\nこれは本文です\n',
      '---\n\n12:30 に集合\n',
      '---\n| a | b |\n|---|---|\n',
    ];
    let warned = 0;
    for (const src of CASES) {
      const isBroken = parseFrontmatter(src).warnings.some((w) => w.kind === 'malformed');
      if (isBroken) warned += 1;
      const out = spliceFrontmatterKeys(src, { status: 'done' });
      // 前置したかどうか = 出力が `---\nstatus: done\n---\n` + 原文 か
      const prepended = out === `---\nstatus: done\n---\n${src}`;
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
    expect(frontmatterProblem('---\ntags: [あ]\n本文\n')).toContain('閉じの ---');
  });

  /**
   * 🔴 **既に二重 fence になっている本文も拾う**(#318 の「対で塞ぐもの」)。
   *
   * ⚠ #318 の直しは**これから壊れるのを止める**だけで、**既に壊れた本文は残る**。
   *   しかも二重 fence は 1 本目が正しく読めるので `warnings` が **0 件**になり、
   *   情報ペインは「タグ **無し**」と断定する ── いちばん壊れた状態で、
   *   いちばん安心させる形である。
   */
  it('🔴 既に二重 fence になっている本文も拾う', () => {
    // 直す前の書込が作っていた形をそのまま置く
    const broken = '---\nstatus: done\n---\n---\ntags: [あ]\n本文\n';
    // ⚠ 前提 ── 1 本目は読めてしまう(だから warnings では拾えない)
    const r = parseFrontmatter(broken);
    expect(r.found, '前提が崩れている').toBe(true);
    expect(r.warnings, '前提が崩れている(1 本目で警告が出ている)').toEqual([]);
    expect(r.meta, '前提が崩れている').toEqual({ status: 'done' });

    expect(frontmatterProblem(broken), '二重 fence を見逃した').toContain('2 本目');
  });

  it('🔴 読めている本文には理由を返さない(常在する警告を作らない)', () => {
    for (const ok of [
      '---\ntags: [あ]\n---\n本文\n',
      '本文だけ\n',
      '---\n本文\n', // ただの水平線
      '---\ntags: [あ]\n---\n\n---\n\n第 2 節\n', // 本文中の水平線
      '', // 空
    ]) {
      expect(frontmatterProblem(ok), `理由を作った: ${JSON.stringify(ok)}`).toBeNull();
    }
  });
});
