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
import { EDITING_STATE_WORD } from '../../src/adapter/ui/render/status-line';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * 🔴 **例外:短いタイルの名前と、合成メニューの動詞形の名前**(#1054 段②)。
 *
 * ⚠ #716 が守るのは「**無関係に見える 2 か所**が、同じ action なのに別の字を
 *   名乗ること」── 中央の帯と追記欄は user から見て**別々の場所**なので、
 *   字が違うと「別の操作か」と読める。
 * 🔑 ここは**その形と違う**:合成メニューの項目は、**その帯自身の ▼ を開かないと
 *   出てこない**(タイルの隣にある同じ 1 個の器の中)。短い名前(タイル・
 *   長押しメニュー)と、OS 風の動詞形の名前(合成メニュー)が**同じ場所から
 *   同時に読める**ので、「別の操作に見える」という #716 の実害が起きない。
 * ⚠ **だから緩めるのではなく、既知の対として明示する** ── 3 種目が紛れ込んだら
 *   (`set.size` が既知の 2 種と食い違ったら)ここでも落ちる。
 */
const KNOWN_DIFFERENT: ReadonlyMap<string, readonly string[]> = new Map([
  ['open-today', ['今日', '今日のノートを開く']],
  ['attach-file', ['添付', '添付する']],
  ['start-audio-capture', ['録音', '録音する']],
  ['start-screen-capture', ['画面録画', '画面を録画する']],
]);

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
      .filter(([action, set]) => {
        const known = KNOWN_DIFFERENT.get(action);
        if (known === undefined) return set.size > 1;
        return set.size !== known.length || !known.every((l) => set.has(l));
      })
      .map(([action, set]) => `${action}: ${[...set].join(' / ')}`);
    expect(bad, '同じ action なのに字が違うボタンがある(user には別の操作に見える)').toEqual([]);
    // 🔑 既知の対が、実際に「両方在る」ことも見る ── 片方だけになったら既知リストが腐っている
    for (const [action, known] of KNOWN_DIFFERENT) {
      expect(
        [...(labels.get(action) ?? [])].sort(),
        `${action} の既知の対が崩れている(片方だけになった?)`,
      ).toEqual([...known].sort());
    }
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

  /**
   * 🔴 **C4(#1038 台帳③ 段 D)で書き直した** ── 「編集中」は画面いちばん下の
   * ステータスバー(`status-line.ts`)も言うようになったので、追記欄はもう
   * その状態を長い文で言い直さない。⚠ 主張は「同じ定数と等値」(設計 doc §1
   * P3 の test②)── 文字列を手で書くと、どちらかだけ直した日に緑のまま食い違う。
   */
  it('🔴 追記欄の断り文は「編集中」の 1 語(ステータスバーと同じ定数)', () => {
    const root = editing();
    const reason = root.querySelector('[data-pkc-field="append-lock-reason"]')!.textContent ?? '';
    expect(reason).toBe(EDITING_STATE_WORD);
  });

  /**
   * 🔴 **1 語にしても、出口(保存 / キャンセル)は減らない**(§4.2「触らない物」/
   * §9「これが分かったら覆る」の対照 ── 出口を削る変更ではないことを固定する)。
   * ⚠ 上の describe の 2 つの it が「2 か所に出て、字が空でない」までは見ているので、
   *   ここは**追記欄の中で**両方が見えることだけを見る(重複させない)。
   */
  it('🔴 追記欄の断り文の隣に、保存 / キャンセルのボタンがそのまま在る', () => {
    const root = editing();
    const lockBar = root.querySelector('[data-pkc-field="append-lock"]')!;
    expect(lockBar.querySelector('button[data-pkc-action="commit-edit"]'), '保存の出口が無い').not.toBeNull();
    expect(lockBar.querySelector('button[data-pkc-action="cancel-edit"]'), 'キャンセルの出口が無い').not.toBeNull();
  });
});
