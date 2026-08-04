/**
 * P8 段⑱: 添付を**本文へ書く形**の組み立て(`features/asset/asset-ref-format.ts`)。
 *
 * 🔴 ここが守るのは「**貼ったら出る**」── 裸の `asset:<key>` を渡していた頃は、
 * マニュアルが「貼ってください」と案内している当の文字列が markdown としては
 * ただの文字列で、貼っても何も出なかった(review H)。
 *
 * 🔑 **組み立ては 1 本**(コピー導線と md ZIP 書出しが同じ規則を使う)。
 * 別々に書けば必ずずれる ── CLAUDE.md「判定を増やさない」。
 */
import { describe, it, expect } from 'vitest';
import {
  formatAssetRef,
  escapeAssetLabel,
  escapeAssetTarget,
  isImageAssetMime,
} from '@features/asset/asset-ref-format';
import { renderMarkdown } from '@features/markdown/markdown-render';

describe('asset-ref-format', () => {
  it('画像は `!` が付き、画像以外は付かない', () => {
    expect(formatAssetRef('p.png', 'asset:ast-1', true)).toBe('![p.png](asset:ast-1)');
    expect(formatAssetRef('a.zip', 'asset:ast-1', false)).toBe('[a.zip](asset:ast-1)');
  });

  it('mime の判定はここ 1 本(前方一致)', () => {
    expect(isImageAssetMime('image/png')).toBe(true);
    expect(isImageAssetMime('image/svg+xml')).toBe(true);
    expect(isImageAssetMime('application/zip')).toBe(false);
    expect(isImageAssetMime(undefined)).toBe(false);
    expect(isImageAssetMime(null)).toBe(false);
  });

  it('ラベルの `]` と改行でリンクが死なない', () => {
    expect(escapeAssetLabel('a]b')).toBe('a\\]b');
    expect(escapeAssetLabel('a\nb')).toBe('a b');
    expect(escapeAssetLabel('a[b\\c')).toBe('a\\[b\\\\c');
  });

  it('名前が空なら宛先を見出しにする(無題のリンクを作らない)', () => {
    expect(formatAssetRef('   ', 'asset:ast-1', false)).toBe('[asset:ast-1](asset:ast-1)');
  });

  it('宛先に空白や括弧が混じるときだけ `<…>` で囲む', () => {
    expect(escapeAssetTarget('asset:ast-1')).toBe('asset:ast-1');
    expect(escapeAssetTarget('assets/a b.png')).toBe('<assets/a b.png>');
    expect(escapeAssetTarget('assets/a(1).png')).toBe('<assets/a(1).png>');
  });

  /**
   * ⚠ **下流の結果ではなく、当の振る舞いを見る** ── 「形が合っているか」を
   * 目視で決めず、**実際の renderer に通して** 添付として出ることを確かめる。
   * かつての裸 `asset:<key>` はここで 0 件になる。
   */
  it('🔴 組み立てた行を renderer に通すと、添付として出る', () => {
    const img = renderMarkdown(`見て: ${formatAssetRef('p.png', 'asset:ast-1', true)}\n`);
    expect(img).toContain('data-pkc-asset-key="ast-1"');
    expect(img).toContain('<img');

    const link = renderMarkdown(`${formatAssetRef('a.zip', 'asset:ast-2', false)}\n`);
    expect(link).toContain('data-pkc-asset-key="ast-2"');
    expect(link).toContain('download-asset');

    // 裸の key は**貼っても出ない**(直す前の形。ここが退行の見張り)
    expect(renderMarkdown('見て: asset:ast-1\n')).not.toContain('data-pkc-asset-key');
  });

  it('ラベルに `]` が入っていても renderer が参照として読む', () => {
    const html = renderMarkdown(`${formatAssetRef('a]b.png', 'asset:ast-3', true)}\n`);
    expect(html).toContain('data-pkc-asset-key="ast-3"');
  });
});
