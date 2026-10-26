/** @vitest-environment node */
/**
 * 🔴 **本文の `[[題名]]` を、題名のノートへの押せる字にして描く**(#1174 段②)。
 *
 * ⚠ 描画に届いているか(渡し忘れ・ruby/em との取り違え・書き出しの 1 バイト不変)を見る。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const on = (md: string): string => renderMarkdown(md, { titleLinks: true });
const off = (md: string): string => renderMarkdown(md, {});

describe('[[題名]] を押せる字にする', () => {
  it('🔴 押せる字になる(受け手と題名が属性に載り、括弧は外れる)', () => {
    const html = on('詳しくは [[設計の背景]] を見る');
    expect(html).toContain(
      '<span class="pkc-title-link" data-pkc-action="open-title-note" data-pkc-title="設計の背景" role="link" tabindex="0">設計の背景</span>',
    );
    expect(html, '前後の字が消えた').toContain('詳しくは ');
    expect(html).toContain(' を見る');
    expect(html, '括弧が残っている').not.toContain('[[');
  });

  it('[[題名|表示]] は表示の字で出し、題名は属性に持つ', () => {
    const html = on('[[設計の背景|背景]]');
    expect(html).toContain('data-pkc-title="設計の背景"');
    expect(html).toContain('>背景</span>');
  });

  it('🔴 渡さない面(書き出し等)は 1 文字も変わらない / 渡すと変わる(空振り防止)', () => {
    const html = off('[[設計の背景]]');
    expect(html).not.toContain('pkc-title-link');
    expect(html).not.toContain('open-title-note');
    expect(html).toContain('[[設計の背景]]');
    expect(on('[[設計の背景]]')).not.toBe(html);
  });

  it('🔴 ruby / em の記法は取り違えない(対照群: 同じ面で両方が働く)', () => {
    const html = on('[[ruby:漢字|かんじ]] と [[em:強調]] と [[題名]]');
    expect(html).toContain('<ruby>');
    expect(html).toContain('pkc-em-dot');
    expect(html.match(/pkc-title-link/g)).toHaveLength(1);
    expect(html).toContain('data-pkc-title="題名"');
  });

  it('属性に入る題名は escape される / 空・改行入りは拾わない / リンクの中は入れ子にしない', () => {
    expect(on('[[a"b<c]]')).toContain('data-pkc-title="a&quot;b&lt;c"');
    expect(on('[[ ]]')).not.toContain('pkc-title-link');
    expect(on('[[a\nb]]')).not.toContain('pkc-title-link');
    expect(on('[[題名]](https://example.com)')).not.toContain('open-title-note');
    expect(on('`[[題名]]`'), 'コードの中は字のまま').not.toContain('open-title-note');
  });

  it('同じ行に 2 つ書けば 2 つとも押せる', () => {
    expect(on('[[A]] と [[B]]').match(/pkc-title-link"/g)).toHaveLength(2);
  });
});
