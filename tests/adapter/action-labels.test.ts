/** @vitest-environment happy-dom */
/**
 * 🔴 **同じ action のボタンは、どの面に出ても同じ字である**(#716)。
 *
 * ## なぜ要るか
 *
 * 編集中の出口は 2 か所に出る ── 中央の帯(`detail.ts`)と追記欄(`append-box.ts`)。
 * どちらも `commit-edit` / `cancel-edit` なのに、字は「保存 / キャンセル」と
 * 「保存して解放 / 編集を破棄」で**別物に見えた**(押した結果は 1 バイトも違わない)。
 * user は「別の操作か」と読んで、どちらを押すか迷う。
 *
 * ## 守る主張
 *
 * 1. 🔴 `src` の `iconButton('<action>', '<字>')` を全数拾い、**action ごとに字は 1 種類**
 *    (静的 ── 面を描かなくても、字を打ち直した瞬間に落ちる)
 * 2. 🔴 実際に描いた編集中の画面で、`commit-edit` / `cancel-edit` が**2 か所に出て**、
 *    字と説明(`title`)がそれぞれ 1 種類・空でない(動的 ── 描き手が別の字を
 *    `textContent` で差し替える経路も見る)
 *
 * ⚠ 1 は**引数が字面のリテラル**の呼び出しだけを数える(変数で渡す `btn(action, label)`
 *   は表から引くので、表の側の test が字を縛る)。空振り防止に件数の下限を置く。
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

describe('同じ action のボタンの字は 1 種類(#716)', () => {
  it('🔴 src の iconButton(action, 字) を全数拾って、action ごとに字が 1 種類', () => {
    const labels = new Map<string, Set<string>>();
    let calls = 0;
    for (const file of walk('src')) {
      const text = readFileSync(file, 'utf-8');
      for (const m of text.matchAll(/iconButton\(\s*'([a-z0-9-]+)'\s*,\s*'([^']+)'/g)) {
        calls += 1;
        const set = labels.get(m[1]!) ?? new Set<string>();
        set.add(m[2]!);
        labels.set(m[1]!, set);
      }
    }
    // 空振り防止 ── 拾い方が壊れて 0 件になったら「全部 1 種類」が自明に通る
    expect(calls, 'iconButton の呼び出しを 1 つも拾えていない').toBeGreaterThan(20);
    expect(labels.has('commit-edit'), '前提が崩れている(commit-edit を拾えていない)').toBe(true);
    // ⚠ 2 か所に出ることを前提として pin する ── 1 か所に減ったら、この test の主張が空になる
    const bad = [...labels.entries()]
      .filter(([, set]) => set.size > 1)
      .map(([action, set]) => `${action}: ${[...set].join(' / ')}`);
    expect(bad, '同じ action なのに字が違うボタンがある(user には別の操作に見える)').toEqual([]);
  });
});

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

describe('編集中の出口 2 か所(#716)', () => {
  function editing() {
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
    d.dispatch({ type: 'START_EDIT' });
    // 前提:追記欄はロックの帯(出口)を出している
    expect(
      root.querySelector<HTMLElement>('[data-pkc-field="append-lock"]')!.hidden,
      '前提が崩れている(追記欄が編集中の帯を出していない)',
    ).toBe(false);
    return root;
  }

  for (const action of ['commit-edit', 'cancel-edit']) {
    it(`🔴 ${action} は中央と追記欄の 2 か所に出て、字も説明も 1 種類で空でない`, () => {
      const root = editing();
      const all = [...root.querySelectorAll<HTMLButtonElement>(`button[data-pkc-action="${action}"]`)];
      // ⚠ 出口が 2 つ在ることは #655 ④ の約束 ── 1 つに減ったら「揃っている」は自明になる
      expect(all.length, `${action} が 2 か所に出ていない(前提が崩れている)`).toBe(2);
      const inDetail = all.some((b) => b.closest('[data-pkc-region="detail"]') !== null);
      const inAppend = all.some((b) => b.closest('[data-pkc-region="append"]') !== null);
      expect(inDetail && inAppend, '中央と追記欄の両方に出ていない').toBe(true);
      const labels = new Set(
        all.map((b) => b.querySelector('[data-pkc-field="label"]')?.textContent ?? ''),
      );
      expect([...labels], `${action} の字が面で違う`).toHaveLength(1);
      expect([...labels][0], '字が空').not.toBe('');
      const titles = new Set(all.map((b) => b.title));
      expect([...titles], `${action} の説明が面で違う`).toHaveLength(1);
      // 🔴 説明は**起きること**で書く ── 空だと「保存」の 1 語だけで何が起きるか読めない
      expect([...titles][0], `${action} の説明が空`).toMatch(/編集を終えます$/);
    });
  }

  it('🔴 追記欄の断り文も同じ字で出口を言う(「編集を破棄」と言わない)', () => {
    const root = editing();
    const reason = root.querySelector('[data-pkc-field="append-lock-reason"]')!.textContent ?? '';
    expect(reason).toContain('保存するか、キャンセルすると');
    expect(reason, 'ボタンに無い字で出口を言っている').not.toContain('編集を破棄');
  });
});
