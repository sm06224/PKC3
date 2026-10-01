/** @vitest-environment happy-dom */
/**
 * 🔴 **本文の `@日付` の右に添える「あと3日」「5日前」**(#1225)── どの日付に、いつ、差すか。
 *
 * 字そのものは `tests/features/relative-days.test.ts`、設定は `settings-relative-days.test.ts`。
 * ⚠ ここが見るのは **「どれに差し、どれに差さないか」** と **「日をまたいだら計算し直すか」**。
 *
 * 裁定(Gemini 2026-10-01 ①B):チェックが付いていない項目と、チェック項目でない地の文の
 * 日付だけ。済んだ項目には出さない。期間・繰り返しには出さない。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import {
  appRelativeDays,
  applyRelativeDays,
  clearRelativeDays,
  REL_ATTR,
  syncRelativeDays,
  watchRelativeDays,
} from '../../src/adapter/ui/render/relative-days';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

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

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function stateWithBody(body: string) {
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a')],
    relations: [],
  }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body }).state;
  return s;
}

/** 読む面(本物の DetailRenderer)で描く。 */
async function paint(body: string): Promise<HTMLElement> {
  const root = document.createElement('div');
  document.body.append(root);
  const detail = new DetailRenderer(buildShell(root).detail);
  detail.render(stateWithBody(body));
  await settle();
  return root.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
}

/** 今日から `n` 日後の `YYYY-MM-DD`(local)。 */
function ymd(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (v: number): string => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const relOf = (host: ParentNode, date: string): string | null =>
  host.querySelector(`.pkc-date-link[data-pkc-date="${date}"]`)?.getAttribute(REL_ATTR) ?? null;

afterEach(() => {
  appRelativeDays.setEnabled(true);
  document.body.textContent = '';
});

describe('どの日付に差すか(読む面 = 本物の DetailRenderer)', () => {
  it('🔴 チェックが付いていない項目と、地の文の日付に差す(今日 / 明日 / あとN日 / N日前)', async () => {
    const body = await paint(
      [
        `- [ ] 見積を送る @${ymd(3)}`,
        `- [ ] 会議 @${ymd(0)}`,
        `- [ ] 資料 @${ymd(1)}`,
        '',
        `地の文でも @${ymd(-5)} は過ぎた。`,
      ].join('\n') + '\n',
    );
    expect(relOf(body, ymd(3))).toBe('あと3日');
    expect(relOf(body, ymd(0))).toBe('今日');
    expect(relOf(body, ymd(1))).toBe('明日');
    expect(relOf(body, ymd(-5))).toBe('5日前');
  });

  it('🔴 済んだ項目には差さない(同じ形の未了の項目には差す ── 対照群)', async () => {
    const body = await paint(`- [x] 済んだ @${ymd(3)}\n- [ ] まだ @${ymd(4)}\n`);
    // ⚠ 空振り防止 ── 日付は両方とも押せる字として在る
    expect(body.querySelectorAll('.pkc-date-link')).toHaveLength(2);
    expect(relOf(body, ymd(3)), '済んだ項目に出ている').toBeNull();
    expect(relOf(body, ymd(4)), '未了の項目に出ていない').toBe('あと4日');
  });

  it('🔴 期間と繰り返しには差さない(単日の隣では差す ── 対照群)', async () => {
    const body = await paint(
      [
        `出張 @${ymd(2)}..${ymd(5)} です`,
        `- [ ] ゴミ出し @${ymd(7)} 毎週`,
        `- [ ] 提出 @${ymd(9)}`,
      ].join('\n') + '\n',
    );
    expect(body.querySelectorAll('.pkc-date-link')).toHaveLength(3);
    expect(relOf(body, ymd(2)), '期間の開始に出ている').toBeNull();
    expect(relOf(body, ymd(7)), '繰り返しに出ている').toBeNull();
    expect(relOf(body, ymd(9))).toBe('あと9日');
  });

  it('🔴 入れ子は「その日付がある行」の項目で決まる(外側の済みに引きずられない)', async () => {
    const body = await paint(
      [
        `- [x] 済んだ親 @${ymd(10)}`,
        `  - 子の地の文 @${ymd(11)}`,
        `- [ ] 未了の親`,
        `  - [x] 済んだ子 @${ymd(12)}`,
        `  - [ ] 未了の子 @${ymd(13)}`,
      ].join('\n') + '\n',
    );
    expect(body.querySelectorAll('.pkc-date-link')).toHaveLength(4);
    expect(relOf(body, ymd(10)), '済んだ親に出ている').toBeNull();
    expect(relOf(body, ymd(11)), '済んだ親の中の地の文(別の項目)に出ていない').toBe('あと11日');
    expect(relOf(body, ymd(12)), '済んだ子に出ている').toBeNull();
    expect(relOf(body, ymd(13)), '未了の子に出ていない').toBe('あと13日');
  });

  it('🔴 原文も本文の字も変えない(添え字は属性にだけ在り、textContent に入らない)', async () => {
    const text = `- [ ] 見積を送る @${ymd(3)}\n`;
    const body = await paint(text);
    expect(relOf(body, ymd(3))).toBe('あと3日'); // 空振り防止
    expect(body.textContent, '添え字が本文の字に入っている').not.toContain('あと3日');
    expect(body.textContent).toContain(`@${ymd(3)}`);
  });

  it('🔴 設定を切ると 1 つも差さない(入れば差す ── 対照群)', async () => {
    const text = `- [ ] 見積を送る @${ymd(3)}\n`;
    appRelativeDays.setEnabled(true);
    expect(relOf(await paint(text), ymd(3))).toBe('あと3日');
    document.body.textContent = '';
    appRelativeDays.setEnabled(false);
    const body = await paint(text);
    expect(body.querySelectorAll('.pkc-date-link'), '空振り(日付が押せる字で無い)').toHaveLength(1);
    expect(body.querySelector(`[${REL_ATTR}]`), '切なのに差している').toBeNull();
  });
});

describe('差す / 外す / 計算し直す', () => {
  const root = (html: string): HTMLElement => {
    const el = document.createElement('div');
    el.innerHTML = html;
    document.body.append(el);
    return el;
  };
  const span = (date: string, extra = ''): string =>
    `<span class="pkc-date-link" data-pkc-date="${date}"${extra}>@${date}</span>`;

  it('🔴 日をまたぐと、同じ描画結果のまま字が変わる(描画結果に日数を焼いていない)', () => {
    const r = root(`<p>${span('2026-10-04')}</p>`);
    applyRelativeDays(r, '2026-10-01');
    expect(relOf(r, '2026-10-04')).toBe('あと3日');
    applyRelativeDays(r, '2026-10-02');
    expect(relOf(r, '2026-10-04')).toBe('あと2日');
    applyRelativeDays(r, '2026-10-04');
    expect(relOf(r, '2026-10-04')).toBe('今日');
    applyRelativeDays(r, '2026-10-06');
    expect(relOf(r, '2026-10-04')).toBe('2日前');
  });

  it('🔴 描画結果そのものに日数は書かれない(書き出しにも入らない)', () => {
    const on = renderMarkdown(`- [ ] x @${ymd(3)}\n`, { interactiveDates: true });
    const off = renderMarkdown(`- [ ] x @${ymd(3)}\n`);
    expect(on, '空振り(押せる字になっていない)').toContain('pkc-date-link');
    expect(on).not.toContain(REL_ATTR);
    expect(off).not.toContain(REL_ATTR);
  });

  it('🔴 済ませた(チェックを付けた)後の計算し直しで、添え字が外れる', () => {
    const r = root(
      `<ul><li class="pkc-task-item"><p><input type="checkbox" class="pkc-task-checkbox"> 見積 ${span('2026-10-04')}</p></li></ul>`,
    );
    applyRelativeDays(r, '2026-10-01');
    expect(relOf(r, '2026-10-04'), '未了なのに出ていない').toBe('あと3日');
    r.querySelector<HTMLInputElement>('.pkc-task-checkbox')!.checked = true;
    applyRelativeDays(r, '2026-10-01');
    expect(relOf(r, '2026-10-04'), '済ませたのに残っている').toBeNull();
  });

  it('🔴 clearRelativeDays は差したものを全部外す(日付そのものは残る)', () => {
    const r = root(`<p>${span('2026-10-04')} ${span('2026-10-09')}</p>`);
    applyRelativeDays(r, '2026-10-01');
    expect(r.querySelectorAll(`[${REL_ATTR}]`)).toHaveLength(2);
    clearRelativeDays(r);
    expect(r.querySelectorAll(`[${REL_ATTR}]`)).toHaveLength(0);
    expect(r.querySelectorAll('.pkc-date-link')).toHaveLength(2);
  });

  it('🔴 読めない日付・種類つき(期間 / 繰り返し)には差さず、既に差していた物は外す', () => {
    const r = root(
      `<p>${span('2026-10-04', ` ${REL_ATTR}="古い"`)} ${span('2026-10-05', ` data-pkc-date-kind="range" ${REL_ATTR}="古い"`)} ${span('いつか', ` ${REL_ATTR}="古い"`)}</p>`,
    );
    applyRelativeDays(r, '2026-10-01');
    expect(relOf(r, '2026-10-04')).toBe('あと3日'); // 古い字が差し替わる(対照群)
    expect(relOf(r, '2026-10-05'), '期間に残っている').toBeNull();
    expect(relOf(r, 'いつか'), '読めない日付に残っている').toBeNull();
  });

  it('🔴 syncRelativeDays は設定に従う(入なら差し、切なら外す)', () => {
    const r = root(`<p>${span('2026-10-04')}</p>`);
    const now = new Date(2026, 9, 1);
    appRelativeDays.setEnabled(true);
    syncRelativeDays(r, now);
    expect(relOf(r, '2026-10-04')).toBe('あと3日');
    appRelativeDays.setEnabled(false);
    syncRelativeDays(r, now);
    expect(relOf(r, '2026-10-04'), '切にしたのに残っている').toBeNull();
  });
});

describe('画面に戻ってきたとき(visible)に計算し直す(常駐タイマーは立てない)', () => {
  function setVisibility(v: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }
  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('🔴 visible で計算し直す / hidden では触らない / 外したら止まる', () => {
    const r = document.createElement('div');
    r.innerHTML = '<p><span class="pkc-date-link" data-pkc-date="2026-10-04">@2026-10-04</span></p>';
    document.body.append(r);
    let now = new Date(2026, 9, 1);
    const stop = watchRelativeDays(document, r, () => now);

    setVisibility('visible');
    expect(relOf(r, '2026-10-04'), '戻ってきたのに計算していない').toBe('あと3日');

    now = new Date(2026, 9, 3); // 日をまたいだ
    setVisibility('hidden');
    expect(relOf(r, '2026-10-04'), '隠れた時に計算している(visible の時だけ)').toBe('あと3日');
    setVisibility('visible');
    expect(relOf(r, '2026-10-04'), '日をまたいだのに古いまま').toBe('明日');

    stop();
    now = new Date(2026, 9, 4);
    setVisibility('visible');
    expect(relOf(r, '2026-10-04'), '外したのに動いている').toBe('明日');
  });

  it('🔴 設定を切っていれば、戻ってきても差さない', () => {
    const r = document.createElement('div');
    r.innerHTML = '<p><span class="pkc-date-link" data-pkc-date="2026-10-04">@2026-10-04</span></p>';
    document.body.append(r);
    appRelativeDays.setEnabled(false);
    const stop = watchRelativeDays(document, r, () => new Date(2026, 9, 1));
    setVisibility('visible');
    expect(relOf(r, '2026-10-04')).toBeNull();
    stop();
  });
});
