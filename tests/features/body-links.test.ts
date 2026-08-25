/**
 * 🔴 **本文のリンクを読む文法は 1 つ**(#186 段③ / #348)。
 *
 * ⚠ この file が守るのは「正しく拾える」だけではない ──
 * **出ていく側と入ってくる側が、同じ答えを出すこと**である(CLAUDE.md §7)。
 */
import { describe, expect, it } from 'vitest';
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
    expect(bodyLinksTo('末尾は entry:n7', 'n7')).toBe(true);
  });

  it('lid の文字(A-Za-z0-9_-)は途中で切らない', () => {
    expect(bodyLinkTargets('entry:ab_cd-12')).toEqual(['ab_cd-12']);
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
      'entry:n1',
      '[a](entry:n12) [b](entry:n1)',
      'entry:n1#sec と entry:ab-12',
      'entry:n1_2 だけ',
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
    expect(bodyLinkTargets('entry:n2 と pkc://c1/entry/n2', CID)).toEqual(['n2']);
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
    expect(() => bodyLinkTargets('entry:n2', 'a.*b')).not.toThrow();
    expect(bodyLinkTargets('[x](pkc://a.*b/entry/n2)', 'a.*b')).toEqual([]);
    // 対照群 ── entry: のほうは変わらず拾う(cid が変でも本文は読める)
    expect(bodyLinkTargets('entry:n2', 'a.*b')).toEqual(['n2']);
  });

  /**
   * 🔑 **絞り込みの字面と、拾う文法を揃える**(§7)。
   * ⚠ 片方だけ形を足すと、候補に挙がらない(取りこぼし)か、
   *   挙がって弾かれる(無駄)になる。
   */
  it('🔴 LIKE の字面が、拾える形を全部覆っている', () => {
    const needles = bodyLinkNeedles('n2', CID);
    expect(needles).toEqual(['entry:n2', 'pkc://c1/entry/n2']);
    for (const n of needles) {
      const body = `前 ${n} 後`;
      expect(bodyLinksTo(body, 'n2', CID), `${n} が拾えていない`).toBe(true);
    }
    // ⚠ cid が無ければ字面も 1 つ(絞り込みが広がりすぎない)
    expect(bodyLinkNeedles('n2')).toEqual(['entry:n2']);
  });
});
