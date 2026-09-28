/**
 * 🔴 **GitHub Flavored Markdown (GFM) Alerts**(#1144)。
 *
 * `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`
 * の自動認識とコールアウトレンダリングを検証する。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

describe('GitHub Flavored Markdown (GFM) Alerts (#1144)', () => {
  it('🔴 5 種のアラートが正しくクラスとロールを持つ', () => {
    const cases = [
      { tag: 'NOTE', role: 'note', title: 'Note', icon: 'ℹ' },
      { tag: 'TIP', role: 'tip', title: 'Tip', icon: '💡' },
      { tag: 'IMPORTANT', role: 'important', title: 'Important', icon: '🛈' },
      { tag: 'WARNING', role: 'warning', title: 'Warning', icon: '⚠' },
      { tag: 'CAUTION', role: 'caution', title: 'Caution', icon: '🛑' },
    ];

    for (const c of cases) {
      const md = `> [!${c.tag}]\n> これは${c.title}の内容です。`;
      const html = renderMarkdown(md);

      expect(html, `${c.tag} が callout クラスを持たない`).toContain('pkc-section-callout');
      expect(html, `${c.tag} が pkc-section-${c.role} クラスを持たない`).toContain(`pkc-section-${c.role}`);
      expect(html, `${c.tag} が pkc-md-alert クラスを持たない`).toContain('pkc-md-alert');
      expect(html, `${c.tag} が data-pkc-role 属性を持たない`).toContain(`data-pkc-role="${c.role}"`);
      expect(html, `${c.tag} がタイトルを持たない`).toContain(`${c.title}</p>`);
      expect(html, `${c.tag} がアイコンを持たない`).toContain(`>${c.icon}</span>`);
      expect(html, `${c.tag} の本文が消えている`).toContain(`これは${c.title}の内容です。`);
    }
  });

  it('🔴 同じ行に本文が続く場合もタイトルと本文が両立する', () => {
    const md = '> [!NOTE] 1行目に書かれたメモです。';
    const html = renderMarkdown(md);

    expect(html).toContain('pkc-section-callout');
    expect(html).toContain('pkc-section-note');
    expect(html).toContain('Note</p>');
    expect(html).toContain('1行目に書かれたメモです。');
  });

  it('🔴 小文字の [!note] でも同様に認識される', () => {
    const md = '> [!note]\n> 小文字タグのメモです。';
    const html = renderMarkdown(md);

    expect(html).toContain('pkc-section-callout');
    expect(html).toContain('pkc-section-note');
    expect(html).toContain('小文字タグのメモです。');
  });

  it('🔴 通常の引用ブロックはアラート化されず blockquote のまま(非破壊)', () => {
    const md = '> これは通常の名言の引用です。\n> 二行目。';
    const html = renderMarkdown(md);

    expect(html).toContain('<blockquote>');
    expect(html).not.toContain('pkc-section-callout');
    expect(html).not.toContain('pkc-md-alert');
    expect(html).not.toContain('pkc-alert-title');
    expect(html).toContain('これは通常の名言の引用です。');
  });

  it('🔴 複数段落を含むアラートも正しく包まれる', () => {
    const md = ['> [!WARNING]', '> 段落1', '>', '> 段落2'].join('\n');
    const html = renderMarkdown(md);

    expect(html).toContain('pkc-section-callout pkc-section-warning pkc-md-alert');
    expect(html).toContain('Warning');
    expect(html).toContain('段落1');
    expect(html).toContain('段落2');
  });
});
