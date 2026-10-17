/** @vitest-environment happy-dom */
/**
 * 🔴 **同じ題名のノートが 2 件あっても、つながりを足す相手を見分けて選べる**(Gemini 裁定 = #1163 の依頼 45 の 3、#1657)。
 *
 * 直す前は、候補の一覧に同じ字が並ぶだけで、足すときは「題名を分けてから足してください」で止まった。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { relationTargetLabel, resolveRelationTarget } from '../../src/features/relation/target-label';

function meta(lid: string, title: string, extra: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
    ...extra,
  };
}

const IN = (id: string, from: string, to: string): Relation => ({
  id,
  fromLid: from,
  toLid: to,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});

const METAS = [
  meta('n1', '自分'),
  meta('f1', '週次', { archetype: 'folder' }),
  meta('f2', '月次', { archetype: 'folder' }),
  meta('x1', '会議メモ', { updatedAt: '2026-10-13T03:00:00.000Z' }),
  meta('x2', '会議メモ', { updatedAt: '2026-09-01T03:00:00.000Z' }),
];
const RELS = [IN('s1', 'f1', 'x1'), IN('s2', 'f2', 'x2')];

describe('候補の見分け(純粋な部分)', () => {
  it('🔴 同じ題名はフォルダの名前つきで 1 件に決まる。題名だけでは決めない', () => {
    const label = relationTargetLabel('会議メモ', '週次', METAS[3]!.updatedAt);
    const m = new Map(METAS.map((x) => [x.lid, x]));
    expect(resolveRelationTarget('会議メモ', m, RELS, 'n1')).toEqual({ kind: 'ambiguous', count: 2 });
    expect(resolveRelationTarget(label, m, RELS, 'n1')).toEqual({ kind: 'hit', lid: 'x1' });
    expect(resolveRelationTarget(relationTargetLabel('会議メモ', '月次', METAS[4]!.updatedAt), m, RELS, 'n1')).toEqual({
      kind: 'hit',
      lid: 'x2',
    });
  });

  it('同じフォルダ・同じ更新日で見分けがつかないときは、勝手に選ばず止まる', () => {
    const metas = new Map(
      [meta('n1', '自分'), meta('y1', '同'), meta('y2', '同')].map((x) => [x.lid, x]),
    );
    const label = relationTargetLabel('同', null, null);
    expect(resolveRelationTarget(label, metas, [], 'n1')).toEqual({ kind: 'ambiguous', count: 2 });
  });

  it('対照群:題名が 1 件だけなら今までどおり題名で決まり、無ければ none、自分だけなら self', () => {
    const m = new Map(METAS.map((x) => [x.lid, x]));
    expect(resolveRelationTarget('週次', m, RELS, 'n1')).toEqual({ kind: 'hit', lid: 'f1' });
    expect(resolveRelationTarget('無い', m, RELS, 'n1')).toEqual({ kind: 'none' });
    expect(resolveRelationTarget('自分', m, RELS, 'n1')).toEqual({ kind: 'self' });
  });
});

describe('情報ペインの候補と「つながりを足す」', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function mounted() {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const inspector = new InspectorRenderer(regions.inspector);
    d.onState((s) => inspector.render(s));
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    return { root, d };
  }

  it('🔴 同じ題名の候補だけ、フォルダの名前と更新日が添わる。1 件だけの題名はそのまま', () => {
    const { root } = mounted();
    root.querySelector<HTMLInputElement>('[data-pkc-field="relation-target"]')!.focus();
    const values = [...root.querySelectorAll('#pkc-relation-candidates option')].map((o) => o.getAttribute('value'));
    expect(values, '同じ字が 2 つ並んでいる').not.toContain('会議メモ');
    expect(values).toContain(relationTargetLabel('会議メモ', '週次', METAS[3]!.updatedAt));
    expect(values).toContain(relationTargetLabel('会議メモ', '月次', METAS[4]!.updatedAt));
    expect(values, '1 件だけの題名に余計な字が付いた').toContain('週次');
  });

  it('🔴 候補で選んだ字なら、選んだノートへつながる', () => {
    const { root, d } = mounted();
    root.querySelector<HTMLInputElement>('[data-pkc-field="relation-target"]')!.value =
      relationTargetLabel('会議メモ', '月次', METAS[4]!.updatedAt);
    root.querySelector<HTMLButtonElement>('[data-pkc-action="add-relation"]')!.click();
    expect(d.getState().error ?? '', '足せていない').toBe('');
    const added = d.getState().relations.filter((r) => r.kind !== 'structural');
    expect(added).toHaveLength(1);
    expect(added[0]!.toLid, '選んだのと別のノートへつながった').toBe('x2');
  });

  it('対照群:題名だけで打ったときは今までどおり止まり、候補を選ぶよう言う', () => {
    const { root, d } = mounted();
    root.querySelector<HTMLInputElement>('[data-pkc-field="relation-target"]')!.value = '会議メモ';
    root.querySelector<HTMLButtonElement>('[data-pkc-action="add-relation"]')!.click();
    expect(d.getState().error ?? '').toContain('2 件');
    expect(d.getState().error ?? '').toContain('候補');
    expect(d.getState().relations.filter((r) => r.kind !== 'structural')).toHaveLength(0);
  });
});
