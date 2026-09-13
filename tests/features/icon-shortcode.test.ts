/**
 * 🔴 **本文に図案を置く字**(`:home:` → 家の絵。#853 段①)。
 *
 * 守る主張:
 * 1. **表に在る 49 語だけ**が絵になる ── それ以外は**字のまま**
 *    (user 裁定 2026-09-12 ── `:smile:` のような世に広く在る短縮記法を巻き込まない)
 * 2. 🔴 **先に在る記法を壊さない** ── `:code:[x]` は**役**のまま(`code` は図案名でもある)
 * 3. 🔴 **囲みの中は字のまま** ── `` `:home:` `` と書いたら絵にしない
 * 4. **読み上げの名前を持つ** ── 本文の図案は**それ自体が中身**なので隠さない
 * 5. ⚠ **器に字を入れない** ── 本文の `textContent` に見えない 1 文字を混ぜない
 *    (#770 段① で全量 smoke が 5 件落ちた形)
 * 6. 🔴 **49 語が 1 つ残らず出る** ── 表に足した絵が本文で当たらない、を起こさない
 */
import { describe, expect, it } from 'vitest';
import {
  iconShortcodeAt,
  iconShortcodeFor,
  isBodyIconName,
} from '../../src/features/icon/icon-shortcode';
import { TILE_ICON_CHOICES } from '../../src/features/icon/tile-icons';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

describe('字を読む(#853 段①)', () => {
  it('🔴 表に在る語は読む', () => {
    expect(iconShortcodeAt(':home: へ帰る', 0)).toEqual({ name: 'home', label: '家', length: 6 });
  });

  it('⚠ `-` 入りの語も読む(表にある唯一の形)', () => {
    expect(iconShortcodeAt(':check-box:', 0)?.name).toBe('check-box');
  });

  it('🔴 表に無い語は読まない(字のまま)', () => {
    expect(iconShortcodeAt(':smile:', 0), '世に広く在る短縮記法を食べた').toBeNull();
  });

  it('🔴 図案は在るが表に無い語も読まない(`trash` は操作の意味が固まっている)', () => {
    expect(iconShortcodeAt(':trash:', 0)).toBeNull();
  });

  it('🔴 `[` が続いたら読まない(役の記法に手を出さない)', () => {
    expect(iconShortcodeAt(':code:[x]', 0), '役の記法を食べた').toBeNull();
    expect(iconShortcodeAt(':list:{id=a}', 0)).toBeNull();
  });

  it('⚠ 大文字・先頭の数字は読まない', () => {
    expect(iconShortcodeAt(':Home:', 0)).toBeNull();
    expect(iconShortcodeAt(':30:', 0), '時刻を食べた').toBeNull();
  });

  it('⚠ 始まりが `:` でなければ読まない(空振り防止)', () => {
    expect(iconShortcodeAt('home:', 0)).toBeNull();
  });

  it('⚠ 途中の位置からも読む(`start` を無視していない)', () => {
    expect(iconShortcodeAt('あ:home:', 1)?.name).toBe('home');
  });

  it('挿す字と読む字は同じ綴り', () => {
    const s = iconShortcodeFor('home');
    expect(iconShortcodeAt(s, 0)?.name).toBe('home');
  });

  it('表に在るかを答える', () => {
    expect(isBodyIconName('home')).toBe(true);
    expect(isBodyIconName('trash')).toBe(false);
  });
});

describe('本文に描く(#853 段①)', () => {
  it('🔴 絵の器が出る', () => {
    const html = renderMarkdown('きょうは :home: に居ます');
    expect(html, '器が出ていない').toContain('data-pkc-symbol="home"');
    expect(html, '図案の印が無い(CSS が当たらない)').toContain('data-pkc-icon');
  });

  it('🔴 読み上げの名前を持つ(本文の図案は中身そのもの)', () => {
    expect(renderMarkdown(':home:')).toContain('aria-label="家"');
  });

  it('🔴 器に字を入れない(本文の字が変わらない)', () => {
    const html = renderMarkdown(':home:');
    expect(html, '器に字が入っている').toContain('></span>');
  });

  it('🔴 表に無い語は字のまま出る', () => {
    const html = renderMarkdown('やった :smile: ね');
    expect(html).toContain(':smile:');
    expect(html).not.toContain('data-pkc-symbol');
  });

  it('🔴 囲みの中は字のまま', () => {
    const html = renderMarkdown('`:home:` と書きます');
    expect(html, '囲みの中まで絵にした').not.toContain('data-pkc-symbol');
    expect(html).toContain(':home:');
  });

  it('🔴 役の記法は役のまま(`:code:[x]`)', () => {
    const html = renderMarkdown(':code:[x]');
    expect(html, '役を食べた').not.toContain('data-pkc-symbol');
    expect(html).toContain('<code>x</code>');
  });

  it('⚠ 日本語に挟まれても出る(空白を要求しない)', () => {
    expect(renderMarkdown('家:home:へ')).toContain('data-pkc-symbol="home"');
  });

  it('⚠ 時刻は変わらない', () => {
    const html = renderMarkdown('12:30:45 に始まります');
    expect(html).toContain('12:30:45');
    expect(html).not.toContain('data-pkc-symbol');
  });

  it('🔴 表の 49 語が 1 つ残らず出る', () => {
    const missing = TILE_ICON_CHOICES.filter(
      (c) => !renderMarkdown(`:${c.name}:`).includes(`data-pkc-symbol="${c.name}"`),
    ).map((c) => c.name);
    expect(missing, '本文で当たらない絵がある').toEqual([]);
    // ⚠ 空振り防止 ── 表そのものが空だと上は常に真になる
    expect(TILE_ICON_CHOICES.length).toBeGreaterThan(40);
  });
});
