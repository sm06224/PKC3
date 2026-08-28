/**
 * 🔴 **囲みの中身を添付から取る**(#444 段①。user 裁定 2026-08-26
 * 「**HTML に限らずにフェンス内にアセットを呼び込むようにすればいいのでは?**」)。
 *
 * 守る主張:
 * 1. **見出しの読み方**(1 つだけ / 語順に依らない / 書いてあるのに使えないなら理由)
 * 2. 🔴 **どの言語でも効く** ── html 専用の口を作らない
 * 3. 🔴 **誰も埋めなかったときに読める字が出る** ── 書き出した HTML には
 *    hydrator が居ないので、ここが空だと「持ち出したら中身が消える」になる
 * 4. 🔴 **描き方の規則は 1 本** ── 添付から取った字も、本文に書いた字と
 *    **同じ HTML** になる(parity)
 */
import { humanBytes } from '../../src/features/human-bytes';
import { describe, expect, it } from 'vitest';
import {
  FENCE_ASSET_PREFIX,
  takeFenceAsset,
} from '../../src/features/markdown/fence-asset';
import type { SourceRange } from '../../src/features/markdown/markdown-render';
import {
  collectFenceAssetKeys,
  renderFenceFromAsset,
  renderMarkdown,
} from '../../src/features/markdown/markdown-render';

describe('見出しから添付を読む', () => {
  it('1 つ書いてあれば取れて、残りの語は残る', () => {
    expect(takeFenceAsset(' asset:ast-k1')).toEqual({ kind: 'one', key: 'ast-k1', rest: '' });
    expect(takeFenceAsset(' noheader asset:ast-k1')).toEqual({
      kind: 'one',
      key: 'ast-k1',
      rest: 'noheader',
    });
  });

  it('🔴 語順に依らない(user に順番を覚えさせない)', () => {
    expect(takeFenceAsset(' asset:ast-k1 noheader')).toEqual(
      takeFenceAsset(' noheader asset:ast-k1'),
    );
  });

  it('書いていなければ `none`(ふつうの囲みとして描く)', () => {
    expect(takeFenceAsset('')).toEqual({ kind: 'none' });
    expect(takeFenceAsset(' noheader')).toEqual({ kind: 'none' });
  });

  it('🔴 2 つ書いてあったら**勝手に片方を選ばない**(理由を返す)', () => {
    const r = takeFenceAsset(' asset:a asset:b');
    expect(r.kind).toBe('invalid');
    expect(r.kind === 'invalid' && r.why).toContain('2 つ');
  });

  it('🔴 鍵が空なら理由を返す(黙ってふつうの囲みに落とさない)', () => {
    const r = takeFenceAsset(' asset:');
    expect(r.kind).toBe('invalid');
    expect(r.kind === 'invalid' && r.why).toContain('空');
  });

  it('印は本文の `![](asset:…)` と同じ綴り(2 つ目の書き方を作らない)', () => {
    expect(FENCE_ASSET_PREFIX).toBe('asset:');
  });

  it('大きさは読める字になる', () => {
    expect(humanBytes(512)).toBe('512 B');
    expect(humanBytes(2048)).toBe('2.0 KB');
    expect(humanBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});

describe('本文に書いたときの器(#444 段①)', () => {
  const html = (md: string): string => renderMarkdown(md);

  it('🔴 どの言語でも器になる(html 専用ではない)', () => {
    for (const lang of ['html', 'mermaid', 'chart', 'csv', 'tsv', 'psv', 'js', 'python']) {
      const out = html('```' + lang + ' asset:ast-k1\n```');
      expect(out, `${lang} が器にならない`).toContain('data-pkc-fence-asset-key="ast-k1"');
      // ⚠ 見出しの語は**そのまま**運ぶ(hydrator が読み直す)
      expect(out).toContain(`data-pkc-fence-asset-info="${lang}"`);
    }
  });

  it('🔴 誰も埋めなかったときに読める字が出る(書き出しで中身が消えない)', () => {
    const out = html('```csv asset:ast-k1\n```');
    expect(out, '空の器を出している').toContain('この囲みの中身は添付');
    expect(out, 'どの添付かが分からない').toContain('ast-k1');
  });

  it('⚠ 囲みに書いた字は**控え**として残る(黙って捨てない)', () => {
    const out = html('```csv asset:ast-k1\nあ,い\n```');
    expect(out).toContain('data-pkc-fence-asset-fallback');
    expect(out).toContain('あ,い');
  });

  it('🔴 使えない書き方は理由が出る(黙ってふつうの囲みに落とさない)', () => {
    const out = html('```csv asset:a asset:b\n```');
    expect(out).toContain('data-pkc-fence-asset-error');
    expect(out).toContain('2 つ');
    expect(out, '器として扱ってしまっている').not.toContain('data-pkc-fence-asset-key');
  });

  it('⚠ `asset:` を書いていない囲みは 1 バイトも変わらない', () => {
    const before = html('```csv\nあ,い\n```');
    expect(before).not.toContain('fence-asset');
    expect(before).toContain('<table');
  });

  it('🔴 言語を書かない ` ```asset:鍵 ` も記法である(先頭語でも読む)', () => {
    const out = renderMarkdown('```asset:ast-k1\n控え\n```');
    expect(out).toContain('data-pkc-fence-asset-key="ast-k1"');
    // ⚠ 直す前はここが `class="language-asset:ast-k1"` の素のコード囲みだった
    //    ── **黙って落ちる**形である(段② の一致検査が落ちて教えた)
    expect(out).not.toContain('language-asset');
  });

  it('⚠ 言語の前に書いても後ろに書いても同じ(語順に依らないのは先頭語も同じ)', () => {
    expect(renderMarkdown('```asset:ast-k1 csv\n控え\n```')).toBe(
      renderMarkdown('```csv asset:ast-k1\n控え\n```'),
    );
  });

  it('🔴 コードフェンスの中に書いた `asset:` は記法ではない(字である)', () => {
    // ⚠ 囲みの**中身**に `asset:` が在っても、見出しではないので器にしない
    const out = html('```js\nconst x = "asset:ast-k1";\n```');
    expect(out).not.toContain('data-pkc-fence-asset-key');
  });

  it('鍵は属性として escape される(`"` を書かれても壊れない)', () => {
    const out = html('```js asset:a"b\n```');
    expect(out).toContain('data-pkc-fence-asset-key="a&quot;b"');
  });
});

/**
 * 🔴 **描き方の規則は 1 本**(CLAUDE.md §7)。
 *
 * ⚠ hydrator は本文の rule とは別の口(`renderFenceFromAsset`)を通るので、
 *   **片方だけ古くなる**形が生えうる。ここがその機械的な突合である。
 * 🔑 比べるのは**本文に直接書いたときの HTML** ── 中身が同じなら 1 バイトも
 *   違ってはいけない(`data-pkc-source-line` は本文側にしか無いので、
 *   その属性を持たない形で比べる)。
 */
describe('添付から取った字は、本文に書いたのと同じ HTML になる', () => {
  const cases: ReadonlyArray<{ info: string; content: string }> = [
    { info: 'csv', content: 'あ,い\n1,2' },
    { info: 'csv noheader', content: 'あ,い\n1,2' },
    { info: 'tsv', content: 'あ\tい\n1\t2' },
    { info: 'psv', content: 'あ|い\n1|2' },
    { info: 'csv-norender', content: 'あ,い' },
    { info: 'mermaid', content: 'graph TD;A-->B;' },
    { info: 'html', content: '<p>ほん</p>' },
    { info: 'js', content: 'const x = 1;' },
    { info: 'python', content: 'x = 1' },
    // ⚠ 言語を書かない囲みも通す(`class="language-"` を出さないこと)
    { info: '', content: 'ただの字' },
  ];

  it('🔴 末尾に改行が無い添付でも一致する(画面と書き出しで 1 バイトずれない)', () => {
    // ⚠ 実際の添付は改行で終わっているとは限らない ── markdown-it の囲みの中身は
    //    必ず改行で終わるので、揃えないと**画面だけ**最後の 1 バイトがずれる
    expect(renderFenceFromAsset('js', 'const x = 1;').trim()).toBe(
      renderMarkdown('```js\nconst x = 1;\n```').trim(),
    );
  });

  for (const c of cases) {
    it(`「${c.info || '(言語なし)'}」が一致する`, () => {
      const direct = renderMarkdown('```' + c.info + '\n' + c.content + '\n```');
      const viaAsset = renderFenceFromAsset(c.info, c.content + '\n');
      // 空振り防止 ── 本文側が本当に囲みを描いている
      expect(direct, '本文側が囲みを描いていない').toContain('pkc-md-block');
      expect(viaAsset.trim()).toBe(direct.trim());
    });
  }
});

/**
 * 🔴 **同じ囲みを 2 つ書いても、切替の id が衝突しない**(着地前の自己レビュー)。
 *
 * ⚠ `-both`(既定)は `<input id>` + `<label for>` の対で「ソース / レンダリング」を
 *   切り替える。id は「**同じ(言語, 中身)の中で何番目か**」から作るので、
 *   その数を憶える object を囲みごとに作り直すと**常に 0 番目**になり、
 *   **片方の `‹/›` を押すともう片方が開く**。
 * 🔑 本文の経路(`renderMarkdown`)は 1 回の描画で env を 1 つ作って共有している ──
 *   ここもそれに揃っていることを機械で見る。
 */
describe('切替の id は、同じ囲みが 2 つあっても衝突しない', () => {
  /** 切替の `<input id>` を出てくる順に拾う。 */
  const ids = (html: string): string[] =>
    [...html.matchAll(/<input type="checkbox" id="([^"]+)"/g)].map((m) => m[1]!);

  it('本文に直接書いたときは、2 つの id が違う(対照群)', () => {
    const out = renderMarkdown('```csv\nあ,い\n```\n\n```csv\nあ,い\n```');
    const got = ids(out);
    expect(got, '前提: 切替が 2 つ出ていない').toHaveLength(2);
    expect(new Set(got).size, '本文の経路で既に衝突している').toBe(2);
  });

  it('🔴 添付から埋めるときも、同じ object を使えば衝突しない', () => {
    const env = {};
    const out =
      renderFenceFromAsset('csv', 'あ,い\n', env) + renderFenceFromAsset('csv', 'あ,い\n', env);
    const got = ids(out);
    expect(got, '前提: 切替が 2 つ出ていない').toHaveLength(2);
    expect(new Set(got).size, '同じ id を 2 つ出している(押すと隣が開く)').toBe(2);
  });

  it('⚠ 別の object を渡すと衝突する ── だから 1 回に 1 つを使い回す', () => {
    const out = renderFenceFromAsset('csv', 'あ,い\n', {}) + renderFenceFromAsset('csv', 'あ,い\n', {});
    expect(new Set(ids(out)).size, 'この前提が崩れたら上の 2 件は何も守っていない').toBe(1);
  });
});

/**
 * 🔴 **書き出しのときは、その場で焼き込む**(#444 段②)。
 *
 * 配った HTML / Word には hydrator が居ないので、器のままだと
 * 「持ち出したら中身が消える」になる ── 呼び手が字を渡していれば、
 * **本文に書いてあったのと同じ HTML** が出る。
 *
 * 🔑 比べる相手は**本文に直接書いた描画**である ── 実装の綴りを写した
 *   期待値ではなく、**もう 1 本の実際の経路**の出力(CLAUDE.md §1
 *   「期待値は別の綴りではなく別の観測から作る」)。
 */
describe('渡された字は、その場で焼き込まれる(#444 段②)', () => {
  const cases: ReadonlyArray<{ info: string; content: string }> = [
    { info: 'csv', content: 'あ,い\n1,2' },
    { info: 'csv noheader', content: 'あ,い\n1,2' },
    { info: 'mermaid', content: 'graph TD;A-->B;' },
    { info: 'html', content: '<p>ほん</p>' },
    { info: 'js', content: 'const x = 1;' },
    { info: '', content: 'ただの字' },
  ];

  for (const c of cases) {
    it(`「${c.info || '(言語なし)'}」が、本文に書いたのと同じ HTML になる`, () => {
      const direct = renderMarkdown(`\`\`\`${c.info}\n${c.content}\n\`\`\``);
      const first = c.info.split(/\s+/)[0] ?? '';
      const restWords = c.info.slice(first.length).trim();
      const header = `${first} asset:ast-k1${restWords === '' ? '' : ` ${restWords}`}`;
      const baked = renderMarkdown(`\`\`\`${header}\n控え\n\`\`\``, {
        fenceAssets: { 'ast-k1': c.content },
      });
      expect(direct, '前提: 本文側が囲みを描いていない').toContain('pkc-md-block');
      expect(baked).toBe(direct);
    });
  }

  it('🔴 渡さなければ器のまま(対照群 ── 上の一致は「常に同じ」ではない)', () => {
    const held = renderMarkdown('```csv asset:ast-k1\n控え\n```');
    expect(held).toContain('data-pkc-fence-asset-pending');
    expect(held).not.toContain('pkc-md-table');
  });

  it('🔴 鍵が渡された束に無ければ器のまま(空で焼かない)', () => {
    const out = renderMarkdown('```csv asset:ast-k1\n控え\n```', {
      fenceAssets: { 'ast-other': 'あ,い' },
    });
    expect(out).toContain('data-pkc-fence-asset-pending');
  });

  it('⚠ 書き方が使えない囲みは、字を渡されても理由が出る', () => {
    const out = renderMarkdown('```csv asset:a asset:b\n控え\n```', {
      fenceAssets: { a: 'あ,い', b: 'う,え' },
    });
    expect(out).toContain('data-pkc-fence-asset-error');
  });

  it('🔴 末尾に改行が無い添付でも、本文に書いたのと 1 バイトも違わない', () => {
    const direct = renderMarkdown('```js\nconst x = 1;\n```');
    const baked = renderMarkdown('```js asset:ast-k1\n控え\n```', {
      fenceAssets: { 'ast-k1': 'const x = 1;' },
    });
    expect(baked).toBe(direct);
  });

  it('⚠ 焼き込んだ後も token は元のまま ── 別の面が添付の字を本文と誤認しない', () => {
    const ranges: SourceRange[] = [];
    const src = '```js asset:ast-k1\n控え\n```';
    renderMarkdown(src, { fenceAssets: { 'ast-k1': '焼いた字' }, collectRanges: ranges });
    expect(ranges.length, '前提: 対応表が 1 件も採れていない').toBeGreaterThan(0);
    // 🔑 対応表は**原文**の範囲である ── 焼いた字の長さで採られていたら、
    //    書き出しの後に本文の別の行を指す
    for (const r of ranges) expect(r.end).toBeLessThanOrEqual(src.length);
  });

  it('🔴 同じ添付を 2 つの囲みが指しても、切替の id が衝突しない', () => {
    const out = renderMarkdown(
      '```csv asset:ast-k1\n控え\n```\n\n```csv asset:ast-k1\n控え\n```',
      { fenceAssets: { 'ast-k1': 'あ,い' } },
    );
    const got = [...out.matchAll(/<input type="checkbox" id="([^"]+)"/g)].map((m) => m[1]!);
    expect(got, '前提: 切替が 2 つ出ていない').toHaveLength(2);
    expect(new Set(got).size, '同じ id を 2 つ出している(押すと隣が開く)').toBe(2);
  });
});

/**
 * 🔴 **どの添付を読むかを数え上げる**(#444 段②)。
 *
 * 書き出し側は「本文が指している鍵**だけ**」を字にする ── 全添付を読むと
 * ゼロコピーの積み上げ(不可侵指示 2026-07-27)が崩れる。
 * ⚠ 判定は描く側と**同じ関数**を通る(読み手を 2 つにしない)。
 */
describe('本文が指している添付の鍵を数え上げる(#444 段②)', () => {
  it('囲みの見出しから拾う', () => {
    expect(collectFenceAssetKeys('```csv asset:ast-k1\n控え\n```')).toEqual(['ast-k1']);
  });

  it('🔴 引用・リストの中の囲みも拾う(自前の正規表現なら落とす所)', () => {
    expect(collectFenceAssetKeys('> ```csv asset:ast-q\n> 控え\n> ```')).toEqual(['ast-q']);
    expect(collectFenceAssetKeys('- ```csv asset:ast-l\n  控え\n  ```')).toEqual(['ast-l']);
  });

  it('⚠ `~~~` の囲みも拾う', () => {
    expect(collectFenceAssetKeys('~~~csv asset:ast-t\n控え\n~~~')).toEqual(['ast-t']);
  });

  it('🔴 同じ鍵は 1 回だけ(読みを重ねない)', () => {
    expect(
      collectFenceAssetKeys('```csv asset:ast-k1\nx\n```\n\n```js asset:ast-k1\ny\n```'),
    ).toEqual(['ast-k1']);
  });

  it('🔴 本文に出てくるだけの `asset:` は数えない(囲みの見出しだけ)', () => {
    expect(collectFenceAssetKeys('ここに asset:ast-k1 と書いただけ')).toEqual([]);
    expect(collectFenceAssetKeys('![](asset:ast-k1)')).toEqual([]);
  });

  it('⚠ 使えない書き方は読まない(描く側がその場で理由を出す)', () => {
    expect(collectFenceAssetKeys('```csv asset:a asset:b\nx\n```')).toEqual([]);
    expect(collectFenceAssetKeys('```csv asset:\nx\n```')).toEqual([]);
  });

  it('印が 1 つも無い本文は、markdown を読まずに空を返す', () => {
    expect(collectFenceAssetKeys('ふつうの本文')).toEqual([]);
  });
});
