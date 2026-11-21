import { describe, expect, it } from 'vitest';
import {
  decideMerge,
  decideOne,
  entryFingerprintText,
  extractChanges,
  nextBaseline,
  relationFingerprintText,
  type KeyedState,
  type Tombstone,
} from '@features/sync/change-set';

const ks = (key: string, hash: string): KeyedState => ({ key, hash });
const tomb = (key: string, lastHash: string, seq = 1): Tombstone => ({ key, lastHash, device: 'aaaaaaaaaaaaaaaa', seq });

describe('指紋の材料', () => {
  const f = { title: '買い物', archetype: 'text', parentLid: 'f1', body: '牛乳' };
  it('題名・種別・親・本文のどれが変わっても文字列が変わる', () => {
    const base = entryFingerprintText(f);
    expect(entryFingerprintText({ ...f, title: '買物' })).not.toBe(base);
    expect(entryFingerprintText({ ...f, archetype: 'todo' })).not.toBe(base);
    expect(entryFingerprintText({ ...f, parentLid: null })).not.toBe(base);
    expect(entryFingerprintText({ ...f, body: '牛乳\n卵' })).not.toBe(base);
  });
  it('項目の境界をずらしても衝突しない(題名 "a" + 本文 "bc" と 題名 "ab" + 本文 "c")', () => {
    const a = entryFingerprintText({ title: 'a', archetype: 'text', parentLid: null, body: 'bc' });
    const b = entryFingerprintText({ title: 'ab', archetype: 'text', parentLid: null, body: 'c' });
    expect(a).not.toBe(b);
  });
  it('つながりの指紋は向き・種類で変わる', () => {
    const r = { from: 'a', to: 'b', kind: 'semantic' };
    expect(relationFingerprintText(r)).not.toBe(relationFingerprintText({ ...r, from: 'b', to: 'a' }));
    expect(relationFingerprintText(r)).not.toBe(relationFingerprintText({ ...r, kind: 'temporal' }));
  });
});

describe('extractChanges(前回の合意からの差)', () => {
  const baseline = { e1: 'h1', e2: 'h2', e3: 'h3' };
  it('追加・変更・削除・不変を分ける(複数件・日本語題名の lid はキーのみ)', () => {
    const cs = extractChanges([ks('e1', 'h1'), ks('e2', 'h2x'), ks('e4', 'h4'), ks('e5', 'h5')], baseline, []);
    expect(cs.added.map((a) => a.key)).toEqual(['e4', 'e5']);
    expect(cs.changed).toEqual([{ key: 'e2', hash: 'h2x' }]);
    expect(cs.deleted).toEqual([{ key: 'e3', lastHash: 'h3' }]);
  });
  it('合意が空なら現在の全件が追加', () => {
    const cs = extractChanges([ks('e2', 'x'), ks('e1', 'y')], {}, []);
    expect(cs.added.map((a) => a.key)).toEqual(['e1', 'e2']);
    expect(cs.changed).toEqual([]);
    expect(cs.deleted).toEqual([]);
  });
  it('ゴミ箱を空にして墓標が無くても、合意との差で削除を拾う', () => {
    const cs = extractChanges([ks('e1', 'h1')], baseline, []);
    expect(cs.deleted.map((d) => d.key)).toEqual(['e2', 'e3']);
  });
  it('一度も同期していない相手へも、墓標があれば削除が届く(第三の端末)', () => {
    const cs = extractChanges([ks('e1', 'h1')], { e1: 'h1' }, [tomb('e9', 'h9')]);
    expect(cs.deleted).toEqual([{ key: 'e9', lastHash: 'h9' }]);
  });
  it('いま在るキーの墓標は無視する(消してから戻した)', () => {
    const cs = extractChanges([ks('e9', 'h9')], {}, [tomb('e9', 'h9')]);
    expect(cs.deleted).toEqual([]);
    expect(cs.added).toEqual([{ key: 'e9', hash: 'h9' }]);
  });
  it('合意にあり墓標もあるキーは 1 件だけ(重複しない)', () => {
    const cs = extractChanges([], { e1: 'h1' }, [tomb('e1', 'h1')]);
    expect(cs.deleted).toEqual([{ key: 'e1', lastHash: 'h1' }]);
  });
});

describe('decideOne(三者比較の全分岐)', () => {
  const present = (hash: string) => ({ kind: 'present' as const, hash });
  const del = (lastHash: string) => ({ kind: 'deleted' as const, lastHash });
  it('双方が同じ内容 → 何もしない', () => {
    expect(decideOne('k', 'b', 'x', present('x')).action).toBe('noop');
    expect(decideOne('k', undefined, 'x', present('x')).action).toBe('noop');
  });
  it('双方が消した → 何もしない', () => {
    expect(decideOne('k', 'b', undefined, del('b')).action).toBe('noop');
    expect(decideOne('k', 'b', undefined, { kind: 'absent' }).action).toBe('noop');
  });
  it('相手だけが変えた → 取り込む', () => {
    expect(decideOne('k', 'b', 'b', present('r'))).toEqual({ action: 'take-remote', key: 'k', hash: 'r' });
  });
  it('相手だけが追加した → 取り込む', () => {
    expect(decideOne('k', undefined, undefined, present('r')).action).toBe('take-remote');
  });
  it('こちらだけが変えた → 送る', () => {
    expect(decideOne('k', 'b', 'l', present('b'))).toEqual({ action: 'push-local', key: 'k', hash: 'l' });
  });
  it('こちらだけが追加した → 送る', () => {
    expect(decideOne('k', undefined, 'l', { kind: 'absent' }).action).toBe('push-local');
  });
  it('相手が消し、こちらは変えていない → ゴミ箱へ', () => {
    expect(decideOne('k', 'b', 'b', del('b')).action).toBe('trash-local');
  });
  it('こちらが消し、相手は変えていない → 相手へ消去を送る', () => {
    expect(decideOne('k', 'b', undefined, present('b'))).toEqual({ action: 'push-delete', key: 'k', lastHash: 'b' });
  });
  it('両方が変えて違う内容 → 競合(両方残す)', () => {
    expect(decideOne('k', 'b', 'l', present('r'))).toMatchObject({
      action: 'conflict',
      kind: 'both-edited',
      resolution: 'keep-both-copy',
      localHash: 'l',
      remoteHash: 'r',
    });
  });
  it('両方が別々に新規作成(同じ lid・違う内容)→ 競合', () => {
    expect(decideOne('k', undefined, 'l', present('r'))).toMatchObject({ action: 'conflict', kind: 'both-added', resolution: 'keep-both-copy' });
  });
  it('こちらは消し、相手は変えた → 競合(消さない・相手の版を戻す)', () => {
    expect(decideOne('k', 'b', undefined, present('r'))).toMatchObject({
      action: 'conflict',
      kind: 'deleted-here-edited-there',
      resolution: 'restore-remote',
      remoteHash: 'r',
    });
  });
  it('こちらは変え、相手は消した → 競合(消さない・こちらを残す)', () => {
    expect(decideOne('k', 'b', 'l', del('b'))).toMatchObject({
      action: 'conflict',
      kind: 'edited-here-deleted-there',
      resolution: 'keep-local',
      localHash: 'l',
    });
  });
  it('合意が無くても墓標の指紋を基準にできる: 同じ内容なら消す / 違えば競合', () => {
    expect(decideOne('k', undefined, 'h9', del('h9')).action).toBe('trash-local');
    expect(decideOne('k', undefined, 'h9x', del('h9'))).toMatchObject({ kind: 'edited-here-deleted-there' });
  });
  it('相手が編集後に消した墓標(合意と墓標の指紋が違う)でも、こちらが未変更なら消す', () => {
    expect(decideOne('k', 'b', 'b', del('b2')).action).toBe('trash-local');
  });
});

describe('decideMerge(複数ノート)', () => {
  const baseline = { n1: 'a', n2: 'b', n3: 'c', n4: 'd', n5: 'e', n6: 'f' };
  it('全件の相手 ── 各分岐が同時に正しく出る', () => {
    const local = [ks('n1', 'a'), ks('n2', 'b2'), ks('n3', 'c'), ks('n4', 'd'), ks('n7', 'g')];
    const remote = [ks('n1', 'a'), ks('n2', 'b'), ks('n3', 'c3'), ks('n4', 'd4'), ks('n5', 'e'), ks('n8', 'i')];
    const d = decideMerge({ baseline, local, remote, remoteTombstones: [], remoteIsComplete: true });
    const by = Object.fromEntries(d.map((x) => [x.key, x]));
    expect(by.n1?.action).toBe('noop');
    expect(by.n2?.action).toBe('push-local');
    expect(by.n3?.action).toBe('take-remote');
    expect(by.n4?.action).toBe('take-remote');
    expect(by.n5?.action).toBe('push-delete'); // こちらで消し、相手は変えていない
    expect(by.n6?.action).toBe('noop'); // 双方で消えた
    expect(by.n7?.action).toBe('push-local');
    expect(by.n8?.action).toBe('take-remote');
    expect(d.map((x) => x.key)).toEqual([...d.map((x) => x.key)].sort());
  });
  it('差分だけの相手: 相手に無い物は「変えていない」、墓標のある物だけ消える', () => {
    const local = [ks('n1', 'a'), ks('n2', 'b'), ks('n3', 'cL')];
    const d = decideMerge({
      baseline: { n1: 'a', n2: 'b', n3: 'c' },
      local,
      remote: [],
      remoteTombstones: [tomb('n2', 'b'), tomb('n3', 'c')],
      remoteIsComplete: false,
    });
    const by = Object.fromEntries(d.map((x) => [x.key, x]));
    expect(by.n1?.action).toBe('noop');
    expect(by.n2?.action).toBe('trash-local');
    expect(by.n3).toMatchObject({ action: 'conflict', kind: 'edited-here-deleted-there' });
  });
  it('全件の相手でも、こちらの変更は消されない(相手に無い + こちらが変更 → 競合)', () => {
    const d = decideMerge({ baseline: { n1: 'a' }, local: [ks('n1', 'a2')], remote: [], remoteTombstones: [], remoteIsComplete: true });
    expect(d[0]).toMatchObject({ action: 'conflict', kind: 'edited-here-deleted-there' });
  });
});

describe('時計ずれの耐性(判定は updated_at を見ない)', () => {
  it('入力に時刻が無い型で完結する: 端末 A の時計が 1 年先・B が 1 年前でも結果は同じ', () => {
    // 指紋が同じなら、時計がどうであれ noop。指紋が違えば、どちらが「新しい」かに関係なく競合。
    const d1 = decideOne('k', 'b', 'l', { kind: 'present', hash: 'r' });
    const d2 = decideOne('k', 'b', 'l', { kind: 'present', hash: 'r' });
    expect(d1).toEqual(d2);
    expect(d1.action).toBe('conflict');
  });
  it('時計が戻って「古い更新日時」で再編集されても、指紋が変われば変更として拾う', () => {
    const cs = extractChanges([ks('e1', 'edited-after-clock-rollback')], { e1: 'old' }, []);
    expect(cs.changed).toHaveLength(1);
  });
  it('更新日時だけが進んで内容が同じなら変更ではない', () => {
    expect(extractChanges([ks('e1', 'same')], { e1: 'same' }, [])).toEqual({ added: [], changed: [], deleted: [] });
  });
});

describe('nextBaseline と往復', () => {
  it('同期後の全件が次の合意になり、消えたキーは載らない。次の抽出は空', () => {
    const final = [ks('n1', 'a'), ks('n2', 'b2')];
    const b = nextBaseline(final);
    expect(b).toEqual({ n1: 'a', n2: 'b2' });
    expect(extractChanges(final, b, [])).toEqual({ added: [], changed: [], deleted: [] });
  });
  it('2 端末の往復: A 編集・B 別ノート編集 → 取り込みあって収束する', () => {
    const base = { n1: 'a', n2: 'b' };
    const A = [ks('n1', 'a1'), ks('n2', 'b')];
    const B = [ks('n1', 'a'), ks('n2', 'b1')];
    const atA = decideMerge({ baseline: base, local: A, remote: B, remoteTombstones: [], remoteIsComplete: true });
    expect(atA.map((x) => x.action)).toEqual(['push-local', 'take-remote']);
    const atB = decideMerge({ baseline: base, local: B, remote: A, remoteTombstones: [], remoteIsComplete: true });
    expect(atB.map((x) => x.action)).toEqual(['take-remote', 'push-local']);
  });
});
