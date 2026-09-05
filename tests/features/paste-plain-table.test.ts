/** @vitest-environment happy-dom */
/**
 * 🔴 **タブ区切りの平文を貼ったら表になる**(#708 段③)。
 *
 * ## ⚠ この段の前提は、途中で 1 度ひっくり返っている
 *
 * #708 の本文には「**Excel から貼っても表にならない**」と書いてあったが、
 * 2026-09-05 に読み直したら**誤り**だった ── Excel / Google スプレッドシートは
 * `text/html` に `<table>` を載せるので、既定の設定なら**いまでも markdown の表**に
 * なる(`convertPastedHtml` → `gfmTable`。`tests/features/html-to-markdown.test.ts`
 * が pin している)。
 *
 * 🔑 だから残っていた穴は「**タブ区切りの平文しか届かないとき**」だけである ──
 * 端末・`.tsv` の中身・チャットのコードブロックからのコピーがそれに当たる。
 * ⚠ 主張の範囲がここまで狭いことを書いておかないと、次に読む人が
 * 「Excel の貼付を守っている検査」だと誤読する(そして本物の穴を塞ぎ直す)。
 */
import { describe, expect, it } from 'vitest';
import { tsvFenceFromPlain } from '../../src/features/markdown/table-convert';
import {
  choosePaste,
  describePaste,
  type PasteConverters,
} from '../../src/features/markdown/paste-source';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

/** 描いた表の升(⚠ **実物の読み手**で見る ── 字面の一致では「表になった」と言えない)。 */
function grid(md: string): string[][] {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(md, {});
  const t = host.querySelector('table');
  return t === null
    ? []
    : [...t.querySelectorAll('tr')].map((tr) =>
        [...tr.children].map((c) => (c.textContent ?? '').trim()),
      );
}

const NONE: PasteConverters = {
  permalink: () => null,
  html: () => null,
  htmlFence: () => null,
  rtf: () => null,
  plainTable: () => null,
};

describe('タブ区切りの平文を表にする(#708 段③)', () => {
  describe('表と決めてよい条件', () => {
    it('🔴 2 行以上・どの行もタブの数が同じ・タブが 1 つ以上 なら組む', () => {
      const out = tsvFenceFromPlain('品名\t数\nりんご\t3\nみかん\t12\n');
      expect(out, '組んでいない').not.toBeNull();
      // 🔑 観測点は**描いた表**(囲みの字面ではなく、user が見る物)
      expect(grid(out!), '表として描かれていない').toEqual([
        ['品名', '数'],
        ['りんご', '3'],
        ['みかん', '12'],
      ]);
    });

    /**
     * ⚠ 断る側を**条件ごとに 1 つずつ**置く(CLAUDE.md §1「門を N 個置いたら
     *   N 個目だけが鳴る場面を N 通り作る」)── まとめて 1 本にすると、
     *   条件を 1 つ落としても別の条件が救って落ち続ける。
     */
    it.each([
      ['1 行しかない', 'a\tb\n'],
      ['タブが 1 つも無い', 'あいうえお\nかきくけこ\n'],
      ['行によってタブの数が違う', 'a\tb\nc\td\te\n'],
      ['途中に空行がある(列数が揃わない)', 'a\tb\n\nc\td\n'],
      ['空', ''],
    ])('⚠ %s ときは組まない(勝手に囲みへ入れない)', (_name, plain) => {
      expect(tsvFenceFromPlain(plain), '表ではない字を囲みに入れた').toBeNull();
    });

    it('⚠ 末尾の空行は数えない(コピーの最後の改行で断らない)', () => {
      expect(tsvFenceFromPlain('a\tb\nc\td\n\n\n'), '末尾の改行だけで断った').not.toBeNull();
    });

    /**
     * 🔴 **柵は中身より 1 本長くする** ── 升の字が ``` で始まると、囲みが
     *   **そこで閉じて**貼った字が本文へこぼれる(`convertTable` と同じ罠)。
     * 🔑 綴りは 1 か所(`fenceMarkerFor`)から借りているので、ここでは
     *   **結果が壊れていないこと**を実物の読み手で見る。
     */
    it('🔴 升の字が ``` でも、囲みが途中で閉じない', () => {
      /**
       * ⚠ **「柵で始まる」だけでは足りない**(変異試験 N5 が SURVIVED で教えた)──
       *   閉じとして読まれるのは「**柵のあと空白と tab しか無い行**」なので、
       *   `柵\t\`\`\`` のように**後ろに字が付く**形では、柵を伸ばさない実装でも
       *   囲みは閉じない = この検査は何も見ていなかった。
       * 🔑 だから **1 列目が柵そのもの**で、2 列目が空の行を台にする。
       */
      const out = tsvFenceFromPlain('```\t\nあ\tい\n')!;
      expect(grid(out), '囲みが途中で閉じて表が壊れた').toEqual([
        ['```', ''],
        ['あ', 'い'],
      ]);
      /**
       * ⚠ **行頭に空白が付いた柵でも閉じる**(変異試験 M17 が SURVIVED で教えた)──
       *   閉じの柵は 3 個までの字下げを許すので、`fenceMarkerFor` の `^\s*` を
       *   落とすと**この形だけ**囲みが途中で閉じ、1 行目が丸ごと消える。
       */
      const indented = tsvFenceFromPlain('  ```\t\nあ\tい\n')!;
      // ⚠ `grid()` は升の字を trim するので、行頭の空白は落ちる(閉じていないことが要点)
      expect(grid(indented), '字下げした柵で囲みが閉じた').toEqual([
        ['```', ''],
        ['あ', 'い'],
      ]);
    });

    /**
     * 🔴 **貼った字が、そのまま升に出る**(着地前レビュー 🔴1。**行が消えていた**)。
     *
     * ⚠ 直す前は逃がさずに囲みへ入れていたので、読み手(`parseCsv` = RFC4180)と
     *   描く側(`'` を剥がし `=` を式として評価する)に食われていた。実測:
     *   `太郎⇥5" ディスク` の**次の行ごと 1 升に飲まれて消えた**。
     * 🔑 観測点は**描いた升**(囲みの字面ではなく、user が見る物)。
     */
    it.each([
      ['引用符が奇数個 ── 次の行を飲み込まない', '名前\t寸法\n太郎\t5" ディスク\n次郎\tok\n', [['名前', '寸法'], ['太郎', '5" ディスク'], ['次郎', 'ok']]],
      ['先頭の = ── 式として計算されない', '=1+1\tx\nあ\tい\n', [['=1+1', 'x'], ['あ', 'い']]],
      ["先頭の ' ── 消えない", "'quoted\tx\nあ\tい\n", [["'quoted", 'x'], ['あ', 'い']]],
    ])('🔴 %s', (_name, plain, want) => {
      const out = tsvFenceFromPlain(plain);
      expect(out, '組んでいない(前提が崩れている)').not.toBeNull();
      expect(grid(out!), '貼った字と升が違う').toEqual(want);
    });

    /**
     * 🔴 **タブ字下げのコードは表ではない**(着地前レビュー ⚠3)。
     * ⚠ 「タブの数が同じ」だけだと Makefile のレシピや Go / C の 2 行が
     *   「1 列目が空の表」になる ── 貼ったら知らない表になった、を作らない。
     */
    it('🔴 行頭のタブは列ではなく字下げ(コードを表にしない)', () => {
      expect(tsvFenceFromPlain('\tif (x) {\n\treturn;\n'), '字下げを表にした').toBeNull();
      // 対照群 ── 1 列目に字が在れば、いままでどおり表になる
      expect(tsvFenceFromPlain('a\tif (x) {\nb\treturn;\n')).not.toBeNull();
    });

    /**
     * 🔴 **markdown の原文は原文のまま**(着地前レビュー ⚠4)。
     * ⚠ `convertPastedHtml` は「平文が markdown に見えるならわざと降りる」ので、
     *   その `null` を最後の手が拾うと**マニュアルの約束を上書きする**。
     */
    it.each([['見出し', '## 見出し\tA\n本文\tB\n'], ['箇条書き', '- 項目\tA\n- 項目\tB\n'], ['表', '| a | b |\tx\n| c | d |\ty\n']])(
      '🔴 %s で始まる行が在れば組まない(原文のまま入れる)',
      (_n, plain) => {
        expect(tsvFenceFromPlain(plain), 'markdown の原文を囲みへ入れた').toBeNull();
      },
    );

    it('⚠ CRLF でも同じに読む(Windows からのコピー)', () => {
      const out = tsvFenceFromPlain('a\tb\r\nc\td\r\n')!;
      expect(grid(out)).toEqual([
        ['a', 'b'],
        ['c', 'd'],
      ]);
      /**
       * ⚠ **升の一致だけでは、正規化を守っていない**(変異試験 M3 が SURVIVED で
       *   教えた)── `parseCsv` が自分で `\r\n?` を潰すので、こちらが正規化を
       *   落としても升は揃う(§1「救い手が変わっただけ」)。
       * 🔑 だから**本文に `\r` を残していないこと**を直接見る。
       */
      expect(out, '本文に CR が残っている').not.toContain('\r');
      /**
       * ⚠ **`\r` だけの改行(古い Mac)も 2 行と数える** ── `/\r\n?/` は
       *   単独の `\r` にも当たるので、正規化を外すと**1 行と数えて組まなくなる**。
       *   🔑 こちらが「正規化が効いている」ことの本当の観測点である。
       */
      expect(grid(tsvFenceFromPlain('a\tb\rc\td\r')!), 'CR だけの改行を読めていない').toEqual([
        ['a', 'b'],
        ['c', 'd'],
      ]);
    });

    /**
     * 🔴 **1 行目は見出しになる**(変異試験 M2 が SURVIVED で教えた)。
     * ⚠ `grid()` は `th` と `td` を区別しないので、`noheader` を付ける変異が
     *   生き延びていた ── **どちらを既定にするか**は user に見える選択なので、
     *   いまの選択を等値で pin しておく(変えるなら、この検査が落ちて気づく)。
     */
    it('🔴 貼った表の 1 行目は見出しになる(いまの既定を pin する)', () => {
      const host = document.createElement('div');
      host.innerHTML = renderMarkdown(tsvFenceFromPlain('品名\t数\nりんご\t3\n')!, {});
      expect(host.querySelectorAll('th').length, '見出しの升が無い').toBe(2);
      expect(host.querySelectorAll('td').length, '中身の升が無い').toBe(2);
    });
  });

  describe('いつ使うか(choosePaste の順番)', () => {
    const sizes = (plain: number, html = 0, rtf = 0) => ({ html, rtf, plain });
    const withTable: PasteConverters = { ...NONE, plainTable: () => '```tsv\na\tb\n```' };

    it('🔴 HTML も RTF も使えなかったときだけ使う(最後の手)', () => {
      const r = choosePaste({ source: 'auto', sizes: sizes(10), convert: withTable });
      expect(r.attempt.used, '最後の手が使われていない').toBe('plain-table');
      expect(r.text, '組んだ字が返っていない').toContain('tsv');
    });

    /**
     * 🔴 **HTML のほうが必ず忠実なので、先に当てない**(Excel からの貼付を
     *   わざわざ粗い形へ落とさない)。
     * ⚠ 対照群を同じ it に置く ── 置かないと「HTML が在っても表になった」を
     *   次に見抜けない。
     */
    it('🔴 HTML が使えるなら、そちらが勝つ', () => {
      const r = choosePaste({
        source: 'auto',
        sizes: sizes(10, 500),
        convert: { ...withTable, html: () => '| a | b |\n| --- | --- |' },
      });
      expect(r.attempt.used, 'HTML を差し置いてタブ区切りを使った').toBe('html');
    });

    /**
     * ⚠ **「ウェブページの形だけ」「リッチテキストを優先」でも組む**(着地前レビュー ⚠5)。
     * 🔑 この 2 つは**どのリッチな形を読むか**の設定なので、平文の扱いは変えない ──
     *   マニュアルにもそう書いてある。⚠ 変えるなら user に見える字が変わるので、
     *   いまの選択をここで pin する。
     */
    it.each([['html'], ['rtf']] as const)('⚠ 設定「%s」でも、平文が表になる', (source) => {
      const r = choosePaste({ source, sizes: sizes(10), convert: withTable });
      expect(r.attempt.used).toBe('plain-table');
    });

    it('🔴 設定「変換しない」では組まない(設定の字が嘘になる)', () => {
      const r = choosePaste({ source: 'plain', sizes: sizes(10), convert: withTable });
      expect(r.attempt.used).toBe('plain');
      expect(r.text, '「変換しない」なのに組んだ').toBeNull();
    });

    it('⚠ 設定「ウェブページの形をそのまま」でも組まない(そのまま残す設定である)', () => {
      const r = choosePaste({ source: 'html-fence', sizes: sizes(10), convert: withTable });
      expect(r.attempt.used).toBe('plain');
      expect(r.text, 'そのまま残す設定なのに組んだ').toBeNull();
    });

    it('⚠ タブ区切りでなければ、いままでどおり素の貼付に任せる', () => {
      const r = choosePaste({ source: 'auto', sizes: sizes(10), convert: NONE });
      expect(r.attempt.used).toBe('plain');
      expect(r.text).toBeNull();
    });

    /**
     * 🔴 **見送った理由が残る**(着地前レビュー ⚠6)。
     * ⚠ `paste.inspect` を点けても「そのままの文字を使いました」としか出ないと、
     *   **3 条件のどれで外れたか**が読めない ── この file の上の註記どおり、
     *   切替だけだと当てずっぽうになる。
     */
    it('🔴 組まなかった理由が、フラグの 1 行に出る', () => {
      const r = choosePaste({ source: 'auto', sizes: sizes(10), convert: NONE });
      const line = describePaste(r.attempt);
      expect(line, '見送った理由が出ていない').toContain('タブ');
      // ⚠ 名前も出る(変異試験 M13 ── 呼び名を空にしても緑だった)
      expect(line, '見送った物の呼び名が出ていない').toContain('タブ区切りの表');
      // 対照群 ── 平文が 1 文字も届いていない回は、言うことが無いので積まない
      const none = choosePaste({ source: 'auto', sizes: sizes(0), convert: NONE });
      expect(describePaste(none.attempt), '何も届いていないのに理由を出した').not.toContain(
        'タブ区切りの表',
      );
    });
  });
});
