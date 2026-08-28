/** @vitest-environment happy-dom */
/**
 * #395 段①: **追記の入り先を選ぶ**(押した所から disk まで)。
 *
 * > user の物語: 長い議事録の「決定事項」の節に **1 行だけ**足したい。
 * > いまは「編集」を押して本文を丸ごと開き、目で節を探すしかない。
 *
 * 🔴 **配線の test を別に置く理由**:`append-target.test.ts` は挿し込みの規則を
 * 見るが、それが**画面から届くか**は 1 行も見ていない。#397 で「作ったのに
 * 繋いでいない」を直したばかりなので、同じ穴を自分で作らない。
 *
 * 観測点は **disk に着いた本文**(画面だけ変わって保存されない、を作らない)。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { AppendBoxRenderer } from '../../src/adapter/ui/render/append-box';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';

const DOC = [
  '# 議事録',
  '',
  '出席者は 3 名。',
  '',
  '## 決定事項',
  '',
  '- A を採用する',
  '',
  '## 次回',
  '',
  '来週。',
  '',
].join('\n');

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
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

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.textContent = '';
});

function setup(body = DOC) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const box = new AppendBoxRenderer(buildShell(root).append);
  d.onState((s) => box.render(s));
  bindActions(root, d);
  const persisted: EntryUpsert[] = [];
  const disk: Record<string, string> = { n1: body, n2: 'べつのノート\n' };
  const failures: string[] = [];
  d.onState((s) => {
    if (s.error !== null && !failures.includes(s.error)) failures.push(s.error);
  });
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => disk[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      persisted.push(e);
      disk[e.lid] = e.body;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1'), meta('n2')], relations: [] });
  const q = <T extends HTMLElement>(s: string): T | null => root.querySelector<T>(s);
  return { root, d, persisted, disk, failures, q };
}

async function open(s: ReturnType<typeof setup>): Promise<void> {
  s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  await tick();
}

const sel = (s: ReturnType<typeof setup>): HTMLSelectElement =>
  s.q<HTMLSelectElement>('[data-pkc-field="append-target"]')!;

function send(s: ReturnType<typeof setup>, text: string): void {
  s.q<HTMLTextAreaElement>('[data-pkc-field="append-input"]')!.value = text;
  s.q('[data-pkc-action="append-entry"]')!.click();
}

describe('#395 段① 入り先の選択が画面に出る', () => {
  it('🔑 本文の見出しが並ぶ(既定は末尾)', async () => {
    const s = setup();
    await open(s);
    expect([...sel(s).options].map((o) => o.textContent?.trim())).toEqual([
      '末尾',
      '議事録',
      '決定事項',
      '次回',
    ]);
    expect(sel(s).value, '既定が末尾でない(これまでの挙動が変わる)').toBe('');
  });

  /**
   * 🔴 **入り先は「打つ欄の行」の外に居る**(#496)。
   *
   * ⚠ 幅と上下は CSS の話なので unit では測れない(happy-dom は全部 0)──
   *   ここで守れるのは**器の組み立て**だけである:`<select>` が
   *   `append-row`(打つ欄と押す物の行)の**中に戻っていない**こと。
   * 🔑 戻すと横 1 列に復帰し、見出しの長いノートで打つ欄が押しのけられる
   *   (実測 64px → 765px)。幅と位置そのものは
   *   `tests/smoke/append-ui.smoke.spec.ts` が実ブラウザで見る。
   */
  it('🔴 入り先は打つ欄の行の外に居る(横 1 列に戻っていない)', async () => {
    const s = setup();
    await open(s);
    const form = s.q('[data-pkc-field="append-form"]')!;
    const row = s.q('[data-pkc-field="append-row"]')!;
    const target = sel(s);
    expect(target.parentElement, '入り先が append-form の直下に居ない').toBe(form);
    expect(row.contains(target), '入り先が打つ欄の行の中に戻っている').toBe(false);
    // ⚠ 空振り防止 ── 打つ欄と押す物は**その行の中**に在る(器が空でない)
    expect(row.contains(s.q('[data-pkc-field="append-input"]')!)).toBe(true);
    expect(row.contains(s.q('[data-pkc-action="append-entry"]')!)).toBe(true);
    // 🔑 **上に出す**ので、器の中で打つ欄より前に居る
    expect(
      form.firstElementChild,
      '入り先が打つ欄より後ろに居る(上に出ない)',
    ).toBe(target);
  });

  it('⚠ 見出しが 1 つも無いノートでは畳む(選ぶ物が無い口を出さない)', async () => {
    const s = setup('ただの本文です。\n');
    await open(s);
    expect(sel(s).hidden).toBe(true);
  });

  it('🔴 本文が変わったら一覧も変わる(見出しを足しても出てこない、を作らない)', async () => {
    const s = setup('# はじめ\n\n本文\n');
    await open(s);
    expect([...sel(s).options].map((o) => o.textContent?.trim())).toEqual(['末尾', 'はじめ']);
    send(s, '## あとから');
    await tick();
    expect(
      [...sel(s).options].map((o) => o.textContent?.trim()),
      '足した見出しが一覧に出てこない',
    ).toEqual(['末尾', 'はじめ', 'あとから']);
  });

  /**
   * 🔴 **一覧が組み直されても、選んだ物は残る**(2 稿目。変異試験が拾った)。
   *
   * ⚠ 1 稿目は「見出しが変わらない追記」でしか見ていなかったので、
   *   **選択を戻す 1 行を消しても緑**だった ── 指紋が同じなら組み直さないので、
   *   救っていたのは早期 return のほうで、`keep` の復元は**一度も走っていなかった**
   *   (CLAUDE.md §2「弱いのではなく走っていない」)。
   * 🔑 だから**見出しが増える追記**で見る ── そこでだけ組み直しが起きる。
   */
  it('🔴 一覧が組み直されても、選んだ入り先は残る', async () => {
    const s = setup();
    await open(s);
    const target = [...sel(s).options].find((o) => o.textContent?.trim() === '決定事項')!.value;
    sel(s).value = target;
    // 見出しを 1 つ増やす = 一覧の指紋が変わる = 組み直しが走る
    send(s, '## あとから');
    await tick();
    expect(
      [...sel(s).options].map((o) => o.textContent?.trim()),
      '前提が崩れた(組み直しが起きていない)',
    ).toContain('あとから');
    expect(sel(s).value, '組み直しで選んだ入り先が飛んだ').toBe(target);
  });

  it('🔴 選んだ物は、追記しても飛ばない(続けて同じ節へ足せる)', async () => {
    const s = setup();
    await open(s);
    const target = [...sel(s).options].find((o) => o.textContent?.trim() === '決定事項')!.value;
    sel(s).value = target;
    send(s, 'B を採用する');
    await tick();
    expect(sel(s).value, '追記のたびに「末尾」へ戻っている').toBe(target);
  });
});

describe('#395 段① 選んだ節へ入る(disk まで)', () => {
  it('🔴 選んだ節の中に入り、次の節へこぼれない', async () => {
    const s = setup();
    await open(s);
    sel(s).value = [...sel(s).options].find((o) => o.textContent?.trim() === '決定事項')!.value;
    send(s, 'B を採用する');
    await tick();
    const lines = s.disk['n1']!.split('\n');
    const at = lines.indexOf('B を採用する');
    expect(at, 'disk に届いていない').toBeGreaterThan(-1);
    expect(at, '次の節へこぼれた').toBeLessThan(lines.indexOf('## 次回'));
    expect(at).toBeGreaterThan(lines.indexOf('- A を採用する'));
  });

  it('⚠ 既定(末尾)はこれまでと同じ ── 選ばなければ挙動は変わらない', async () => {
    const s = setup();
    await open(s);
    send(s, '末尾の一行');
    await tick();
    expect(s.disk['n1']!.trimEnd().endsWith('末尾の一行')).toBe(true);
  });

  it('🔴 見出しが消えていたら足さない ── 黙って末尾へ落とさない', async () => {
    const s = setup();
    await open(s);
    sel(s).value = [...sel(s).options].find((o) => o.textContent?.trim() === '決定事項')!.value;
    // 別の窓が見出しを消した後で押す
    s.disk['n1'] = '# 議事録\n\n出席者は 3 名。\n';
    send(s, 'B を採用する');
    await tick();
    expect(s.disk['n1'], '見出しが無いのに書き込んだ').toBe('# 議事録\n\n出席者は 3 名。\n');
    expect(s.failures.join(''), '理由が出ていない(無言で失敗した)').toContain('入り先');
  });
});

describe('#395 段① 足したものを外せる(片道の操作を作らない)', () => {
  it('🔴 追記が通ると「元に戻す」が出て、押すと disk から消える', async () => {
    const s = setup();
    await open(s);
    const undo = (): HTMLButtonElement =>
      s.q<HTMLButtonElement>('[data-pkc-action="undo-append"]')!;
    expect(undo().hidden, '何も足していないのに出ている').toBe(true);
    sel(s).value = [...sel(s).options].find((o) => o.textContent?.trim() === '決定事項')!.value;
    send(s, 'B を採用する');
    await tick();
    expect(undo().hidden, '足したのに戻す口が出ない').toBe(false);
    undo().click();
    await tick();
    expect(s.disk['n1'], '足す前へ戻っていない').toBe(DOC);
  });

  /**
   * 🔴 **2 度押しで、もとから在った行を食わない**(2 稿目。変異試験が拾った)。
   *
   * ⚠ 1 稿目の fixture は、2 度目の取り消しが**そもそも当たらない**本文だった
   *   ── だから「1 手で使い切る」を消しても緑で、**空振りのまま合格**していた。
   * 🔑 **もとから同じ行が在る本文**で見る ── そこでだけ、2 度目が
   *   「user が前から書いていた行」を消す(= 静かなデータ破壊)。
   */
  it('🔴 2 度押しても、もとから在った同じ行を消さない(1 手で使い切る)', async () => {
    const s = setup('x\n\nB\n');
    await open(s);
    send(s, 'B');
    await tick();
    const undo = (): HTMLButtonElement =>
      s.q<HTMLButtonElement>('[data-pkc-action="undo-append"]')!;
    undo().click();
    await tick();
    expect(s.disk['n1'], '足す前へ戻っていない(前提が崩れた)').toBe('x\n\nB\n');
    // ⚠ 2 度目は state から材料が消えているので何も起きない
    s.q('[data-pkc-action="undo-append"]')?.click();
    await tick();
    expect(s.disk['n1'], '2 度目で、もとから在った行まで消えた').toBe('x\n\nB\n');
  });

  it('⚠ 別のノートを選んでいる間は出さない(いま見ている物が戻ると読まれる)', async () => {
    const s = setup();
    await open(s);
    send(s, 'B');
    await tick();
    expect(s.q('[data-pkc-action="undo-append"]')!.hidden).toBe(false);
    // ⚠ **実在するノート**へ移る ── 居ない lid は reducer が no-op にするので、
    //   そちらで書くと「移ったつもり」の空振りになる(1 稿目で踏んだ)
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    await tick();
    expect(s.q('[data-pkc-action="undo-append"]')!.hidden).toBe(true);
  });
});
