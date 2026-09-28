/**
 * 🔴 **Markdown 表の縞模様（ゼブラストライプ）と行ホバーハイライト**(#1142)。
 *
 * 構文と規則の配備を pin する。
 * - 偶数行（nth-child(even)）に --surface-2
 * - ホバー行（:hover）に --surface-hover
 * - 印刷時（@media print）に print-color-adjust: exact と --surface-2
 * - 配布 HTML（extractBodyCss）にも同一の規則が含まれること
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, mediaBlock, stripComments, withoutMedia } from '../helpers/css-blocks';
import { extractBodyCss } from '../../build/body-css';

const appCssRaw = readFileSync('src/styles/app.css', 'utf-8');
const tokensRaw = readFileSync('src/styles/tokens.css', 'utf-8');
const screenCss = (): string => withoutMedia(stripComments(appCssRaw));

describe('Markdown 表のゼブラストライプと行ホバーハイライト(#1142)', () => {
  it('🔴 偶数行(nth-child(even))に --surface-2 の規則が在る', () => {
    const text = screenCss();
    const sel = '.pkc-md-rendered table tbody tr:nth-child(even)';
    const b = blocksFor(text, sel);
    expect(b.length, `${sel} の規則が無い`).toBeGreaterThan(0);
    expect(b.join('\n')).toMatch(decl('background', 'var\\(--surface-2\\)'));
  });

  it('🔴 ホバー行(:hover)に --surface-hover の規則が在る', () => {
    const text = screenCss();
    const sel = '.pkc-md-rendered table tbody tr:hover';
    const b = blocksFor(text, sel);
    expect(b.length, `${sel} の規則が無い`).toBeGreaterThan(0);
    expect(b.join('\n')).toMatch(decl('background', 'var\\(--surface-hover\\)'));
  });

  it('🔴 印刷時(@media print)にゼブラストライプを上品に保持する', () => {
    const stripped = stripComments(appCssRaw);
    const printBlock = mediaBlock(stripped, 'print');
    expect(printBlock.body, '@media print 節が無い').toBeTruthy();

    const sel = '.pkc-md-rendered table tbody tr:nth-child(even)';
    const b = blocksFor(printBlock.body, sel);
    expect(b.length, `印刷用の ${sel} 規則が無い`).toBeGreaterThan(0);
    const joined = b.join('\n');
    expect(joined).toMatch(decl('background', 'var\\(--surface-2\\)'));
    expect(joined).toMatch(decl('print-color-adjust', 'exact'));
  });

  it('🔴 書き出し HTML(extractBodyCss)にもゼブラストライプとホバーの規則が含まれる', () => {
    const baked = extractBodyCss(appCssRaw, tokensRaw).css;
    expect(baked).toContain('.pkc-md-rendered table tbody tr:nth-child(even)');
    expect(baked).toContain('.pkc-md-rendered table tbody tr:hover');
    expect(baked).toContain('var(--surface-2)');
    expect(baked).toContain('var(--surface-hover)');
  });
});
