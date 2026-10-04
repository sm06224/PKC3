/**
 * 🔴 **音の再生機の貼り付き(#1232 段 b)の規則を、CSS を構文で読んで pin する。**
 *
 * 配置そのものは happy-dom では測れない(実ブラウザの smoke `media-capture.smoke.spec.ts` が見る)。
 * ここが守るのは**規則の宛先と文脈**:
 *   ① 貼り付くのは「直下に `<audio>` が居る器」だけ ── **`<video>` を宛先に入れない**(動画は大きく、貼ると本文を潰す。
 *      smoke に動画の fixture が無いので、ここが唯一の門)
 *   ② 印刷と低い窓では解く(`position: static`)
 *   ③ 見出しの余白は `[data-pkc-prose]` 起点(`.pkc-md-rendered` 起点は書き出しへ焼かれる)
 * ⚠ 字面の `toContain` ではなく、`build/body-css.ts` の `parseRules`(コメントを落とし、`@media` の文脈を持ち運ぶ)で
 *   規則を拾い、**選択子**を見る ── 解説コメントの字や、別の規則の字に満たされない。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseRules } from '../../build/body-css';

const CSS = readFileSync('src/styles/app.css', 'utf8');
const norm = (s: string): string => s.replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
const rules = parseRules(CSS).map((r) => ({ at: r.at.map(norm), sel: norm(r.selector), body: norm(r.body) }));

/** 「直下に audio が居る」を条件に持つ器の規則(`:has(> audio…)`)。 */
const playerRules = rules.filter((r) => r.sel.includes('attachment-preview') && r.sel.includes(':has('));

describe('音の再生機の貼り付き(#1232 段 b)', () => {
  it('🔴 貼り付く規則は 1 本で、宛先は「直下の <audio>」だけ ── <video> を含まず、書き出しへ焼かれる起点でもない', () => {
    const sticky = playerRules.filter((r) => r.at.length === 0 && /position: sticky/.test(r.body));
    expect(sticky, '画面で貼り付く規則がちょうど 1 本でない(消えた / 増えた)').toHaveLength(1);
    const sel = sticky[0]!.sel;
    expect(sel, '宛先が直下の <audio> でない').toContain(':has(> audio[data-pkc-field=attachment-media])');
    expect(sel, '動画まで貼り付く宛先になっている').not.toContain('video');
    expect(sel, '画像・PDF の器まで宛先に入っている').not.toMatch(/img|object|iframe/);
    expect(sel, '書き出しへ焼かれる起点(.pkc-md-rendered)になっている').not.toContain('.pkc-md-rendered');
    // 地と重なりの順(smoke は実ブラウザの計算後の値で見る ── ここは宣言が在ること)
    expect(sticky[0]!.body).toMatch(/background: var\(--surface\)/);
    expect(sticky[0]!.body).toMatch(/z-index: 1/);
    // 帯の高さを測った変数に乗る(固定の px だけにしない)
    expect(sticky[0]!.body).toContain('var(--pkc-detail-bar-h');
  });

  it('🔴 印刷と低い窓(高さ 30rem 以下)では貼り付きを解く(同じ宛先の規則が static)', () => {
    const sticky = playerRules.find((r) => r.at.length === 0 && /position: sticky/.test(r.body))!;
    const printStatic = playerRules.filter((r) => r.at.some((a) => a.includes('@media print')) && /position: static/.test(r.body));
    const lowStatic = playerRules.filter((r) => r.at.some((a) => a.includes('max-height: 30rem')) && /position: static/.test(r.body));
    expect(printStatic, '印刷で解く規則が無い').toHaveLength(1);
    expect(lowStatic, '低い窓で解く規則が無い').toHaveLength(1);
    // 解く規則の宛先は、貼る規則と**同じ**(宛先がずれると解けない)
    expect(printStatic[0]!.sel).toBe(sticky.sel);
    expect(lowStatic[0]!.sel).toBe(sticky.sel);
  });

  it('🔴 見出しの余白は [data-pkc-prose] 起点で、帯 + 再生機の高さを引く(低い窓では帯だけ)', () => {
    const margin = rules.filter((r) => r.sel.includes(':is(h1, h2, h3, h4, h5, h6)') && /scroll-margin-top/.test(r.body));
    const screen = margin.filter((r) => r.at.length === 0);
    const low = margin.filter((r) => r.at.some((a) => a.includes('max-height: 30rem')));
    expect(screen, '画面の余白の規則がちょうど 1 本でない').toHaveLength(1);
    expect(low, '低い窓の余白の規則がちょうど 1 本でない').toHaveLength(1);
    expect(screen[0]!.sel.startsWith('[data-pkc-prose]'), '起点が [data-pkc-prose] でない').toBe(true);
    expect(low[0]!.sel.startsWith('[data-pkc-prose]')).toBe(true);
    expect(screen[0]!.body).toContain('var(--pkc-detail-bar-h');
    expect(screen[0]!.body).toContain('var(--pkc-sticky-player-h');
    // 低い窓では再生機が貼り付かないので、余白に再生機の高さを足さない
    expect(low[0]!.body).toContain('var(--pkc-detail-bar-h');
    expect(low[0]!.body, '貼り付かない再生機の高さまで余白に足している').not.toContain('--pkc-sticky-player-h');
  });
});
