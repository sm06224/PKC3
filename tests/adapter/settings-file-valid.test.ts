/** @vitest-environment happy-dom */
/**
 * 🔴 **設定ファイルの下見は、端末の読み手が読めない値を「変わります」と言わない**(#1087)。
 *
 * 直す前は 23 個の鍵に `valid` が無く、`banana` のような値も「入れます」と下見に出て、入れた後に
 * 読み手が黙って既定へ丸めていた(下見も「入れました」も偽)。
 *
 * 🔑 期待値は**各 store 自身が書いた値**から取る(手で書かない) ── store の書き方が変わった日に、
 *   下見の検査が古い形のまま緑になるのを防ぐ。
 * 🔑 対象は `PORTABLE_KEYS` の**全数**。検査を持たない鍵が 1 つでも在れば落ちる。
 */
import { chooseBoardLayout } from '../../src/adapter/ui/render/schedule-board';
import { describe, expect, it } from 'vitest';
import { KEY_COMMANDS } from '../../src/features/keymap';
import { PORTABLE_KEYS, planSettingsImport } from '../../src/features/settings/settings-file';
import { ADAPTER_SETTING_VALIDATORS } from '../../src/adapter/ui/render/settings-validators';
import { PANES } from '../../src/features/pane-visibility';
import { SIZED_PANES } from '../../src/features/pane-size';
import { PaneVisibilityStore } from '../../src/adapter/ui/render/pane-visibility';
import { PaneSizeStore } from '../../src/adapter/ui/render/pane-size';
import { OpenInEditStore } from '../../src/adapter/ui/render/open-in-edit';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { BrowseModeStore } from '../../src/adapter/ui/render/browse-mode';
import { DualPrefsStore } from '../../src/adapter/ui/render/dual-prefs';
import { QueryKeyStore, QUERY_KEY_STORAGE_KEY } from '../../src/adapter/ui/render/query-key-store';
import { AlarmEnabledStore } from '../../src/adapter/ui/render/alarm-enabled';
import { ScheduleNotifyStore } from '../../src/adapter/ui/render/schedule-notify';
import { ScheduleWeekStartStore } from '../../src/adapter/ui/render/schedule-week-start';
import { VoiceBoostStore } from '../../src/adapter/ui/render/voice-boost';
import { PhoneLinksStore } from '../../src/adapter/ui/render/phone-links';
import { DateLinksStore } from '../../src/adapter/ui/render/date-links';
import { RelativeDaysStore } from '../../src/adapter/ui/render/relative-days';
import { ColorSwatchStore } from '../../src/adapter/ui/render/color-swatch';
import { MissingLinksStore } from '../../src/adapter/ui/render/missing-links';
import { CodeCollapseStore } from '../../src/adapter/ui/render/code-collapse';
import { InlineCodeCopyStore } from '../../src/adapter/ui/render/inline-code-copy';
import { InlineCompleteStore } from '../../src/adapter/ui/render/inline-complete-setting';
import { PdfReaderStore } from '../../src/adapter/ui/render/pdf-reader-setting';
import { GroupFoldStore } from '../../src/adapter/ui/render/group-fold';
import { FilerFlattenStore } from '../../src/adapter/ui/render/filer-flatten';
import { THEMES } from '../../src/adapter/ui/render/theme';
import { PAGE_FORMATS } from '../../src/features/page-format';
import { PROSE_ALIGNS } from '../../src/features/prose-align';
import { READ_COLUMN_CHOICES } from '../../src/features/read-columns';
import { COLUMN_RULES } from '../../src/features/column-rule';
import { TAG_BADGES } from '../../src/features/tag-badge';
import { TEXT_SCALES } from '../../src/features/text-scale';
import { EDITOR_MODES } from '../../src/features/editor-mode';
import { PASTE_SOURCES } from '../../src/features/markdown/paste-source';
import { OPEN_PLACES } from '../../src/features/open-place';
import { APP_OPEN_TARGETS } from '../../src/features/launcher/open-target';
import { MESSAGE_CAP_OPTIONS } from '../../src/features/message/message-log';

/** 鍵 → 値の入れ物(Storage の 3 つの口だけ)。store に渡して、書かれた字を読み戻す。 */
function fakeStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  dump: () => Record<string, string>;
} {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

/** store に `setEnabled(on)` を 1 回言わせ、書かれた字(鍵 → 値)を返す。 */
function viaToggle(
  make: (s: ReturnType<typeof fakeStorage>) => { setEnabled(on: boolean): void },
  on: boolean,
): Record<string, string> {
  const s = fakeStorage();
  make(s).setEnabled(on);
  return s.dump();
}

const toggles: Record<string, (s: ReturnType<typeof fakeStorage>) => { setEnabled(on: boolean): void }> = {
  'pkc3.open-in-edit': (s) => new OpenInEditStore(s),
  'pkc3.alarm': (s) => new AlarmEnabledStore(s),
  'pkc3.voice-boost': (s) => new VoiceBoostStore(s),
  'pkc3.voice-level': (s) => ({ setEnabled: (on) => new VoiceBoostStore(s).setLevelEnabled(on) }),
  'pkc3.voice-crossfeed': (s) => ({ setEnabled: (on) => new VoiceBoostStore(s).setCrossfeedEnabled(on) }),
  'pkc3.phone-links': (s) => new PhoneLinksStore(s),
  'pkc3.date-links': (s) => new DateLinksStore(s),
  'pkc3.relative-days': (s) => new RelativeDaysStore(s),
  'pkc3.color-swatch': (s) => new ColorSwatchStore(s),
  'pkc3.missing-links': (s) => new MissingLinksStore(s),
  'pkc3.code-collapse': (s) => new CodeCollapseStore(s),
  'pkc3.inline-code-copy': (s) => new InlineCodeCopyStore(s),
  'pkc3.inline-complete': (s) => new InlineCompleteStore(s),
  'pkc3.pdf-reader': (s) => new PdfReaderStore(s),
  'pkc3.filer-flatten': (s) => new FilerFlattenStore(s),
};

/** 各鍵が**書き手(store / 表)から得る**有効な値。 */
function validSamples(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, make] of Object.entries(toggles)) {
    const on = viaToggle(make, true)[key];
    const off = viaToggle(make, false)[key];
    if (on === undefined || off === undefined) throw new Error(`${key}: store が書かなかった`);
    out[key] = [on, off];
  }
  {
    const s = fakeStorage();
    new PaneVisibilityStore(s).setHidden([PANES[0]!, PANES[1]!]);
    out['pkc3.panes'] = [s.dump()['pkc3.panes']!];
  }
  {
    const s = fakeStorage();
    new PaneSizeStore(s).set(SIZED_PANES[0]!, 300);
    out['pkc3.pane-sizes'] = [s.dump()['pkc3.pane-sizes']!];
  }
  {
    const s = fakeStorage();
    const k = new KeymapStore(s);
    // 割当が足せる (命令, キー) の組を探す ── 足せたものが書かれた字
    for (const c of KEY_COMMANDS) {
      if (k.addBinding(c.id, 'Ctrl+Alt+Shift+F9') === null) break;
    }
    out['pkc3.keymap'] = [s.dump()['pkc3.keymap']!];
  }
  {
    // 🔴 #1457: 予定表のカンバンの列の組み方 ── 書き手(`chooseBoardLayout`)が実際に書く字を採る
    localStorage.removeItem('pkc3.board-layout');
    chooseBoardLayout('signal');
    const a = localStorage.getItem('pkc3.board-layout')!;
    chooseBoardLayout('status');
    const b = localStorage.getItem('pkc3.board-layout')!;
    localStorage.removeItem('pkc3.board-layout');
    out['pkc3.board-layout'] = [a, b];
  }
  {
    const s = fakeStorage();
    new BrowseModeStore(s).set('filer');
    out['pkc3.browse'] = [s.dump()['pkc3.browse']!];
  }
  {
    const s = fakeStorage();
    new DualPrefsStore(s).setPreview(true);
    const t = fakeStorage();
    new DualPrefsStore(t).setPreview(false);
    out['pkc3.dual-preview'] = [s.dump()['pkc3.dual-preview']!, t.dump()['pkc3.dual-preview']!];
  }
  {
    const s = fakeStorage();
    new QueryKeyStore(s).set('priority');
    out['pkc3.query-key'] = [s.dump()['pkc3.query-key']!];
  }
  {
    const lead = fakeStorage();
    new ScheduleNotifyStore(lead).setLead(30);
    const on = fakeStorage();
    new ScheduleNotifyStore(on).setMissedOn(true);
    const off = fakeStorage();
    new ScheduleNotifyStore(off).setMissedOn(false);
    out['pkc3.schedule-lead'] = [lead.dump()['pkc3.schedule-lead']!];
    out['pkc3.schedule-missed'] = [on.dump()['pkc3.schedule-missed']!, off.dump()['pkc3.schedule-missed']!];
    // 週の始まり(台帳 #1852 束 E2、依頼 191)── 書き手が実際に書いた値を見本にする
    const mon = fakeStorage();
    new ScheduleWeekStartStore(mon).set(1);
    const sun = fakeStorage();
    new ScheduleWeekStartStore(sun).set(0);
    out['pkc3.schedule-week-start'] = [mon.dump()['pkc3.schedule-week-start']!, sun.dump()['pkc3.schedule-week-start']!];
  }
  {
    const s = fakeStorage();
    new GroupFoldStore(s).toggle('仕事');
    out['pkc3.app-group-folded'] = [s.dump()['pkc3.app-group-folded']!];
  }
  // 表から引く鍵(書き手が表の id をそのまま書く)
  out['pkc3.theme'] = THEMES.map((t) => t.id);
  out['pkc3.editor-mode'] = EDITOR_MODES.map((m) => m.id);
  out['pkc3.page-format'] = PAGE_FORMATS.map((m) => m.id);
  out['pkc3.prose-align'] = PROSE_ALIGNS.map((m) => m.id);
  out['pkc3.text-scale'] = TEXT_SCALES.map((m) => m.id);
  out['pkc3.read-columns'] = READ_COLUMN_CHOICES.map((m) => m.id);
  out['pkc3.column-rule'] = COLUMN_RULES.map((m) => m.id);
  out['pkc3.tag-badge'] = TAG_BADGES.map((m) => m.id);
  out['pkc3.paste-source'] = PASTE_SOURCES.map((m) => m.id);
  out['pkc3.open-place'] = OPEN_PLACES.map((m) => m.id);
  out['pkc3.app-open-target'] = APP_OPEN_TARGETS.map((m) => m.id);
  out['pkc3.messages.cap'] = MESSAGE_CAP_OPTIONS.map(String);
  return out;
}

const validOf = (key: string): ((v: string) => boolean) | undefined =>
  PORTABLE_KEYS.find((p) => p.key === key)?.valid ?? ADAPTER_SETTING_VALIDATORS[key];

/** 何を入れても読める鍵はここへ(理由つき)。今は 0 件 ── 足すなら理由を書く。 */
const ACCEPTS_ANYTHING: Readonly<Record<string, string>> = {};

describe('設定ファイル: 値の検査(#1087)', () => {
  const samples = validSamples();

  it('🔴 全部の鍵が検査を持つ(足し忘れ・載せ忘れで落ちる)', () => {
    expect(PORTABLE_KEYS.length, '鍵の一覧が空').toBeGreaterThan(30);
    for (const { key } of PORTABLE_KEYS) {
      if (key in ACCEPTS_ANYTHING) continue;
      expect(validOf(key), `${key} に検査が無い`).toBeDefined();
    }
  });

  it('🔑 有効な値の見本が全部の鍵に在る / 見本を持たない鍵の見本は無い(表が実装と同じ鍵を指す)', () => {
    const keys = PORTABLE_KEYS.map((p) => p.key).sort();
    expect(Object.keys(samples).sort()).toEqual(keys);
  });

  it('🔴 各 store / 表が書く値は全部通る(下見が正しい値まで断らない)', () => {
    let n = 0;
    for (const [key, list] of Object.entries(samples)) {
      expect(list.length, `${key}: 見本が無い`).toBeGreaterThan(0);
      for (const v of list) {
        expect(v, `${key}: store が空を書いた`).not.toBe('');
        expect(validOf(key)!(v), `${key} の ${JSON.stringify(v)} が断られた`).toBe(true);
        n += 1;
      }
    }
    expect(n).toBeGreaterThan(80);
  });

  it('🔴 読めない値(banana)は全部断る', () => {
    for (const { key } of PORTABLE_KEYS) {
      if (key === QUERY_KEY_STORAGE_KEY) continue; // 下: 任意の短い字が読める鍵
      expect(validOf(key)!('banana'), `${key} が banana を通した`).toBe(false);
    }
  });

  it('集計のグループ化: 空と長すぎる字は読めない(短い字は何でも読める鍵)', () => {
    const v = validOf(QUERY_KEY_STORAGE_KEY)!;
    expect(v('banana')).toBe(true);
    expect(v('x'.repeat(200))).toBe(true);
    expect(v('x'.repeat(201))).toBe(false);
    expect(v('')).toBe(false);
  });

  it('形の違う JSON・畳み方・幅・予定の分も断る(banana だけが偽ではない)', () => {
    expect(validOf('pkc3.keymap')!('[]')).toBe(false);
    expect(validOf('pkc3.keymap')!('"x"')).toBe(false);
    expect(validOf('pkc3.app-group-folded')!('{}')).toBe(false);
    expect(validOf('pkc3.app-group-folded')!('[1]')).toBe(false);
    expect(validOf('pkc3.panes')!(`${PANES[0]} banana`)).toBe(false);
    expect(validOf('pkc3.pane-sizes')!(`${SIZED_PANES[0]}:-5`)).toBe(false);
    expect(validOf('pkc3.pane-sizes')!(`${SIZED_PANES[0]}:300 junk`)).toBe(false);
    expect(validOf('pkc3.schedule-lead')!('7')).toBe(false);
    expect(validOf('pkc3.schedule-week-start')!('2')).toBe(false);
    expect(validOf('pkc3.schedule-week-start')!('月曜')).toBe(false);
    expect(validOf('pkc3.alarm')!('2')).toBe(false);
    expect(validOf('pkc3.date-links')!('yes')).toBe(false);
  });

  it('🔴 下見に出る: banana は「変わります」ではなく「読めない」に数える(23 鍵を通して)', () => {
    const keys = PORTABLE_KEYS.map((p) => p.key).filter((k) => k !== QUERY_KEY_STORAGE_KEY);
    const text = JSON.stringify({
      kind: 'pkc3-settings',
      entries: keys.map((key) => ({ key, value: 'banana' })),
    });
    const plan = planSettingsImport(text, () => null, ADAPTER_SETTING_VALIDATORS);
    // ⚠ 種別名が違えば kind 不一致で全件 0 になる → 空振りを防ぐため error も見る
    expect(plan.error, '設定ファイルとして読まれていない').toBeNull();
    expect(plan.changes, '読めない値が「変わります」に残った').toEqual([]);
    expect(plan.unreadable.length).toBe(keys.length);
  });
});
