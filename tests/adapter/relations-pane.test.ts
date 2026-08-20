/** @vitest-environment happy-dom */
/**
 * 関係の導線(#185 段② / 台帳 #180 の A-7)── 情報ペインで**見る・作る・消す**。
 *
 * 🔴 守る主張:
 * 1. 親子(居場所)は**上の行**が出しているので、ここには出さない(2 か所に出さない)
 * 2. 相手は**押せる**(辿れないと一覧が行き止まりになる)
 * 3. **消すボタンが対で在る**(作れて消せないのは dead click の一種)
 * 4. 相手は題名で指す ── 見つからない / 曖昧なら**理由を言う**(無反応にしない)
 * 5. 候補は**出し切れないとき件数を書く**(黙って切らない)
 * 6. 関係が無いときは「無し」と書く(空欄は「不明」に見える)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import {
  InspectorRenderer,
  RELATION_CANDIDATE_MAX,
} from '../../src/adapter/ui/render/inspector';
import { bindActions } from '../../src/adapter/ui/actions/binder';

function meta(lid: string, title: string): EntryMeta {
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
  };
}

describe('関係の導線', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function mounted(metas: EntryMeta[]) {
    const relations: never[] = [];
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const inspector = new InspectorRenderer(regions.inspector);
    d.onState((s) => inspector.render(s));
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations });
    d.dispatch({ type: 'SELECT_ENTRY', lid: metas[0]!.lid });
    return { root, d };
  }

  const box = (root: HTMLElement) =>
    root.querySelector<HTMLElement>('[data-pkc-field="inspector-relations"]')!;

  it('関係が無いときは「無し」と書く(空欄は不明に見える)', () => {
    const { root } = mounted([meta('n1', 'あ'), meta('n2', 'い')]);
    expect(box(root).textContent).toBe('無し');
  });

  it('🔴 足すと一覧に出て、相手が押せて、消すボタンが対で在る', () => {
    const { root, d } = mounted([meta('n1', 'あ'), meta('n2', 'い')]);
    root.querySelector<HTMLInputElement>('[data-pkc-field="relation-target"]')!.value = 'い';
    root.querySelector<HTMLButtonElement>('[data-pkc-action="add-relation"]')!.click();

    expect(d.getState().relations, '関係が作られていない').toHaveLength(1);
    const item = box(root).querySelector('[data-pkc-field="inspector-relation"]');
    expect(item, '一覧に出ていない').not.toBeNull();
    expect(item!.textContent).toContain('関連');
    const go = item!.querySelector<HTMLButtonElement>('[data-pkc-field="relation-target-link"]')!;
    expect(go.textContent, '相手の題名が出ていない').toBe('い');
    expect(
      item!.querySelector('[data-pkc-action="remove-relation"]'),
      '消すボタンが無い(作れて消せない)',
    ).not.toBeNull();

    // 🔴 相手を押すと実際にそのノートへ移る
    go.click();
    expect(d.getState().selectedLid, '押しても移らない').toBe('n2');
  });

  it('🔴 消すと一覧から消え、state からも消える', () => {
    const { root, d } = mounted([meta('n1', 'あ'), meta('n2', 'い')]);
    root.querySelector<HTMLInputElement>('[data-pkc-field="relation-target"]')!.value = 'い';
    root.querySelector<HTMLButtonElement>('[data-pkc-action="add-relation"]')!.click();
    box(root).querySelector<HTMLButtonElement>('[data-pkc-action="remove-relation"]')!.click();
    expect(d.getState().relations).toHaveLength(0);
    expect(box(root).textContent).toBe('無し');
  });

  it('🔴 見つからない相手は理由を言う(押して無反応にしない)', () => {
    const { root, d } = mounted([meta('n1', 'あ'), meta('n2', 'い')]);
    root.querySelector<HTMLInputElement>('[data-pkc-field="relation-target"]')!.value = 'ない題名';
    root.querySelector<HTMLButtonElement>('[data-pkc-action="add-relation"]')!.click();
    expect(d.getState().error ?? '', '理由が出ていない').toContain('見つかりません');
    expect(d.getState().relations).toHaveLength(0);
  });

  it('🔴 同じ題名が複数あるときは勝手に選ばない', () => {
    const { root, d } = mounted([meta('n1', 'あ'), meta('n2', '同じ'), meta('n3', '同じ')]);
    root.querySelector<HTMLInputElement>('[data-pkc-field="relation-target"]')!.value = '同じ';
    root.querySelector<HTMLButtonElement>('[data-pkc-action="add-relation"]')!.click();
    expect(d.getState().error ?? '').toContain('2 件');
    expect(d.getState().relations).toHaveLength(0);
  });

  it('空欄で押しても黙らない', () => {
    const { root, d } = mounted([meta('n1', 'あ'), meta('n2', 'い')]);
    root.querySelector<HTMLButtonElement>('[data-pkc-action="add-relation"]')!.click();
    expect(d.getState().error ?? '').toContain('題名');
  });

  it('🔴 居場所(親子)はこの行に出ない(同じものを 2 か所に出さない)', () => {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const inspector = new InspectorRenderer(regions.inspector);
    d.onState((s) => inspector.render(s));
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      // ⚠ 居場所の解決は **archetype 'folder'** が条件(`getAncestorFolders`)
      metas: [meta('n1', 'あ'), { ...meta('f1', 'フォルダ'), archetype: 'folder' }],
      relations: [
        { id: 's1', fromLid: 'f1', toLid: 'n1', kind: 'structural', createdAt: null, updatedAt: null },
      ],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    expect(box(root).textContent, '居場所が関係の行にも出ている').toBe('無し');
    // ⚠ ただし「居場所」の行には出ている(消したのではない)
    expect(
      root.querySelector('[data-pkc-field="inspector-folder"]')?.textContent,
    ).toContain('フォルダ');
  });

  it('🔴 候補が多いときは件数を書く(黙って切らない)', () => {
    const many = Array.from({ length: RELATION_CANDIDATE_MAX + 5 }, (_, i) =>
      meta(`n${i}`, `t${i}`),
    );
    const { root } = mounted(many);
    const opts = [...root.querySelectorAll('#pkc-relation-candidates option')];
    expect(opts.length).toBe(RELATION_CANDIDATE_MAX + 1);
    expect(opts[opts.length - 1]!.getAttribute('value') ?? '').toContain('ほかに 4 件');
  });

  it('自分自身は候補に出ない(張れないものを見せない)', () => {
    const { root } = mounted([meta('n1', 'あ'), meta('n2', 'い')]);
    const values = [...root.querySelectorAll('#pkc-relation-candidates option')].map((o) =>
      o.getAttribute('value'),
    );
    expect(values).toEqual(['い']);
  });
});
