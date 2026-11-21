import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  decideMerge,
  decideOne,
  entryFingerprintTexts,
  extractChanges,
  nextBaseline,
  relationFingerprintText,
  relationKey,
  seedBaseline,
  type Baseline,
  type Decision,
  type Fp,
  type KeyedState,
  type MergeInput,
  type Tombstone,
} from '@features/sync/change-set';

const fp = (content: string, place?: string): Fp => (place === undefined ? { content } : { content, place });
const ks = (key: string, content: string, place?: string): KeyedState => ({ key, ...fp(content, place) });
const tomb = (key: string, content: string, place?: string, seq = 1): Tombstone => ({
  key,
  lastFp: fp(content, place),
  device: 'aaaaaaaaaaaaaaaa',
  seq,
});
const bl = (o: Record<string, Fp>): Baseline => o;
const present = (content: string, place?: string) => ({ kind: 'present' as const, fp: fp(content, place) });
const del = (content: string, place?: string) => ({ kind: 'deleted' as const, lastFp: fp(content, place) });
const noTomb: readonly Tombstone[] = [];
const merge = (m: Partial<MergeInput> & Pick<MergeInput, 'local' | 'remote'>): readonly Decision[] =>
  decideMerge({ baseline: {}, remoteTombstones: noTomb, localTombstones: noTomb, remoteIsComplete: true, ...m });

describe('指紋の材料', () => {
  const f = { title: '買い物', archetype: 'text', parentLid: 'f1', body: '牛乳' };
  it('題名・種別・本文は content、親は place に分かれる', () => {
    const base = entryFingerprintTexts(f);
    for (const c of [{ title: '買物' }, { archetype: 'todo' }, { body: '牛乳\n卵' }]) {
      const x = entryFingerprintTexts({ ...f, ...c });
      expect(x.content).not.toBe(base.content);
      expect(x.place).toBe(base.place);
    }
    const moved = entryFingerprintTexts({ ...f, parentLid: null });
    expect(moved.place).not.toBe(base.place);
    expect(moved.content).toBe(base.content);
  });
  it('項目の境界をずらしても衝突しない', () => {
    const a = entryFingerprintTexts({ title: 'a', archetype: 'text', parentLid: null, body: 'bc' });
    const b = entryFingerprintTexts({ title: 'ab', archetype: 'text', parentLid: null, body: 'c' });
    expect(a.content).not.toBe(b.content);
  });
  it('つながりのキーは from|to|kind(id ではない)。向き・種類で変わり、指紋は定数', () => {
    const r = { from: 'a', to: 'b', kind: 'semantic' };
    expect(relationKey(r)).toBe('rel:a|b|semantic');
    expect(relationKey(r)).not.toBe(relationKey({ ...r, from: 'b', to: 'a' }));
    expect(relationKey(r)).not.toBe(relationKey({ ...r, kind: 'temporal' }));
    expect(relationFingerprintText()).toBe(relationFingerprintText());
  });
  it('🔴 2 台が同じ A→B を別々に作っても 1 本に揃い、重複しない', () => {
    // id が違っても、キーが同じなので同じ指紋 → noop(重複の取り込みが起きない)
    const k = relationKey({ from: 'a', to: 'b', kind: 'semantic' });
    const c = relationFingerprintText();
    const d = merge({ local: [ks(k, c)], remote: [ks(k, c)] });
    expect(d).toEqual([{ action: 'noop', key: k }]);
  });
});

describe('extractChanges(前回の合意からの差)', () => {
  const baseline = bl({ e1: fp('h1', 'p'), e2: fp('h2', 'p'), e3: fp('h3', 'p') });
  it('追加・変更・削除・不変を分ける', () => {
    const cs = extractChanges([ks('e1', 'h1', 'p'), ks('e2', 'h2x', 'p'), ks('e4', 'h4', 'p'), ks('e5', 'h5', 'p')], baseline, []);
    expect(cs.added.map((a) => a.key)).toEqual(['e4', 'e5']);
    expect(cs.changed).toEqual([{ key: 'e2', content: 'h2x', place: 'p' }]);
    expect(cs.deleted).toEqual([{ key: 'e3', lastFp: fp('h3', 'p') }]);
  });
  it('移動だけ(place だけ違う)でも変更として拾う', () => {
    const cs = extractChanges([ks('e1', 'h1', 'q'), ks('e2', 'h2', 'p'), ks('e3', 'h3', 'p')], baseline, []);
    expect(cs.changed.map((c) => c.key)).toEqual(['e1']);
  });
  it('合意が空なら現在の全件が追加(キーの昇順)', () => {
    const cs = extractChanges([ks('e2', 'x'), ks('e1', 'y')], {}, []);
    expect(cs.added.map((a) => a.key)).toEqual(['e1', 'e2']);
    expect(cs.changed).toEqual([]);
    expect(cs.deleted).toEqual([]);
  });
  it('ゴミ箱を空にして墓標が無くても、合意との差で削除を拾う', () => {
    const cs = extractChanges([ks('e1', 'h1', 'p')], baseline, []);
    expect(cs.deleted.map((d) => d.key)).toEqual(['e2', 'e3']);
  });
  it('一度も同期していない相手へも、墓標があれば削除が届く(第三の端末)', () => {
    const cs = extractChanges([ks('e1', 'h1')], bl({ e1: fp('h1') }), [tomb('e9', 'h9')]);
    expect(cs.deleted).toEqual([{ key: 'e9', lastFp: fp('h9') }]);
  });
  it('🔴 同じキーの墓標が重なっていても、削除は 1 件(先の物の指紋)', () => {
    const cs = extractChanges([], {}, [tomb('e9', 'first', undefined, 1), tomb('e9', 'second', undefined, 2), tomb('e8', 'x')]);
    expect(cs.deleted).toEqual([
      { key: 'e8', lastFp: fp('x') },
      { key: 'e9', lastFp: fp('first') },
    ]);
  });
  it('いま在るキーの墓標は無視する(消してから戻した)', () => {
    const cs = extractChanges([ks('e9', 'h9')], {}, [tomb('e9', 'h9')]);
    expect(cs.deleted).toEqual([]);
    expect(cs.added).toEqual([{ key: 'e9', content: 'h9' }]);
  });
  it('合意にあり墓標もあるキーは 1 件だけ(重複しない)', () => {
    const cs = extractChanges([], bl({ e1: fp('h1') }), [tomb('e1', 'h1')]);
    expect(cs.deleted).toEqual([{ key: 'e1', lastFp: fp('h1') }]);
  });
  it('🔴 順は入力の順に依らない(合意・墓標を逆順で渡しても削除はキーの昇順)', () => {
    const cs = extractChanges([], bl({ e9: fp('a'), e1: fp('b'), e5: fp('c') }), [tomb('e8', 'x'), tomb('e2', 'y'), tomb('e7', 'z')]);
    expect(cs.deleted.map((d) => d.key)).toEqual(['e1', 'e2', 'e5', 'e7', 'e8', 'e9']);
    const cs2 = extractChanges([ks('e7', 'q'), ks('e3', 'q'), ks('e5', 'q')], {}, []);
    expect(cs2.added.map((d) => d.key)).toEqual(['e3', 'e5', 'e7']);
  });
});

describe('decideOne(三者比較の全分岐)', () => {
  it('双方が同じ内容 → 何もしない', () => {
    expect(decideOne('k', fp('b'), fp('x'), present('x')).action).toBe('noop');
    expect(decideOne('k', undefined, fp('x'), present('x')).action).toBe('noop');
  });
  it('双方が消した → 何もしない', () => {
    expect(decideOne('k', fp('b'), undefined, del('b')).action).toBe('noop');
    expect(decideOne('k', fp('b'), undefined, { kind: 'absent' }).action).toBe('noop');
  });
  it('相手だけが変えた → 取り込む / 追加も', () => {
    expect(decideOne('k', fp('b'), fp('b'), present('r'))).toEqual({ action: 'take-remote', key: 'k', fp: fp('r') });
    expect(decideOne('k', undefined, undefined, present('r')).action).toBe('take-remote');
  });
  it('こちらだけが変えた → 送る / 追加も', () => {
    expect(decideOne('k', fp('b'), fp('l'), present('b'))).toEqual({ action: 'push-local', key: 'k', fp: fp('l') });
    expect(decideOne('k', undefined, fp('l'), { kind: 'absent' }).action).toBe('push-local');
  });
  it('相手が消し、こちらは変えていない → ゴミ箱へ', () => {
    expect(decideOne('k', fp('b'), fp('b'), del('b')).action).toBe('trash-local');
  });
  it('こちらが消し、相手は変えていない → 相手へ消去を送る', () => {
    expect(decideOne('k', fp('b'), undefined, present('b'))).toEqual({ action: 'push-delete', key: 'k', lastFp: fp('b') });
  });
  it('同じ欄を両方が変えて違う → 競合(両方残す)。欄が分かる', () => {
    expect(decideOne('k', fp('b', 'p'), fp('l', 'p'), present('r', 'p'))).toMatchObject({
      action: 'conflict',
      kind: 'both-edited',
      resolution: 'keep-both-copy',
      fields: ['content'],
      local: fp('l', 'p'),
      remote: fp('r', 'p'),
    });
    expect(decideOne('k', fp('b', 'p'), fp('b', 'q'), present('b', 'r'))).toMatchObject({ kind: 'both-edited', fields: ['place'] });
    expect(decideOne('k', fp('b', 'p'), fp('l', 'q'), present('r', 'r'))).toMatchObject({ fields: ['content', 'place'] });
  });
  it('⚠1 片方が移動・もう片方が編集 → 競合にならず自動で合わさる', () => {
    const base = fp('b', 'p');
    const d = decideOne('k', base, fp('b', 'q'), present('r', 'p')); // こちら=移動、相手=編集
    expect(d).toEqual({ action: 'merge', key: 'k', fp: fp('r', 'q') });
    const d2 = decideOne('k', base, fp('l', 'p'), present('b', 'q')); // こちら=編集、相手=移動
    expect(d2).toEqual({ action: 'merge', key: 'k', fp: fp('l', 'q') });
  });
  it('両方が同じ変更をした欄は競合にならない(片方の欄だけ違う)', () => {
    expect(decideOne('k', fp('b', 'p'), fp('x', 'q'), present('x', 'p'))).toEqual({ action: 'push-local', key: 'k', fp: fp('x', 'q') });
    expect(decideOne('k', fp('b', 'p'), fp('x', 'p'), present('x', 'q'))).toEqual({ action: 'take-remote', key: 'k', fp: fp('x', 'q') });
  });
  it('合意が無く両方にあって違う → first-sync(競合・両方残す。通常の競合と区別)', () => {
    expect(decideOne('k', undefined, fp('l', 'p'), present('r', 'p'))).toMatchObject({
      action: 'conflict',
      kind: 'first-sync',
      resolution: 'keep-both-copy',
      fields: ['content'],
    });
  });
  it('こちらは消し、相手は変えた → 競合(消さない・相手の版を戻す)。移動だけでも変更', () => {
    expect(decideOne('k', fp('b', 'p'), undefined, present('r', 'p'))).toMatchObject({
      action: 'conflict',
      kind: 'deleted-here-edited-there',
      resolution: 'restore-remote',
      remote: fp('r', 'p'),
    });
    expect(decideOne('k', fp('b', 'p'), undefined, present('b', 'q')).action).toBe('conflict');
  });
  it('こちらは変え、相手は消した → 競合(消さない・こちらを残す)', () => {
    expect(decideOne('k', fp('b'), fp('l'), del('b'))).toMatchObject({
      action: 'conflict',
      kind: 'edited-here-deleted-there',
      resolution: 'keep-local',
      local: fp('l'),
    });
  });
  it('合意が無くても相手の墓標の指紋を基準にできる: 同じ内容なら消す / 違えば競合', () => {
    expect(decideOne('k', undefined, fp('h9'), del('h9')).action).toBe('trash-local');
    expect(decideOne('k', undefined, fp('h9x'), del('h9'))).toMatchObject({ kind: 'edited-here-deleted-there' });
  });
  it('相手が編集後に消した墓標(合意と墓標の指紋が違う)でも、こちらが未変更なら消す', () => {
    expect(decideOne('k', fp('b'), fp('b'), del('b2')).action).toBe('trash-local');
  });
  it('🔴 合意の指紋が空文字でも「合意あり」として扱う(墓標の指紋に化けない)', () => {
    // 合意 {content:''} が墓標の指紋 'z' に取って代わられると、local 'z' が trash-local になってしまう
    expect(decideOne('k', fp(''), fp('z'), del('z'))).toMatchObject({ action: 'conflict', kind: 'edited-here-deleted-there' });
    expect(decideOne('k', fp(''), fp(''), del('z')).action).toBe('trash-local');
  });
});

describe('decideMerge(複数ノート)', () => {
  const baseline = bl({ n1: fp('a'), n2: fp('b'), n3: fp('c'), n4: fp('d'), n5: fp('e'), n6: fp('f') });
  it('全件の相手 ── 各分岐が同時に正しく出る', () => {
    const local = [ks('n1', 'a'), ks('n2', 'b2'), ks('n3', 'c'), ks('n4', 'd'), ks('n7', 'g')];
    const remote = [ks('n1', 'a'), ks('n2', 'b'), ks('n3', 'c3'), ks('n4', 'd4'), ks('n5', 'e'), ks('n8', 'i')];
    const d = merge({ baseline, local, remote });
    const by = Object.fromEntries(d.map((x) => [x.key, x]));
    expect(by.n1?.action).toBe('noop');
    expect(by.n2?.action).toBe('push-local');
    expect(by.n3?.action).toBe('take-remote');
    expect(by.n4?.action).toBe('take-remote');
    expect(by.n5?.action).toBe('push-delete');
    expect(by.n6?.action).toBe('noop');
    expect(by.n7?.action).toBe('push-local');
    expect(by.n8?.action).toBe('take-remote');
    expect(d.map((x) => x.key)).toEqual([...d.map((x) => x.key)].sort());
  });
  it('差分だけの相手: 相手に無い物は「変えていない」、墓標のある物だけ消える', () => {
    const d = merge({
      baseline: bl({ n1: fp('a'), n2: fp('b'), n3: fp('c') }),
      local: [ks('n1', 'a'), ks('n2', 'b'), ks('n3', 'cL')],
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
    const d = merge({ baseline: bl({ n1: fp('a') }), local: [ks('n1', 'a2')], remote: [] });
    expect(d[0]).toMatchObject({ action: 'conflict', kind: 'edited-here-deleted-there' });
  });
  it('🔴 相手に在るキーに同じキーの墓標も付いてきたら、在る方を採る(墓標より present が先)', () => {
    // 墓標が先に評価されると、こちら未変更(b)は trash-local になってしまう
    const d = merge({
      baseline: bl({ n1: fp('b') }),
      local: [ks('n1', 'b')],
      remote: [ks('n1', 'r')],
      remoteTombstones: [tomb('n1', 'b')],
    });
    expect(d).toEqual([{ action: 'take-remote', key: 'n1', fp: fp('r') }]);
  });
  it('🔴1 こちらで消した(ゴミ箱を空にした)ノートは、合意が無くても未同期の相手から復活しない', () => {
    const d = merge({ local: [], remote: [ks('n1', 'h', 'p')], localTombstones: [tomb('n1', 'h', 'p')] });
    expect(d).toEqual([{ action: 'push-delete', key: 'n1', lastFp: fp('h', 'p') }]);
    // 対照: こちらの墓標が無ければ(従来)相手の物が「新規」として戻ってくる
    expect(merge({ local: [], remote: [ks('n1', 'h', 'p')] })[0]?.action).toBe('take-remote');
  });
  it('🔴 合意とこちらの墓標が両方ある(こちらは消し済み): 合意の指紋が正本 → 相手が合意のままなら push-delete', () => {
    // 墓標の指紋('edited')を先に使うと、相手('b')と食い違って競合に見える
    const d = merge({
      baseline: bl({ n1: fp('b') }),
      local: [],
      remote: [ks('n1', 'b')],
      localTombstones: [tomb('n1', 'edited')],
    });
    expect(d).toEqual([{ action: 'push-delete', key: 'n1', lastFp: fp('b') }]);
  });
  it('🔴1 こちらの墓標があり、相手が編集していた(内容が違う)→ 競合(相手の版を戻す)', () => {
    const d = merge({ local: [], remote: [ks('n1', 'h2', 'p')], localTombstones: [tomb('n1', 'h', 'p')] });
    expect(d[0]).toMatchObject({ action: 'conflict', kind: 'deleted-here-edited-there', resolution: 'restore-remote', remote: fp('h2', 'p') });
  });
  it('🔴1 こちらの墓標があってもキーが今こちらに在る(戻した)なら墓標は使わない', () => {
    const d = merge({ local: [ks('n1', 'h')], remote: [ks('n1', 'h2')], localTombstones: [tomb('n1', 'h')] });
    expect(d[0]).toMatchObject({ action: 'conflict', kind: 'first-sync' });
  });
});

describe('⚠2 first-sync と種の同期の記録(seedBaseline)', () => {
  // 同じバックアップから復元した 2 台。復元後に A は n1 を、B は n2 を編集した
  const snapshot = [ks('n1', 'a', 'p'), ks('n2', 'b', 'p'), ks('n3', 'c', 'p')];
  const A = [ks('n1', 'a1', 'p'), ks('n2', 'b', 'p'), ks('n3', 'c', 'p')];
  const B = [ks('n1', 'a', 'p'), ks('n2', 'b1', 'p'), ks('n3', 'c', 'p')];
  it('記録が無いと、編集したノートは first-sync の競合(安全側)', () => {
    const a = merge({ local: A, remote: B });
    expect(a.map((d) => d.action)).toEqual(['conflict', 'conflict', 'noop']);
    expect(a.map((d) => (d.action === 'conflict' ? d.kind : null))).toEqual(['first-sync', 'first-sync', null]);
  });
  it('種があれば、同じ編集が競合にならず取り込み・送りになる', () => {
    const seed = seedBaseline(snapshot);
    expect(seed).toEqual({ n1: fp('a', 'p'), n2: fp('b', 'p'), n3: fp('c', 'p') });
    expect(merge({ baseline: seed, local: A, remote: B }).map((d) => d.action)).toEqual(['push-local', 'take-remote', 'noop']);
    expect(merge({ baseline: seed, local: B, remote: A }).map((d) => d.action)).toEqual(['take-remote', 'push-local', 'noop']);
  });
  it('種は空の指紋を捨て、同じキーは後の物を採る', () => {
    const s = seedBaseline([ks('x', ''), ks('y', '1'), ks('y', '2')]);
    expect(s).toEqual({ y: fp('2') });
  });
});

describe('時計は判定に入らない(入力の型に時刻の欄が無い)', () => {
  it('KeyedState / Fp / MergeInput の欄に時刻・連番が無い(型で固定)', () => {
    expectTypeOf<keyof KeyedState>().toEqualTypeOf<'key' | 'content' | 'place'>();
    expectTypeOf<keyof Fp>().toEqualTypeOf<'content' | 'place'>();
    expectTypeOf<keyof MergeInput>().toEqualTypeOf<
      'baseline' | 'local' | 'remote' | 'remoteTombstones' | 'localTombstones' | 'remoteIsComplete'
    >();
  });
  it('墓標の deletedAt は表示・整理専用: 日時が違っても判定は同じ', () => {
    const early = { ...tomb('n1', 'b'), deletedAt: '2000-01-01T00:00:00Z' };
    const late = { ...tomb('n1', 'b'), deletedAt: '2099-01-01T00:00:00Z' };
    const run = (t: Tombstone) => merge({ baseline: bl({ n1: fp('b') }), local: [ks('n1', 'b')], remote: [], remoteTombstones: [t] });
    expect(run(early)).toEqual(run(late));
    expect(run(early)[0]?.action).toBe('trash-local');
  });
  it('更新日時だけが進んで内容が同じなら変更ではない', () => {
    expect(extractChanges([ks('e1', 'same')], bl({ e1: fp('same') }), [])).toEqual({ added: [], changed: [], deleted: [] });
  });
});

describe('nextBaseline と往復', () => {
  it('同期後の全件が次の合意になり、消えたキーは載らない。次の抽出は空', () => {
    const final = [ks('n1', 'a', 'p'), ks('n2', 'b2')];
    const b = nextBaseline(final);
    expect(b).toEqual({ n1: fp('a', 'p'), n2: fp('b2') });
    expect(extractChanges(final, b, [])).toEqual({ added: [], changed: [], deleted: [] });
  });
  it('2 端末の往復: A 編集・B 別ノート編集 → 取り込みあって収束する', () => {
    const base = bl({ n1: fp('a'), n2: fp('b') });
    const A = [ks('n1', 'a1'), ks('n2', 'b')];
    const B = [ks('n1', 'a'), ks('n2', 'b1')];
    expect(merge({ baseline: base, local: A, remote: B }).map((x) => x.action)).toEqual(['push-local', 'take-remote']);
    expect(merge({ baseline: base, local: B, remote: A }).map((x) => x.action)).toEqual(['take-remote', 'push-local']);
  });
  it('⚠1 移動(A)と編集(B)の往復: 両端で同じ結果に収束する', () => {
    const base = bl({ n1: fp('a', 'p') });
    const A = [ks('n1', 'a', 'q')];
    const B = [ks('n1', 'a1', 'p')];
    const atA = merge({ baseline: base, local: A, remote: B })[0];
    const atB = merge({ baseline: base, local: B, remote: A })[0];
    expect(atA).toEqual({ action: 'merge', key: 'n1', fp: fp('a1', 'q') });
    expect(atB).toEqual({ action: 'merge', key: 'n1', fp: fp('a1', 'q') });
  });
});
