/**
 * 🔴 **本文のリンクを読む文法は 1 つ**(#186 段③ / #348)。
 *
 * ⚠ この file が守るのは「正しく拾える」だけではない ──
 * **出ていく側と入ってくる側が、同じ答えを出すこと**である(CLAUDE.md §7)。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import {
  bodyLinkNeedles,
  bodyLinkTargets,
  bodyLinksTo,
} from '../../src/features/entry-ref/body-links';

describe('本文が指しているノート', () => {
  it('出てきた順に、重複を畳んで返す', () => {
    const body = '[あ](entry:n2) と [い](entry:n3)、また [あ](entry:n2)';
    expect(bodyLinkTargets(body)).toEqual(['n2', 'n3']);
  });

  it('章へのリンクでも、繋がっている先はノートである', () => {
    expect(bodyLinkTargets('[章](entry:n2#log/a)')).toEqual(['n2']);
  });

  it('リンクが無ければ空', () => {
    expect(bodyLinkTargets('ただの本文。entry という語は出てくる')).toEqual([]);
  });

  /**
   * 🔴 **これが直したかった穴**。`LIKE '%entry:n1%'` は `entry:n12` の中に当たる。
   * ⚠ 過剰報告なので、出た物を誰も検算しない形で残る。
   */
  it('🔴 前置きが重なる lid を取り違えない(entry:n1 は entry:n12 ではない)', () => {
    expect(bodyLinkTargets('[長い](entry:n12)')).toEqual(['n12']);
    expect(bodyLinksTo('[長い](entry:n12)', 'n1')).toBe(false);
    // 対照群 ── 本物は当たる(「常に false」で通る実装を許さない)
    expect(bodyLinksTo('[短い](entry:n1)', 'n1')).toBe(true);
  });

  it('本文の末尾で終わっていても拾う(境界の片側だけ見ていない)', () => {
    expect(bodyLinksTo('末尾は [七](entry:n7)', 'n7')).toBe(true);
    // 🔴 リンクの形になっていない字は数えない(#1163 依頼 230)
    expect(bodyLinksTo('末尾は entry:n7', 'n7')).toBe(false);
  });

  it('lid の文字(A-Za-z0-9_-)は途中で切らない', () => {
    expect(bodyLinkTargets('[x](entry:ab_cd-12)')).toEqual(['ab_cd-12']);
  });

  /**
   * 🔑 **両方向が同じ答えを出す**(§7 の parity)。
   * ⚠ `bodyLinksTo` を「別の綴り」で書き直すと、同じ盲点を共有して
   *   一致してしまう ── だからここでは**総当たりの本文**を作り、
   *   「拾った先は必ず当たる / 拾わなかった先は当たらない」を両側から見る。
   */
  it('🔴 出ていく側と入ってくる側が食い違わない(総当たり)', () => {
    const lids = ['n1', 'n12', 'n1_2', 'n2', 'ab-1', 'ab-12'];
    const bodies = [
      '',
      '[x](entry:n1)',
      '[a](entry:n12) [b](entry:n1)',
      '[s](entry:n1#sec) と [t](entry:ab-12)',
      '[u](entry:n1_2) だけ',
      'entry と : は別々',
      '[x](entry:ab-1)[y](entry:n2)',
    ];
    let hits = 0;
    for (const body of bodies) {
      const found = new Set(bodyLinkTargets(body));
      for (const lid of lids) {
        expect(bodyLinksTo(body, lid), `${body} / ${lid}`).toBe(found.has(lid));
        if (found.has(lid)) hits += 1;
      }
    }
    // ⚠ **空振り防止** ── 1 件も当たらない corpus では、上の一致は何も言っていない
    expect(hits, '当たりが 1 件も無い(corpus が弱い)').toBeGreaterThanOrEqual(6);
  });
});

/**
 * 🔴 **同じ容れ物を指す形は 2 つある**(#379)。
 *
 * 描画側は `pkc://<自分>/entry/<lid>` を `entry:` と**同じ扱い**にしている
 * (押せば飛ぶ)。⚠ こちらが片方しか見ないと「リンクは効くのに参照元から消える」。
 */
describe('pkc:// の自分あても同じリンクとして読む (#379)', () => {
  const CID = 'c1';

  it('🔴 pkc://<自分>/entry/<lid> を拾う', () => {
    expect(bodyLinkTargets('[b へ](pkc://c1/entry/n2)', CID)).toEqual(['n2']);
    expect(bodyLinksTo('[b へ](pkc://c1/entry/n2)', 'n2', CID)).toBe(true);
  });

  it('🔴 別の容れ物あては拾わない(この容れ物に相手が居ない)', () => {
    expect(bodyLinkTargets('[よそ](pkc://c9/entry/n2)', CID)).toEqual([]);
    expect(bodyLinksTo('[よそ](pkc://c9/entry/n2)', 'n2', CID)).toBe(false);
  });

  it('⚠ cid を渡さなければ pkc:// は拾わない(対照群)', () => {
    expect(bodyLinkTargets('[b へ](pkc://c1/entry/n2)')).toEqual([]);
    // 対照群 ── entry: のほうは cid 無しでも拾う
    expect(bodyLinkTargets('[b へ](entry:n2)')).toEqual(['n2']);
  });

  it('添付あて(asset)はノートへの辺にしない', () => {
    expect(bodyLinkTargets('[添付](pkc://c1/asset/k1)', CID)).toEqual([]);
  });

  it('章あて(#fragment)でも、繋がる先はノートである', () => {
    expect(bodyLinkTargets('[章](pkc://c1/entry/n2#log/a)', CID)).toEqual(['n2']);
  });

  it('両方の形で同じ相手を指していても、1 件に畳む', () => {
    expect(bodyLinkTargets('[a](entry:n2) と [b](pkc://c1/entry/n2)', CID)).toEqual(['n2']);
  });

  it('🔴 前置きが重なる lid は、pkc:// 側でも取り違えない', () => {
    expect(bodyLinksTo('[長い](pkc://c1/entry/n12)', 'n1', CID)).toBe(false);
    expect(bodyLinksTo('[短い](pkc://c1/entry/n1)', 'n1', CID)).toBe(true);
  });

  /**
   * ⚠ cid は正規表現に埋めるので、記号が混じると**正規表現ごと壊れる**。
   * 🔑 保証(`permalink.ts` の TOKEN_RE)を当てにせず、ここで弾く。
   */
  it('⚠ 形の違う cid を渡されても壊れない(pkc:// は拾わないだけ)', () => {
    expect(() => bodyLinkTargets('[x](entry:n2)', 'a.*b')).not.toThrow();
    expect(bodyLinkTargets('[x](pkc://a.*b/entry/n2)', 'a.*b')).toEqual([]);
    // 対照群 ── entry: のほうは変わらず拾う(cid が変でも本文は読める)
    expect(bodyLinkTargets('[x](entry:n2)', 'a.*b')).toEqual(['n2']);
  });

  /**
   * 🔑 **絞り込みの字面と、拾う文法を揃える**(§7)。
   * ⚠ 片方だけ形を足すと、候補に挙がらない(取りこぼし)か、
   *   挙がって弾かれる(無駄)になる。
   */
  it('🔴 LIKE の字面が、拾える形を全部覆っている', () => {
    const needles = bodyLinkNeedles('n2', CID);
    // 末尾の 2 つは「宛先に変数を書いた形」の字面(依頼 271)── lid は前書きの値で決まるので、字面に居ない
    expect(needles).toEqual(['entry:n2', 'pkc://c1/entry/n2', 'entry:{{', 'pkc://c1/entry/{{']);
    for (const n of needles.filter((x) => !x.includes('{{'))) {
      const body = `前 [x](${n}) 後`;
      expect(bodyLinksTo(body, 'n2', CID), `${n} が拾えていない`).toBe(true);
    }
    // 変数の形は、前書きの値で展開して初めて拾える
    for (const n of needles.filter((x) => x.includes('{{'))) {
      const body = `---\nvars:\n  t: n2\n---\n前 [x](${n}vars.t}}) 後`;
      expect(bodyLinksTo(body, 'n2', CID), `${n} が拾えていない`).toBe(true);
    }
    // ⚠ cid が無ければ字面も絞る(絞り込みが広がりすぎない)
    expect(bodyLinkNeedles('n2')).toEqual(['entry:n2', 'entry:{{']);
  });
});

describe('🔴 コードの中・左の境界は参照元ではない(#1087)', () => {
  const CID = 'c1';
  it('フェンスの中の `entry:` は拾わない(外のリンクは拾う)', () => {
    const body = '```\n[x](entry:n2)\n```\n[y](entry:n3)';
    expect(bodyLinkTargets(body)).toEqual(['n3']);
    expect(bodyLinksTo(body, 'n2')).toBe(false);
    expect(bodyLinksTo(body, 'n3')).toBe(true);
  });
  it('閉じていないフェンスは末尾まで全部コード', () => {
    expect(bodyLinkTargets('本文\n```\n[a](entry:n2)')).toEqual([]);
  });
  it('行内コードの中は拾わない / 同じ行の外は拾う', () => {
    expect(bodyLinkTargets('`[a](entry:n2)` と [b](entry:n3)')).toEqual(['n3']);
  });
  it('コードの中の pkc:// の形も拾わない', () => {
    expect(bodyLinkTargets('`pkc://c1/entry/n2` と [a](pkc://c1/entry/n3)', CID)).toEqual(['n3']);
  });
  it('`xentry:n2` は `entry:` ではない / 区切りの後ろなら拾う', () => {
    expect(bodyLinkTargets('[a](xentry:n2) <a-entry:n4>')).toEqual([]);
    expect(bodyLinkTargets('[a](entry:n2) <entry:n3>')).toEqual(['n2', 'n3']);
  });
  it('表・引用・箇条書きの中のリンクは参照元である', () => {
    const body = '| a | b |\n|---|---|\n| [x](entry:n2) | y |\n\n> [q](entry:n3)\n\n- [l](entry:n4)';
    expect(bodyLinkTargets(body)).toEqual(['n2', 'n3', 'n4']);
  });
  it('~~~ のフェンスも同じ', () => {
    expect(bodyLinkTargets('~~~\n[a](entry:n2)\n~~~')).toEqual([]);
  });
});

/**
 * 🔴 **字下げ(4 スペース / タブ)のコードブロックの中は、リンクではない**(#1087)。
 * ⚠ 期待値は**描画が実際に何をリンクにしたか**から引く(本文の字面から組まない ── 実装と同じ盲点を共有する)。
 */
describe('🔴 csv / tsv / psv の囲みの中のリンクは表のセルなので、参照元に数える', () => {
  it('csv のセルの [x](entry:n1) は押せる ── 参照元にも数える', () => {
    const el = document.createElement('div');
    el.innerHTML = renderMarkdown('```csv\na,b\n[x](entry:n1),2\n```', { currentContainerId: 'c1' } as never);
    expect(el.querySelector('[data-pkc-entry-ref="entry:n1"]'), '前提: 描画ではリンクになる').not.toBeNull();
    expect(bodyLinkTargets('```csv\na,b\n[x](entry:n1),2\n```')).toEqual(['n1']);
    expect(bodyLinksTo('~~~tsv\n[x](entry:n1)\t2\n~~~', 'n1')).toBe(true);
    expect(bodyLinksTo('```psv noheader\n[x](entry:n1)|2\n```', 'n1')).toBe(true);
    expect(bodyLinksTo('```CSV\n[x](entry:n1),2\n```', 'n1')).toBe(true);
  });
  it('対照群: 表にならない囲み(js / csvx / -norender)と行内コードは従来どおり数えない', () => {
    expect(bodyLinksTo('```js\n[x](entry:n1)\n```', 'n1')).toBe(false);
    expect(bodyLinksTo('```csvx\n[x](entry:n1)\n```', 'n1')).toBe(false);
    expect(bodyLinksTo('```csv-norender\n[x](entry:n1)\n```', 'n1')).toBe(false);
    expect(bodyLinksTo('`[x](entry:n1)`', 'n1')).toBe(false);
  });
  it('csv の囲みが閉じた後ろのコードは、数えないまま', () => {
    expect(bodyLinkTargets('```csv\na,b\n```\n\n```\n[x](entry:n2)\n```')).toEqual([]);
  });
});

describe('字下げのコードブロック', () => {
  const rendered = (body: string): string[] =>
    [...renderMarkdown(body).matchAll(/data-pkc-entry-ref="entry:([^"#]+)/g)].map((m) => m[1]!);

  const CASES: Array<[string, string]> = [
    ['空行のあとの 4 スペースのコード', '段落\n\n    [a](entry:n2)\n\n[a](entry:n3)'],
    ['空行のあとのタブのコード', '段落\n\n\t[a](entry:n2)\n\n[a](entry:n3)'],
    ['文書の先頭からのコード', '    [a](entry:n2)\n\n[a](entry:n3)'],
    ['空行をはさんで続くコード', '段落\n\n    one\n\n    [a](entry:n2)\n\n[a](entry:n3)'],
  ];

  it.each(CASES)('🔴 %s は拾わない(描画もリンクにしない)', (_name, body) => {
    expect(rendered(body), '前提:描画はコード内をリンクにしない').toEqual(['n3']);
    expect(bodyLinkTargets(body)).toEqual(['n3']);
  });

  it('🔑 対照群: 段落の続きの字下げ行は、コードではなくリンクである', () => {
    const body = '段落\n    [a](entry:n2)\n';
    expect(rendered(body), '前提:描画はリンクにする').toEqual(['n2']);
    expect(bodyLinkTargets(body)).toEqual(['n2']);
  });

  it('🔑 対照群: 箇条書きの項目の続きの字下げ段落は、コードではなくリンクである', () => {
    const body = '- 項目\n\n    [a](entry:n2)\n';
    expect(rendered(body), '前提:描画はリンクにする').toEqual(['n2']);
    expect(bodyLinkTargets(body)).toEqual(['n2']);
  });

  it('箇条書きが終わったあとの字下げはコードに戻る', () => {
    const body = '- 項目\n\n本文\n\n    [a](entry:n2)\n';
    expect(rendered(body)).toEqual([]);
    expect(bodyLinkTargets(body)).toEqual([]);
  });
});

describe('綴りの大小(#1087)', () => {
  it('🔴 `Entry:n2` / `ENTRY:n3` も描画がリンクにするので、参照元に数える', () => {
    const body = '[a](Entry:n2) [b](ENTRY:n3)';
    const rendered = [...renderMarkdown(body).matchAll(/data-pkc-entry-ref="entry:([^"#]+)/g)].map((m) => m[1]);
    expect(rendered, '前提:描画が内部リンクにしていない').toEqual(['n2', 'n3']);
    expect(bodyLinkTargets(body)).toEqual(['n2', 'n3']);
  });
});

/**
 * 🔴 **数えるのは「画面でリンクとして出るもの」だけ**(#1163 依頼 178 / 230 / 271。Gemini の裁定)。
 * ⚠ 期待値は描画が実際にリンクにした lid から引く(本文の字面から組まない)。
 */
describe('🔴 リンクの形になっていない字・隠した囲みの中は数えない(依頼 178 / 230 / 271)', () => {
  const rendered = (body: string): string[] =>
    [...renderMarkdown(body).matchAll(/data-pkc-entry-ref="entry:([^"#]+)/g)].map((m) => m[1]!);

  const CASES: Array<[string, string, string[]]> = [
    ['字で書いただけの entry:n2(リンクの形ではない)', 'entry:n2 と [a](entry:n3)', ['n3']],
    ['行内の隠しメモ %% … %%', '%% [x](entry:n2) %% [a](entry:n3)', ['n3']],
    ['%%% の隠しメモ', '%%%\n[x](entry:n2)\n%%%\n[a](entry:n3)', ['n3']],
    [':::comment の中', ':::comment\n[x](entry:n2)\n:::\n[a](entry:n3)', ['n3']],
    ['Word だけの囲み(:::if{format=docx})の中', ':::if{format=docx}\n[x](entry:n2)\n:::\n[a](entry:n3)', ['n3']],
  ];
  it.each(CASES)('🔴 %s は数えない(描画もリンクにしない)', (_name, body, want) => {
    expect(rendered(body), '前提:描画がリンクにしたのは対照群だけ').toEqual(want);
    expect(bodyLinkTargets(body)).toEqual(want);
  });

  it('🔑 対照群: 画面に出る囲み(:::if{format=html} / :::note)の中のリンクは数える', () => {
    const body = ':::if{format=html}\n[x](entry:n2)\n:::\n:::note\n[y](entry:n3)\n:::';
    expect(rendered(body), '前提:描画はリンクにする').toEqual(['n2', 'n3']);
    expect(bodyLinkTargets(body)).toEqual(['n2', 'n3']);
  });

  it('🔑 対照群: 参照形式の定義行・画像形・山括弧の宛先は、画面でリンク(か埋め込み)になるので数える', () => {
    expect(bodyLinkTargets('[x][r]\n\n[r]: entry:n2')).toEqual(['n2']);
    expect(bodyLinkTargets('![図](entry:n3)')).toEqual(['n3']);
    expect(bodyLinkTargets('<entry:n4>')).toEqual(['n4']);
    expect(rendered('<entry:n4>'), '前提:山括弧の宛先は描画でリンクになる').toEqual(['n4']);
  });

  it('隠しメモが閉じていないとき、閉じのある対照群と区別できる(閉じた後ろは数える)', () => {
    expect(bodyLinkTargets('%%%\n[x](entry:n2)\n%%%\n[a](entry:n3)')).toEqual(['n3']);
    expect(bodyLinkTargets('[a](entry:n3)\n[b](entry:n2) %% 後ろだけ隠す %%')).toEqual(['n3', 'n2']);
  });
});

describe('台帳 #1852 束 R1(依頼 271): 画面でリンクとして見える物だけを参照元に数える', () => {
  it('数式の中の `entry:` は数えない(外のリンクは数える)', () => {
    expect(bodyLinkTargets('式 $a [x](entry:n2) b$ と [y](entry:n3)')).toEqual(['n3']);
    expect(bodyLinkTargets('$$\n[x](entry:n2)\n$$\n[y](entry:n3)')).toEqual(['n3']);
  });

  it('対照群: 数式にならない `$`(通貨など)は数式扱いしない', () => {
    expect(bodyLinkTargets('[x](entry:n2) は $5 です。[y](entry:n3) は $6 です')).toEqual(['n2', 'n3']);
    // 閉じの無い `$$` は塊ではない
    expect(bodyLinkTargets('$$\n[x](entry:n2)')).toEqual(['n2']);
  });

  it('宛先に変数を書いた `[x](entry:{{vars.t}})` は、前書きの値で数える', () => {
    const body = '---\nvars:\n  t: n2\n---\n[x](entry:{{vars.t}})';
    expect(bodyLinkTargets(body)).toEqual(['n2']);
    expect(bodyLinksTo(body, 'n2')).toBe(true);
    // 未定義の名前は数えない
    expect(bodyLinkTargets('[x](entry:{{vars.nope}})')).toEqual([]);
  });

  it('既に入っている物の対照群: 隠しメモ・画面以外向けの囲み・リンクの形でない `entry:lid` は数えない', () => {
    expect(bodyLinkTargets('%% [x](entry:n2) %%')).toEqual([]);
    expect(bodyLinkTargets('%%%\n[x](entry:n2)\n%%%')).toEqual([]);
    expect(bodyLinkTargets(':::if{format=docx}\n[x](entry:n2)\n:::')).toEqual([]);
    expect(bodyLinkTargets('entry:n2 とただ書いた')).toEqual([]);
  });
});
