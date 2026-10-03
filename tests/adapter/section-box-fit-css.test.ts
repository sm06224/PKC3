/**
 * 🔴 **章の箱 / コード枠の箱の高さの上限は、viewport ではなく「読む面の器の高さ」とも
 * `min()` を取る**(2026-10-03。実ブラウザの smoke `context-menu.smoke.spec.ts` の
 * 「45 行の章は見出しもボタンも画面に収まり…」が、お知らせを 1 件足した PR で落ちて拾った)。
 *
 * ⚠ 直す前の `calc(var(--pkc-col-h, 100vh) - 300px)` は「読む面の高さは常に viewport − 206px」
 *   という前提で、shell の下の行(起動直後のお知らせのカード / 注意 / 収録中の帯 / タイマー)が
 *   出ている間は成り立たない ── 1280×800 で 5 項目のお知らせが 30vh(237px)まで伸びると
 *   器は 560px、箱 530px は見える 526px に収まらず、見出しの行が貼り付いた帯の下へ隠れた(実測)。
 * 🔑 器の高さは `read-columns.ts` の `exposePaneHeight` が `--pkc-pane-h` として px で下ろす。
 *   ここは **CSS が読んでいること**と**JS が書いていること**の両端を pin する(片方だけでは
 *   「書いているのに誰も読まない / 読んでいるのに誰も書かない」が静かに通る)。
 * ⚠ 「隠れない」こと自体は実ブラウザの smoke が結果で守る ── ここは規則の在処だけ。
 */
/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';
import { PANE_H_VAR, exposePaneHeight, fitColumnHeight } from '../../src/adapter/ui/render/read-columns';

const css = (): string => withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));

describe('章の箱の高さは器の高さにも頭打ちされる(2026-10-03)', () => {
  it.each(["[data-pkc-field='section-draft-input']", "[data-pkc-field='code-draft-input']"])(
    '🔴 %s の max-height は 100vh − 300px と 器 − 110px の min()',
    (sel) => {
      const b = blocksFor(css(), sel);
      expect(b.length, `${sel} の規則が無い(空振り)`).toBeGreaterThan(0);
      const text = b.join('\n');
      const m = /max-height:\s*([^;]+);/.exec(text);
      expect(m, 'max-height が無い').not.toBeNull();
      const v = m![1]!.replace(/\s+/g, ' ');
      expect(v, '100vh − 300px の既定が消えている(下の行が無い日の見た目が変わる)').toContain(
        'calc(var(--pkc-col-h, 100vh) - 300px)',
      );
      expect(v, '器の高さ(--pkc-pane-h)を読んでいない ── お知らせのカードが出ている間、見出しが帯の下へ隠れる').toContain(
        `calc(var(${PANE_H_VAR}, 100vh) - 110px)`,
      );
      expect(v.startsWith('min('), '2 つは min() で結ぶ(小さいほうが効く)').toBe(true);
    },
  );

  it('🔴 予備の値の無い var(--pkc-pane-h) を書かない(宣言ごと捨てられる)', () => {
    const text = css();
    const all = [...text.matchAll(/var\(--pkc-pane-h([^)]*)\)/g)];
    expect(all.length, '--pkc-pane-h を読む所が 1 つも無い(空振り)').toBeGreaterThan(0);
    for (const m of all) expect(m[1], `予備の値の無い var(--pkc-pane-h) が在る: ${m[0]}`).toMatch(/^\s*,/);
  });
});

function shell(): { root: HTMLElement; region: HTMLElement; pane: HTMLElement } {
  const root = document.createElement('div');
  const region = document.createElement('div');
  region.setAttribute('data-pkc-region', 'detail');
  const pane = document.createElement('div');
  pane.setAttribute('data-pkc-view-pane', 'detail');
  pane.setAttribute('data-pkc-detail-mode', 'view');
  region.append(pane);
  root.append(region);
  document.body.append(root);
  return { root, region, pane };
}

describe('器の高さを CSS へ下ろす(exposePaneHeight)', () => {
  it('🔴 器の clientHeight を px で、面ではなく器(面の親)へ書く', () => {
    const { root, region, pane } = shell();
    Object.defineProperty(region, 'clientHeight', { value: 560, configurable: true });
    expect(exposePaneHeight(root)).toBe(560);
    expect(region.style.getPropertyValue(PANE_H_VAR)).toBe('560px');
    // ⚠ 面には書かない ── 読む面は中身の高さまで伸びるので、面の高さは器の高さではない
    expect(pane.style.getPropertyValue(PANE_H_VAR)).toBe('');
    root.remove();
  });

  it('採寸できない(0)なら触らない ── 0px にすると箱が消える', () => {
    const { root, region } = shell();
    region.style.setProperty(PANE_H_VAR, '560px');
    Object.defineProperty(region, 'clientHeight', { value: 0, configurable: true });
    expect(exposePaneHeight(root)).toBeNull();
    expect(region.style.getPropertyValue(PANE_H_VAR), '0 の回に前の値を消した / 0px を書いた').toBe('560px');
    root.remove();
  });

  it('🔴 fitColumnHeight が段組みの有無に関わらず下ろす(1 段でも / off の経路でも)', () => {
    const { root, region } = shell();
    Object.defineProperty(region, 'clientHeight', { value: 420, configurable: true });
    // happy-dom は getBoundingClientRect が 0 なので fitColumnHeight 自体は null(= 段組みの採寸はしない)
    expect(fitColumnHeight(root, document)).toBeNull();
    expect(region.style.getPropertyValue(PANE_H_VAR), '段組みを採れない回に器の高さを下ろしていない').toBe('420px');
    root.remove();
  });

  it('🔴 見張りは面だけでなく器(面の親)も観る ── 長いノートでは器が縮んでも面は動かない(原文 pin)', () => {
    const rc = readFileSync('src/adapter/ui/render/read-columns.ts', 'utf8');
    expect(rc).toContain('exposePaneHeight(root);');
    expect(rc, '器を ResizeObserver で観ていない').toMatch(/watchedRegion = region;/);
    expect(rc, '変数名が CSS と食い違っている').toContain("PANE_H_VAR = '--pkc-pane-h'");
  });
});
