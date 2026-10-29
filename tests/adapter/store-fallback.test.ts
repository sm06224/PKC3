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
import { VoiceBoostStore } from '@adapter/ui/render/voice-boost';
import { MissingLinksStore } from '@adapter/ui/render/missing-links';
import { CodeCollapseStore } from '@adapter/ui/render/code-collapse';
import { InlineCodeCopyStore } from '@adapter/ui/render/inline-code-copy';
import { InlineCompleteStore } from '@adapter/ui/render/inline-complete-setting';
import { PdfReaderStore } from '@adapter/ui/render/pdf-reader-setting';
import { PhoneLinksStore } from '@adapter/ui/render/phone-links';
import { DateLinksStore } from '@adapter/ui/render/date-links';
import { RelativeDaysStore } from '@adapter/ui/render/relative-days';
import { ScheduleWeekStartStore } from '@adapter/ui/render/schedule-week-start';
import { ColorSwatchStore } from '@adapter/ui/render/color-swatch';
import { TooNarrowOkStore } from '@adapter/ui/render/too-narrow';
import { EditorModeStore } from '@adapter/ui/render/editor-mode';
import { PaneSizeStore } from '@adapter/ui/render/pane-size';
import { QueryKeyStore } from '@adapter/ui/render/query-key-store';
import { CalcDraftStore } from '@adapter/ui/render/calc-draft-store';
import { BrowseModeStore } from '@adapter/ui/render/browse-mode';
import { PaneVisibilityStore } from '@adapter/ui/render/pane-visibility';
import { GroupFoldStore } from '@adapter/ui/render/group-fold';
import { CreateKindStore } from '@adapter/ui/render/create-kind';
import { EntrySortStore } from '@adapter/ui/render/entry-sort-memory';
import { ListPlaceStore } from '@adapter/ui/render/list-place-memory';
import { PcFolderPlaceStore } from '@adapter/ui/render/pc-folder-place';
import { FilerFlattenStore } from '@adapter/ui/render/filer-flatten';
import { PopupHintStore } from '@adapter/ui/render/popup-hint';
import { OfficeImageNoteStore } from '@adapter/ui/render/office-image-note';
import { PasteSourceStore } from '@adapter/ui/render/paste-source';
import { ExternalImagePolicy } from '@adapter/ui/render/external-images';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * 🔴 **読めるが、書くと容量不足で落ちる**保存(#1087 D1)。
 * `fail` を false にすると以後は普通に書ける(「あとの書き込みが成功したら保存に戻る」の対照)。
 */
function quotaStorage(): StorageLike & { fail: boolean; data: Map<string, string> } {
  const data = new Map<string, string>();
  const s = {
    fail: true,
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (s.fail) throw new DOMException('quota', 'QuotaExceededError');
      data.set(k, v);
    },
    removeItem: (k: string) => {
      if (s.fail) throw new DOMException('quota', 'QuotaExceededError');
      data.delete(k);
    },
  };
  return s;
}

/**
 * 「保存が無い状態で書いて、読み直したら同じ値が返る」を 1 組で見る。
 * ⚠ 型がばらばらなので、**書く / 読む / 別の値**を呼び側が渡す。
 */
const CASES: readonly {
  name: string;
  make: (st?: StorageLike | null) => { write: (v: unknown) => void; read: () => unknown };
  a: unknown;
  b: unknown;
}[] = [
  {
    name: 'OpenInEditStore',
    make: (st: StorageLike | null = null) => {
      const s = new OpenInEditStore(st);
      return { write: (v) => s.setEnabled(v as boolean), read: () => s.enabled() };
    },
    a: true,
    b: false,
  },
  {
    name: 'AlarmEnabledStore',
    make: (st: StorageLike | null = null) => {
      const s = new AlarmEnabledStore(st);
      return { write: (v) => s.setEnabled(v as boolean), read: () => s.enabled() };
    },
    a: true,
    b: false,
  },
  {
    name: 'VoiceBoostStore',
    make: (st: StorageLike | null = null) => {
      const s = new VoiceBoostStore(st);
      return { write: (v) => s.setEnabled(v as boolean), read: () => s.enabled() };
    },
    a: true,
    b: false,
  },
  {
    name: 'VoiceBoostStore(音量をそろえる)',
    make: (st: StorageLike | null = null) => {
      const s = new VoiceBoostStore(st);
      return { write: (v) => s.setLevelEnabled(v as boolean), read: () => s.levelEnabled() };
    },
    a: true,
    b: false,
  },
  {
    name: 'VoiceBoostStore(頭の中で鳴る感じを和らげる)',
    make: (st: StorageLike | null = null) => {
      const s = new VoiceBoostStore(st);
      return { write: (v) => s.setCrossfeedEnabled(v as boolean), read: () => s.crossfeedEnabled() };
    },
    a: true,
    b: false,
  },
  {
    name: 'PhoneLinksStore',
    make: (st: StorageLike | null = null) => {
      const s = new PhoneLinksStore(st);
      return { write: (v) => s.setEnabled(v as boolean), read: () => s.enabled() };
    },
    a: true,
    b: false,
  },
  {
    name: 'DateLinksStore',
    make: (st: StorageLike | null = null) => {
      const s = new DateLinksStore(st);
      return { write: (v) => s.setEnabled(v as boolean), read: () => s.enabled() };
    },
    // ⚠ **既定が入**なので、最初に書くのは**切**にする ── 入から書くと、控えが死んでいて
    //   既定のまま読まれても通ってしまう(代替物で満たせる検査になる)
    a: false,
    b: true,
  },
  {
    name: 'RelativeDaysStore',
    make: (st: StorageLike | null = null) => {
      const s = new RelativeDaysStore(st);
      return { write: (v) => s.setEnabled(v as boolean), read: () => s.enabled() };
    },
    // ⚠ **既定が入**なので、最初に書くのは**切**にする(`DateLinksStore` と同じ理由)
    a: false,
    b: true,
  },
  {
    // ⚠ 既定は日曜始まり(0)── 最初に書くのは月曜始まり(1)にする(控えが死んで既定へ戻る実装を 1 回目の読みで捕まえる)
    name: 'ScheduleWeekStartStore',
    make: (st: StorageLike | null = null) => {
      const s = new ScheduleWeekStartStore(st);
      return { write: (v) => s.set(v as 0 | 1), read: () => s.get() };
    },
    a: 1,
    b: 0,
  },
  {
    name: 'ColorSwatchStore',
    make: (st: StorageLike | null = null) => {
      const s = new ColorSwatchStore(st);
      return { write: (v) => s.setEnabled(v as boolean), read: () => s.enabled() };
    },
    // ⚠ **既定が入**なので、最初に書くのは**切**にする(`DateLinksStore` と同じ理由)
    a: false,
    b: true,
  },
  {
    // ⚠ 既定が「入」の store ── a を切(false)にしておくと、控えが死んでいて
    //   既定へ戻る実装(読みが常に true)を 1 回目の読みで捕まえられる
    name: 'MissingLinksStore',
    make: (st: StorageLike | null = null) => {
      const s = new MissingLinksStore(st);
      return { write: (v) => s.setEnabled(v as boolean), read: () => s.enabled() };
    },
    a: false,
    b: true,
  },
  {
    // ⚠ 既定が「入」の store(#1087)── a を切(false)にして、控えが死んでいて既定へ戻る実装を捕まえる
    name: 'CodeCollapseStore',
    make: (st: StorageLike | null = null) => {
      const s = new CodeCollapseStore(st);
      return { write: (v) => s.setEnabled(v as boolean), read: () => s.enabled() };
    },
    a: false,
    b: true,
  },
  {
    // ⚠ 既定が「入」の store(#1449 / #1450)── a を切(false)にして、控えが死んで既定(入)へ戻る実装を捕まえる
    name: 'InlineCompleteStore',
    make: (st: StorageLike | null = null) => {
      const s = new InlineCompleteStore(st);
      return { write: (v) => s.setEnabled(v as boolean), read: () => s.enabled() };
    },
    a: false,
    b: true,
  },
  {
    name: 'InlineCodeCopyStore',
    make: (st: StorageLike | null = null) => {
      const s = new InlineCodeCopyStore(st);
      return { write: (v) => s.setEnabled(v as boolean), read: () => s.enabled() };
    },
    a: false,
    b: true,
  },
  {
    // ⚠ 既定が「切」の store(#275)── a を入(true)にして、控えが死んで既定(切)へ戻る実装を捕まえる
    name: 'PdfReaderStore',
    make: (st: StorageLike | null = null) => {
      const s = new PdfReaderStore(st);
      return { write: (v) => s.setEnabled(v as boolean), read: () => s.enabled() };
    },
    a: true,
    b: false,
  },
  {
    name: 'TooNarrowOkStore',
    make: (st: StorageLike | null = null) => {
      const s = new TooNarrowOkStore(st);
      return { write: (v) => s.setEnabled(v as boolean), read: () => s.enabled() };
    },
    a: false,
    b: true,
  },
  {
    name: 'EditorModeStore',
    make: (st: StorageLike | null = null) => {
      const s = new EditorModeStore(st);
      return { write: (v) => void s.setMode(v as string), read: () => s.getMode() };
    },
    a: 'split',
    b: 'live',
  },
  {
    name: 'PaneSizeStore',
    make: (st: StorageLike | null = null) => {
      const s = new PaneSizeStore(st);
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
    make: (st: StorageLike | null = null) => {
      const s = new QueryKeyStore(st);
      return { write: (v) => s.set(v as string | null), read: () => s.get() };
    },
    a: 'tags',
    b: null,
  },
  {
    // 🔴 計算スクラッチパッドの打ちかけ(#1230)。空文字は「消す」(空という選択を書かない)
    name: 'CalcDraftStore',
    make: (st: StorageLike | null = null) => {
      const s = new CalcDraftStore(st);
      return { write: (v) => s.set(v as string), read: () => s.get() };
    },
    a: '基本単価 = 3200 円\n合計',
    b: '',
  },
  {
    name: 'CreateKindStore',
    make: (st: StorageLike | null = null) => {
      const s = new CreateKindStore(st);
      return { write: (v) => s.set(v as string | null), read: () => s.get() };
    },
    a: 'textlog',
    b: null,
  },
  {
    name: 'BrowseModeStore',
    make: (st: StorageLike | null = null) => {
      const s = new BrowseModeStore(st);
      return { write: (v) => s.set(v as Parameters<typeof s.set>[0]), read: () => s.get() };
    },
    a: 'apps',
    b: 'filer',
  },
  {
    name: 'GroupFoldStore',
    make: (st: StorageLike | null = null) => {
      const s = new GroupFoldStore(st);
      /**
       * ⚠ この store の口は**押すたびに裏返る**(`set` ではない)ので、
       *   台が渡す「あるべき集合」へ**差分だけ**押す。
       * 🔑 こうすると、控えが死んでいる実装では **2 回目の読みで食い違う**
       *   (`read` が毎回空を返すので、差分が永久に埋まらない)。
       */
      const setTo = (want: readonly string[]): void => {
        for (const g of new Set([...s.get(), ...want]))
          if (want.includes(g) !== s.get().includes(g)) s.toggle(g);
      };
      return { write: (v) => setTo(v as string[]), read: () => [...s.get()] };
    },
    a: ['資料'],
    b: [],
  },
  {
    // ⚠ 既定が「切」の store(#813 段②)── a を入(true)にして、控えが死んでいて
    //   既定(切)のまま読まれる実装を 1 回目の読みで捕まえる
    name: 'FilerFlattenStore',
    make: (st: StorageLike | null = null) => {
      const s = new FilerFlattenStore(st);
      return { write: (v) => s.setEnabled(v as boolean), read: () => s.enabled() };
    },
    a: true,
    b: false,
  },
  {
    // ⚠ 既定が「まだ言っていない」の store ── a を true(言った)にして、控えが死んでいて
    //   既定のまま読まれる実装を 1 回目の読みで捕まえる
    name: 'PopupHintStore',
    make: (st: StorageLike | null = null) => {
      const s = new PopupHintStore(st);
      return { write: (v) => s.setShown(v as boolean), read: () => s.shown() };
    },
    a: true,
    b: false,
  },
  {
    // 🔴 既定が「まだ見せていない」の store(#88。Office の窓では外部画像が出ないことの初回の案内)── a を true(見せた)にして、
    //   控えが死んで既定のまま読まれる実装を 1 回目の読みで捕まえる
    name: 'OfficeImageNoteStore',
    make: (st: StorageLike | null = null) => {
      const s = new OfficeImageNoteStore(st);
      return { write: (v) => s.setSeen(v as boolean), read: () => s.seen() };
    },
    a: true,
    b: false,
  },
  {
    name: 'PaneVisibilityStore',
    make: (st: StorageLike | null = null) => {
      const s = new PaneVisibilityStore(st);
      return {
        write: (v) => void s.setHidden(v as Parameters<typeof s.setHidden>[0]),
        read: () => s.getHidden(),
      };
    },
    a: ['inspector'],
    b: [],
  },
  {
    // ⚠ 既定が「自動」── a を別の値にして、控えが死んで既定へ戻る実装を捕まえる(#1087 S4)
    name: 'PasteSourceStore',
    make: (st: StorageLike | null = null) => {
      const s = new PasteSourceStore(st);
      return { write: (v) => void s.set(v as 'html'), read: () => s.get() };
    },
    a: 'html',
    b: 'auto',
  },
  {
    // 🔴 既定は「憶えていない(null)」── a / b を別の並びにして、控えが死んで null へ戻る実装を捕まえる(依頼 82-3)
    name: 'EntrySortStore',
    make: (st: StorageLike | null = null) => {
      const s = new EntrySortStore(st);
      const w = (v: unknown): void => {
        const x = v as { sort: 'title' | 'updated'; desc: boolean };
        s.set(x.sort, x.desc);
      };
      return { write: w, read: () => s.get() };
    },
    a: { sort: 'title', desc: true },
    b: { sort: 'updated', desc: false },
  },
  {
    // 🔴 既定は「憶えていない(null)」── a / b を別の場所にして、控えが死んで null へ戻る実装を捕まえる(依頼 277)
    name: 'ListPlaceStore',
    make: (st: StorageLike | null = null) => {
      const s = new ListPlaceStore(st);
      const w = (v: unknown): void => {
        s.set(v as { cid: string; scope: string | null; kinds: string[] });
      };
      return { write: w, read: () => s.get() };
    },
    a: { cid: 'c1', scope: 'f1', kinds: ['text'] },
    b: { cid: 'c1', scope: null, kinds: [] },
  },
  {
    name: 'PcFolderPlaceStore',
    make: (st: StorageLike | null = null) => {
      const s = new PcFolderPlaceStore(st);
      return { write: (v) => s.set(v as { root: string; path: string[] }), read: () => s.get() };
    },
    a: { root: '資料', path: ['下'] },
    b: { root: '資料', path: [] },
  },
  {
    // ⚠ 既定が「確認」── a を別の値にする(#1087 S4)
    name: 'ExternalImagePolicy',
    make: (st: StorageLike | null = null) => {
      const s = new ExternalImagePolicy(st);
      return { write: (v) => void s.setMode(v as string), read: () => s.getMode() };
    },
    a: 'never',
    b: 'always',
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

  for (const c of CASES) {
    it(`🔴 ${c.name}: 保存が容量不足で書けなくても、書いた値が読める(#1087 D1)`, () => {
      const st = quotaStorage();
      const s = c.make(st);
      s.write(c.a);
      expect(s.read(), '書けなかったとき、押した設定が元へ戻る').toEqual(c.a);
      s.write(c.b);
      expect(s.read(), '2 回目の書き換えが効いていない').toEqual(c.b);
    });

    it(`🔴 ${c.name}: あとの書き込みが成功したら、保存の値を読む(#1087 D1)`, () => {
      const st = quotaStorage();
      const s = c.make(st);
      s.write(c.a);
      st.fail = false;
      s.write(c.b);
      expect(s.read()).toEqual(c.b);
      // 書けた後は保存が正本 ── 控えのまま固まっていないこと。
      // b を書いた時点の保存を控え、a を書いたあとで保存だけを b の姿へ戻す(外の書き手)。
      // 読みが保存を見ていれば b、控え(a)に固まっていれば a が返る。
      const snapshotB = new Map(st.data);
      s.write(c.a);
      st.data.clear();
      for (const [k, v] of snapshotB) st.data.set(k, v);
      // ⚠ PopupHintStore は「一度言ったら戻らない」片道の store(読みが `保存 || 控え`)なので除く
      if (c.name !== 'PopupHintStore')
        expect(s.read(), '書けた後も控えに固まっている(保存の値を読んでいない)').toEqual(c.b);
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
