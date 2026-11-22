/** @vitest-environment happy-dom */
/**
 * 🔴 **ログの見た目の 3 段**(#2018 8。user 裁定 2026-11-22)── 日の行 / 親の記録(`##` の時刻)/ 入れ子の追いログ(`###`〜)。
 *
 * 守る主張:
 * 1. 印(`data-pkc-log-depth` / `data-pkc-log-time`)はログの読む面にだけ付き、ログでない面には 1 つも残さない
 * 2. 規則は**画面だけ**(`@media screen` の中)── 印刷・書き出しは今までのまま
 * 3. 色は意味にだけ: 使う色は `--fg` / `--muted` / `--surface-2` だけ(強調色を使わない)。その組は 12 テーマで地の上 4.5:1 以上
 *    (時刻の字 = 文字 4.5:1、縦線 = 部品 3:1 を満たす)── 比は `theme-tokens.test.ts` の対(`--muted` × `--surface` /
 *    `--bg` / `--surface-2`、`--fg` × `--surface-2`)が全テーマで見ている。ここは「その組しか使っていない」ことを見る
 * 4. 1px の格子にしない: 枠線(`border` の幅を足す宣言)を足さない ── 区切りは背景の段差と余白。縦線は背景の 2px の帯
 *
 * ⚠ 実際の見え方(段差・字下げ・縦線のつながり)は実ブラウザのスクリーンショットで見る(`tests/smoke/log-visual.smoke.spec.ts`)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyHeadingFold } from '../../src/adapter/ui/render/heading-fold';
import { LOG_DAYS_HOST_ATTR, LOG_DEPTH_ATTR, LOG_TIME_ATTR } from '../../src/adapter/ui/render/log-days';

const HTML =
  '<h3 id="pre-h">前置きの小見出し</h3>' +
  '<h2 id="a">2026-10-09 09:00:00</h2><p id="a1">朝</p>' +
  '<h3 id="a2">2026-10-09 09:30:00</h3><p id="a3">追い</p>' +
  '<h4 id="a4">2026-10-09 09:40:00</h4><p id="a5">追いの追い</p>' +
  '<h2 id="b">手書きの見出し</h2><p id="b1">ふつう</p>';

function host(log: boolean): HTMLElement {
  const h = document.createElement('div');
  if (log) h.setAttribute(LOG_DAYS_HOST_ATTR, '');
  h.innerHTML = HTML;
  document.body.append(h);
  applyHeadingFold(h);
  return h;
}
const depth = (h: HTMLElement, id: string): string | null => h.querySelector(`#${id}`)!.getAttribute(LOG_DEPTH_ATTR);
const time = (h: HTMLElement, id: string): boolean => h.querySelector(`#${id}`)!.hasAttribute(LOG_TIME_ATTR);

describe('印', () => {
  it('🔴 入れ子の深さ: 親の記録は無し、### とその中身は 1、#### は 2、次の ## で戻る。前置きの ### は記録の外', () => {
    const h = host(true);
    expect(['pre-h', 'a', 'a1', 'a2', 'a3', 'a4', 'a5', 'b', 'b1'].map((id) => depth(h, id))).toEqual([
      null,
      null,
      null,
      '1',
      '1',
      '2',
      '2',
      null,
      null,
    ]);
  });

  it('🔴 時刻の見出しの印は、日時で始まる見出し(親・入れ子とも)だけ。手書きの見出し・段落には付けない', () => {
    const h = host(true);
    expect(['a', 'a2', 'a4', 'b', 'a1', 'pre-h'].map((id) => time(h, id))).toEqual([true, true, true, false, false, false]);
  });

  it('⚠ 対照群: ログでない面には 1 つも付けない / ログから外れたら外す', () => {
    const plain = host(false);
    expect(plain.querySelectorAll(`[${LOG_DEPTH_ATTR}], [${LOG_TIME_ATTR}]`)).toHaveLength(0);
    const h = host(true);
    expect(h.querySelectorAll(`[${LOG_DEPTH_ATTR}]`).length, '前提: 印が付いていない').toBeGreaterThan(0);
    h.removeAttribute(LOG_DAYS_HOST_ATTR);
    applyHeadingFold(h);
    expect(h.querySelectorAll(`[${LOG_DEPTH_ATTR}], [${LOG_TIME_ATTR}]`)).toHaveLength(0);
  });
});

describe('CSS', () => {
  const css = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  /** 印を使う規則の塊(`@media screen { … }` の中身)。 */
  function screenBlock(): string {
    const at = css.indexOf('@media screen {');
    expect(at, '画面だけの節が無い').toBeGreaterThanOrEqual(0);
    let depthCount = 0;
    for (let i = css.indexOf('{', at); i < css.length; i += 1) {
      if (css[i] === '{') depthCount += 1;
      else if (css[i] === '}') {
        depthCount -= 1;
        if (depthCount === 0) return css.slice(at, i + 1);
      }
    }
    throw new Error('画面だけの節が閉じていない');
  }

  it('🔴 印(log-depth / log-time)を使う規則は画面だけの節の中にしか無い(印刷・書き出しは今までのまま)', () => {
    const block = screenBlock();
    expect(block, '空振り防止: 節の中に入れ子の規則が無い').toContain('[data-pkc-log-depth]');
    const outside = css.replace(block, '');
    expect(outside).not.toMatch(/data-pkc-log-depth|data-pkc-log-time/);
  });

  it('🔴 使う色は --fg / --muted / --surface-2 だけ(強調色を使わない)・枠線の幅を足さない', () => {
    const block = screenBlock();
    const vars = new Set([...block.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!));
    for (const v of vars) expect(['--fg', '--muted', '--surface-2', '--radius'], `使わない色: ${v}`).toContain(v);
    // 縦線は背景の 2px の帯(字下げした位置)── 色は --muted
    expect(block, '縦線が --muted でない').toMatch(/background-image:\s*linear-gradient\(var\(--muted\),\s*var\(--muted\)\)/);
    expect(block).toMatch(/background-size:\s*2px 100%/);
    // 🔴 字下げは padding(塊の左の余白は読み幅を中央に置く規則が持つ ── margin で付けると負けて字下げが出ない)
    expect(block).not.toMatch(/margin-inline-start/);
    // 枠を足す宣言(border: 1px … / border-*: Npx solid)は置かない ── 既存の見出しの帯の幅を 2px にするだけ
    expect(block).not.toMatch(/border(?:-[a-z-]+)?:\s*\d+px\s+solid/);
  });
});
