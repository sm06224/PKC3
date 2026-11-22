/** @vitest-environment happy-dom */
/**
 * 🔴 **ノートを選んだ直後、本文が届くまでの間に右の列の行を畳まない**(「その他 ▾」が跳ねて押しが外れる)。
 *
 * 実ブラウザ(1440x900)で測ると、行を選んだ直後に情報ペインの「その他 ▾」が
 * **575px → 483px → 583px** と動いていた ── 本文がまだ届いていない間は「担当」の行(26px)と
 * タグを打つ欄(67px)を畳み、本文が届くと出していたためである。
 * 負荷の高いフル smoke(586 件・2 workers)で、押す直前に測った位置へ本文の到着で行が差し込まれ、
 * `organize.smoke.spec.ts` の「その他 ▾」の押しが外れて一覧が出なかった(2026-11-21)。
 * user にとっても、選んですぐ押すと別の物を押す形になる(業務画面の「同じものが常に同じ場所にある」に反する)。
 *
 * ## 守る主張
 * 1. 本文を待っている間も、本文が届いた後に出る行(担当 / タグを打つ欄)は**場所を取っておく**
 *    (`hidden` にしない)── 待っている間と届いた後で、出ている行の並びが同じ
 * 2. 待っている間は**見せず・押させない**(`data-pkc-pending` + `inert`)── 「無し」と嘘をつかない / 押しても何も起きない口を作らない
 * 3. 本文を持たない形(フォルダの担当)・書けない理由がある形(編集中のタグ欄)は、いままでどおり畳む
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';

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
    bodyChars: null,
  };
}

const METAS = new Map<string, EntryMeta>([
  ['a', meta('a', 'ノートA')],
  ['b', meta('b', 'ノートB')],
  ['f', meta('f', 'フォルダ', 'folder')],
]);
const BODY = '本文\n';

function stateOf(selectedLid: string, loaded: boolean, over: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    phase: 'ready',
    entryMetas: METAS,
    relations: [],
    selectedLid,
    openBody: loaded ? { lid: selectedLid, body: BODY, baseline: BODY, persisted: BODY, diskAhead: false } : null,
    ...over,
  } as AppState;
}

function setup() {
  document.body.textContent = '';
  const root = document.createElement('div');
  document.body.append(root);
  const regions = buildShell(root);
  const inspector = new InspectorRenderer(regions.inspector);
  const region = regions.inspector;
  /** 場所を取っている(= `hidden` でない)物の一覧。⚠ 祖先が畳まれていれば場所は取らない。 */
  const laidOut = (): string[] =>
    [...region.querySelectorAll<HTMLElement>('dl > dt, dl > dd, [data-pkc-field="tag-add"]')]
      .filter((el) => el.closest('[hidden]') === null)
      .map((el) => (el.tagName === 'DT' ? `dt:${el.textContent ?? ''}` : (el.getAttribute('data-pkc-field') ?? '')));
  const ownerDd = (): HTMLElement => region.querySelector<HTMLElement>('[data-pkc-field="inspector-owner"]')!;
  const tagForm = (): HTMLElement => region.querySelector<HTMLElement>('[data-pkc-field="tag-add"]')!;
  return { inspector, laidOut, ownerDd, tagForm };
}

describe('本文を待つ間の右の列の並び', () => {
  it('選び直した直後(本文待ち)と本文が届いた後で、場所を取る行が同じ(「その他 ▾」が跳ねない)', () => {
    const { inspector, laidOut } = setup();
    inspector.render(stateOf('a', true));
    inspector.render(stateOf('b', false));
    const pending = laidOut();
    inspector.render(stateOf('b', true));
    const loaded = laidOut();
    // 前提: 本文が届いた後には担当の行とタグを打つ欄が在る(観測点の空振り止め)
    expect(loaded).toContain('inspector-owner');
    expect(loaded).toContain('tag-add');
    expect(pending, '本文待ちの間に行を畳んでいる(届いたときに下の操作が押し下げられる)').toEqual(loaded);
  });

  it('待っている間は見せず・押させない。届いたら外す', () => {
    const { inspector, ownerDd, tagForm } = setup();
    inspector.render(stateOf('b', false));
    expect(ownerDd().hasAttribute('data-pkc-pending')).toBe(true);
    expect(ownerDd().hasAttribute('inert')).toBe(true);
    expect(tagForm().hasAttribute('data-pkc-pending')).toBe(true);
    expect(tagForm().hasAttribute('inert')).toBe(true);
    // 「担当を外す」は出さない(待っている間に前のノートの担当を見せない)
    expect(ownerDd().querySelector('[data-pkc-field="inspector-owner-name"]')).toBeNull();
    inspector.render(stateOf('b', true));
    expect(ownerDd().hasAttribute('data-pkc-pending')).toBe(false);
    expect(ownerDd().hasAttribute('inert')).toBe(false);
    expect(tagForm().hasAttribute('data-pkc-pending')).toBe(false);
    expect(tagForm().hasAttribute('inert')).toBe(false);
    expect(tagForm().hidden).toBe(false);
  });

  it('前のノートの担当の名前を、待っている間に持ち越さない', () => {
    const { inspector, ownerDd } = setup();
    const withOwner = '---\nowner: 佐藤\n---\n本文\n';
    inspector.render(
      stateOf('a', true, { openBody: { lid: 'a', body: withOwner, baseline: withOwner, persisted: withOwner, diskAhead: false } }),
    );
    expect(ownerDd().textContent, '前提: 担当が出ている').toContain('佐藤');
    inspector.render(stateOf('b', false));
    expect(ownerDd().textContent).not.toContain('佐藤');
  });

  it('フォルダの担当の行は、いままでどおり畳む(本文を持たない形に空き地を作らない)', () => {
    const { inspector, ownerDd } = setup();
    inspector.render(stateOf('f', false));
    expect(ownerDd().hidden).toBe(true);
    expect(ownerDd().hasAttribute('data-pkc-pending')).toBe(false);
  });

  it('編集中など書けない理由があるときのタグ欄は、いままでどおり畳む(待ちの印を付けない)', () => {
    const { inspector, tagForm } = setup();
    inspector.render(stateOf('a', true, { phase: 'editing' }));
    expect(tagForm().hidden).toBe(true);
    expect(tagForm().hasAttribute('data-pkc-pending')).toBe(false);
  });
});

describe('待ちの印を付ける物・付けない物(着地前レビューの変異)', () => {
  const statsDd = (): HTMLElement =>
    document.querySelector<HTMLElement>('[data-pkc-region="inspector"] [data-pkc-field="inspector-stats"]')!;

  it('字数の行も、待っている間は見せず押させない(場所だけ取る)。届いたら外す', () => {
    const { inspector } = setup();
    inspector.render(stateOf('b', false));
    expect(statsDd().hidden).toBe(false);
    expect(statsDd().hasAttribute('data-pkc-pending')).toBe(true);
    expect(statsDd().hasAttribute('inert')).toBe(true);
    inspector.render(stateOf('b', true));
    expect(statsDd().hasAttribute('data-pkc-pending')).toBe(false);
    expect(statsDd().hasAttribute('inert')).toBe(false);
  });

  it('編集中で本文がまだ無いときのタグ欄は、待ちの印を付けずに畳む(phase の条件の片側)', () => {
    const { inspector, tagForm } = setup();
    inspector.render(stateOf('b', false, { phase: 'editing' }));
    expect(tagForm().hidden).toBe(true);
    expect(tagForm().hasAttribute('data-pkc-pending')).toBe(false);
  });

  /**
   * 🔴 **本文の読み込みに失敗したら待たない**(`BODY_LOAD_FAILED` は `openBody` を null のまま `error` だけ立てる)。
   * ⚠ 待ち続けると、次に選び直すまで見えない空き地(担当・タグ欄・字数で約 100px)が残る。
   */
  it('本文の読み込みに失敗したら、待ちの印を外して従来どおり畳む', () => {
    const { inspector, ownerDd, tagForm, laidOut } = setup();
    inspector.render(stateOf('b', false, { error: '本文を読み込めませんでした: boom' }));
    for (const el of [ownerDd(), tagForm(), statsDd()]) {
      expect(el.hasAttribute('data-pkc-pending'), el.getAttribute('data-pkc-field') ?? '').toBe(false);
      expect(el.hasAttribute('inert')).toBe(false);
    }
    const shown = laidOut();
    expect(shown).not.toContain('inspector-owner');
    expect(shown).not.toContain('tag-add');
    expect(shown).not.toContain('inspector-stats');
  });

  it('⚠ 対照群 ── 関係の無い知らせ(error)が出ているだけなら、待ちの印は付く', () => {
    const { inspector, ownerDd } = setup();
    inspector.render(stateOf('b', false, { error: '保存できませんでした' }));
    expect(ownerDd().hasAttribute('data-pkc-pending')).toBe(true);
  });
});

describe('待ちの印の CSS', () => {
  it('待ちの印は場所を取ったまま見えなくする(visibility: hidden)', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const m = /\[data-pkc-region='inspector'\]\s*\[data-pkc-pending\]\s*\{([^}]*)\}/.exec(css);
    expect(m, '待ちの印の規則が無い').not.toBeNull();
    expect(m![1]).toMatch(/visibility:\s*hidden/);
    expect(m![1]).not.toMatch(/display:\s*none/);
  });
});
