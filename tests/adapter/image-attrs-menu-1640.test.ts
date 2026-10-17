/** @vitest-environment happy-dom */
/**
 * 🔴 **右クリックで本文の画像の大きさ・寄せを書く**(#1640 ③。🟣 Gemini 依頼 37 の答え「A」)。
 *
 * ⚠ 面は**本物の描画**(`renderMarkdown`)から組む ── 手で `<img data-pkc-source-line>` を書くと、
 *   描画が実際に何を焼くかを 1 度も見ないことになる(`table-format-menu.test.ts` と同じ作法)。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { initialState, type AppState, type DomainEvent } from '../../src/adapter/state/app-state';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { applyBodyRewrite, type BodyRewrite } from '../../src/features/markdown/body-rewrite';
import { frontmatterLineCount, bodyBelowFrontmatter } from '../../src/features/markdown/frontmatter';

const MENU = '[data-pkc-region="context-menu"]';

function setup(body: string, phase: AppState['phase'] = 'ready') {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  root.innerHTML = '<div data-pkc-region="detail"><div data-pkc-field="detail-body"></div></div>';
  document.body.append(root);
  const host = root.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
  host.innerHTML = renderMarkdown(bodyBelowFrontmatter(body), {
    sourceLineAnchors: true,
    taskLineOffset: frontmatterLineCount(body),
    interactiveCells: true,
  } as never);
  const metas = new Map<string, never>();
  for (const [i, lid] of ['n1', 'n2'].entries()) {
    metas.set(lid, { lid, title: lid, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: i + 1, status: null, date: null, archived: false } as never);
  }
  const d = new Dispatcher({
    ...initialState,
    cid: 'c1',
    phase,
    selectedLid: 'n1',
    entryMetas: metas as AppState['entryMetas'],
    openBody: { lid: 'n1', body, baseline: body, persisted: body, diskAhead: false },
  });
  const events: DomainEvent[] = [];
  d.onEvent((e) => void events.push(e));
  bindActions(root, d, {});
  const rightClick = (sel: string): boolean => {
    const el = host.querySelector(sel);
    if (el === null) throw new Error(`前提が崩れている: ${sel} が描かれていない`);
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  const labels = (): string[] =>
    [...(root.querySelector(MENU)?.querySelectorAll('button[data-pkc-action]') ?? [])].map(
      (b) => `${b.getAttribute('data-pkc-action')}:${b.textContent}`,
    );
  const press = (label: string): void => {
    const b = [...root.querySelectorAll<HTMLElement>(`${MENU} button[data-pkc-action]`)].find((x) => x.textContent === label);
    if (b === undefined) throw new Error(`前提が崩れている: 「${label}」が出ていない`);
    b.click();
  };
  const rewrites = (): BodyRewrite[] =>
    events.flatMap((e) => (e.type === 'REQUEST_BODY_REWRITE' ? [e.rewrite as BodyRewrite] : []));
  return { d, events, rightClick, labels, press, rewrites };
}

const BODY = '# 覚書\n\nまえ\n\n![図](asset:k1){w=50%}\n\n![別](asset:k2) と ![図](asset:k1)\n';

describe('画像の右クリック(大きさ・寄せ)', () => {
  it('🔴 画像の上でブラウザ既定を奪い、いまの値を除いた項目を出す', () => {
    const t = setup(BODY);
    const prevented = t.rightClick('img[data-pkc-asset-key="k1"]');
    expect(prevented, '画像の右クリックで自前のメニューが出ていない').toBe(true);
    const l = t.labels();
    expect(l).toContain('image-width:画像の大きさ: 25%');
    expect(l, 'いまの値(50%)は出さない').not.toContain('image-width:画像の大きさ: 50%');
    expect(l, '置けるなら外せる').toContain('image-width:画像の大きさ: もとに戻す');
    expect(l).toContain('image-align:画像を中央に寄せる');
    expect(l, '寄せが無いときは「もとに戻す」を出さない').not.toContain('image-align:画像の寄せ: もとに戻す');
  });

  it('🔴 押すと、押した画像の行だけを書き換える依頼が出る(同じ鍵が別の行にあっても)', () => {
    const t = setup(BODY);
    t.rightClick('img[data-pkc-asset-key="k2"]');
    t.press('画像を右に寄せる');
    const r = t.rewrites();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'image-attrs', key: 'k2', align: 'right', openLine: '![別](asset:k2) と ![図](asset:k1)' });
    const after = applyBodyRewrite(BODY, r[0]!);
    expect(after).toBe('# 覚書\n\nまえ\n\n![図](asset:k1){w=50%}\n\n![別](asset:k2){align=right} と ![図](asset:k1)\n');
  });

  it('🔴 もとに戻すは札を外す(w だけ外し、align は保つ)', () => {
    const body = '![図](asset:k1){w=50% align=center}\n';
    const t = setup(body);
    t.rightClick('img[data-pkc-asset-key="k1"]');
    t.press('画像の大きさ: もとに戻す');
    expect(applyBodyRewrite(body, t.rewrites()[0]!)).toBe('![図](asset:k1){align=center}\n');
  });

  it('🔴 frontmatter があっても行がずれない', () => {
    const body = '---\ntitle: x\n---\n\n![図](asset:k1)\n';
    const t = setup(body);
    t.rightClick('img[data-pkc-asset-key="k1"]');
    t.press('画像の大きさ: 25%');
    expect(applyBodyRewrite(body, t.rewrites()[0]!)).toBe('---\ntitle: x\n---\n\n![図](asset:k1){w=25%}\n');
  });

  it('🔴 編集中は書かず、理由を言う', () => {
    const t = setup(BODY, 'editing');
    t.rightClick('img[data-pkc-asset-key="k1"]');
    t.press('画像の大きさ: 25%');
    expect(t.rewrites()).toEqual([]);
    expect(t.d.getState().error ?? '').toContain('画像の大きさを変えてください');
  });

  it('リンクの中の画像は、ブラウザ既定のまま(奪わない)', () => {
    const t = setup('[![図](asset:k1)](https://example.com/)\n');
    expect(t.rightClick('img[data-pkc-asset-key="k1"]')).toBe(false);
  });
});

describe('body-rewrite image-attrs(書く側の門)', () => {
  it('押した時点と違う行・鍵の無い行は書かない', () => {
    const body = 'a\n![図](asset:k1)\n';
    expect(applyBodyRewrite(body, { kind: 'image-attrs', line: 1, openLine: '![図](asset:k1)', key: 'k1', w: 50 })).toBe('a\n![図](asset:k1){w=50%}\n');
    expect(applyBodyRewrite(body, { kind: 'image-attrs', line: 1, openLine: '別の行', key: 'k1', w: 50 }), '行が変わった').toBeNull();
    expect(applyBodyRewrite(body, { kind: 'image-attrs', line: 1, openLine: '![図](asset:k1)', key: 'zz', w: 50 }), '鍵が無い').toBeNull();
    expect(applyBodyRewrite(body, { kind: 'image-attrs', line: 1, openLine: '![図](asset:k1)', key: 'k1', w: null }), '変わらない').toBeNull();
  });
  it('行ごとの改行コードを保つ', () => {
    const body = 'a\r\n![図](asset:k1)\nb\r\n';
    expect(applyBodyRewrite(body, { kind: 'image-attrs', line: 1, openLine: '![図](asset:k1)', key: 'k1', align: 'left' })).toBe(
      'a\r\n![図](asset:k1){align=left}\nb\r\n',
    );
  });
});
