/** @vitest-environment happy-dom */
/**
 * 🔴 **左の列の「一覧」タブを外した**(#813 段③。🟣 Gemini 裁定 2026-10-01 = A「いま外す」)。
 *
 * 段③-a で「一覧でしかできなかった物」をフォルダへ移したうえで外した(その pin は
 * `folder-moved-from-list.test.ts` / `folder-left-column.test.ts`)。ここは**外したこと自体**を守る:
 *
 * - タブは 6 枚で、「一覧」が無い(表・型・既定・退避先・種類の札の面の 5 か所が揃っている)
 * - 動線(退避先 / 別窓が塞がれたとき / 深いリンク)が「一覧」へ向いていない
 * - 消した描画器・器・規則・文脈への参照が、`src` に 1 件も残っていない
 *
 * ⚠ 憶えていた `list` をフォルダで開く pin は `multi-select.test.ts`(探し方の既定と記憶)。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BROWSE_TABS } from '../../src/adapter/ui/render/browse';
import {
  BROWSE_MODES,
  KIND_FILTER_MODES,
  homeTabOf,
  isBrowseMode,
} from '../../src/adapter/ui/render/browse-mode';
import { VIEW_MODES } from '../../src/adapter/state/app-state';
import { BROWSE_ICONS } from '../../src/adapter/ui/render/icons';
import { CONTEXT_LABELS, CONTEXT_ORDER } from '../../src/features/keymap';

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, ext));
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

/** 注釈を落とす(解説に旧い名前を書いても落ちない ── 見るのは実行する行。CLAUDE.md §1)。 */
const code = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');

describe('「一覧」タブは外してある(#813 段③)', () => {
  it('🔴 タブは 6 枚で、「一覧」が無い(6 枚目は「パソコン」── #215 段①)', () => {
    expect(BROWSE_TABS.map((t) => t.mode)).toEqual(['filer', 'launcher', 'schedule', 'contacts', 'captures', 'pc']);
    expect(BROWSE_TABS.map((t) => t.label)).not.toContain('一覧');
    // 型・判定・図案・種類の札の面が、表と同じ数で揃っている(1 つだけ残ると、押せないタブか知らない面になる)
    expect([...BROWSE_MODES].sort()).toEqual(BROWSE_TABS.map((t) => t.mode).sort());
    expect(isBrowseMode('list'), '外した「一覧」を探し方として受けている').toBe(false);
    expect(Object.keys(BROWSE_ICONS)).not.toContain('list');
    expect([...KIND_FILTER_MODES]).not.toContain('list');
  });

  it('🔴 どの中央の面の退避先も「一覧」ではない(別窓が塞がれたとき)', () => {
    const dests = VIEW_MODES.map((v) => homeTabOf(v));
    // ⚠ 空振り防止 ── 退避先を持つ面(予定・連絡先・音/動画)が実際に在る
    expect(dests.filter((d) => d !== null).length, '退避先を持つ面が 1 つも無い').toBeGreaterThan(0);
    for (const d of dests) expect(d === null || BROWSE_MODES.includes(d)).toBe(true);
    expect(dests as (string | null)[]).not.toContain('list');
  });

  it('🔴 キー割当の文脈 `list` も消えている(「一覧タブ」の見出しが設定画面に残らない)', () => {
    expect(Object.keys(CONTEXT_LABELS)).not.toContain('list');
    expect(CONTEXT_ORDER as readonly string[]).not.toContain('list');
  });

  it('🔴 消した描画器・器・規則への参照が src に 1 つも残っていない', () => {
    const ts = files('src', /\.tsx?$/);
    // ⚠ 空振り防止 ── 走査が壊れて 0 件を見ていないこと
    expect(ts.length, '走査が空振りしている').toBeGreaterThan(100);
    const banned = [
      'SidebarRenderer',
      'listRows(',
      'listTabShowing',
      'visibleListRows',
      'visibleLeftColumnRows',
      'maybeOpenListNote',
      'runListKey',
      'listRowEls',
      'entry-list',
      "scope: 'list'",
      "scope === 'list'",
      "keymap.match(ke, 'list')",
      "setBrowse?.('list')",
      "'data-pkc-browse', 'list'",
    ];
    const hits: string[] = [];
    for (const f of ts) {
      const c = code(readFileSync(f, 'utf-8'));
      for (const b of banned) if (c.includes(b)) hits.push(`${f}: ${b}`);
    }
    expect(hits, '外した「一覧」への参照が残っている').toEqual([]);
    const css = code(files('src/styles', /\.css$/).map((f) => readFileSync(f, 'utf-8')).join('\n'));
    expect(css, '一覧の器の CSS が残っている').not.toContain('entry-list');
  });

  it('🔴 描画器の file そのものが無い(`sidebar.ts`)', () => {
    expect(() => readFileSync('src/adapter/ui/render/sidebar.ts', 'utf-8')).toThrow();
  });
});
