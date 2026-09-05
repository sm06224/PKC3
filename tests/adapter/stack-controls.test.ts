/** @vitest-environment happy-dom */
/**
 * 🔴 **保存したスタックの中を、読む面から並べ替える**(#633 段④)── 「上へ / 下へ」。
 *
 * 見るのは 3 つ:①押し所がリンク行にだけ生え、**原文の行番号**を持つ(frontmatter ぶんを足す)
 * ②端は押せない(押しても何も起きない口を出さない)③押すと `MOVE_STACK_LINK` が飛び、
 * reducer が `REQUEST_BODY_REWRITE`(`link-move`)へ落とす ── 編集中は理由を言う。
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { applyStackControls, STACK_MOVE_FIELD } from '../../src/adapter/ui/render/stack-controls';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { stackBody } from '../../src/features/flavor/stack-flavor';

function meta(lid: string, title: string, archetype = 'text'): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: 0,
  };
}

const BODY = stackBody([
  { title: '議事録', lid: 'a' },
  { title: '資料 B', lid: 'b' },
  { title: '去年の稟議', lid: 'c' },
]);

/** 本文を実物の描画で器へ入れる(`sourceLineAnchors` は読む面と同じ)。 */
function paint(body: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(body, { sourceLineAnchors: true });
  document.body.append(host);
  return host;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('押し所を当てる(applyStackControls)', () => {
  it('🔴 リンク行の全部に ↑↓ が生え、原文の行番号(frontmatter ぶんを足した値)を持つ', () => {
    const host = paint(BODY);
    // ⚠ 前提: 実物の描画が箇条書きの行に行番号を焼いている(焼いていなければ空振り)
    expect(host.querySelectorAll('li[data-pkc-source-line]').length, '前提が崩れている').toBe(3);
    const n = applyStackControls(host, 3); // frontmatter が 3 行あった、として
    expect(n).toBe(3);
    const ups = [...host.querySelectorAll<HTMLButtonElement>('[data-pkc-action="stack-link-up"]')];
    const downs = [...host.querySelectorAll<HTMLButtonElement>('[data-pkc-action="stack-link-down"]')];
    expect(ups.map((b) => b.getAttribute('data-pkc-line'))).toEqual(['3', '4', '5']);
    expect(downs.map((b) => b.getAttribute('data-pkc-line'))).toEqual(['3', '4', '5']);
    // ② 端は押せない
    expect(ups.map((b) => b.disabled)).toEqual([true, false, false]);
    expect(downs.map((b) => b.disabled)).toEqual([false, false, true]);
  });

  it('⚠ 冪等 ── 2 度当てても押し所は増えない(描き直しのたびに呼ぶため)', () => {
    const host = paint(BODY);
    applyStackControls(host, 0);
    applyStackControls(host, 0);
    expect(host.querySelectorAll(`[data-pkc-field="${STACK_MOVE_FIELD}"]`)).toHaveLength(3);
  });

  it('⚠ リンクでない箇条書きには生えない(対照群)', () => {
    const host = paint('- ただの項目\n- [外のリンク](https://example.com)\n- [中](entry:x)\n');
    expect(applyStackControls(host, 0)).toBe(1);
    expect(host.querySelectorAll(`[data-pkc-field="${STACK_MOVE_FIELD}"]`)).toHaveLength(1);
  });
});

/**
 * 🔴 **読む面の実物の描画経路で生えるか**(`detail.ts` の配線)。
 * ⚠ `applyStackControls` 単体の test は「当てれば生える」しか言えない ── 呼び忘れ /
 *   種類の門の取り違えは、実物の `CenterRouter` で描いて初めて見える。
 */
describe('読む面の配線(detail.ts)', () => {
  async function settle(): Promise<void> {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  }
  function bootView() {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-region', 'detail');
    document.body.append(root);
    const center = new CenterRouter(root, undefined, null, undefined, undefined);
    const d = new Dispatcher();
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('s', '今週の束', 'stack'), meta('a', '議事録'), meta('t', 'リンク集')] as never,
      relations: [],
    });
    d.onState((st) => center.render(st));
    return { root, d };
  }

  it('🔴 スタックの入れ物を開くと各行に ↑↓ が生え、普通のノートの同じ本文には生えない(対照群)', async () => {
    const { root, d } = bootView();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 's' });
    d.dispatch({ type: 'BODY_LOADED', lid: 's', body: BODY });
    await settle();
    expect(
      root.querySelectorAll(`[data-pkc-field="detail-body"] [data-pkc-field="${STACK_MOVE_FIELD}"]`),
      '入れ物の行に押し所が生えていない(detail.ts の配線が切れている)',
    ).toHaveLength(3);
    // 対照群: 同じ本文でも普通のノートには生えない
    d.dispatch({ type: 'SELECT_ENTRY', lid: 't' });
    d.dispatch({ type: 'BODY_LOADED', lid: 't', body: BODY });
    await settle();
    expect(root.querySelectorAll(`[data-pkc-field="${STACK_MOVE_FIELD}"]`)).toHaveLength(0);
  });
});

describe('MOVE_STACK_LINK(reducer)', () => {
  function booted(): Dispatcher {
    const d = new Dispatcher();
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('s', '今週の束', 'stack'), meta('a', '議事録')] as never,
      relations: [],
    });
    return d;
  }

  it('🔴 押した時点の行を添えて REQUEST_BODY_REWRITE(link-move)へ落とす', () => {
    const d = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 's' });
    d.dispatch({ type: 'BODY_LOADED', lid: 's', body: BODY });
    const seen: unknown[] = [];
    const off = d.onEvent((e) => seen.push(e));
    d.dispatch({ type: 'MOVE_STACK_LINK', lid: 's', line: 0, dir: 'down' });
    off();
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: 'REQUEST_BODY_REWRITE',
        lid: 's',
        rewrite: { kind: 'link-move', line: 0, openLine: '- [議事録](entry:a)', dir: 'down' },
      }),
    );
  });

  it('🔴 編集中は声に出して断る / 入れ物でないノートには効かない', () => {
    const d = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 's' });
    d.dispatch({ type: 'BODY_LOADED', lid: 's', body: BODY });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '前提: 編集に入った').toBe('editing');
    d.dispatch({ type: 'MOVE_STACK_LINK', lid: 's', line: 0, dir: 'down' });
    expect(d.getState().error).toContain('並べ替え');
    const e = booted();
    e.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    e.dispatch({ type: 'BODY_LOADED', lid: 'a', body: BODY });
    const before = e.getState();
    const leaked: unknown[] = [];
    const stop = e.onEvent((ev) => leaked.push(ev));
    e.dispatch({ type: 'MOVE_STACK_LINK', lid: 'a', line: 0, dir: 'down' });
    stop();
    expect(e.getState()).toBe(before);
    // ⚠ state が同じでも event は飛びうる(`bodyRewriteGate`(旧 `placeRewrite`)は state を変えずに event を返す)──
    //   種類の門を外しても state だけ見ていると緑のまま(変異試験 M6 が教えた)
    expect(leaked.filter((ev) => (ev as { type: string }).type === 'REQUEST_BODY_REWRITE')).toEqual([]);
  });
});

describe('受け手(binder)', () => {
  it('🔴 押した所から lid と原文の行を引いて MOVE_STACK_LINK を撃つ(横の枠の身元も拾う)', () => {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    buildShell(root);
    const d = new Dispatcher();
    const sent: Dispatchable[] = [];
    const raw = d.dispatch.bind(d);
    d.dispatch = ((a: Dispatchable) => {
      sent.push(a);
      return raw(a);
    }) as typeof d.dispatch;
    bindActions(root, d);
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('s', '今週の束', 'stack'), meta('a', '議事録')] as never,
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    // 横の枠に入れ物が出ている形 ── 主は a、枠は s
    const frame = document.createElement('div');
    frame.setAttribute('data-pkc-split-lid', 's');
    frame.innerHTML = '<ul><li data-pkc-source-line="0"><a href="entry:a">議事録</a></li><li data-pkc-source-line="1"><a href="entry:b">B</a></li></ul>';
    root.append(frame);
    applyStackControls(frame, 2);
    sent.length = 0;
    frame.querySelector<HTMLButtonElement>('[data-pkc-action="stack-link-down"]')!.click();
    expect(sent).toContainEqual({ type: 'MOVE_STACK_LINK', lid: 's', line: 2, dir: 'down' });
  });
});

/**
 * 🔴 **↑↓ は本文を書くので、忙しい間の門(`BODY_WRITE_ACTIONS`)に載っている。**
 * ⚠ `tests/repo-hygiene.test.ts` の機械的な数え上げは、reducer の case 本文に
 *   `type: 'REQUEST_BODY_REWRITE'` の字面が在るものしか拾わない ── `MOVE_STACK_LINK` は
 *   `bodyRewriteGate()`(旧 `placeRewrite`)へ委ねるので**その門をすり抜ける**(変異試験 M7 が SURVIVED で教えた)。
 *   ここは名指しの pin で埋める(数え上げを `bodyRewriteGate(` まで広げると、既存の板の操作
 *   3 つが同じ漏れで赤くなる ── それは別件として報告した)。
 */
describe('忙しい間の門', () => {
  it('🔴 stack-link-up / stack-link-down が BODY_WRITE_ACTIONS に載っている', () => {
    const binder = readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8');
    const gate = /const BODY_WRITE_ACTIONS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)/.exec(binder)?.[1];
    expect(gate, '門の一覧を読めていない(空振り)').toBeDefined();
    const names = [...gate!.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
    expect(names).toContain('stack-link-up');
    expect(names).toContain('stack-link-down');
  });
});
