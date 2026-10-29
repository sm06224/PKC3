import { describe, it, expect } from 'vitest';
import {
  claimName,
  describeSync,
  emptyManifest,
  isMarkdownName,
  isSyncable,
  parseManifest,
  planSync,
  readManifest,
  reinstateReturned,
  SYNC_CONFLICT_DIR,
  SYNC_INTERVAL_MINUTES,
  SYNC_MANIFEST_NAME,
  type LocalNote,
  type SyncManifest,
  type SyncRecord,
} from '../../src/features/folder-sync/folder-sync';

/**
 * 🔴 PC のフォルダとの同期の「判断」(#1455 の後半)。ファイルの読み書きは持たない純関数。
 * 表の見方: ノート側の世代(更新日時・文字数)とファイル側のハッシュが、前回の記録と同じかどうか。
 */
const note = (lid: string, over: Partial<LocalNote> = {}): LocalNote => ({
  lid,
  title: 'T' + lid,
  archetype: 'text',
  updatedAt: '2026-10-01 00:00:00',
  chars: 10,
  busy: false,
  ...over,
});
const rec = (file: string, over: Partial<SyncRecord> = {}): SyncRecord => ({
  file,
  hash: 'h-' + file,
  title: 'T',
  updatedAt: '2026-10-01 00:00:00',
  chars: 10,
  ...over,
});
const manifest = (entries: Record<string, SyncRecord>, removed: SyncManifest['removed'] = {}): SyncManifest => ({
  ...emptyManifest('c1'),
  entries,
  removed,
});
const ext = (name: string, hash = 'h-' + name) => ({ name, hash });
const kinds = (p: ReturnType<typeof planSync>) => p.actions.map((a) => `${a.kind}:${'lid' in a ? a.lid : a.file}`);

describe('planSync: ノートとファイルの突き合わせ', () => {
  it('🔴 初回: 記録が無いノートは新しい名前で書く。名前は題名から(重ならない)', () => {
    const p = planSync(
      emptyManifest('c1'),
      [note('a', { title: 'メモ' }), note('b', { title: 'メモ' })],
      [],
    );
    expect(p.actions.map((a) => (a.kind === 'write' ? [a.file, a.reason] : null))).toEqual([
      ['メモ.md', 'new'],
      ['メモ-2.md', 'new'],
    ]);
  });

  it('🔴 どちらも変わっていなければ何もしない(空振りの対照: 変えれば動く)', () => {
    const m = manifest({ a: rec('a.md', { title: 'Ta' }) });
    const same = planSync(m, [note('a')], [ext('a.md')]);
    expect(same.actions).toEqual([]);
    // 対照: ノート側を変えると write、ファイル側を変えると pull
    expect(kinds(planSync(m, [note('a', { updatedAt: '2026-10-02 00:00:00' })], [ext('a.md')]))).toEqual(['write:a']);
    expect(kinds(planSync(m, [note('a')], [ext('a.md', 'other')]))).toEqual(['pull:a']);
  });

  it('🔴 文字数だけ変わっても(同じ秒の 2 度目の保存)ノート側の変更と読む', () => {
    const m = manifest({ a: rec('a.md', { title: 'Ta' }) });
    expect(kinds(planSync(m, [note('a', { chars: 11 })], [ext('a.md')]))).toEqual(['write:a']);
  });

  it('🔴 両方が変わった = 競合: PKC3 の版を書く(reason=conflict)。ファイルの版を消すのは呼び手が退避してから', () => {
    const m = manifest({ a: rec('a.md', { title: 'Ta' }) });
    const p = planSync(m, [note('a', { chars: 99 })], [ext('a.md', 'edited')]);
    expect(p.actions).toEqual([{ kind: 'write', lid: 'a', file: 'a.md', prevFile: null, reason: 'conflict' }]);
  });

  it('🔴 ファイルが消えていたら黙って書き戻さない(gone)。「書き戻す」を選んだときだけ書く / 「外す」で記録から外す', () => {
    const m = manifest({ a: rec('a.md', { title: 'Ta' }) });
    expect(planSync(m, [note('a')], []).actions).toEqual([{ kind: 'gone', lid: 'a', file: 'a.md' }]);
    // ノート側が変わっていても同じ(選ぶまでは何も書かない)
    expect(planSync(m, [note('a', { chars: 99 })], []).actions).toEqual([{ kind: 'gone', lid: 'a', file: 'a.md' }]);
    expect(planSync(m, [note('a')], [], new Map([['a', 'restore' as const]])).actions).toEqual([
      { kind: 'write', lid: 'a', file: 'a.md', prevFile: null, reason: 'missing' },
    ]);
    expect(planSync(m, [note('a')], [], new Map([['a', 'detach' as const]])).actions).toEqual([{ kind: 'detach', lid: 'a' }]);
  });

  it('🔴 同期から外したノートは、書かず・取り込まず・forget もしない', () => {
    const m = { ...manifest({}, { a: { file: 'a.md', hash: 'h-a.md' } }), detached: { a: true as const } };
    expect(planSync(m, [note('a')], [ext('a.md')]).actions).toEqual([]);
  });

  it('🔴 読めない(大きすぎる)ファイルは、書かず・取り込まず(unreadable)。新しいファイルなら取り込まない', () => {
    const m = manifest({ a: rec('a.md', { title: 'Ta' }) });
    const big = { name: 'a.md', hash: '', unreadable: true };
    // ノート側が変わっていても上書きしない
    expect(planSync(m, [note('a', { chars: 99 })], [big]).actions).toEqual([{ kind: 'unreadable', lid: 'a', file: 'a.md' }]);
    expect(planSync(emptyManifest('c1'), [], [{ name: 'huge.md', hash: '', unreadable: true }]).actions).toEqual([]);
  });

  it('🔴 `_` や `.` で始まる題名のファイルも、記録にあれば照合できる(毎回書き直さない)。名前は `_` で始まらない', () => {
    const used = new Set<string>();
    expect(claimName(used, '_メモ')).toBe('メモ.md');
    expect(claimName(used, '.hidden')).toBe('hidden.md');
    expect(claimName(used, '__')).toBe('ノート.md');
    // 古い記録が `_x.md` を指していても、ファイルが在れば「在る」と読む(isMarkdownName を通さない)
    const m = manifest({ a: rec('_x.md', { title: 'Ta' }) });
    expect(planSync(m, [note('a')], [ext('_x.md')]).actions).toEqual([]);
  });

  it('🔴 ゴミ箱から戻ったノートは、前のファイル名のまま記録へ戻る(2 つのファイルにしない)', () => {
    const m = manifest({}, { a: { file: 'メモ.md', hash: 'h' } });
    const locals = [note('a', { title: 'メモ' })];
    expect(reinstateReturned(m, locals)).toBe(1);
    expect(m.entries['a']).toMatchObject({ file: 'メモ.md', hash: 'h', title: '', updatedAt: null });
    expect(m.removed['a']).toBeUndefined();
    // 戻したあとの計画: 新しい名前で書かない(ノート側が変わった扱いで、同じ名前へ)
    const p = planSync(m, locals, [ext('メモ.md', 'h')]);
    expect(p.actions).toEqual([{ kind: 'write', lid: 'a', file: 'メモ.md', prevFile: null, reason: 'local' }]);
    // 対象外の種類・既に記録がある物は触らない
    expect(reinstateReturned(manifest({}, { f: { file: 'f.md', hash: 'h' } }), [note('f', { archetype: 'folder' })])).toBe(0);
  });

  it('同じファイルを指す 2 つの記録(壊れた記録)── 後の記録のノートは新しい名前で書く', () => {
    const m = manifest({ a: rec('x.md', { title: 'Ta' }), b: rec('x.md', { title: 'Tb' }) });
    const p = planSync(m, [note('a'), note('b')], [ext('x.md')]);
    expect(p.actions.filter((x) => x.kind === 'write')).toEqual([
      { kind: 'write', lid: 'b', file: 'Tb.md', prevFile: null, reason: 'new' },
    ]);
  });

  it('大文字小文字の違うファイル名でも同じファイルとして照合する', () => {
    const m = manifest({ a: rec('Memo.md', { title: 'Ta' }) });
    expect(planSync(m, [note('a')], [ext('memo.md', 'h-Memo.md')]).actions).toEqual([]);
  });

  it('🔴 改題したら新しい名前で書き、前のファイルを渡す(外で触られていないときだけ)', () => {
    const m = manifest({ a: rec('旧.md', { title: '旧' }) });
    const p = planSync(m, [note('a', { title: '新', updatedAt: '2026-10-02 00:00:00' })], [ext('旧.md')]);
    expect(p.actions).toEqual([{ kind: 'write', lid: 'a', file: '新.md', prevFile: '旧.md', reason: 'local' }]);
    // 外で触られていたら競合 ── 名前は変えない
    const c = planSync(m, [note('a', { title: '新', updatedAt: '2026-10-02 00:00:00' })], [ext('旧.md', 'x')]);
    expect(c.actions).toEqual([{ kind: 'write', lid: 'a', file: '旧.md', prevFile: null, reason: 'conflict' }]);
  });

  it('🔴 編集中は触らない(defer)── 取り込みも書き込みもしない', () => {
    const m = manifest({ a: rec('a.md', { title: 'Ta' }) });
    const p = planSync(m, [note('a', { busy: true, chars: 99 })], [ext('a.md', 'edited')]);
    expect(p.actions).toEqual([{ kind: 'defer', lid: 'a' }]);
  });

  it('🔴 新しい .md は取り込む。記録にあるファイル・隠しファイル・_ で始まる退避先・他の拡張子は取り込まない', () => {
    const p = planSync(
      manifest({ a: rec('a.md', { title: 'Ta' }) }),
      [note('a')],
      [ext('a.md'), ext('new.md'), ext('.hidden.md'), ext('_conflicts.md'), ext('pic.png'), ext('B.markdown')],
    );
    expect(p.actions.filter((x) => x.kind === 'adopt').map((x) => (x as { file: string }).file)).toEqual([
      'new.md',
      'B.markdown',
    ]);
  });

  it('🔴 ノートが消えたら forget(ファイルは消さない)。同じ内容のファイルは取り込み直さず、変わっていたら取り込む', () => {
    const m = manifest({ gone: rec('gone.md') });
    const p = planSync(m, [], [ext('gone.md')]);
    expect(p.actions).toEqual([{ kind: 'forget', lid: 'gone' }]);
    // 消した後の次の回: removed に印がある → 同じハッシュなら取り込まない
    const m2 = manifest({}, { gone: { file: 'gone.md', hash: 'h-gone.md' } });
    expect(planSync(m2, [], [ext('gone.md')]).actions).toEqual([]);
    // 外で書き換えられていたら新しいノートとして取り込む
    expect(planSync(m2, [], [ext('gone.md', 'changed')]).actions).toEqual([{ kind: 'adopt', file: 'gone.md' }]);
  });

  it('🔴 対象外の種類(フォルダ・添付…)は書かない。ノートに戻ったら書く', () => {
    expect(isSyncable('folder')).toBe(false);
    expect(isSyncable('attachment')).toBe(false);
    expect(isSyncable('text')).toBe(true);
    expect(isSyncable('todo')).toBe(true);
    const p = planSync(emptyManifest('c1'), [note('f', { archetype: 'folder' }), note('t')], []);
    expect(kinds(p)).toEqual(['write:t']);
  });

  it('新しいノートの名前が、フォルダに在る別のファイルと重ならない', () => {
    const p = planSync(emptyManifest('c1'), [note('a', { title: 'x' })], [ext('x.md'), ext('X-2.md')]);
    expect(p.actions[0]).toMatchObject({ kind: 'write', file: 'x-3.md' });
  });
});

describe('補助', () => {
  it('claimName: 大文字小文字・正規化を同一視して重ねない', () => {
    const used = new Set<string>();
    expect(claimName(used, 'A')).toBe('A.md');
    expect(claimName(used, 'a')).toBe('a-2.md');
  });
  it('isMarkdownName', () => {
    expect(isMarkdownName('a.md')).toBe(true);
    expect(isMarkdownName('A.MARKDOWN')).toBe(true);
    expect(isMarkdownName('a.txt')).toBe(false);
    expect(isMarkdownName('.a.md')).toBe(false);
    expect(isMarkdownName(SYNC_MANIFEST_NAME)).toBe(false);
    expect(isMarkdownName(`${SYNC_CONFLICT_DIR}.md`)).toBe(false);
  });
  it('parseManifest: 往復と、壊れた記録は null', () => {
    const m = manifest({ a: rec('a.md') });
    expect(parseManifest(JSON.stringify(m))).toEqual(m);
    expect(parseManifest('{')).toBeNull();
    expect(parseManifest(JSON.stringify({ ...m, format: 'x' }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...m, entries: { a: { file: 1 } } }))).toBeNull();
  });
  it('describeSync: 0 件は言わない / 全部 0 は「変更はありませんでした」', () => {
    const zero = { written: 0, pulled: 0, adopted: 0, conflicts: 0, deferred: 0, gone: 0, failed: 0 };
    expect(describeSync(zero)).toBe('変更はありませんでした');
    expect(describeSync({ ...zero, written: 2, conflicts: 1 })).toContain('2 件をフォルダへ書きました');
    expect(describeSync({ ...zero, written: 2, conflicts: 1 })).toContain(SYNC_CONFLICT_DIR);
    expect(describeSync({ ...zero, written: 2 })).not.toContain('取り込み');
  });
  it('describeSync: フォルダで消えたノートの件数を言う', () => {
    const zero = { written: 0, pulled: 0, adopted: 0, conflicts: 0, deferred: 0, gone: 0, failed: 0 };
    expect(describeSync({ ...zero, gone: 2 })).toContain('2 件はフォルダでファイルが消えています');
  });
  it('🔴 readManifest: 別の版は「壊れている」ではなく version と読む。形が違えば broken', () => {
    const m = manifest({ a: rec('a.md') });
    expect(readManifest(JSON.stringify(m))).toMatchObject({ ok: true });
    expect(readManifest(JSON.stringify({ ...m, version: 2 }))).toEqual({ ok: false, reason: 'version' });
    expect(readManifest(JSON.stringify({ ...m, version: 'x' }))).toEqual({ ok: false, reason: 'broken' });
    expect(readManifest('{')).toEqual({ ok: false, reason: 'broken' });
    // 旧い記録(detached が無い)は空として読む
    const { detached: _d, ...old } = m;
    void _d;
    const r = readManifest(JSON.stringify(old));
    expect(r.ok && r.manifest.detached).toEqual({});
  });
  it('🔴 readManifest: 「消した」「外した」の印の壊れた要素は捨てる(落とさない)', () => {
    const m = manifest({ a: rec('a.md') }) as unknown as { removed: Record<string, unknown>; detached: Record<string, unknown> };
    m.removed['ok'] = { file: 'x.md', hash: 'h' };
    m.removed['n'] = null;
    m.removed['num'] = 5;
    m.removed['nofile'] = { hash: 'h' };
    m.detached['yes'] = true;
    m.detached['str'] = 'true';
    const r = readManifest(JSON.stringify(m));
    expect(r.ok && Object.keys(r.manifest.removed)).toEqual(['ok']);
    expect(r.ok && r.manifest.detached).toEqual({ yes: true });
  });
  it('🔴 大文字小文字・NFC だけの改題は、前のファイルを持たない(prevFile=null)', () => {
    const m = manifest({ a: rec('readme.md', { title: 'readme' }) });
    const p = planSync(m, [note('a', { title: 'Readme', chars: 99 })], [ext('readme.md')]);
    expect(p.actions).toEqual([{ kind: 'write', lid: 'a', file: 'Readme.md', prevFile: null, reason: 'local' }]);
  });
  it('間隔の選択肢は昇順で 1 分以上', () => {
    expect([...SYNC_INTERVAL_MINUTES]).toEqual([...SYNC_INTERVAL_MINUTES].sort((a, b) => a - b));
    expect(SYNC_INTERVAL_MINUTES[0]).toBeGreaterThanOrEqual(1);
  });
});
