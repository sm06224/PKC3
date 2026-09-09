/**
 * 🔴 **保存が使えない端末でも、設定はその session の中で効く**
 * (#278 段② の test が教えた。2026-09-09)。
 *
 * ## 何が起きていたか
 *
 * 端末側の設定は `localStorage` に憶える。⚠ ところが **`localStorage` が
 * 使えない端末が実在する**(私用ウィンドウ / 「すべての Cookie をブロック」)──
 * そこでは `readStorage()` が `null` を返し、各 store は「控え」(`fallback`)を
 * 持つことでこの session だけは効かせる**つもり**だった。
 *
 * 🔴 **その控えは、一度も読まれていなかった。**
 *
 * ```ts
 * // 直す前
 * try { return this.storage?.getItem(KEY) === '1'; } catch { return this.fallback; }
 * ```
 *
 * ⚠ `storage` が `null` なら `?.` は **`undefined` を返して例外を投げない** ──
 * つまり `catch` へ入らないので、`fallback` は**死んだ枝**だった。
 * 帰結:そういう端末では**設定を押しても何も起きない**(押した印だけ付いて、
 * 次の描画で元へ戻る)── この repo がいちばん嫌う**無言の dead click** である。
 *
 * ## ⚠ 8 個とも同じ形だった
 *
 * 1 つ直したら**対称の反対側を疑う**(CLAUDE.md)── `grep` で数え上げたら
 * **8 個**が同じ `?.` の形をしていた。だからこの test は
 * **1 個ずつではなく全数**を見る(1 つ足した日に鳴る)。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { codeOnly } from '../helpers/code-only';
import { join } from 'node:path';
import { OpenInEditStore } from '@adapter/ui/render/open-in-edit';
import { AlarmEnabledStore } from '@adapter/ui/render/alarm-enabled';
import { PhoneLinksStore } from '@adapter/ui/render/phone-links';
import { TooNarrowOkStore } from '@adapter/ui/render/too-narrow';
import { EditorModeStore } from '@adapter/ui/render/editor-mode';
import { PaneSizeStore } from '@adapter/ui/render/pane-size';
import { QueryKeyStore } from '@adapter/ui/render/query-key-store';
import { BrowseModeStore } from '@adapter/ui/render/browse-mode';
import { PaneVisibilityStore } from '@adapter/ui/render/pane-visibility';

/**
 * 「保存が無い状態で書いて、読み直したら同じ値が返る」を 1 組で見る。
 * ⚠ 型がばらばらなので、**書く / 読む / 別の値**を呼び側が渡す。
 */
const CASES: readonly {
  name: string;
  make: () => { write: (v: unknown) => void; read: () => unknown };
  a: unknown;
  b: unknown;
}[] = [
  {
    name: 'OpenInEditStore',
    make: () => {
      const s = new OpenInEditStore(null);
      return { write: (v) => s.setEnabled(v as boolean), read: () => s.enabled() };
    },
    a: true,
    b: false,
  },
  {
    name: 'AlarmEnabledStore',
    make: () => {
      const s = new AlarmEnabledStore(null);
      return { write: (v) => s.setEnabled(v as boolean), read: () => s.enabled() };
    },
    a: true,
    b: false,
  },
  {
    name: 'PhoneLinksStore',
    make: () => {
      const s = new PhoneLinksStore(null);
      return { write: (v) => s.setEnabled(v as boolean), read: () => s.enabled() };
    },
    a: true,
    b: false,
  },
  {
    name: 'TooNarrowOkStore',
    make: () => {
      const s = new TooNarrowOkStore(null);
      return { write: (v) => s.setEnabled(v as boolean), read: () => s.enabled() };
    },
    a: false,
    b: true,
  },
  {
    name: 'EditorModeStore',
    make: () => {
      const s = new EditorModeStore(null);
      return { write: (v) => void s.setMode(v as string), read: () => s.getMode() };
    },
    a: 'split',
    b: 'live',
  },
  {
    name: 'PaneSizeStore',
    make: () => {
      const s = new PaneSizeStore(null);
      // ⚠ **1 枚ずつ**渡す口である(`set(id, px)`)── 1 稿目は object を渡して
      //   `[object Object]` を鍵にしていた(台の側の誤りで、製品は無傷)
      return {
        write: (v) => void s.set('sidebar', v as number),
        read: () => s.get().sidebar,
      };
    },
    a: 320,
    b: 240,
  },
  {
    name: 'QueryKeyStore',
    make: () => {
      const s = new QueryKeyStore(null);
      return { write: (v) => s.set(v as string | null), read: () => s.get() };
    },
    a: 'tags',
    b: null,
  },
  {
    name: 'BrowseModeStore',
    make: () => {
      const s = new BrowseModeStore(null);
      return { write: (v) => s.set(v as Parameters<typeof s.set>[0]), read: () => s.get() };
    },
    a: 'apps',
    b: 'filer',
  },
  {
    name: 'PaneVisibilityStore',
    make: () => {
      const s = new PaneVisibilityStore(null);
      return {
        write: (v) => void s.setHidden(v as Parameters<typeof s.setHidden>[0]),
        read: () => s.getHidden(),
      };
    },
    a: ['inspector'],
    b: [],
  },
];

describe('保存が使えない端末でも、設定はこの session で効く', () => {
  for (const c of CASES) {
    it(`🔴 ${c.name}: 書いた値がそのまま読める`, () => {
      const s = c.make();
      s.write(c.a);
      expect(s.read(), '書いた値が読めない(押しても何も起きない端末になる)').toEqual(c.a);
      // ⚠ 対照群 ── もう一方へ書き換えても追いつくこと(1 回目だけ効く形ではない)
      s.write(c.b);
      expect(s.read(), '2 回目の書き換えが効いていない').toEqual(c.b);
    });
  }

  /**
   * 🔴 **同じ形の store を新しく足した日に鳴る**(全数の門)。
   *
   * ⚠ 上の一覧は手で並べているので、**足した人が並べ忘れると静かに漏れる**。
   * 🔑 だから「`fallback` を持つ store は全部この一覧に在る」を機械で見る ──
   *   件数ではなく**名前の集合**で突き合わせる(CLAUDE.md §8「件数ではなく集合」)。
   */
  it('🔴 `fallback` を持つ store が、1 つ残らずこの一覧に在る', () => {
    const dir = join(process.cwd(), 'src/adapter/ui/render');
    const found: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue;
      const src = readFileSync(join(dir, f), 'utf-8');
      if (!/^\s*private fallback\b/m.test(src)) continue;
      for (const m of src.matchAll(/^export class (\w+)/gm)) found.push(m[1]!);
    }
    // 空振り防止 ── 走査が壊れて 0 件になっていないこと
    expect(found.length, '走査が 1 件も拾っていない(前処理が壊れている)').toBeGreaterThan(4);
    const listed = new Set(CASES.map((c) => c.name));
    const missing = found.filter((n) => !listed.has(n));
    expect(
      missing,
      '控えを持つ store が一覧に無い ── 保存の使えない端末で「押しても何も起きない」に戻る',
    ).toEqual([]);
  });

  /**
   * 🔴 **`?.` で読まない**(直す前の形が戻っていないこと)。
   * ⚠ `storage?.getItem` は `null` のとき**例外を投げずに `undefined` を返す**ので、
   *   `catch` の控えへ 1 度も入らない ── **緑のまま壊れる**書き方である。
   */
  it('🔴 保存を `?.` で読む形が戻っていない', () => {
    const dir = join(process.cwd(), 'src/adapter/ui/render');
    const bad: string[] = [];
    let seen = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue;
      /**
       * ⚠ **注釈を落としてから見る**(CLAUDE.md §1 の 5 度目と同じ罠)── 直す前の
       *   綴りを**この直しの解説コメントに書いた**ので、file 全体で探すと
       *   **自分の説明に満たされて必ず落ちる**(実際に落ちた)。
       */
      const src = codeOnly(readFileSync(join(dir, f), 'utf-8'));
      if (!/^\s*private fallback\b/m.test(src)) continue;
      seen += 1;
      if (/this\.storage\?\.getItem/.test(src)) bad.push(f);
    }
    // 🔴 空振り防止 ── 注釈を落とした後も、走査が store を拾えていること
    expect(seen, '注釈を落としたら 1 件も拾えなくなった(前処理が壊れている)').toBeGreaterThan(4);
    expect(bad, '`this.storage?.getItem` が戻っている(控えが死ぬ)').toEqual([]);
  });
});
