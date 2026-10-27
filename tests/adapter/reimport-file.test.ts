/** @vitest-environment happy-dom */
/**
 * 🔴 **取り込んだ後にパソコン側で変わったファイルを、もう一度押したら「取り込み直す」**
 * (台帳 #1852 束 N1 / 依頼 97-2 A。Gemini 回答 = 推薦どおり)。
 *
 * 直す前: 外のエディタで直して同じ行をもう一度押しても「取り込んだ後にパソコン側で変わっています」と出るだけで、
 * 外で直した内容を PKC3 に取り込む道が無かった(「元ファイルへ書き戻す」は、外の変更を消す側にしか進めない)。
 *
 * 守る主張:
 *  1. 聞く(ノートの中身を置き換えるので)。「取り込み直す」を選んだときだけ置き換える
 *  2. 置き換えるのは本文だけ。今のノートの中身は履歴に積まれ、画面の下の「元に戻す」で戻せる
 *  3. 本文が同じなら書かない(履歴を増やさない)/ 別の窓が書いていたら断る / ノートが消えていたら理由を言う
 *  4. ファイルが読めなかったときは、ノートに触らず理由を言う
 */
import { describe, expect, it, vi } from 'vitest';
import {
  REIMPORT_CANCEL_LABEL,
  REIMPORT_OK_LABEL,
  REIMPORT_UNREADABLE,
  offerReimport,
  reimportQuestion,
  type ReimportDeps,
} from '../../src/adapter/ui/actions/reimport-file';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';

function deps(over: Partial<ReimportDeps> = {}): { d: ReimportDeps; calls: string[]; said: string[]; asked: string[] } {
  const calls: string[] = [];
  const said: string[] = [];
  const asked: string[] = [];
  const d: ReimportDeps = {
    confirm: async (message, o) => {
      asked.push(`${message}|${o.okLabel}|${o.cancelLabel}`);
      return true;
    },
    readText: async () => '外で直した本文',
    titleOf: (lid) => (lid === 'n1' ? 'メモ' : null),
    replace: (lid, body) => void calls.push(`replace:${lid}:${body}`),
    refreshModified: async (lid) => void calls.push(`refresh:${lid}`),
    say: (t) => void said.push(t),
    ...over,
  };
  return { d, calls, said, asked };
}

describe('1. 聞いてから置き換える', () => {
  it('🔴 確認の字は題名とファイル名を言い、「取り込み直す」「このままにする」を出す。選んだら置き換え、更新時刻を憶え直す', async () => {
    const h = deps();
    expect(await offerReimport(h.d, { lid: 'n1', name: 'memo.md' })).toBe(true);
    expect(h.asked).toEqual([`${reimportQuestion('メモ', 'memo.md')}|${REIMPORT_OK_LABEL}|${REIMPORT_CANCEL_LABEL}`]);
    expect(reimportQuestion('メモ', 'memo.md')).toContain('「メモ」');
    expect(reimportQuestion('メモ', 'memo.md')).toContain('「memo.md」');
    expect(reimportQuestion('メモ', 'memo.md'), '前の中身が残ると言っていない').toContain('履歴に残ります');
    expect(h.calls).toEqual(['replace:n1:外で直した本文', 'refresh:n1']);
  });

  it('⚠ 対照群 ── 「このままにする」なら、読みも書きもしない', async () => {
    const readText = vi.fn(async () => '外で直した本文');
    const h = deps({ confirm: async () => false, readText });
    expect(await offerReimport(h.d, { lid: 'n1', name: 'memo.md' })).toBe(false);
    expect(readText, '断ったのに読んだ').not.toHaveBeenCalled();
    expect(h.calls, '断ったのに置き換えた / 更新時刻を憶え直した(次に聞かなくなる)').toEqual([]);
  });

  it('ノートがもう無いときは聞かない', async () => {
    const h = deps();
    expect(await offerReimport(h.d, { lid: 'gone', name: 'x.md' })).toBe(false);
    expect(h.asked).toEqual([]);
  });

  it('🔴 答えを待つ間にノートが消えたら、置き換えない(消えたノートを作り直さない)', async () => {
    let alive = true;
    const h = deps({
      titleOf: () => (alive ? 'メモ' : null),
      confirm: async () => {
        alive = false;
        return true;
      },
    });
    expect(await offerReimport(h.d, { lid: 'n1', name: 'memo.md' })).toBe(false);
    expect(h.calls).toEqual([]);
  });
});

describe('4. ファイルが読めなかったとき', () => {
  it('🔴 ノートに触らず、理由を言う', async () => {
    const h = deps({
      readText: async () => {
        throw new Error('gone');
      },
    });
    expect(await offerReimport(h.d, { lid: 'n1', name: 'memo.md' })).toBe(false);
    expect(h.calls).toEqual([]);
    expect(h.said).toEqual([REIMPORT_UNREADABLE]);
  });
});

/** 実物の書き込み(effect)から画面まで届くこと ── 2・3 の主張。 */
describe('本文を置き換える書き込み(REIMPORT_BODY → REQUEST_REIMPORT)', () => {
  const meta = (lid: string, title: string, archetype = 'text'): EntryMeta => ({
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  });
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

  function wired(disk: { body: string | null }, over: Record<string, unknown> = {}) {
    const d = new Dispatcher();
    const written: Array<{ entry: { lid: string; body: string }; opts: Record<string, unknown> | undefined }> = [];
    let revisions = 0;
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => disk.body,
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async (entry: { lid: string; body: string }, opts?: Record<string, unknown>) => {
        written.push({ entry, opts });
        // 本物の worker と同じ ── checkpoint で現状を履歴へ積む
        if (opts?.checkpoint === true) revisions += 1;
        disk.body = entry.body;
        return stubStamps();
      },
      listRevisionMetas: async () => Array.from({ length: revisions }, (_, i) => ({ id: `rev-${String(i)}`, rev_order: i })),
      ...over,
    } as never);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 'メモ')], relations: [] });
    return { d, written };
  }

  it('🔴 置き換えると、前の中身が履歴に積まれ、画面の本文が新しくなり、知らせの隣に「元に戻す」の行き先が付く', async () => {
    const disk = { body: '取り込んだときの本文' };
    const { d, written } = wired(disk);
    // 押した行のノートは、取り込み直す前に選ばれている(`selectWhenPresent`)
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '取り込んだときの本文' });
    d.dispatch({ type: 'REIMPORT_BODY', lid: 'n1', body: '外で直した本文' });
    await tick();
    expect(written, '書いていない').toHaveLength(1);
    expect(written[0]!.opts?.checkpoint, '前の中身を履歴に積んでいない(戻せない)').toBe(true);
    expect(written[0]!.opts?.expectHash, '別の窓の書込を踏まない門が無い').toBeTruthy();
    expect(written[0]!.entry.body).toBe('外で直した本文');
    expect(d.getState().openBody?.body, '画面の本文が新しくなっていない').toBe('外で直した本文');
    expect(d.getState().notice).toBe('「メモ」を、パソコン側のファイルの今の中身に取り込み直しました(前の中身は履歴に残しています)');
    expect(d.getState().restoreUndo?.revId, '「元に戻す」の行き先が無い').toBe('rev-0');
    expect(d.getState().restoreUndo?.notice, '「元に戻す」が出る知らせの字が違う').toBe(d.getState().notice);
  });

  it('別のノートを選び直していても、取り込み直したことは言う(選択を奪い返さない)', async () => {
    const disk = { body: '取り込んだときの本文' };
    const { d } = wired(disk);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 'メモ'), meta('n2', '別')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'REIMPORT_BODY', lid: 'n1', body: '外で直した本文' });
    await tick();
    expect(d.getState().selectedLid, '選択を奪い返した').toBe('n2');
    expect(d.getState().notice).toBe('「メモ」を、パソコン側のファイルの今の中身に取り込み直しました(前の中身は履歴に残しています)');
  });

  it('🔴 本文が同じなら書かない(履歴を増やさない)', async () => {
    const disk = { body: '同じ本文' };
    const { d, written } = wired(disk);
    d.dispatch({ type: 'REIMPORT_BODY', lid: 'n1', body: '同じ本文' });
    await tick();
    expect(written).toEqual([]);
    expect(d.getState().notice).toBe('「メモ」は、ファイルの今の中身と同じなので、そのままです');
  });

  it('🔴 読んでから書くまでに別の窓が書いていたら断る(1 バイトも書かない扱い)', async () => {
    const disk = { body: '取り込んだときの本文' };
    const { d } = wired(disk, {
      persistEntry: async () => ({ ...stubStamps(), conflict: true }),
    });
    d.dispatch({ type: 'REIMPORT_BODY', lid: 'n1', body: '外で直した本文' });
    await tick();
    expect(d.getState().error ?? '').toContain('別のタブまたはウィンドウがこのノートを書き換えたため、取り込み直せませんでした');
    expect(d.getState().openBody?.body, '断ったのに画面が新しくなった').not.toBe('外で直した本文');
  });

  it('ノートが disk に無ければ理由を出す / 編集中は声に出して断る', async () => {
    const gone = wired({ body: null });
    gone.d.dispatch({ type: 'REIMPORT_BODY', lid: 'n1', body: 'x' });
    await tick();
    expect(gone.d.getState().error ?? '').not.toBe('');
    const busy = wired({ body: '本文' });
    busy.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    busy.d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文' });
    busy.d.dispatch({ type: 'START_EDIT' });
    busy.d.dispatch({ type: 'REIMPORT_BODY', lid: 'n1', body: '外' });
    await tick();
    expect(busy.written).toEqual([]);
    expect(busy.d.getState().error ?? '', '編集中に黙って断った').toContain('取り込み直してください');
  });

  /**
   * 🔴 **知らせの `{title}` は題名に置き換わり、`{` が残らない。題名の `$` は特殊な記法として読まれない**
   * (差分マージ・テキスト整形のレビュー、テストの穴 B)。
   * ⚠ 文字列の置換は、置換文の `$&` `$'` `` $` `` を「一致した字」などに読み替える ── 関数で置換していないと、
   *   題名に `$&` を含むノートで知らせが壊れる。`{title}` を 2 回書いた知らせも、2 回とも題名になる。
   */
  it.each([
    ['メモ', '「メモ」を、整えた内容で置き換えました。もう一度「メモ」を見てください'],
    ['価格 $& と $\' と $`', '「価格 $& と $\' と $`」を、整えた内容で置き換えました。もう一度「価格 $& と $\' と $`」を見てください'],
    ['{title}', '「{title}」を、整えた内容で置き換えました。もう一度「{title}」を見てください'],
  ])('🔴 題名「%s」が知らせに入り、置換の特殊記法として読まれない', async (title, expected) => {
    const disk = { body: '元の本文' };
    const { d } = wired(disk);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n9', title)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n9' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n9', body: '元の本文' });
    d.dispatch({
      type: 'REIMPORT_BODY',
      lid: 'n9',
      body: '直した本文',
      notice: '「{title}」を、整えた内容で置き換えました。もう一度「{title}」を見てください',
    });
    await tick();
    const notice = d.getState().notice ?? '';
    expect(notice).toBe(expected);
    // 題名そのものに `{` を含む回を除き、未置換の `{title}` が残らない
    if (title !== '{title}') expect(notice, '{title} が置き換わらずに残っている').not.toContain('{');
  });
});
