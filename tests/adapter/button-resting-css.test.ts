/** @vitest-environment happy-dom */
/**
 * 🔴 **字のあるボタンの静止の見え方**(#1982 ①)の原文検査と、**図案だけのボタンの印**(`data-pkc-icon-only`)。
 *
 * 見る点は 2 つ:
 *  ① 帯・書式バー・情報ペインの日付 / 担当の `button` の規則が、素の `button` の地と枠を**上書きしていない**
 *     (旧い「紙の上の帯はゴースト」が `background: transparent; border: none` を書いて、字と見分けがつかなかった)。
 *     例外は**値**(押せる札)だけで、名指しで数える。
 *  ② 図案だけのボタンは**印で**地を外す(`:where(button)[data-pkc-icon-only]`)── 印は本物の描画に付いている。
 * ⚠ 実ブラウザの computed は `tests/smoke/primary-action.smoke.spec.ts` が測る。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blocksFor, decl, stripComments } from '../helpers/css-blocks';
import { ICON_ONLY_ATTR, markIconOnly } from '../../src/adapter/ui/render/icons';
import { buildIconPalette } from '../../src/adapter/ui/render/icon-palette';
import { installQuickToc } from '../../src/adapter/ui/render/quick-toc';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { NoteTabsBar } from '../../src/adapter/ui/render/note-tabs';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { iconButton } from '../../src/adapter/ui/render/icons';

/** 全体(`@media` の中も含む)。コメントは剥ぐ。 */
const css = stripComments(readFileSync('src/styles/app.css', 'utf-8'));

/** 選択子(リストの 1 要素)と宣言の組を全部読む。 */
function rules(): { sel: string; body: string }[] {
  const out: { sel: string; body: string }[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const s of m[1]!.split(',')) out.push({ sel: s.trim().replace(/\s+/g, ' '), body: m[2]! });
  }
  return out;
}

describe('字のあるボタンは、帯の規則で地と枠を消されない(#1982 ①)', () => {
  /** 帯の中の `button`(子孫)を狙う選択子。 */
  const BAR_BUTTON = /(format-bar'\]|detail-toolbar'\]|inspector-(?:date|owner)'\]) (?:\[[^\]]*\])*button/;
  /** 例外 = **値**(字のまま置く札)。ここに挙げた選択子だけ地・枠を持ってよい。 */
  const VALUE_EXCEPTIONS = [
    "[data-pkc-field='inspector-owner'] button[data-pkc-field='inspector-owner-name']",
    "[data-pkc-field='inspector-date'] button[data-pkc-has-value]",
  ];
  const isException = (sel: string): boolean => VALUE_EXCEPTIONS.some((e) => sel === e || sel.startsWith(`${e}:`));

  it('🔴 書式バー・本文の帯・情報の日付 / 担当の button は background / border を書かない(値の札だけ例外)', () => {
    const hits = rules().filter((r) => BAR_BUTTON.test(r.sel));
    // ⚠ 空振り防止 ── 見るべき 3 つの帯が実際に拾えている(書式バー・日付・担当)
    for (const need of ['format-bar', 'inspector-date', 'inspector-owner']) {
      expect(hits.some((r) => r.sel.includes(need)), `${need} の button の規則を 1 つも拾えない(空振り)`).toBe(true);
    }
    const offenders = hits
      .filter((r) => !isException(r.sel))
      .filter((r) => /(?:^|[;\s])(background[a-z-]*|border[a-z-]*)\s*:/.test(r.body))
      .map((r) => r.sel);
    expect(offenders, '帯の button の規則が地・枠を上書きしている').toEqual([]);
  });

  it('🔴 本文の帯(detail-toolbar)の button を狙う規則は 1 つも無い(素の button に任せる)', () => {
    const toolbar = rules().filter((r) => /detail-toolbar'\] (?:\[[^\]]*\])*button/.test(r.sel));
    expect(toolbar.map((r) => r.sel)).toEqual([]);
  });

  it('⚠ 例外の札は 2 つだけ(増えたら、値かどうかを確かめて一覧へ足す)', () => {
    const hits = rules().filter((r) => BAR_BUTTON.test(r.sel) && isException(r.sel));
    expect(new Set(hits.map((r) => r.sel.split(':')[0])).size).toBe(VALUE_EXCEPTIONS.length);
    // 例外は枠なし・地なしの「字のまま」(下線だけ)
    const base = blocksFor(css, VALUE_EXCEPTIONS[0]!);
    expect(base).toHaveLength(1);
    expect(base[0]).toMatch(decl('background', 'none'));
  });

  it('🔴 書式バーの button は、枠(1px × 2)の分だけ余白を減らして**幅を変えない**', () => {
    const bar = blocksFor(css, "[data-pkc-region='format-bar'] button");
    expect(bar).toHaveLength(1);
    expect(bar[0]).toMatch(decl('padding', '0 calc\\(var\\(--s2\\) - 1px\\)'));
  });

  it('🔴 図案だけのボタンは印 1 つで地と枠を外す(`:where` で詳細度 0,1,0 = 面ごとの規則を上書きしない)', () => {
    const b = blocksFor(css, ':where(button)[data-pkc-icon-only]');
    expect(b).toHaveLength(1);
    expect(b[0]).toMatch(decl('background', 'transparent'));
    expect(b[0]).toMatch(decl('border-color', 'transparent'));
  });

  it('🔴 「その他」の開いた状態は hover より強い(地 + 縁。アクセントを使わない)', () => {
    const open = blocksFor(css, "[data-pkc-region='format-bar'] [data-pkc-field='format-more'][aria-expanded='true']");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatch(decl('background', 'var\\(--pkc-mark-bg\\)'));
    expect(open[0]).toMatch(/box-shadow:\s*inset 0 0 0 1px color-mix\(in srgb, var\(--fg\) \d+%, transparent\)/);
    expect(open[0], '開いた印にアクセントを使っている(アクセントは主の操作・焦点だけ)').not.toContain('--accent');
  });
});

describe('図案だけのボタンには印が付いている(本物の描画で)', () => {
  it('図案の表(icon-palette)の絵のボタンには付き、字の「なし」には付かない', () => {
    const box = buildIconPalette({ current: '', field: 'f', ariaLabel: 'a', each: () => {} });
    const all = [...box.querySelectorAll('button')];
    const drawn = all.filter((b) => b.querySelector('[data-pkc-icon]') !== null);
    expect(drawn.length, '絵のボタンが無い(空振り)').toBeGreaterThan(10);
    expect(drawn.every((b) => b.hasAttribute(ICON_ONLY_ATTR))).toBe(true);
    const none = all.find((b) => b.querySelector('[data-pkc-field="label"]') !== null);
    expect(none, '字の「なし」が無い').toBeDefined();
    expect(none!.hasAttribute(ICON_ONLY_ATTR), '字のあるボタンに図案だけの印').toBe(false);
  });

  it('目次の × に付いている', () => {
    const container = document.createElement('div');
    document.body.append(container);
    installQuickToc(container, document.createElement('div'));
    const close = container.querySelector('.pkc-quick-toc-close');
    expect(close, '目次の × が無い').not.toBeNull();
    expect(close!.hasAttribute(ICON_ONLY_ATTR)).toBe(true);
    // 開く側(`≡` + 字)は図案だけではない扱い ── 印の対象は × だけ
    expect(container.querySelector('.pkc-quick-toc-btn')!.hasAttribute(ICON_ONLY_ATTR)).toBe(false);
  });

  it('ノートのタブの × に付いている(タブ本体には付かない)', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const bar = new NoteTabsBar(regions.noteTabs);
    d.onState((s) => bar.render(s));
    bindActions(root, d, {});
    const meta = (lid: string, order: number) => ({
      lid, title: `t-${lid}`, archetype: 'text' as const, createdAt: null, updatedAt: null,
      entryOrder: order, status: null, date: null, archived: false, bodyChars: null,
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1), meta('b', 2)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'NOTE_TAB_OPEN', lid: 'b' });
    const closes = [...regions.noteTabs.querySelectorAll('[data-pkc-action="close-note-tab"]')];
    expect(closes.length, '× が無い(空振り)').toBeGreaterThanOrEqual(2);
    expect(closes.every((c) => c.hasAttribute(ICON_ONLY_ATTR))).toBe(true);
    expect(regions.noteTabs.querySelector('[role="tab"]')!.hasAttribute(ICON_ONLY_ATTR)).toBe(false);
  });

  it('markIconOnly は印を付けて同じボタンを返す。字のある iconButton は自動では付かない', () => {
    const b = document.createElement('button');
    expect(markIconOnly(b)).toBe(b);
    expect(b.hasAttribute(ICON_ONLY_ATTR)).toBe(true);
    expect(iconButton('export-markdown', 'Markdown').hasAttribute(ICON_ONLY_ATTR)).toBe(false);
  });
});
