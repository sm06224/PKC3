/** @vitest-environment happy-dom */
/**
 * 🔴 **csv の表の 1 行目を、見出しにする / やめる**(#1662 3。Gemini 裁定 = #1163 依頼 48 の 3 = A)。
 *
 * 直す前は、新しく作った表(`csv-render noheader`)の 1 行目に「品名,数」と打っても見出しにならず、
 * 見出しにするには編集で ` noheader` を消すしか無かった。口は表の右上の ▾ の小窓の 1 行。
 * ⚠ 面は本物の描画(`renderMarkdown`)から組む(`table-format-menu.test.ts` と同じ作法)。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { initialState, type AppState, type DomainEvent } from '../../src/adapter/state/app-state';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { applyBodyRewrite, type BodyRewrite } from '../../src/features/markdown/body-rewrite';
import { frontmatterLineCount, bodyBelowFrontmatter } from '../../src/features/markdown/frontmatter';

function metasOf(lids: readonly string[]): AppState['entryMetas'] {
  const m = new Map<string, unknown>();
  for (const [i, lid] of lids.entries()) {
    m.set(lid, {
      lid,
      title: lid,
      archetype: 'text',
      createdAt: null,
      updatedAt: null,
      entryOrder: i + 1,
      status: null,
      date: null,
      archived: false,
    });
  }
  return m as AppState['entryMetas'];
}

function setup(body: string, splitLid: string | null = null) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  root.innerHTML = '<div data-pkc-region="detail"><div data-pkc-field="detail-body"></div></div>';
  document.body.append(root);
  const host = root.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
  const drawn = renderMarkdown(bodyBelowFrontmatter(body), {
    sourceLineAnchors: true,
    taskLineOffset: frontmatterLineCount(body),
    interactiveCells: true,
  } as never);
  host.innerHTML = splitLid === null ? drawn : `<div data-pkc-split-lid="${splitLid}">${drawn}</div>`;
  const d = new Dispatcher({
    ...initialState,
    cid: 'c1',
    phase: 'ready',
    selectedLid: 'n1',
    entryMetas: metasOf(['n1', 'n2']),
    openBody: { lid: 'n1', body, baseline: body, persisted: body, diskAhead: false },
  });
  const events: DomainEvent[] = [];
  d.onEvent((e) => void events.push(e));
  bindActions(root, d, {});
  return { d, events, host };
}

async function openPick(host: HTMLElement): Promise<HTMLElement[]> {
  const menu = host.querySelector<HTMLElement>('[data-pkc-copy-menu]');
  if (menu === null) throw new Error('前提が崩れている: ▾ が描かれていない');
  menu.click();
  await Promise.resolve();
  return [...document.querySelectorAll<HTMLElement>('[data-pkc-field="pick-copy-format"]')];
}

async function closePick(): Promise<void> {
  document.querySelector<HTMLElement>('[data-pkc-field="dialog-cancel"]')?.click();
  await Promise.resolve();
}

const MD = '# 覚書\n\n| 品名 | 数 |\n|---|---|\n| りんご | 3 |\n';
const NOHEAD = '# 覚書\n\n```csv-render noheader\n品名,数\nりんご,3\n```\n';
const HEAD = '# 覚書\n\n```csv-render\n品名,数\nりんご,3\n```\n';
/** 小窓の行を押してから書換が頼まれるまで(選択 → 他タブの確認 → 頼む)待つ。 */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 5));
};

describe('表の 1 行目を見出しにする(#1662 3)', () => {
  it('🔴 見出し無しの表の ▾ には「1 行目を見出しにする」が出て、押すと旗だけが外れる', async () => {
    const s = setup(NOHEAD);
    const rows = await openPick(s.host);
    const row = rows.find((r) => (r.textContent ?? '').includes('1 行目を見出しにする'));
    expect(row, '▾ の小窓に「1 行目を見出しにする」が出ていない').toBeDefined();
    row!.click();
    await tick();
    const ev = s.events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev, `書換が頼まれていない: ${String(s.d.getState().error)}`).toBeDefined();
    const rw = (ev as { rewrite: BodyRewrite }).rewrite;
    expect(rw).toMatchObject({ kind: 'table-format', header: true });
    expect(applyBodyRewrite(NOHEAD, rw)).toBe(HEAD);
  });

  it('🔴 見出しのある表の ▾ には「見出しをやめる」が出て、押すと noheader が付く', async () => {
    const s = setup(HEAD);
    const rows = await openPick(s.host);
    const row = rows.find((r) => (r.textContent ?? '').includes('見出しをやめる'));
    expect(row, '▾ の小窓に「見出しをやめる」が出ていない').toBeDefined();
    expect(rows.some((r) => (r.textContent ?? '').includes('1 行目を見出しにする')), '両方出た').toBe(false);
    row!.click();
    await tick();
    const ev = s.events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(applyBodyRewrite(HEAD, (ev as { rewrite: BodyRewrite }).rewrite)).toBe(NOHEAD);
  });

  it('⚠ markdown の表には出さない(見出しは形の一部)/ 留めた枠にも出さない', async () => {
    const md = setup(MD);
    const mdRows = await openPick(md.host);
    expect(mdRows.length, '前提が崩れている: 小窓が開いていない').toBeGreaterThan(0);
    expect(mdRows.some((r) => /見出し/.test(r.textContent ?? ''))).toBe(false);
    await closePick();
    const split = setup(HEAD, 'n2');
    const splitRows = await openPick(split.host);
    expect(splitRows.length, '前提が崩れている: 小窓が開いていない').toBeGreaterThan(0);
    expect(splitRows.some((r) => /見出し/.test(r.textContent ?? ''))).toBe(false);
    await closePick();
  });

  it('旗の足し引きは開き行の 1 語だけ ── ほかの旗・升・引用の前置きは動かさない / もうその状態なら断る', () => {
    const rw = (line: number, open: string, header: boolean): BodyRewrite =>
      ({ kind: 'table-format', line, openLine: open, to: 'csv', header }) as BodyRewrite;
    const body = '> ```tsv NoHeader foo\n> a\tb\n> ```\n';
    expect(applyBodyRewrite(body, rw(0, '> ```tsv NoHeader foo', true))).toBe('> ```tsv foo\n> a\tb\n> ```\n');
    expect(applyBodyRewrite(HEAD, rw(2, '```csv-render', true)), 'もう見出しなのに書いた').toBeNull();
    expect(applyBodyRewrite(NOHEAD, rw(2, '```csv-render noheader', false)), 'もう見出し無しなのに書いた').toBeNull();
  });

  it('🔴 見出しを切り替えた ack は、戻し方を言う', () => {
    const rw = {
      kind: 'table-format',
      line: 2,
      openLine: '```csv-render noheader',
      to: 'csv',
      header: true,
    } as BodyRewrite;
    const next = applyBodyRewrite(NOHEAD, rw)!;
    const d = new Dispatcher({
      ...initialState,
      cid: 'c1',
      phase: 'ready',
      selectedLid: 'n1',
      entryMetas: metasOf(['n1']),
      openBody: { lid: 'n1', body: NOHEAD, baseline: NOHEAD, persisted: NOHEAD, diskAhead: false },
    });
    d.dispatch({ type: 'BODY_REWRITTEN', lid: 'n1', body: next, rewrite: rw } as never);
    expect(d.getState().notice).toBe('表の 1 行目を見出しにしました(戻すには表の右上の ▾ から)');
  });
});
