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
  SKIPPED_KEYS,
} from '../../src/features/settings/settings-file';

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

  it('名前に日付が入る(どちらが新しいか分かる)', () => {
    expect(settingsFileName('2026-08-26')).toBe('PKC3-settings-2026-08-26.json');
  });
});

describe('読み込む前に、何が変わるか見せる(#414)', () => {
  const file = (entries: { key: string; value: string }[]): string =>
    JSON.stringify({ kind: SETTINGS_FILE_KIND, version: 1, entries });

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
