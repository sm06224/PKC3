/** @vitest-environment happy-dom */
/**
 * 🔴 **広い面(別ウィンドウ / 中央)の配置**(#1442 S3-1。Stage 3 PR-1)。
 *
 * 見るのは 3 点(寸法そのものは実ブラウザの smoke `builtin-apps.smoke.spec.ts` が測る):
 * ① 🔴 **予定表の DOM** ── 広い面(`data-pkc-view-pane`)だけ「操作の列」と「見る所」の 2 つの箱を作り、
 *    左の列(`data-pkc-browse-pane`)は**箱を作らず、元の並びのまま**(見え方を変えない)
 * ② 🔴 **録ったものの「聞いている 1 枚」の印** ── 格子の中でその 1 枚だけ行いっぱいに広げる CSS が読む
 * ③ 🔴 **CSS の置き方** ── 判定は面そのものの幅(`container: pkc-wide`)に 1 か所寄せ、
 *    左の列(`browse-pane`)の選択子を 1 つも足していない / 箱の配置は `@container` の中にある(詳細度で負けない)
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { CapturesRenderer } from '../../src/adapter/ui/render/captures';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { captureItemsFrom } from '../../src/features/capture/capture-item';

const NOW = (): Date => new Date(2026, 10, 24);

function scheduleHost(attr: 'data-pkc-view-pane' | 'data-pkc-browse-pane'): HTMLElement {
  const host = document.createElement('div');
  host.setAttribute(attr, 'schedule');
  document.body.append(host);
  new ScheduleRenderer(host, NOW).render({ ...initialState, calendarMonth: { year: 2026, month: 11 } } as AppState);
  return host;
}
const fields = (el: Element): string[] => [...el.children].map((c) => c.getAttribute('data-pkc-field') ?? c.getAttribute('data-pkc-region') ?? '');

describe('予定表の箱(広い面だけ 2 つに分ける)', () => {
  it('🔴 広い面は「操作の列(rail)」と「見る所(main)」を持ち、中身の並びが正しい', () => {
    const host = scheduleHost('data-pkc-view-pane');
    expect(fields(host), '箱が 2 つ(操作の列 → 見る所)').toEqual(['schedule-rail', 'schedule-main']);
    const rail = host.querySelector('[data-pkc-field="schedule-rail"]')!;
    const main = host.querySelector('[data-pkc-field="schedule-main"]')!;
    // 操作 = 月の送り・見せ方・追加欄・小さな月・切替・書き出し・知らせ(元の順のまま)
    expect(fields(rail).slice(0, 4)).toEqual(['schedule-toolbar', 'schedule-modes', 'schedule-quick', 'schedule-grid']);
    expect(fields(rail)).toContain('schedule-export');
    expect(fields(rail)).toContain('schedule-notify');
    // 見る所 = 日 / 週 / 月 / カンバン / 日ごとの一覧
    expect(fields(main)).toEqual(['schedule-day', 'schedule-weekview', 'schedule-monthview', 'schedule-board', 'schedule-groups']);
    // 空振り防止: 見る所の中身は本当に描かれている(日ごとの一覧の箱が在り、操作の列に月の送りの 2 ボタンがある)
    expect(main.querySelector('[data-pkc-region="schedule-groups"]')).not.toBeNull();
    expect(rail.querySelectorAll('[data-pkc-action="schedule-nav"]')).toHaveLength(2);
  });

  it('🔴 対照群: 左の列(狭い面)は箱を作らず、14 個の部品が元の順のまま並ぶ', () => {
    const host = scheduleHost('data-pkc-browse-pane');
    expect(host.querySelector('[data-pkc-field="schedule-rail"], [data-pkc-field="schedule-main"]'), '左の列に箱ができた').toBeNull();
    expect(fields(host)).toEqual([
      'schedule-toolbar',
      'schedule-modes',
      'schedule-quick',
      'schedule-grid',
      'schedule-note',
      'schedule-clear-filter',
      'schedule-toggles',
      'schedule-export',
      'schedule-notify',
      'schedule-day',
      'schedule-weekview',
      'schedule-monthview',
      'schedule-board',
      'schedule-groups',
    ]);
  });
});

describe('録ったものの「聞いている 1 枚」の印', () => {
  const body = ['---', 'attachment.name: 録音.webm', 'attachment.mime: audio/webm', 'attachment.size: 2048', 'attachment.asset_key: k-1', '---', ''].join('\n');
  const items = (): ReturnType<typeof captureItemsFrom> =>
    captureItemsFrom([
      { lid: 'a', title: 'a', body },
      { lid: 'b', title: 'b', body: body.replace('k-1', 'k-2') },
    ]);
  const lender = {
    getBlob: async (): Promise<Blob | null> => null,
    lend: async (k: string): Promise<{ url: string; dispose: () => void }> => ({ url: `blob:${k}`, dispose: () => undefined }),
  };

  it('🔴 聞いている行だけに印が付き、やめると外れる(対照群 = 別の行には付かない)', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const r = new CapturesRenderer(host, lender, () => undefined);
    r.render({ ...initialState, captureItems: items() } as AppState);
    const open = (): string[] => [...host.querySelectorAll('[data-pkc-capture-open]')].map((e) => e.getAttribute('data-pkc-capture') ?? '');
    expect(open(), '聞く前から印が付いている').toEqual([]);
    r.render({ ...initialState, captureItems: items(), capturePlayingLid: 'a' } as AppState);
    await new Promise((res) => setTimeout(res, 20));
    r.render({ ...initialState, captureItems: items(), capturePlayingLid: 'a' } as AppState);
    expect(open(), '聞いている 1 行だけに印が付く').toEqual(['a']);
    r.render({ ...initialState, captureItems: items(), capturePlayingLid: null } as AppState);
    expect(open(), 'やめたのに印が残る').toEqual([]);
  });
});

/** コメントを剥がした CSS。⚠ コメントの中の文字で満たさない(CLAUDE.md §6-1)。 */
const css = (): string => readFileSync('src/styles/app.css', 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
/** S3-1 の節だけ(ブロックの先頭は container 宣言、末尾は PC のボタン)。 */
const block = (): string => {
  const c = css();
  const a = c.indexOf("[data-pkc-view-pane='schedule'],\n[data-pkc-view-pane='contacts']");
  const b = c.indexOf("[data-pkc-view-pane='pc'] [data-pkc-field='pc-office']");
  expect(a, 'S3-1 の節の頭が見つからない(検査が何も見ていない)').toBeGreaterThan(0);
  expect(b, 'S3-1 の節の終わりが見つからない').toBeGreaterThan(a);
  return c.slice(a, b + 120);
};

describe('広い面の CSS の置き方', () => {
  it('🔴 判定は面の幅(container)の 1 つに寄せ、4 つの面に同じ名前で宣言している', () => {
    const b = block();
    expect(b).toMatch(/\[data-pkc-view-pane='timers'\],\s*\[data-pkc-view-pane='captures'\]\s*\{\s*container:\s*pkc-wide \/ inline-size;/);
    // 名前の無い container 問い合わせ・media による別判定を、この節に足していない
    expect(b.match(/@media/g) ?? [], 'この節に別の判定(@media)がある').toEqual([]);
    for (const q of b.match(/@container[^{]*/g) ?? []) expect(q.trim()).toMatch(/^@container pkc-wide \(min-width: \d+rem\)$/);
  });

  it('🔴 左の列(browse-pane)の選択子を 1 つも足していない / 節の全部の選択子が広い面(view-pane)に限られている(見え方を変えない)', () => {
    expect(block()).not.toContain('browse-pane');
    // 器の限定を 1 つ外すと、同じ描画器を使う左の列へ規則が漏れる(幅が狭いうちは見分けがつかなくても、幅が増えた日に崩れる)
    const selectors = [...block().matchAll(/([^{}]+)\{/g)].map((m) => m[1]!.trim()).filter((q) => !q.startsWith('@container'));
    expect(selectors.length, '選択子を 1 つも読めていない').toBeGreaterThan(15);
    for (const q of selectors) for (const one of q.split(',')) expect(one, `器の限定(data-pkc-view-pane)が無い選択子: ${one.trim()}`).toContain('data-pkc-view-pane');
  });

  it('🔴 予定の箱の配置は @container の中にあり、詳細度が基本の規則に負けない(同じ親 + 子の選択子)', () => {
    const c = css();
    const at = c.indexOf('@container pkc-wide (min-width: 60rem)');
    expect(at).toBeGreaterThan(0);
    const end = c.indexOf("[data-pkc-view-pane='contacts'] [data-pkc-field='contacts-list']", at);
    expect(end, '予定の @container の終わりが見つからない').toBeGreaterThan(at);
    const q = c.slice(at, end);
    expect(q).toContain("[data-pkc-view-pane='schedule'] > [data-pkc-field='schedule-rail']");
    expect(q).toContain("[data-pkc-view-pane='schedule'] > [data-pkc-field='schedule-main']");
    expect(q).toMatch(/schedule-rail'\]\s*\{[^}]*flex:\s*0 0 21rem/);
    expect(q).toMatch(/schedule-main'\]\s*\{[^}]*flex:\s*1 1 0/);
    // 基本(狭いとき)は 1 列に積む
    expect(c).toMatch(/> \[data-pkc-field='schedule-main'\]\s*\{[^}]*flex:\s*1 0 100%/);
  });

  it('🔴 「+」は見出しの隣(左寄せ)/ 連絡先・録ったものは自動で列が増える格子 / 時間は 4 列の表 / グラフ・PC の直し', () => {
    const b = block();
    expect(b).toMatch(/schedule-group-label'\]\s*\{\s*justify-content:\s*flex-start;/);
    expect(b).toMatch(/contacts-list'\]\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill, minmax\(min\(100%, 17rem\), 1fr\)\)/);
    expect(b).toMatch(/captures-list'\]\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill, minmax\(min\(100%, 19rem\), 1fr\)\)/);
    expect(b).toMatch(/li\[data-pkc-capture-open\]\s*\{\s*grid-column:\s*1 \/ -1;/);
    expect(b).toMatch(/timers-list'\] > li\s*\{[^}]*grid-template-columns:\s*11rem minmax\(0, 1fr\) minmax\(0, 1\.2fr\) auto/);
    expect(b).toMatch(/graph-map'\]\s*\{[^}]*height:\s*calc\(100dvh - 7\.5rem\)/);
    expect(b).toMatch(/pc-office'\]\s*\{\s*align-self:\s*flex-start;/);
  });
});
