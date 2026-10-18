/** @vitest-environment node */
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
      { tag: 'NOTE', role: 'note', title: 'メモ', icon: 'ℹ' },
      { tag: 'TIP', role: 'tip', title: 'ヒント', icon: '💡' },
      { tag: 'IMPORTANT', role: 'important', title: '重要', icon: '🛈' },
      { tag: 'WARNING', role: 'warning', title: '警告', icon: '⚠' },
      { tag: 'CAUTION', role: 'caution', title: '注意', icon: '🛑' },
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

  it('🔴 同じ行に書いた字は注意書きの題になる(台帳 #1852 束 R1、依頼 257。以前は本文として出ていた)', () => {
    const md = '> [!NOTE] 自分で付けた題\n> 次の行からが本文です。';
    const html = renderMarkdown(md);

    expect(html).toContain('pkc-section-callout');
    expect(html).toContain('pkc-section-note');
    // 題の段落に自分で付けた字が入り、既定の「メモ」は出ない
    expect(html).toMatch(/<p class="pkc-alert-title"><span class="pkc-alert-icon">ℹ<\/span> 自分で付けた題<\/p>/);
    expect(html).not.toContain('メモ</p>');
    expect(html).toContain('<p>次の行からが本文です。</p>');
  });

  it('🔴 題だけを書いたとき: 本文の段落は出ない / 題の中の記法は効く', () => {
    const html = renderMarkdown('> [!TIP] **太字**の題');
    expect(html).toContain('<strong>太字</strong>の題</p>');
    expect(html.match(/<p/g)).toHaveLength(1);
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
    expect(html).toContain('警告</p>');
    expect(html).toContain('段落1');
    expect(html).toContain('段落2');
  });

  // ── 台帳 #1852 束 R1(依頼 257): Obsidian の書き方 ──
  it.each([
    ['INFO', 'info', '情報'],
    ['abstract', 'summary', '要約'],
    ['Summary', 'summary', '要約'],
    ['TLDR', 'summary', '要約'],
    ['todo', 'note', 'ToDo'],
    ['hint', 'tip', 'ヒント'],
    ['success', 'tip', '成功'],
    ['check', 'tip', '成功'],
    ['done', 'tip', '完了'],
    ['question', 'important', '質問'],
    ['help', 'important', '質問'],
    ['faq', 'important', '質問'],
    ['attention', 'warning', '注意'],
    ['failure', 'danger', '失敗'],
    ['fail', 'danger', '失敗'],
    ['missing', 'danger', '失敗'],
    ['danger', 'danger', '危険'],
    ['error', 'danger', '危険'],
    ['bug', 'danger', 'バグ'],
    ['example', 'important', '例'],
    ['quote', 'summary', '引用'],
    ['cite', 'summary', '引用'],
  ])('Obsidian の種類 [!%s] は近い色の注意書き(role=%s、題「%s」)', (tag, role, title) => {
    const html = renderMarkdown(`> [!${tag}]\n> 本文`);
    expect(html).toContain(`pkc-section-${role} pkc-md-alert`);
    expect(html).toContain(`data-pkc-role="${role}"`);
    expect(html).toContain(`</span> ${title}</p>`);
    expect(html).toContain('<p>本文</p>');
  });

  it('知らない種類 [!FOO] / 後ろに字が続く [!NOTE]x は注意書きにしない(引用のまま)', () => {
    for (const md of ['> [!FOO]\n> x', '> [!NOTE]x\n> y', '> [!toString]\n> z']) {
      const html = renderMarkdown(md);
      expect(html, md).toContain('<blockquote>');
      expect(html, md).not.toContain('pkc-md-alert');
    }
  });

  it('たたむ指定: [!NOTE]+ は開いた <details>、[!NOTE]- は閉じた <details>。題は <summary>', () => {
    const open = renderMarkdown('> [!NOTE]+ 開いて出す\n> 中身');
    expect(open).toMatch(/^<details class="pkc-section-callout pkc-section-note pkc-md-alert" data-pkc-role="note" open="">/);
    expect(open).toContain('<summary class="pkc-alert-title">');
    expect(open).toContain('開いて出す</summary>');
    expect(open).toContain('<p>中身</p>');
    expect(open).toMatch(/<\/details>\s*$/);
    expect(open).not.toContain('blockquote');

    const closed = renderMarkdown('> [!WARNING]-\n> 隠れた中身');
    expect(closed).toContain('<details class="pkc-section-callout pkc-section-warning pkc-md-alert" data-pkc-role="warning">');
    expect(closed).not.toMatch(/<details[^>]*\sopen/);
    expect(closed).toContain('警告</summary>');
  });

  it('たたむ指定のない注意書きは今までどおり <blockquote>(対照群)', () => {
    const html = renderMarkdown('> [!NOTE]\n> 中身');
    expect(html).toContain('<blockquote class="pkc-section-callout');
    expect(html).not.toContain('<details');
  });

  it('入れ子の引用の中でも、たたむ指定は自分の閉じだけを <details> にする', () => {
    const html = renderMarkdown('> [!NOTE]-\n> 外\n>\n> > 内側の引用\n\n普通の段落');
    expect(html.match(/<details/g)).toHaveLength(1);
    expect(html.match(/<\/details>/g)).toHaveLength(1);
    expect(html).toContain('<blockquote>');
    expect(html.indexOf('</details>')).toBeLessThan(html.indexOf('普通の段落'));
  });
});
