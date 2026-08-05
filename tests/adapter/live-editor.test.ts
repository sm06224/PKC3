/** @vitest-environment happy-dom */
/**
 * 🔴 **1 面のライブエディタの配線**(2026-08-05。ライブエディタ S5。
 * 設計 doc `docs/development/live-editor-design-2026-08.md` §4 / §9)。
 *
 * ここで守るのは 4 つ:
 *
 * ① **既定は今日の 2 列**(user 裁定 = 設計 §9 論点 C:塊を跨ぐ Ctrl+Z が
 *    入るまで既定にしない)── 既定が入れ替わると全 user に影響する
 * ② `?pkc-live=1` で**1 面**になる(2 列の原文欄は出ない)
 * ③ 🔴 **確定した本文が外へ出る**(`onBodyChange`)── ここが落ちると
 *    **画面は変わるのに保存されない**(いちばん静かな壊れ方)
 * ④ **分割が組めない本文では原文の編集欄へ退避**する ── 壊れた分割の上で
 *    行を差し替えると本文が壊れる
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { MarkdownClient } from '../../src/adapter/platform/render/markdown-client';

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
  };
}

function editing(body: string): AppState {
  let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] })
    .state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body }).state;
  s = reduce(s, { type: 'START_EDIT' }).state;
  return s;
}

/**
 * ⚠ `location.search` は `history.replaceState` で変える ── グローバルを
 * 丸ごと差し替えない(CLAUDE.md「必要な静的メソッドだけ」)。
 */
function setLive(on: boolean): void {
  history.replaceState(null, '', on ? '/?pkc-live=1' : '/');
}
afterEach(() => setLive(false));

/** worker の無い環境の同期経路(= happy-dom)でも `follower` は microtask で返る。 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

interface Rig {
  root: HTMLElement;
  detail: DetailRenderer;
  bodies: string[];
}

function rig(body: string): Rig {
  const root = document.createElement('div');
  // ⚠ **document へ繋ぐ**。`follower` の callback は `isConnected` を見て
  //    早期 return する(外された後に描かない規律)ので、繋がないと**何も出ない**
  document.body.append(root);
  const bodies: string[] = [];
  const detail = new DetailRenderer(
    buildShell(root).detail,
    null,
    new MarkdownClient(),
    (b) => bodies.push(b),
  );
  detail.render(editing(body));
  return { root, detail, bodies };
}

const DOC = ['# 題', '', '最初の段落。', '', '次の段落。'].join('\n');

describe('ライブエディタ(1 面)の配線', () => {
  it('① 既定は今日の 2 列(原文 | プレビュー)── 勝手に入れ替わっていない', async () => {
    setLive(false);
    const r = rig(DOC);
    await settle();
    expect(r.root.querySelector('[data-pkc-region="editor-split"]')).not.toBeNull();
    expect(r.root.querySelector('[data-pkc-region="editor-live"]')).toBeNull();
    expect(r.root.querySelector('[data-pkc-field="editor-body"]')).not.toBeNull();
  });

  it('② `?pkc-live=1` で 1 面になり、2 列の原文欄は出ない', async () => {
    setLive(true);
    const r = rig(DOC);
    await settle();
    expect(r.root.querySelector('[data-pkc-region="editor-live"]')).not.toBeNull();
    expect(r.root.querySelector('[data-pkc-region="editor-split"]')).toBeNull();
    expect(r.root.querySelector('[data-pkc-field="editor-body"]')).toBeNull();
    // 画面は**描画済み文書**(原文がそのまま出ているのではない)
    const live = r.root.querySelector('[data-pkc-region="editor-live"]')!;
    expect(live.querySelector('h1')?.textContent).toContain('題');
  });

  it('③ 🔴 行を書き換えて確定すると、継ぎ足した本文が外へ出る', async () => {
    setLive(true);
    const r = rig(DOC);
    await settle();
    const live = r.root.querySelector('[data-pkc-region="editor-live"]')!;
    const p = [...live.querySelectorAll('p')].find((e) => e.textContent === '最初の段落。')!;
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    const ta = live.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
    expect(ta.value).toBe('最初の段落。');
    ta.value = '書き換えた。';
    ta.blur();
    // 🔴 **1 行だけ**が変わった本文が出る(他の行を潰していない)
    expect(r.bodies).toEqual([['# 題', '', '書き換えた。', '', '次の段落。'].join('\n')]);
    await settle();
    expect([...live.querySelectorAll('p')].map((e) => e.textContent)).toContain('書き換えた。');
  });

  it('③ 変えずに閉じたら本文は出ない(空の書込を投げない)', async () => {
    setLive(true);
    const r = rig(DOC);
    await settle();
    const live = r.root.querySelector('[data-pkc-region="editor-live"]')!;
    const p = [...live.querySelectorAll('p')].find((e) => e.textContent === '最初の段落。')!;
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    live.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!.blur();
    expect(r.bodies).toEqual([]);
    // ⚠ それでも穴は残っていない
    expect(live.querySelector('[data-pkc-row-slot]')).toBeNull();
    expect([...live.querySelectorAll('p')].map((e) => e.textContent)).toContain('最初の段落。');
  });

  it('④ 分割が組めない本文では原文の編集欄へ退避し、理由を出す', async () => {
    setLive(true);
    // 入れ子の `:::`(今日の描画が壊れている ── 設計 §7-9)
    const r = rig([':::section', '', ':::section', '', '中身', '', ':::', '', ':::', ''].join('\n'));
    await settle();
    const live = r.root.querySelector('[data-pkc-region="editor-live"]')!;
    expect(live.querySelector('[data-pkc-field="editor-body"]')).not.toBeNull();
    expect(live.querySelector('[data-pkc-field="row-source"]')).toBeNull();
    const note = r.root.querySelector('[data-pkc-field="row-note"]')!;
    expect(note.textContent).toContain('行ごとに編集できません');
  });

  it('④ 退避した原文欄の打鍵も外へ出る(退避先で保存が死んでいない)', async () => {
    setLive(true);
    const r = rig([':::section', '', ':::section', '', '中身', '', ':::', '', ':::', ''].join('\n'));
    await settle();
    const ta = r.root.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = '普通の段落に直した。';
    ta.dispatchEvent(new Event('input'));
    expect(r.bodies).toEqual(['普通の段落に直した。']);
  });

  it('お知らせの行は常に同じ場所に在る(出ても配置が動かない)', async () => {
    setLive(true);
    const r = rig(DOC);
    await settle();
    expect(r.root.querySelector('[data-pkc-field="row-note"]')).not.toBeNull();
  });

  it('編集を抜けたら聴くのをやめる(外れた面が反応し続けない)', async () => {
    setLive(true);
    const r = rig(DOC);
    await settle();
    const live = r.root.querySelector<HTMLElement>('[data-pkc-region="editor-live"]')!;
    const p = [...live.querySelectorAll('p')].find((e) => e.textContent === '最初の段落。')!;
    // 表示を閉じる(選択解除)── `cancelPreview` が `RowSwap.dispose()` を呼ぶ
    r.detail.render(
      reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] }).state,
    );
    expect(r.root.querySelector('[data-pkc-region="editor-live"]')).toBeNull();
    // 🔴 外れた面の中をクリックしても、入力欄は生えない(listener が残っていない)
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(live.querySelector('[data-pkc-field="row-source"]')).toBeNull();
    expect(r.bodies).toEqual([]);
  });
});
