/** @vitest-environment happy-dom */
/**
 * #1231 段①: 履歴の面で**くらべる相手を選べる**(いまの本文 / 履歴の別の版 / PC のファイル)+
 * **左右に並べる**+ **変わった字だけ濃くする**。🟣 Gemini 裁定 2026-10-02(Q1 = 見るだけ / Q2 = 版 + PC のファイル)。
 *
 * 観測点は **画面に出た物**(state に載っただけ、を合格にしない)。本物の reducer + `DetailRenderer` +
 * `bindActions` を通す(`revision-preview.test.ts` と同じ作法)。
 *
 * ⚠ 向き: 左 = 相手 / 右 = この版。`−` = 相手にだけ在る行(左)、`+` = この版にだけ在る行(右)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';

const NOW = 'いまの本文\n2 行目\n3 行目\n';
const R7 = 'むかしの本文\n2 行目\n3 行目\n';
const R6 = 'ろくの本文\n2 行目\n3 行目\n';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: '会議メモ',
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.textContent = '';
});

interface Deferred {
  promise: Promise<string | null>;
  resolve(v: string | null): void;
}
function deferred(): Deferred {
  let resolve!: (v: string | null) => void;
  const promise = new Promise<string | null>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Opts {
  /** 版の本文を返すのを、この promise が解けるまで待つ(「読んでいます…」を観測する)。 */
  hold?: Record<string, Deferred>;
  /** PC のファイルの読み(省略 = 読む口が無い環境)。 */
  readLinkedFile?: (lid: string) => Promise<string | { tooLarge: true } | null>;
  bodies?: Record<string, string | null>;
}

function setup(opts: Opts = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const detail = new DetailRenderer(buildShell(root).detail);
  d.onState((s) => detail.render(s));
  const reads: string[] = [];
  const fileReads: string[] = [];
  bindActions(
    root,
    d,
    opts.readLinkedFile === undefined
      ? {}
      : {
          readLinkedFile: (lid) => {
            fileReads.push(lid);
            return opts.readLinkedFile!(lid);
          },
        },
  );
  /** ⚠ **書く口の呼ばれた回数**(読むだけであることを test 側から見る)。 */
  const writes: string[] = [];
  const w = (name: string) => async () => {
    writes.push(name);
    return stubStamps();
  };
  const bodies: Record<string, string | null> = { r7: R7, r6: R6, r5: 'ごの本文\n', ...opts.bodies };
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => NOW,
    deleteEntry: async () => {
      writes.push('deleteEntry');
    },
    setEntryParent: async () => {
      writes.push('setEntryParent');
    },
    renameEntry: w('renameEntry'),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: w('reorderEntry'),
    persistEntry: w('persistEntry'),
    listRevisionMetas: async () => [
      { id: 'r7', rev_order: 7, created_at: '2026-08-22 10:31:05', title: '会議メモ', archetype: 'text' },
      { id: 'r6', rev_order: 6, created_at: '2026-08-22T09:02:00Z', title: '会議メモ', archetype: 'text' },
      { id: 'r5', rev_order: 5, created_at: null, title: '会議メモ', archetype: 'text' },
    ],
    revisionDiffStats: async () => [],
    getRevision: async (revId) => {
      reads.push(revId);
      const held = opts.hold?.[revId];
      if (held !== undefined) {
        const body = await held.promise;
        return body === null ? null : { body, title: '会議メモ', archetype: 'text' };
      }
      const body = bodies[revId];
      return body === undefined || body === null ? null : { body, title: '会議メモ', archetype: 'text' };
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  const q = <T extends HTMLElement>(s: string): T | null => root.querySelector<T>(s);
  const qa = (s: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(s)];
  return { root, d, q, qa, reads, writes, fileReads };
}
type S = ReturnType<typeof setup>;

async function openPreview(s: S, revId = 'r7'): Promise<void> {
  s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  await tick();
  s.d.dispatch({ type: 'SHOW_HISTORY', lid: 'n1' });
  await tick();
  s.root
    .querySelector<HTMLElement>(`[data-pkc-action="preview-revision"][data-pkc-rev-id="${revId}"]`)!
    .click();
  await tick();
}

const select = (s: S): HTMLSelectElement => s.q<HTMLSelectElement>('[data-pkc-field="revision-compare"]')!;
const summary = (s: S): string => s.q('[data-pkc-field="revision-diff-summary"]')!.textContent ?? '';
async function choose(s: S, value: string): Promise<void> {
  const sel = select(s);
  sel.value = value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await tick();
}
const cells = (s: S, side: 'left' | 'right'): HTMLElement[] =>
  s.qa(`[data-pkc-field="revision-diff"] ul > li[data-pkc-diff-side="${side}"]`);
const texts = (els: HTMLElement[]): string[] => els.map((e) => e.textContent ?? '');

describe('#1231 段① くらべる相手', () => {
  it('🔴 ① 既定は「いまの本文」で、今までの字(見出しの形)のまま', async () => {
    const s = setup();
    await openPreview(s);
    expect(select(s).value).toBe('current');
    // 左 = いまの本文 / 右 = この版: 相手にだけ在る行が `−`、この版にだけ在る行が `+`
    expect(summary(s)).toBe('いまの本文とのちがい: +1 −1');
    expect(s.d.getState().revisionPreview?.compare).toEqual({ kind: 'current' });
  });

  it('🔴 選択肢: いまの本文 + 履歴の他の版(見ている版そのものは出さない)。PC のファイルは結びついていないので出ない', async () => {
    const s = setup();
    await openPreview(s);
    const opts = [...select(s).options].map((o) => [o.value, o.textContent]);
    expect(opts).toEqual([
      ['current', 'いまの本文'],
      ['rev:r6', '版 6(2026-08-22 09:02)'],
      // ⚠ 日時の無い版は番号だけ(空の括弧を出さない)
      ['rev:r5', '版 5'],
    ]);
  });

  it('🔴 ② 別の版を選ぶと、読み込みが積まれ(読んでいます…)、届いたら左右に出る', async () => {
    const hold = deferred();
    const s = setup({ hold: { r6: hold } });
    await openPreview(s);
    expect(s.reads, '版を押した 1 回だけ').toEqual(['r7']);
    await choose(s, 'rev:r6');
    expect(s.reads, '相手の版を読んでいない').toEqual(['r7', 'r6']);
    // 読み込み中: 字を出し、差分はまだ描かない(「同じです」と言わない)
    expect(summary(s)).toBe('読んでいます…');
    expect(s.qa('[data-pkc-field="revision-diff"] ul')).toHaveLength(0);
    expect(select(s).value, '選んだ相手が選択肢に反映されていない').toBe('rev:r6');
    hold.resolve(R6);
    await tick();
    expect(summary(s)).toBe('版 6(2026-08-22 09:02)とのちがい: +1 −1');
    // 左 = 相手(版 6)/ 右 = この版(版 7)
    expect(texts(cells(s, 'left'))).toContain('− ろくの本文');
    expect(texts(cells(s, 'right'))).toContain('+ むかしの本文');
    expect(s.writes, '1 バイトも書かない').toEqual([]);
  });

  it('🔴 非対称: 見出しの `+` = この版にだけある行(2)/ `−` = 相手にだけある行(3)(対称の +1 −1 では向きの裏返しが見えない)', async () => {
    // この版 r7 = むかしの本文 / 2 行目 / 3 行目。相手 r6 = ろく1〜3 / 2 行目 ── この版にだけ 2 行・相手にだけ 3 行
    const s = setup({ bodies: { r6: 'ろく1\nろく2\nろく3\n2 行目\n' } });
    await openPreview(s);
    await choose(s, 'rev:r6');
    expect(summary(s)).toBe('版 6(2026-08-22 09:02)とのちがい: +2 −3');
    expect(texts(cells(s, 'right')).filter((t) => t.startsWith('+ '))).toHaveLength(2);
    expect(texts(cells(s, 'left')).filter((t) => t.startsWith('− '))).toHaveLength(3);
  });

  it('🔴 見出しの字: 同じなら「その版と同じです」/ 相手の版が履歴から消えていたら理由を言う', async () => {
    const same = setup({ bodies: { r6: R7 } });
    await openPreview(same);
    await choose(same, 'rev:r6');
    expect(summary(same)).toBe('その版と同じです');

    const gone = setup({ bodies: { r6: null } });
    await openPreview(gone);
    await choose(gone, 'rev:r6');
    expect(summary(gone)).toContain('その版の本文を読めませんでした');
    expect(gone.qa('[data-pkc-field="revision-diff"] ul'), '読めなかったのに差分を出している').toHaveLength(0);
    // 「同じ」と言っていない
    expect(summary(gone)).not.toContain('同じ');
  });

  it('🔴 ③ PC のファイルと結びついていなければ、選択肢に出ない(値を直に送っても選べない)', async () => {
    const s = setup({ readLinkedFile: async () => 'x' });
    await openPreview(s);
    expect([...select(s).options].map((o) => o.value)).not.toContain('file');
    s.d.dispatch({ type: 'SET_REVISION_COMPARE', value: 'file' });
    await tick();
    expect(s.d.getState().revisionPreview?.compare, '結びついていないのに file を相手にした').toEqual({ kind: 'current' });
    expect(s.fileReads).toEqual([]);
  });

  it('🔴 ④ 結びついていれば出て、選ぶと readCurrent 相当が 1 回呼ばれ、左右に出る', async () => {
    const s = setup({ readLinkedFile: async () => 'ファイルの本文\n2 行目\n3 行目\n' });
    await openPreview(s);
    s.d.dispatch({ type: 'FILE_LINKED', lid: 'n1', name: 'memo.md' });
    await tick();
    expect([...select(s).options].map((o) => [o.value, o.textContent])).toContainEqual(['file', 'PC のファイル']);
    expect(s.fileReads, '選ぶ前に読んでいる(一覧で読まない = #1271)').toEqual([]);
    await choose(s, 'file');
    expect(s.fileReads).toEqual(['n1']);
    expect(summary(s)).toBe('PC のファイルとのちがい: +1 −1');
    expect(texts(cells(s, 'left'))).toContain('− ファイルの本文');
    expect(texts(cells(s, 'right'))).toContain('+ むかしの本文');
    expect(s.writes, '1 バイトも書かない').toEqual([]);
  });

  it('🔴 ④ ファイルが同じ中身なら「PC のファイルと同じです」', async () => {
    const s = setup({ readLinkedFile: async () => R7 });
    await openPreview(s);
    s.d.dispatch({ type: 'FILE_LINKED', lid: 'n1', name: 'memo.md' });
    await tick();
    await choose(s, 'file');
    expect(summary(s)).toBe('PC のファイルと同じです');
  });

  it('🔴 ④ 読めなければ「ファイルを読めませんでした」── 「同じ」とも「違いはありません」とも言わない(null も reject も)', async () => {
    for (const read of [async () => null, () => Promise.reject(new Error('許可が無い'))]) {
      const s = setup({ readLinkedFile: read });
      await openPreview(s);
      s.d.dispatch({ type: 'FILE_LINKED', lid: 'n1', name: 'memo.md' });
      await tick();
      await choose(s, 'file');
      expect(summary(s)).toBe('ファイルを読めませんでした');
      expect(s.qa('[data-pkc-field="revision-diff"] ul'), '読めなかったのに差分を出している').toHaveLength(0);
    }
  });

  it('🔴 ④ 大きすぎて読まなかったなら、「読めませんでした」ではなく大きいからと言う(「同じ」とも言わない)', async () => {
    const s = setup({ readLinkedFile: async () => ({ tooLarge: true }) });
    await openPreview(s);
    s.d.dispatch({ type: 'FILE_LINKED', lid: 'n1', name: 'memo.md' });
    await tick();
    await choose(s, 'file');
    expect(summary(s)).toBe('ファイルが大きいため、ちがいは出せません');
    expect(summary(s)).not.toContain('読めませんでした');
    expect(s.qa('[data-pkc-field="revision-diff"] ul'), '読まなかったのに差分を出している').toHaveLength(0);
  });

  it('⚠ 読む口が配線されていない環境でも「読んでいます…」のまま止まらない', async () => {
    const s = setup();
    await openPreview(s);
    s.d.dispatch({ type: 'FILE_LINKED', lid: 'n1', name: 'memo.md' });
    await tick();
    await choose(s, 'file');
    expect(summary(s)).toBe('ファイルを読めませんでした');
  });

  it('🔴 ⑤ 閉じると相手が戻る(閉じる / 履歴を閉じる / 別の版を開く / 別のノートを選ぶ)', async () => {
    const s = setup({ readLinkedFile: async () => 'x\n' });
    await openPreview(s);
    s.d.dispatch({ type: 'FILE_LINKED', lid: 'n1', name: 'memo.md' });
    await tick();
    const backToCurrent = (): void => {
      expect(select(s).value, '開き直しても前の相手を持ち越している').toBe('current');
      expect(s.d.getState().revisionPreview?.compare).toEqual({ kind: 'current' });
    };
    // 「この版を閉じる」→ 開き直す
    await choose(s, 'rev:r6');
    s.q('[data-pkc-action="hide-revision-preview"]')!.click();
    await tick();
    expect(s.q('[data-pkc-field="revision-diff"]')).toBeNull();
    s.q<HTMLElement>('[data-pkc-action="preview-revision"][data-pkc-rev-id="r7"]')!.click();
    await tick();
    backToCurrent();
    // 別の版を開く
    await choose(s, 'file');
    s.q<HTMLElement>('[data-pkc-action="preview-revision"][data-pkc-rev-id="r6"]')!.click();
    await tick();
    expect(s.d.getState().revisionPreview?.revId).toBe('r6');
    backToCurrent();
    // 履歴を閉じる → 開き直す
    await choose(s, 'rev:r5');
    s.q('[data-pkc-action="hide-history"]')!.click();
    await tick();
    s.d.dispatch({ type: 'SHOW_HISTORY', lid: 'n1' });
    await tick();
    s.q<HTMLElement>('[data-pkc-action="preview-revision"][data-pkc-rev-id="r7"]')!.click();
    await tick();
    backToCurrent();
  });

  it('🔴 相手を変えても、相手が「いまの本文」へ戻せる(片道にしない)', async () => {
    const s = setup();
    await openPreview(s);
    await choose(s, 'rev:r6');
    expect(summary(s)).toContain('版 6');
    await choose(s, 'current');
    expect(summary(s)).toBe('いまの本文とのちがい: +1 −1');
  });

  it('🔴 遅れて着いた版の本文は、選び直した後の画面を上書きしない', async () => {
    // 読みは書込と同じ 1 本の chain に載る(`enqueue`)ので、r5 は r6 の後ろで待つ ──
    // r6 が先に届いた時点では、画面の相手はもう r5(読み込み中)。r6 の分は捨てられる
    const h6 = deferred();
    const h5 = deferred();
    const s = setup({ hold: { r6: h6, r5: h5 } });
    await openPreview(s);
    await choose(s, 'rev:r6');
    await choose(s, 'rev:r5');
    h6.resolve(R6);
    await tick();
    expect(
      s.d.getState().revisionPreview?.compare,
      '遅れて着いた版 6 が、選び直した後(版 5 を待っている画面)を上書きした',
    ).toEqual({ kind: 'rev', revId: 'r5', load: { state: 'loading' } });
    expect(summary(s)).toBe('読んでいます…');
    h5.resolve('ごの本文\n');
    await tick();
    expect(summary(s)).toContain('版 5');
    // 「いまの本文」へ戻した後に届いても同じ
    const h = deferred();
    const t = setup({ hold: { r6: h } });
    await openPreview(t);
    await choose(t, 'rev:r6');
    await choose(t, 'current');
    h.resolve(R6);
    await tick();
    expect(t.d.getState().revisionPreview?.compare).toEqual({ kind: 'current' });
    expect(summary(t)).toBe('いまの本文とのちがい: +1 −1');
  });

  it('🔴 版を開き直した後に、前の版の相手が届いても捨てる(別の版の画面に混ざらない)', async () => {
    const h = deferred();
    const s = setup({ hold: { r6: h } });
    await openPreview(s, 'r7');
    await choose(s, 'rev:r6'); // r7 を見ながら r6 を待つ
    // r5 を見る(版 5 の読みは r6 の後ろで待つ)
    s.q<HTMLElement>('[data-pkc-action="preview-revision"][data-pkc-rev-id="r5"]')!.click();
    await tick();
    h.resolve(R6);
    await tick(30);
    const pv = s.d.getState().revisionPreview;
    expect(pv?.revId).toBe('r5');
    expect(pv?.compare, '前の版の相手が持ち越された').toEqual({ kind: 'current' });
  });
});

describe('#1231 段① reducer の門(画面からは撃てない値を、直に送る)', () => {
  it('🔴 相手に選べない値は受けない(見ている版そのもの / 履歴に無い版 / 知らない値)── 読みも積まない', async () => {
    const s = setup();
    await openPreview(s, 'r7');
    for (const value of ['rev:r7', 'rev:zzz', 'rev:', 'bogus', '']) {
      s.d.dispatch({ type: 'SET_REVISION_COMPARE', value });
      await tick();
      expect(s.d.getState().revisionPreview?.compare, `「${value}」を相手にした`).toEqual({ kind: 'current' });
    }
    expect(s.reads, '選べない値で版を読んでいる').toEqual(['r7']);
  });

  it('🔴 見ている版が無いとき・別のノートのものは受けない(読みも積まない)', async () => {
    const s = setup();
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await tick();
    s.d.dispatch({ type: 'SET_REVISION_COMPARE', value: 'current' });
    expect(s.d.getState().revisionPreview).toBeNull();
  });

  it('🔴 届いた中身の照合: lid / 見ている版 / 相手 のどれかが違えば捨てる(読み込み中のまま)', async () => {
    const h = deferred(); // r6 は届かないまま ── 状態は「読んでいます…」で止まる
    const s = setup({ hold: { r6: h } });
    await openPreview(s, 'r7');
    await choose(s, 'rev:r6');
    const loading = { kind: 'rev', revId: 'r6', load: { state: 'loading' } };
    expect(s.d.getState().revisionPreview?.compare).toEqual(loading);
    const send = (over: Partial<{ lid: string; previewRevId: string; against: string; text: string | null }>): void =>
      s.d.dispatch({
        type: 'REVISION_COMPARE_LOADED',
        lid: 'n1',
        previewRevId: 'r7',
        against: 'rev:r6',
        text: 'x',
        ...over,
      });
    send({ lid: 'n2' });
    send({ previewRevId: 'r5' });
    send({ against: 'rev:r5' });
    send({ against: 'file' });
    expect(s.d.getState().revisionPreview?.compare, '食い違う届きを受けた').toEqual(loading);
    // 対照: 合っていれば受ける
    send({});
    expect(s.d.getState().revisionPreview?.compare).toEqual({ kind: 'rev', revId: 'r6', load: { state: 'loaded', text: 'x' } });
    // 読み終えた後に重ねて届いても上書きしない
    send({ text: 'y' });
    expect(s.d.getState().revisionPreview?.compare).toEqual({ kind: 'rev', revId: 'r6', load: { state: 'loaded', text: 'x' } });
    // 相手が「いまの本文」のときは何が届いても受けない
    await choose(s, 'current');
    send({});
    expect(s.d.getState().revisionPreview?.compare).toEqual({ kind: 'current' });
  });
});

describe('#1231 段① 左右表示 / 字単位の強調', () => {
  it('🔴 ⑥ 入れ替わった行で、変わった字だけが mark(同じ字は mark の外)', async () => {
    const s = setup();
    await openPreview(s);
    const left = cells(s, 'left').find((e) => e.getAttribute('data-pkc-diff') === 'del')!;
    const right = cells(s, 'right').find((e) => e.getAttribute('data-pkc-diff') === 'add')!;
    // 左 = いまの本文(相手)/ 右 = むかしの本文(この版)。共通の「の本文」は mark の外
    expect(left.textContent).toBe('− いまの本文');
    expect([...left.querySelectorAll('mark[data-pkc-diff-char]')].map((m) => [m.getAttribute('data-pkc-diff-char'), m.textContent])).toEqual([['del', 'いま']]);
    expect(right.textContent).toBe('+ むかしの本文');
    expect([...right.querySelectorAll('mark[data-pkc-diff-char]')].map((m) => [m.getAttribute('data-pkc-diff-char'), m.textContent])).toEqual([['add', 'むかし']]);
    // 同じ行(2 行目)には mark が 1 つも無い
    const same = cells(s, 'left').find((e) => e.textContent === '  2 行目')!;
    expect(same.querySelector('mark')).toBeNull();
  });

  it('🔴 左右に並ぶ: 升は左・右が交互で、消えた行だけ / 足した行だけは反対が空の升', async () => {
    const s = setup({ bodies: { r6: 'A\nB\n' } });
    await openPreview(s, 'r7');
    await choose(s, 'rev:r6');
    const li = s.qa('[data-pkc-field="revision-diff"] ul > li');
    expect(li.length % 2, '升が左右の対になっていない').toBe(0);
    const sides = li.map((e) => e.getAttribute('data-pkc-diff-side'));
    expect(sides.filter((x) => x === 'left').length).toBe(sides.filter((x) => x === 'right').length);
    // 相手(A / B の 2 行)× この版(3 行)= 2 行は入れ替わり、1 行は足した行だけ
    const empties = li.filter((e) => e.getAttribute('data-pkc-diff') === 'empty');
    expect(empties.length).toBeGreaterThan(0);
    for (const e of empties) expect(e.textContent, '空の升に字が入っている').toBe('');
  });

  it('🔴 畳み(gap)は 1 つの升(両列にまたがる)で、左右の対に混ざらない', async () => {
    const same = Array.from({ length: 12 }, (_, i) => `共通 ${i}`).join('\n');
    const mine = `先頭ちがい\n${same}\n末尾ちがい\n`;
    // 相手 = いまの本文(NOW)ではなく共通の長い本文にしたいので、版 6 を相手にする
    const longOther = `別の先頭\n${same}\n別の末尾\n`;
    const t = setup({ bodies: { r7: mine, r6: longOther } });
    await openPreview(t, 'r7');
    await choose(t, 'rev:r6');
    const gaps = t.qa('[data-pkc-field="revision-diff"] ul > li[data-pkc-diff="gap"]');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.getAttribute('data-pkc-diff-side'), '畳みが片側の升になっている').toBeNull();
    expect(gaps[0]!.textContent).toContain('変わっていない 8 行');
  });

  it('⚠ 列の頭: 左は相手の名前、右は「この版」', async () => {
    const s = setup();
    await openPreview(s);
    const cols = [...s.q('[data-pkc-field="revision-diff-cols"]')!.children].map((e) => e.textContent);
    expect(cols).toEqual(['いまの本文', 'この版']);
    await choose(s, 'rev:r6');
    const cols2 = [...s.q('[data-pkc-field="revision-diff-cols"]')!.children].map((e) => e.textContent);
    expect(cols2).toEqual(['版 6(2026-08-22 09:02)', 'この版']);
  });

  it('⚠ 相手を選んだ後も、選んだ <select> に焦点が残る(キーボードで続けて選べる)', async () => {
    const s = setup();
    await openPreview(s);
    select(s).focus();
    await choose(s, 'rev:r6');
    expect(document.activeElement, '選んだ後に焦点が落ちた').toBe(select(s));
  });
});

describe('#1231 段① 見るだけ', () => {
  it('🔴 ⑦ 相手をどれに変えても 1 バイトも書かない(書く口の呼び出しが 0 回)', async () => {
    const s = setup({ readLinkedFile: async () => 'ファイル\n' });
    await openPreview(s);
    s.d.dispatch({ type: 'FILE_LINKED', lid: 'n1', name: 'memo.md' });
    await tick();
    await choose(s, 'rev:r6');
    await choose(s, 'file');
    await choose(s, 'current');
    expect(s.writes).toEqual([]);
    // 差分の器に、押せる物は「閉じる」と「くらべる相手」だけ(行ごとの取り込みの口を作らない)
    const actions = s
      .qa('[data-pkc-field="revision-diff"] [data-pkc-action]')
      .map((e) => e.getAttribute('data-pkc-action'))
      .sort();
    expect(actions).toEqual(['hide-revision-preview', 'set-revision-compare']);
    // 差分の升の中に button / input / a が無い
    expect(s.qa('[data-pkc-field="revision-diff"] ul button, [data-pkc-field="revision-diff"] ul input, [data-pkc-field="revision-diff"] ul a')).toHaveLength(0);
  });
});
