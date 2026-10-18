/** @vitest-environment node */
/**
 * 🔴 **設定だけを別の端末へ持っていく**(#414)。
 *
 * 守る主張:
 * 1. 🔴 **端末側の鍵は、全数がどちらかの一覧に載っている**(足し忘れを機械で止める)
 * 2. **運んではいけない物を運ばない**(許可 / フラグ / 既読 / lid を持つもの)
 * 3. **当てる前に何が変わるか出る**、そして**黙って捨てない**
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSettingsFile,
  canApplySettings,
  MAX_SETTING_CHARS,
  planSettingsImport,
  PORTABLE_KEYS,
  SETTINGS_FILE_KIND,
  settingsChangeText,
  settingsFileName,
  settingsPlanNote,
  settingsAppliedNote,
  settingsTooLongToExport,
  SKIPPED_KEYS,
} from '../../src/features/settings/settings-file';
import { parseMessageCap, MESSAGE_CAP_OPTIONS } from '../../src/features/message/message-log';
import { PASTE_SOURCES } from '../../src/features/markdown/paste-source';
import { OPEN_PLACES } from '../../src/features/open-place';
import { PANES } from '../../src/features/pane-visibility';
import { SIZED_PANES } from '../../src/features/pane-size';

/**
 * `src` の中の `'pkc3.…'` を全部拾う。
 *
 * 🔴 **仕分けの表そのものは読まない**(2026-08-26 の変異試験 S1b が SURVIVED で教えた)。
 *
 * ⚠ その file も `src` に在るので、素直に走査すると**一覧が自分自身を満たす** ──
 *   `PORTABLE_KEYS` に実装のどこにも無い鍵を足しても、`found` にその鍵が入るので
 *   「実装にも在る」が**常に真**になる(CLAUDE.md §1「救い手が変わっただけ」)。
 * 🔑 除くと**両方向**が効く:
 *   ① 仕分けていない鍵が在れば落ちる ② 実装から消えた鍵が一覧に残っていれば落ちる。
 */
const LIST_FILE = 'settings-file.ts';

function allStorageKeys(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!p.endsWith('.ts')) continue;
      if (p.endsWith(LIST_FILE)) continue;
      const text = readFileSync(p, 'utf8');
      for (const m of text.matchAll(/'(pkc3\.[A-Za-z0-9.-]+)'/g)) out.add(m[1]!);
    }
  };
  walk(join(process.cwd(), 'src'));
  return out;
}

describe('端末側の鍵は全数が仕分けてある(#414)', () => {
  /**
   * 🔴 **これがこの機能でいちばん効く検査である。**
   *
   * ⚠ 名指しの一覧は**鍵が増えた日に必ず古くなる**。しかも足し忘れは
   *   「**書き出したのに戻らない**」という**無言の欠落**として出るので、
   *   誰も気づけない(CLAUDE.md §8 の入力側)。
   * 🔑 だから **`src` の全数**と突き合わせる ── どちらの一覧にも無い鍵が
   *   現れたら落ちるので、次に鍵を足す人は**判断を迫られる**。
   */
  it('🔴 src に在る pkc3.* は、運ぶ / 運ばない のどちらかに必ず載っている', () => {
    const found = allStorageKeys();
    // ⚠ **空振り防止** ── 拾えていなければ、この検査は何も見ていない
    expect(found.size, '鍵を 1 つも拾えていない(検査が空振りしている)').toBeGreaterThan(10);
    const known = new Set([
      ...PORTABLE_KEYS.map((p) => p.key),
      ...SKIPPED_KEYS.map((s) => s.key),
    ]);
    const missing = [...found].filter((k) => !known.has(k)).sort();
    expect(
      missing,
      '仕分けていない鍵が在る ── 運ぶなら PORTABLE_KEYS へ、運ばないなら理由つきで SKIPPED_KEYS へ',
    ).toEqual([]);
  });

  /** ⚠ 逆向きも見る ── **実装から消えた鍵**を一覧に残さない(古い一覧は嘘になる)。 */
  it('🔴 一覧に在る鍵は、実装にも在る', () => {
    const found = allStorageKeys();
    const stale = [...PORTABLE_KEYS.map((p) => p.key), ...SKIPPED_KEYS.map((s) => s.key)]
      .filter((k) => !found.has(k))
      .sort();
    expect(stale, '実装から消えた鍵が一覧に残っている').toEqual([]);
  });

  it('🔴 同じ鍵が両方の一覧に載っていない', () => {
    const both = PORTABLE_KEYS.map((p) => p.key).filter((k) =>
      SKIPPED_KEYS.some((s) => s.key === k),
    );
    expect(both, '運ぶとも運ばないとも書いてある').toEqual([]);
  });

  /** ⚠ **理由の無い行を足さない** ── 理由が無いと「入れ忘れでは?」から始まる。 */
  it('🔴 運ばない鍵には、必ず理由が書いてある', () => {
    for (const s of SKIPPED_KEYS)
      expect(s.why.trim().length, `${s.key} に理由が無い`).toBeGreaterThan(10);
  });

  /**
   * 🔴 **運んではいけない物が、運ぶ側に紛れていない**(名指しで見る)。
   * ⚠ 一般則(「grant を含む鍵は運ばない」)で書くと、綴りが違う日に素通りする。
   */
  it('🔴 許可・フラグ・既読・lid を持つものは運ばない', () => {
    const portable = new Set(PORTABLE_KEYS.map((p) => p.key));
    for (const key of [
      'pkc3.flags',
      'pkc3.external-images',
      'pkc3.extension-grants',
      'pkc3.same-origin-grants',
      'pkc3.embed-origins',
      'pkc3.notices.seen',
      'pkc3.notices.off',
      'pkc3.dual-bookmarks',
    ])
      expect(portable.has(key), `${key} を運ぼうとしている`).toBe(false);
  });
});

describe('書き出す(#414)', () => {
  it('🔴 設定している物だけが入る(無い鍵は入れない)', () => {
    const disk: Record<string, string> = { 'pkc3.theme': 'dark', 'pkc3.keymap': '{}' };
    const f = buildSettingsFile((k) => disk[k] ?? null);
    expect(f.kind).toBe(SETTINGS_FILE_KIND);
    expect(f.entries.map((e) => e.key).sort()).toEqual(['pkc3.keymap', 'pkc3.theme']);
  });

  it('🔴 運ばない鍵は、値が在っても入らない', () => {
    const disk: Record<string, string> = {
      'pkc3.theme': 'dark',
      'pkc3.flags': '{"a":1}',
      'pkc3.same-origin-grants': '["https://example.com"]',
      'pkc3.dual-bookmarks': 'lid1,lid2',
    };
    const f = buildSettingsFile((k) => disk[k] ?? null);
    expect(f.entries.map((e) => e.key), '運ばない鍵が入った').toEqual(['pkc3.theme']);
  });

  it('⚠ 壊れた保存(長すぎる値)は運ばない', () => {
    const disk: Record<string, string> = { 'pkc3.theme': 'x'.repeat(MAX_SETTING_CHARS + 1) };
    expect(buildSettingsFile((k) => disk[k] ?? null).entries).toEqual([]);
  });

  it('🔴 長すぎて落とした設定は、名前で言える(黙って落とさない。#1087)', () => {
    const disk: Record<string, string> = {
      'pkc3.theme': 'x'.repeat(MAX_SETTING_CHARS + 1),
      'pkc3.keymap': 'y'.repeat(MAX_SETTING_CHARS), // ちょうど上限は入る
    };
    const read = (k: string): string | null => disk[k] ?? null;
    expect(settingsTooLongToExport(read)).toEqual(['見た目']);
    expect(buildSettingsFile(read).entries.map((e) => e.key)).toEqual(['pkc3.keymap']);
  });

  it('名前に日付が入る(どちらが新しいか分かる)', () => {
    expect(settingsFileName('2026-08-26')).toBe('PKC3-settings-2026-08-26.json');
  });
});

describe('読み込む前に、何が変わるか見せる(#414)', () => {
  const file = (entries: { key: string; value: string }[]): string =>
    JSON.stringify({ kind: SETTINGS_FILE_KIND, version: 1, entries });

  it('🔴 長すぎて入れない設定は、件数を下見で言う(#1087)', () => {
    const plan = planSettingsImport(
      file([
        { key: 'pkc3.theme', value: 'x'.repeat(MAX_SETTING_CHARS + 1) },
        { key: 'pkc3.keymap', value: '{}' },
      ]),
      () => null,
    );
    expect(plan.tooLong).toEqual(['pkc3.theme']);
    expect(plan.changes.map((c) => c.key)).toEqual(['pkc3.keymap']);
    expect(settingsPlanNote(plan)).toContain('1 件は長すぎるので入れません');
  });

  it('🔴 値が空・文字列でない項目は入れない(端末の設定を空の字で消さない。#1087)', () => {
    const disk: Record<string, string> = { 'pkc3.keymap': '{"edit-entry":["Alt+9"]}', 'pkc3.theme': 'dark' };
    const raw = JSON.stringify({
      kind: SETTINGS_FILE_KIND,
      version: 1,
      entries: [
        { key: 'pkc3.keymap', value: 123 },
        { key: 'pkc3.theme', value: '' },
        { key: 'pkc3.browse' },
        { key: 'pkc3.text-scale', value: 'xlarge' },
      ],
    });
    const plan = planSettingsImport(raw, (k) => disk[k] ?? null);
    expect(plan.changes.map((c) => c.key), '空の字で入れ替える項目が出た').toEqual(['pkc3.text-scale']);
    expect(plan.unreadable).toEqual(['pkc3.keymap', 'pkc3.theme', 'pkc3.browse']);
    expect(settingsPlanNote(plan)).toContain('3 件は中身が空か読めない形なので入れません');
  });

  /**
   * 🔴 **端末の読み手が既定へ丸める値は、「入れました」と言わない**(#1087)。
   * ⚠ 検査の表は「読み手が使う判定」をそのまま持つ ── 別に書き写した許可リストではない。
   *   だから**どの鍵に検査が付いているか**を名指しで pin する(付け忘れ・外し忘れが見える)。
   */
  describe('取り込む値の検査(読み手と同じ判定)', () => {
    const GOOD: Record<string, string> = {
      'pkc3.editor-mode': 'live',
      'pkc3.page-format': 'a4-portrait',
      'pkc3.prose-align': 'center',
      'pkc3.text-scale': 'xlarge',
      'pkc3.tag-badge': 'chip',
      'pkc3.paste-source': PASTE_SOURCES[0]!.id,
      'pkc3.open-place': OPEN_PLACES[0]!.id,
      'pkc3.app-open-target': 'tab',
      'pkc3.messages.cap': '500',
      // 🔴 #1087: 残りの鍵にも検査を付けた(見本の網羅は tests/adapter/settings-file-valid.test.ts が store から引く)
      'pkc3.panes': PANES[0]!,
      'pkc3.pane-sizes': `${SIZED_PANES[0]!}:300`,
      'pkc3.open-in-edit': '1',
      'pkc3.read-columns': '2',
      'pkc3.column-rule': 'none',
      'pkc3.keymap': '{}',
      'pkc3.dual-preview': '0',
      'pkc3.alarm': '1',
      'pkc3.schedule-lead': '30',
      'pkc3.schedule-missed': '0',
      'pkc3.schedule-week-start': '1',
      'pkc3.voice-boost': '1',
      'pkc3.voice-level': '1',
      'pkc3.voice-crossfeed': '0',
      'pkc3.phone-links': '1',
      'pkc3.date-links': '0',
      'pkc3.relative-days': '0',
      'pkc3.color-swatch': '0',
      'pkc3.missing-links': '0',
      'pkc3.code-collapse': '0',
      'pkc3.inline-code-copy': '0',
      'pkc3.pdf-reader': '1',
      'pkc3.app-group-folded': '["仕事"]',
      'pkc3.filer-flatten': '1',
    };
    const plan1 = (key: string, value: string, extra?: Record<string, (v: string) => boolean>) =>
      planSettingsImport(file([{ key, value }]), () => null, extra);

    it('検査が付いている鍵は、この一覧のとおり(増減したら理由を添えて直す)', () => {
      expect(
        PORTABLE_KEYS.filter((p) => p.valid !== undefined).map((p) => p.key).sort(),
      ).toEqual(Object.keys(GOOD).sort());
      // 🔑 検査を持たない鍵は、読み手が adapter にある 3 つだけ(配色・探し方のタブ・集計のグループ化)
      expect(
        PORTABLE_KEYS.filter((p) => p.valid === undefined).map((p) => p.key).sort(),
      ).toEqual(['pkc3.browse', 'pkc3.query-key', 'pkc3.theme']);
    });

    for (const [key, good] of Object.entries(GOOD)) {
      it(`${key}: 読める値は入り、読めない値は「読めない形」に数える`, () => {
        const ok = plan1(key, good);
        expect(ok.changes.map((c) => c.key), `読める値 ${good} が弾かれた`).toEqual([key]);
        expect(ok.unreadable).toEqual([]);
        const bad = plan1(key, 'zzz-これは選べる値ではない');
        expect(bad.changes, '読めない値が「入る」に数えられた').toEqual([]);
        expect(bad.unreadable).toEqual([key]);
        expect(settingsPlanNote(bad)).toContain('1 件は中身が空か読めない形なので入れません');
      });
    }

    it('🔴 メッセージの保管件数: 選べる 3 つ以外(9999 など)は入れない。読み手と同じ判定', () => {
      for (const n of MESSAGE_CAP_OPTIONS) expect(plan1('pkc3.messages.cap', String(n)).changes).toHaveLength(1);
      for (const v of ['9999', '0', '-1', 'abc', '5e2x']) {
        expect(plan1('pkc3.messages.cap', v).changes, v).toEqual([]);
        // 読み手(`parseMessageCap`)も同じ答え ── 下見が「入る」と言うのに丸められる、を作らない
        expect(parseMessageCap(v), v).toBeNull();
      }
    });

    it('🔴 読み手が features に無い鍵(配色)は、呼び側が渡した検査で弾く', () => {
      const themeOk = (v: string): boolean => v === 'dark';
      expect(plan1('pkc3.theme', 'dark', { 'pkc3.theme': themeOk }).changes).toHaveLength(1);
      const bad = plan1('pkc3.theme', 'no-such-theme', { 'pkc3.theme': themeOk });
      expect(bad.changes).toEqual([]);
      expect(bad.unreadable).toEqual(['pkc3.theme']);
      // 対照:検査を渡さなければ通る(検査が効いているのは渡した検査である)
      expect(plan1('pkc3.theme', 'no-such-theme').changes).toHaveLength(1);
    });
  });

  it('🔴 当てた結果は、書けなかった件数も言う(全部書けなくても成功と同じ字にしない。#1087)', () => {
    expect(settingsAppliedNote(3, 0)).not.toContain('保存できず');
    expect(settingsAppliedNote(0, 2)).toContain('2 件はこの端末に保存できず');
    expect(settingsAppliedNote(1, 1)).toContain('設定を 1 件入れました');
  });

  it('🔴 変わるものと、いまと同じものを分ける', () => {
    const disk: Record<string, string> = { 'pkc3.theme': 'light' };
    const plan = planSettingsImport(
      file([
        { key: 'pkc3.theme', value: 'dark' },
        { key: 'pkc3.browse', value: 'filer' },
      ]),
      (k) => disk[k] ?? null,
    );
    expect(plan.error).toBeNull();
    expect(plan.changes.map((c) => c.key)).toEqual(['pkc3.theme', 'pkc3.browse']);
    expect(plan.same).toBe(0);

    const plan2 = planSettingsImport(file([{ key: 'pkc3.theme', value: 'light' }]), (k) => disk[k] ?? null);
    expect(plan2.changes, 'いまと同じものを「変わる」と言った').toEqual([]);
    expect(plan2.same).toBe(1);
  });

  /** 🔴 **黙って捨てない** ── 版が違う設定を読んだとき「全部入った」と思わせない。 */
  it('🔴 運ばない鍵と、知らない鍵を、別々に数えて言う', () => {
    const plan = planSettingsImport(
      file([
        { key: 'pkc3.flags', value: '{}' },
        { key: 'pkc3.same-origin-grants', value: '[]' },
        { key: 'pkc3.future-thing', value: '1' },
      ]),
      () => null,
    );
    expect([...plan.refused].sort()).toEqual(['pkc3.flags', 'pkc3.same-origin-grants']);
    expect(plan.unknown).toEqual(['pkc3.future-thing']);
    expect(plan.changes, '運ばない鍵を当てようとしている').toEqual([]);
    const note = settingsPlanNote(plan);
    expect(note, '運ばない分を言っていない').toContain('2 件');
    expect(note, '知らない分を言っていない').toContain('1 件');
  });

  it('🔴 別の形の file は、そう言って断る', () => {
    expect(planSettingsImport('{', () => null).error).toContain('読めません');
    expect(planSettingsImport(JSON.stringify({ kind: 'pkc3-backup' }), () => null).error).toContain(
      'PKC3 の設定ファイルではありません',
    );
  });

  /** 🔴 #1087 A3 ── kind は合っていて、中身の形が違う file を「変わるものはありません」と言わない。 */
  it('🔴 entries が配列でない file は、読めない形だと言って押せないままにする', () => {
    for (const entries of [undefined, null, 'x', 3, { key: 'pkc3.theme', value: 'dark' }]) {
      const text = JSON.stringify({ kind: SETTINGS_FILE_KIND, version: 1, entries });
      const plan = planSettingsImport(text, () => null);
      expect(plan.error, `entries=${JSON.stringify(entries)} が読めたことになっている`).toContain('中身が読めない形です');
      expect(canApplySettings(plan)).toBe(false);
      expect(settingsPlanNote(plan)).not.toContain('変わるものはありません');
    }
    // 対照: 空の配列は「読めた、変わるものが無い」
    const empty = planSettingsImport(file([]), () => null);
    expect(empty.error).toBeNull();
    expect(settingsPlanNote(empty)).toContain('変わるものはありません');
  });

  /** 🔴 #1087 A2 / 依頼 207 ── 古い版の file(標準の項目を持たない)は、こちらの設定が残ると下見が言う。 */
  it('🔴 下見は、標準の項目を持たないファイルでは「こちらの設定が残る」と言う', () => {
    const note = settingsPlanNote(planSettingsImport(file([{ key: 'pkc3.theme', value: 'dark' }]), () => 'light'));
    expect(note).toContain('書き出した側で標準のままだった項目が入っていません');
    expect(note).toContain('こちらの設定がそのまま残ります');
    // 読めなかった回(error)には添えない
    expect(settingsPlanNote(planSettingsImport('{', () => null))).not.toContain('そのまま残ります');
  });

  /** 🔴 依頼 207(Gemini 裁定 = 推薦 A)── 標準のままの項目も運び、取り込んだ側も標準に戻す。 */
  describe('標準のままの項目も運ぶ(依頼 207)', () => {
    it('書き出し: 設定していない移せる鍵は、全部 defaults に載る(設定している鍵は載らない)', () => {
      const disk: Record<string, string> = { 'pkc3.theme': 'dark', 'pkc3.text-scale': '' };
      const f = buildSettingsFile((k) => disk[k] ?? null);
      expect(f.defaults).toContain('pkc3.text-scale'); // 空 = 標準
      expect(f.defaults).toContain('pkc3.keymap'); // 無い = 標準
      expect(f.defaults).not.toContain('pkc3.theme');
      // 入れる物と標準の物で、移せる鍵の全部を過不足なく分けている
      expect(new Set([...f.entries.map((e) => e.key), ...(f.defaults ?? [])])).toEqual(
        new Set(PORTABLE_KEYS.map((p) => p.key)),
      );
    });

    it('書き出し: 長すぎて落とした値は「標準」に数えない(取り込み先を標準に戻さない)', () => {
      const disk: Record<string, string> = { 'pkc3.theme': 'x'.repeat(MAX_SETTING_CHARS + 1) };
      const f = buildSettingsFile((k) => disk[k] ?? null);
      expect(f.entries.map((e) => e.key)).not.toContain('pkc3.theme');
      expect(f.defaults).not.toContain('pkc3.theme');
    });

    const withDefaults = (entries: { key: string; value: string }[], defaults: unknown): string =>
      JSON.stringify({ kind: SETTINGS_FILE_KIND, version: 1, entries, defaults });

    it('取り込み: こちらに値が在る項目だけ「標準に戻します」になる(元から標準なら変わらない)', () => {
      const disk: Record<string, string> = { 'pkc3.text-scale': 'xlarge' };
      const plan = planSettingsImport(
        withDefaults([], ['pkc3.text-scale', 'pkc3.theme']),
        (k) => disk[k] ?? null,
      );
      expect(plan.changes).toEqual([{ key: 'pkc3.text-scale', label: '文字の大きさ', from: 'xlarge', to: null }]);
      expect(canApplySettings(plan), '標準に戻すだけでも押せる').toBe(true);
      expect(settingsChangeText(plan.changes[0]!)).toBe('文字の大きさ を標準に戻します');
      expect(settingsPlanNote(plan)).not.toContain('入っていません');
    });

    it('取り込み: entries に在る鍵は defaults より優先する / 移せない鍵・知らない鍵は消さない', () => {
      const disk: Record<string, string> = {
        'pkc3.theme': 'light',
        'pkc3.flags': '{"a":1}',
        'pkc3.nobody': 'x',
      };
      const plan = planSettingsImport(
        withDefaults([{ key: 'pkc3.theme', value: 'dark' }], ['pkc3.theme', 'pkc3.flags', 'pkc3.nobody', 5]),
        (k) => disk[k] ?? null,
      );
      expect(plan.changes).toEqual([{ key: 'pkc3.theme', label: '見た目', from: 'light', to: 'dark' }]);
    });

    it('取り込み: 割り当てを標準に戻すときは、置き換わる件数を言う', () => {
      const mine = JSON.stringify({ 'create-entry': ['Alt+M'], 'delete-entry': ['Alt+D'] });
      const plan = planSettingsImport(withDefaults([], ['pkc3.keymap']), (k) => (k === 'pkc3.keymap' ? mine : null));
      expect(plan.keymapReplace).toEqual({ from: 2, to: 0 });
    });

    it('取り込み: defaults が配列でないファイルは、古い版と同じ扱い(落ちない)', () => {
      const plan = planSettingsImport(withDefaults([], 'pkc3.theme'), () => 'dark');
      expect(plan.defaultsIncluded).toBe(false);
      expect(plan.changes).toEqual([]);
    });

    it('書いて読む: 会社(標準)→家(特大)で、取り込むと家も標準に戻る', () => {
      const office = buildSettingsFile(() => null);
      const home: Record<string, string> = { 'pkc3.text-scale': 'xlarge' };
      const plan = planSettingsImport(JSON.stringify(office), (k) => home[k] ?? null);
      expect(plan.changes.map((c) => [c.key, c.to])).toEqual([['pkc3.text-scale', null]]);
    });
  });

  /** 🔴 #1087 B3 ── 割り当ては全体が置き換わる。件数で言う(動きは変えない)。 */
  it('🔴 ショートカットキーの割り当てを含む file は、いまの件数とファイルの件数を言う', () => {
    const mine = JSON.stringify({ 'create-entry': ['Alt+M'], 'row-commit': ['Mod+Enter'], 'filer-rename': ['F2'] });
    const theirs = JSON.stringify({ 'create-entry': ['Alt+N'] });
    const plan = planSettingsImport(file([{ key: 'pkc3.keymap', value: theirs }]), (k) => (k === 'pkc3.keymap' ? mine : null));
    expect(plan.keymapReplace).toEqual({ from: 3, to: 1 });
    expect(settingsPlanNote(plan)).toContain('いま変えてある割り当て 3 件が、ファイルの 1 件に置き換わります');
    // 対照: いま何も変えていなければ 0 件から
    const fresh = planSettingsImport(file([{ key: 'pkc3.keymap', value: theirs }]), () => null);
    expect(fresh.keymapReplace).toEqual({ from: 0, to: 1 });
    // 対照: 割り当てを含まない file は言わない
    const other = planSettingsImport(file([{ key: 'pkc3.theme', value: 'dark' }]), () => null);
    expect(other.keymapReplace).toBeNull();
    expect(settingsPlanNote(other)).not.toContain('置き換わります');
  });

  it('🔴 変わるものが無ければ押せない(空押しを作らない)', () => {
    const plan = planSettingsImport(file([{ key: 'pkc3.theme', value: 'light' }]), () => 'light');
    expect(canApplySettings(plan)).toBe(false);
    expect(settingsPlanNote(plan), '押せない理由が出ていない').toContain('変わるものはありません');
    const plan2 = planSettingsImport(file([{ key: 'pkc3.theme', value: 'dark' }]), () => 'light');
    expect(canApplySettings(plan2)).toBe(true);
  });

  /** ⚠ **中身は出さない** ── 鍵の割当も紙面も JSON で、出しても読めない。 */
  it('🔴 下見は「何が変わるか」だけを言う(値を出さない)', () => {
    expect(settingsChangeText({ label: '見た目', from: null })).toBe('見た目 を設定します');
    expect(settingsChangeText({ label: '見た目', from: 'light' })).toBe('見た目 を入れ替えます');
  });

  it('⚠ 同じ鍵が 2 度書いてあっても 1 度しか数えない', () => {
    const plan = planSettingsImport(
      file([
        { key: 'pkc3.theme', value: 'dark' },
        { key: 'pkc3.theme', value: 'light' },
      ]),
      () => null,
    );
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]?.to, '後の値を採った(先を採るはず)').toBe('dark');
  });
});
