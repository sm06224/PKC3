/** @vitest-environment happy-dom */
/**
 * 🔴 **つながりの図**(#186 / A-6)── 情報ペインに出る側。
 *
 * ⚠ 見るのは 5 つ:①**押せる**(図が行き止まりにならない)②居場所は出さない
 * ③相手が居なければ**行ごと畳む** ④切ったら**言う** ⑤辺は**装飾**(押すのは節点だけ)。
 */
import { describe, expect, it } from 'vitest';
import { BODY_LINK_KIND, renderRelationMap } from '../../src/adapter/ui/render/relation-map';

const titles = (...lids: string[]): Map<string, string> =>
  new Map(lids.map((l) => [l, `題:${l}`]));

function box(): HTMLElement {
  const el = document.createElement('div');
  document.body.append(el);
  return el;
}

describe('つながりの図', () => {
  it('🔴 節点は押せる(既存の select-entry の規約に乗る)', () => {
    const el = box();
    const n = renderRelationMap(el, {
      center: 'a',
      depth: 1,
      edges: [{ fromLid: 'a', toLid: 'b', kind: 'semantic' }],
      titles: titles('a', 'b'),
    });
    expect(n).toBe(2);
    const btns = [...el.querySelectorAll('button')];
    expect(btns).toHaveLength(2);
    for (const b of btns) {
      // ⚠ **既存の規約**(`select-entry` は `data-pkc-entry` を読む)── ここで
      //    別名を作ると、押しても動かない導線になる
      expect(b.getAttribute('data-pkc-action'), '押せない節点が在る').toBe('select-entry');
      expect(b.getAttribute('data-pkc-entry')).toBeTruthy();
    }
    expect(el.querySelector('[data-pkc-field="relation-map-center"]')?.textContent).toBe('題:a');
  });

  it('🔴 相手が居なければ何も出さない(点 1 つを図と呼ばない)', () => {
    const el = box();
    const n = renderRelationMap(el, { center: 'a', depth: 1, edges: [], titles: titles('a') });
    expect(n).toBe(0);
    expect(el.textContent, '中心だけで図を組んだ').toBe('');
  });

  /**
   * 🔴 **辺は装飾**(押すのは節点だけ)── 線の上で節点が押せなくなると、
   * 図の真ん中あたりが**押せない場所**になる。
   */
  it('🔴 線は当たり判定を持たない', () => {
    const el = box();
    renderRelationMap(el, {
      center: 'a',
      depth: 1,
      edges: [{ fromLid: 'a', toLid: 'b', kind: 'semantic' }],
      titles: titles('a', 'b'),
    });
    const svg = el.querySelector('[data-pkc-field="relation-map-edges"]') as SVGElement | null;
    expect(svg, '辺の器が無い').toBeTruthy();
    expect((svg as unknown as HTMLElement).style.pointerEvents).toBe('none');
    expect(el.querySelectorAll('[data-pkc-field="relation-map-edge"]')).toHaveLength(1);
  });

  it('🔴 切ったら件数を出す(黙って切らない)', () => {
    const el = box();
    const many = Array.from({ length: 40 }, (_, i) => ({
      fromLid: 'a',
      toLid: `n${i}`,
      kind: 'semantic',
    }));
    renderRelationMap(el, {
      center: 'a',
      depth: 1,
      edges: many,
      titles: titles('a', ...many.map((m) => m.toLid)),
    });
    const more = el.querySelector('[data-pkc-field="relation-map-truncated"]');
    expect(more, '切ったのに黙っている').toBeTruthy();
    expect(more?.textContent).toContain('件までにしています');
  });

  it('収まるときは「多い」と言わない(空振り防止)', () => {
    const el = box();
    renderRelationMap(el, {
      center: 'a',
      depth: 1,
      edges: [{ fromLid: 'a', toLid: 'b', kind: 'semantic' }],
      titles: titles('a', 'b'),
    });
    expect(el.querySelector('[data-pkc-field="relation-map-truncated"]')).toBe(null);
  });

  /**
   * ⚠ **図だけにしない** ── 線に字は書けない(狭い列で潰れる)ので、
   * 種類の内訳を添える。user に `semantic` と見せないこと。
   */
  it('🔴 種類の内訳を、user の言葉で添える', () => {
    const el = box();
    renderRelationMap(el, {
      center: 'a',
      depth: 1,
      edges: [
        { fromLid: 'a', toLid: 'b', kind: 'semantic' },
        { fromLid: 'a', toLid: 'c', kind: 'provenance' },
      ],
      titles: titles('a', 'b', 'c'),
    });
    const legend = el.querySelector('[data-pkc-field="relation-map-legend"]');
    expect(legend?.textContent, '内訳が無い').toContain('関連');
    expect(legend?.textContent).toContain('出典');
    expect(legend?.textContent, '内部の綴りが漏れている').not.toContain('semantic');
  });

  /**
   * 🔴 **本文のリンクは、関係と見分けが付かなければならない**(段③)。
   *
   * ⚠ 見分けが付かないと「張った覚えのない関係がある」と読まれる。
   * 🔑 分けるのは**破線**であって色ではない ── 色だけで意味を分けると
   *   無彩色のテーマと色覚の違いで読めなくなる。
   */
  it('🔴 本文のリンクは破線で、凡例も user の言葉で出る', () => {
    const el = box();
    renderRelationMap(el, {
      center: 'a',
      depth: 1,
      edges: [
        { fromLid: 'a', toLid: 'b', kind: 'semantic' },
        { fromLid: 'a', toLid: 'c', kind: BODY_LINK_KIND },
      ],
      titles: titles('a', 'b', 'c'),
    });
    const lines = [...el.querySelectorAll('[data-pkc-field="relation-map-edge"]')];
    expect(lines).toHaveLength(2);
    const byKind = new Map(
      lines.map((l) => [l.getAttribute('data-pkc-relation-kind'), l.getAttribute('stroke-dasharray')]),
    );
    expect(byKind.get(BODY_LINK_KIND), '本文のリンクが実線で描かれている').toBeTruthy();
    // 対照群 ── 関係は実線のまま(「全部破線」で通る実装を許さない)
    expect(byKind.get('semantic'), '関係まで破線になっている').toBe(null);
    const legend = el.querySelector('[data-pkc-field="relation-map-legend"]');
    expect(legend?.textContent, '凡例に本文のリンクが無い').toContain('本文のリンク');
    expect(legend?.textContent, '内部の綴りが漏れている').not.toContain(BODY_LINK_KIND);
  });

  it('組み直しで前の図が残らない', () => {
    const el = box();
    renderRelationMap(el, {
      center: 'a',
      depth: 1,
      edges: [{ fromLid: 'a', toLid: 'b', kind: 'semantic' }],
      titles: titles('a', 'b'),
    });
    renderRelationMap(el, {
      center: 'x',
      depth: 1,
      edges: [{ fromLid: 'x', toLid: 'y', kind: 'semantic' }],
      titles: titles('x', 'y'),
    });
    expect(el.textContent, '前の図が残っている').not.toContain('題:b');
    expect(el.querySelectorAll('button')).toHaveLength(2);
  });
});
