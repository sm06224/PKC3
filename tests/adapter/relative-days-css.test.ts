/**
 * 🔴 **「あとN日」の見た目と、配線が外れていないこと**(#1225)。
 *
 * - CSS は**構文で**読む(`helpers/css-blocks.ts`)。⚠ 書き出す HTML の `<style>` に**焼かれない**
 *   こと(`.pkc-md-rendered` を起点にしない)── 焼かれると、字を差す相手が居ない書き出しに
 *   規則だけが載る。
 * - `main.ts` はどの test からも走らないので、**日をまたぐ計算し直しの配線**は原文で pin する
 *   (弱いと自覚して使う ── 判断は `relative-days.ts` に在り、そちらは test が走る)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';
import { codeOnly } from '../helpers/code-only';
import { extractBodyCss } from '../../build/body-css';

const RAW = readFileSync('src/styles/app.css', 'utf8');
const css = withoutMedia(stripComments(RAW));
const SEL = '[data-pkc-prose] .pkc-date-link[data-pkc-rel]::after';

describe('添え字の見た目(#1225)', () => {
  it('🔴 属性から字を出し、薄い無彩色・下線なし(日付の点線を字の続きにしない)', () => {
    const blocks = blocksFor(css, SEL);
    expect(blocks.length, '添え字の規則が無い(空振り)').toBe(1);
    const b = blocks[0]!;
    // 字は属性から ── 描画結果にも原文にも書かないので、選べずコピーにも入らない
    expect(b).toMatch(decl('content', "' ' attr\\(data-pkc-rel\\)"));
    expect(b, '色は薄い無彩色(--muted)').toMatch(decl('color', 'var\\(--muted\\)'));
    // 🔴 日付の点線の下線が、この字へ伸びない(装飾は子へ伝わる。inline-block でなければ外せない)
    expect(b).toMatch(decl('display', 'inline-block'));
  });

  it('🔴 書き出しの CSS に焼かれない(`.pkc-md-rendered` 起点でない = 読む面の印だけが持つ)', () => {
    const tokens = readFileSync('src/styles/tokens.css', 'utf8');
    const baked = extractBodyCss(RAW, tokens).css;
    expect(baked.length, '空振り(書き出しの CSS が空)').toBeGreaterThan(1000);
    expect(baked, '書き出しの <style> へ焼かれている').not.toContain('data-pkc-rel');
  });
});

describe('日をまたぐ計算し直しの配線(#1225。main.ts は原文で pin)', () => {
  const main = codeOnly(readFileSync('src/main.ts', 'utf8'));
  it('🔴 画面に戻ってきたとき(visibilitychange)に計算し直す口を渡している', () => {
    expect(main).toContain('watchRelativeDays(document, document)');
  });
  it('🔴 設定を切り替えたら、描き直さずその場で付け直す / 外す', () => {
    const at = main.indexOf('setRelativeDays:');
    expect(at, '受け手が渡されていない').toBeGreaterThan(-1);
    const body = main.slice(at, at + 200);
    expect(body).toContain('appRelativeDays.setEnabled(on)');
    expect(body).toContain('syncRelativeDays(document)');
  });
  it('⚠ 常駐タイマーは立てない(relative-days.ts に setInterval / setTimeout が無い)', () => {
    const src = codeOnly(readFileSync('src/adapter/ui/render/relative-days.ts', 'utf8'));
    expect(src).not.toMatch(/setInterval|setTimeout/);
  });
});
