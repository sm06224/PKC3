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
import { choosePaste, type PasteConverters } from '../../src/features/markdown/paste-source';
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
    });

    it('⚠ CRLF でも同じに読む(Windows からのコピー)', () => {
      expect(grid(tsvFenceFromPlain('a\tb\r\nc\td\r\n')!)).toEqual([
        ['a', 'b'],
        ['c', 'd'],
      ]);
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
  });
});
