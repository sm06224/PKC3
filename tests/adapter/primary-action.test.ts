/** @vitest-environment happy-dom */
/**
 * 🔴 **その面の「主の操作」は 1 つだけ**(#722 P2-10。user 裁定 2026-09-06 = 案 A)。
 *
 * ## なぜ要るか
 *
 * cowork 実測 2026-09-05:「1440px の 1 画面に押せるボタンが **50 個**、うち
 * **23 個が完全に同じ見た目**。濃い地を持つのは『いま選んでいるタブ』の 1 個だけ」──
 * **どれを押せば話が進むのかが画面から読めない**、が実害だった。
 *
 * ## 守る主張
 *
 * 1. 🔴 **左の列(一覧)の主は「+ ノート」1 つ**
 * 2. 🔴 **読む面の主は「編集」1 つ** ── 編集に入ったら**「保存」へ移る**
 *    (⚠ 増えるのではなく**移る** ── 2 つになった瞬間に段が消える)
 * 3. 🔴 **同じ `commit-edit` でも、追記欄の側には印を付けない**
 *    (中央と追記欄の 2 か所に出る ── 両方濃くすると「1 面 1 つ」が崩れる)
 * 4. ⚠ **印を付ける口は 1 つだけ**(`icons.ts` の `markPrimary`)── 属性を直に
 *    書かれると、上の全数検査が数え落とす
 *
 * ⚠ **空振り防止**:同じ面に**普通のボタンが何個も在る**ことを見る ── 1 個しか
 *   出ていない面で「主は 1 つ」は自明に成り立つ。
 * ⚠ 見え方そのもの(地と字が反転しているか)は CSS なので**実ブラウザにしか無い**
 *   ── `tests/smoke/primary-action.smoke.spec.ts` が見る。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { AppendBoxRenderer } from '../../src/adapter/ui/render/append-box';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

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

beforeEach(() => {
  document.body.textContent = '';
});

/** 面を組んで、状態を送れる口を返す。 */
function mount(): { root: HTMLElement; d: Dispatcher } {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  const box = new AppendBoxRenderer(regions.append);
  d.onState((s) => {
    detail.render(s);
    box.render(s);
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 'あ')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文\n' });
  return { root, d };
}

/** その面に**見えている**主の操作の action(押せる物だけ)。 */
function primariesIn(root: HTMLElement, region: string): string[] {
  const host = root.querySelector(`[data-pkc-region="${region}"]`);
  if (host === null) throw new Error(`前提が崩れている: 面 ${region} が無い`);
  return [...host.querySelectorAll<HTMLButtonElement>('button[data-pkc-primary]')]
    .filter((b) => b.closest('[hidden]') === null)
    .map((b) => b.getAttribute('data-pkc-action') ?? '');
}

/** その面に見えている普通のボタンの数(空振り防止に使う)。 */
function plainCount(root: HTMLElement, region: string): number {
  const host = root.querySelector(`[data-pkc-region="${region}"]`);
  if (host === null) throw new Error(`前提が崩れている: 面 ${region} が無い`);
  return [...host.querySelectorAll<HTMLButtonElement>('button:not([data-pkc-primary])')].filter(
    (b) => b.closest('[hidden]') === null,
  ).length;
}

describe('主の操作は面ごとに 1 つ(#722 P2-10)', () => {
  it('🔴 一覧の主は「+ ノート」1 つだけ', () => {
    const { root } = mount();
    // ⚠ 空振り防止 ── 同じ列に普通のボタンが何個も在ってこそ「1 つ」が意味を持つ
    expect(plainCount(root, 'sidebar'), '左の列にボタンが少なすぎる(何も判定していない)').toBeGreaterThan(3);
    expect(primariesIn(root, 'sidebar')).toEqual(['create-entry']);
  });

  it('🔴 読む面の主は「編集」1 つだけ', () => {
    const { root } = mount();
    expect(plainCount(root, 'detail'), '読む面にボタンが少なすぎる(何も判定していない)').toBeGreaterThan(2);
    expect(primariesIn(root, 'detail')).toEqual(['start-edit']);
  });

  it('🔴 編集に入ると、主は「保存」へ**移る**(増えない)', () => {
    const { root, d } = mount();
    d.dispatch({ type: 'START_EDIT' });
    // 前提:編集の帯が出ている(出ていなければ以下は空振り)
    expect(
      root.querySelector('[data-pkc-region="detail"] button[data-pkc-action="commit-edit"]'),
      '前提が崩れている: 編集の帯が出ていない',
    ).not.toBeNull();
    expect(primariesIn(root, 'detail')).toEqual(['commit-edit']);
  });

  it('🔴 追記欄の「保存」には印を付けない(同じ action でも 2 つ濃くしない)', () => {
    const { root, d } = mount();
    d.dispatch({ type: 'START_EDIT' });
    // 前提:追記欄が編集中の出口を出している(#716 の約束)
    expect(
      root.querySelector<HTMLElement>('[data-pkc-field="append-lock"]')!.hidden,
      '前提が崩れている: 追記欄が編集中の帯を出していない',
    ).toBe(false);
    expect(primariesIn(root, 'append')).toEqual([]);
    // ⚠ 対照群 ── 追記欄にも `commit-edit` は在る(在るのに印だけ無い、を見る)
    expect(
      root.querySelector('[data-pkc-region="append"] button[data-pkc-action="commit-edit"]'),
      '前提が崩れている: 追記欄に保存が無い',
    ).not.toBeNull();
  });

  it('🔴 画面ぜんぶで、主の操作は 2 つを超えない(左の列 + 中央)', () => {
    const { root, d } = mount();
    const count = (): number => root.querySelectorAll('button[data-pkc-primary]').length;
    expect(count(), '読んでいるとき、主が多すぎる').toBe(2);
    d.dispatch({ type: 'START_EDIT' });
    expect(count(), '編集中、主が多すぎる').toBe(2);
  });

  it('🔴 印を付ける口は markPrimary だけ(属性を直に書かない)', () => {
    const bad: string[] = [];
    for (const file of walk('src')) {
      if (file.endsWith(join('ui', 'render', 'icons.ts'))) continue;
      const text = readFileSync(file, 'utf-8');
      // ⚠ コメントの中の言及は拾わない ── 実行する行だけを見る
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      if (code.includes('data-pkc-primary')) bad.push(file);
    }
    expect(bad, '印を直に書いている file がある(全数検査が数え落とす)').toEqual([]);
    // ⚠ 空振り防止 ── icons.ts の側には在ること
    expect(
      readFileSync('src/adapter/ui/render/icons.ts', 'utf-8'),
      '印の定義が icons.ts から消えた',
    ).toContain('data-pkc-primary');
  });
});
