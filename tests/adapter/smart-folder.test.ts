/** @vitest-environment happy-dom */
/**
 * 🔴 **スマートフォルダ**(#421 段①。user 要望 2026-08-26)。
 *
 * 守る主張:
 * 1. **開いたら集めに行く**(そして開き直すたびに集め直す ── 鮮度は「開いた時点」)
 * 2. **中身は条件で当たったもの**(手で入れた子は見ない)
 * 3. **「0 件」と「まだ」と「集められない」を区別する**
 * 4. 🔴 **双方向** ── 落とすと条件のタグが付く / 「ここから外す」で消える
 * 5. **配線** ── 面と binder と effect が本当に繋がっている(どの unit も見ない所)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { FilerRenderer } from '../../src/adapter/ui/render/filer';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';
import {
  MAX_SMART_TAGS,
  readSmartSpec,
  SMART_TAGS_KEY,
} from '../../src/features/smart/smart-spec';
import { readTags } from '../../src/features/flavor/tags';

function meta(lid: string, order: number, title: string, archetype = 'text'): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: 10,
  };
}
const rel = (id: string, fromLid: string, toLid: string): Relation => ({
  id,
  fromLid,
  toLid,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});

/** ルート: スマート(s1)/ はこ(f1)/ 請求のノート(a)。f1 の中に b(請求つき)。 */
const METAS = [
  meta('s1', 1, '請求ぜんぶ', 'smart'),
  meta('f1', 2, 'はこ', 'folder'),
  meta('a', 3, 'あ'),
  meta('b', 4, 'い'),
  // ⚠ 2 つ目の入れ物 ── 「絞った入れ物」と「広い入れ物」に**同時に**出る話に要る
  meta('s2', 5, '2026年ぜんぶ', 'smart'),
];
const RELS = [rel('r1', 'f1', 'b')];

const booted = (): AppState =>
  reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS }).state;

describe('開いたら集めに行く(#421 段①)', () => {
  it('🔴 スマートフォルダへ入ると、集め直しを頼む', () => {
    const out = reduce(booted(), { type: 'SET_SCOPE', lid: 's1' });
    expect(out.events, '集めに行っていない').toEqual([{ type: 'REQUEST_SMART_SCAN', lid: 's1' }]);
  });

  it('⚠ ふつうのフォルダでは頼まない(全件走査が毎回走る)', () => {
    const out = reduce(booted(), { type: 'SET_SCOPE', lid: 'f1' });
    expect(out.events).toEqual([]);
  });

  it('🔴 2 ペインで開いても、同じ 1 つの口から頼む', () => {
    const out = reduce(booted(), { type: 'DUAL_SET_SCOPE', side: 'right', lid: 's1' });
    expect(out.events).toEqual([{ type: 'REQUEST_SMART_SCAN', lid: 's1' }]);
  });

  /**
   * 🔴 **当たりは lid で分ける** ── 左と右で別々のスマートフォルダを開けるので、
   * 上書きにすると片方が消える。
   */
  it('🔴 当たりはスマートフォルダごとに持つ', () => {
    let s = booted();
    s = reduce(s, { type: 'SMART_SCANNED', lid: 's1', lids: ['a'], total: 1, tags: ['請求'] }).state;
    s = reduce(s, { type: 'SMART_SCANNED', lid: 'f1', lids: ['b'], total: 1, tags: ['x'] }).state;
    expect(s.smartHits.get('s1')?.lids).toEqual(['a']);
    expect(s.smartHits.get('f1')?.lids, '上書きされた').toEqual(['b']);
  });

  /**
   * 🔴 **「集められない」は「0 件」ではない** ── 旧い worker が残っている端末で
   * 起きる。⚠ 条件は残す(集められなかっただけで、条件は在る)。
   */
  it('🔴 集められなかったときは、その印が残り、条件は消えない', () => {
    let s = reduce(booted(), {
      type: 'SMART_SCANNED',
      lid: 's1',
      lids: ['a'],
      total: 1,
      tags: ['請求'],
    }).state;
    s = reduce(s, { type: 'SMART_SCAN_FAILED', lid: 's1' }).state;
    expect(s.smartHits.get('s1')?.failed).toBe(true);
    expect(s.smartHits.get('s1')?.tags, '条件まで消えた').toEqual(['請求']);
  });
});

describe('中身は条件で決まる(#421 段①)', () => {
  let region: HTMLElement;
  /**
   * ⚠ **ファイラの器は `buildShell` が持たない**(左の列は `browse.ts` が組む)──
   *   test は自分で器を作って渡す(`bulk-tag-wiring.test.ts` と同じ作法)。
   */
  const mount = (): FilerRenderer => {
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    region = document.createElement('div');
    root.append(region);
    return new FilerRenderer(region);
  };
  const rows = (): string[] =>
    [...region.querySelectorAll('[data-pkc-region="filer-table"] [data-pkc-entry]')].map(
      (el) => el.getAttribute('data-pkc-entry') ?? '',
    );
  const why = (): string =>
    region.querySelector('[data-pkc-field="smart-why"]')?.textContent ?? '';

  beforeEach(() => {
    document.body.textContent = '';
  });

  it('🔴 集めるまでは「集めています…」と出す(0 件と言わない)', () => {
    const r = mount();
    r.render(reduce(booted(), { type: 'SET_SCOPE', lid: 's1' }).state);
    expect(why(), 'まだ集めていないのに件数を言っている').toContain('集めています');
    expect(rows()).toEqual([]);
  });

  it('🔴 当たりが届いたら、その行が並ぶ', () => {
    const r = mount();
    let s = reduce(booted(), { type: 'SET_SCOPE', lid: 's1' }).state;
    r.render(s);
    s = reduce(s, { type: 'SMART_SCANNED', lid: 's1', lids: ['a', 'b'], total: 2, tags: ['請求'] })
      .state;
    r.render(s);
    // 🔑 **b は「はこ」の中に在る**が、条件で当たったので出る(場所を動かさない)
    expect(rows(), '当たりが出ていない').toEqual(['a', 'b']);
    expect(why()).toContain('2 件');
  });

  it('🔴 条件が空なら「条件を選んでください」と出す(全部は集めない)', () => {
    const r = mount();
    let s = reduce(booted(), { type: 'SET_SCOPE', lid: 's1' }).state;
    s = reduce(s, { type: 'SMART_SCANNED', lid: 's1', lids: [], total: 0, tags: [] }).state;
    r.render(s);
    expect(why()).toContain('条件を選んでください');
    expect(rows(), '条件が無いのに集めている').toEqual([]);
  });

  it('⚠ 上限で切ったことを画面に出す(「これで全部」と嘘をつかない)', () => {
    const r = mount();
    let s = reduce(booted(), { type: 'SET_SCOPE', lid: 's1' }).state;
    s = reduce(s, { type: 'SMART_SCANNED', lid: 's1', lids: ['a'], total: 9, tags: ['請求'] }).state;
    r.render(s);
    expect(why(), '切ったことが読めない').toContain('9 件中 1 件');
  });

  it('🔴 条件が札で出て、1 つずつ外せる', () => {
    const r = mount();
    let s = reduce(booted(), { type: 'SET_SCOPE', lid: 's1' }).state;
    s = reduce(s, { type: 'SMART_SCANNED', lid: 's1', lids: [], total: 0, tags: ['請求'] }).state;
    r.render(s);
    const off = region.querySelector<HTMLElement>(
      '[data-pkc-action="smart-cond-remove"][data-pkc-tag="請求"]',
    );
    expect(off, '外す口が無い(置けるのに外せない)').not.toBeNull();
  });

  it('⚠ ふつうのフォルダでは条件の帯を出さない', () => {
    const r = mount();
    r.render(reduce(booted(), { type: 'SET_SCOPE', lid: 'f1' }).state);
    expect(region.querySelector('[data-pkc-field="smart-bar"]')).toBeNull();
  });
});

describe('双方向 ── 落とすと付く / 外すと消える(#421 段①)', () => {
  it('🔴 「ここから外す」は、選んでいるものについて撃つ', () => {
    let s = reduce(booted(), { type: 'SET_SCOPE', lid: 's1' }).state;
    s = reduce(s, { type: 'SMART_SCANNED', lid: 's1', lids: ['a'], total: 1, tags: ['請求'] }).state;
    const out = reduce(s, { type: 'SMART_TAGS', smartLid: 's1', lids: ['a'], mode: 'remove' });
    expect(out.events).toEqual([
      { type: 'REQUEST_SMART_TAGS', smartLid: 's1', lids: ['a'], mode: 'remove' },
    ]);
  });

  it('⚠ 実在しないものは相手にしない', () => {
    const s = booted();
    expect(reduce(s, { type: 'SMART_TAGS', smartLid: 's1', lids: ['zzz'], mode: 'add' }).events)
      .toEqual([]);
  });

  it('🔴 条件を足すと、その入れ物の本文を書く要求が出る', () => {
    const out = reduce(booted(), { type: 'SMART_COND', lid: 's1', tag: '請求', mode: 'add' });
    expect(out.events).toEqual([
      {
        type: 'REQUEST_SMART_COND',
        target: { lid: 's1', title: '請求ぜんぶ', archetype: 'smart', entryOrder: 1 },
        tag: '請求',
        mode: 'add',
      },
    ]);
  });

  it('⚠ スマートフォルダでないものには条件を書かない', () => {
    expect(reduce(booted(), { type: 'SMART_COND', lid: 'f1', tag: '請求', mode: 'add' }).events)
      .toEqual([]);
  });
});

/**
 * 🔴 **文書側でタグを付けたら、開いている入れ物にその場で落ちる**
 * (user 要望 2026-08-26)。
 *
 * > 文書側でタグつけしたら勝手にフォルダに落ちるもやってください
 * > 複数のタグつけにも対応してください
 * > つまり2026年と8月と26日という別々のタグをつけると複数タグ指定で
 * > 2026年8月26日の文書を見るフォルダと2026年のタグで見るフォルダでも見れるみたいな
 */
describe('タグを付けたら勝手に落ちる(user 要望 2026-08-26)', () => {
  /** 当たりを手で置く(worker が返した直後の姿)。 */
  const withHit = (
    state: AppState,
    smartLid: string,
    tags: string[],
    lids: string[],
  ): AppState =>
    reduce(state, { type: 'SMART_SCANNED', lid: smartLid, lids, total: lids.length, tags })
      .state;

  const rewritten = (state: AppState, lid: string, body: string): AppState =>
    reduce(state, {
      type: 'BODY_REWRITTEN',
      lid,
      body,
      rewrite: { kind: 'tag', tag: '請求', mode: 'add' },
      status: null,
      date: null,
      archived: false,
    }).state;

  it('🔴 タグを付けた瞬間に並ぶ(worker に頼み直さない)', () => {
    const s0 = withHit(booted(), 's1', ['請求'], []);
    const s1 = rewritten(s0, 'a', '---\ntags: [請求]\n---\nあ\n');
    expect(s1.smartHits.get('s1')?.lids, '付けたのに出てこない').toEqual(['a']);
    expect(s1.smartHits.get('s1')?.total).toBe(1);
  });

  it('🔴 タグを外した瞬間に消える(片道にしない)', () => {
    const s0 = withHit(booted(), 's1', ['請求'], ['a']);
    const s1 = rewritten(s0, 'a', 'あ の本文だけ\n');
    expect(s1.smartHits.get('s1')?.lids, '外したのに残っている').toEqual([]);
    expect(s1.smartHits.get('s1')?.total).toBe(0);
  });

  /**
   * 🔴 **user の物語そのもの** ── 別々のタグを 3 つ付けると、
   * 「2026年 8月 26日」の入れ物にも「2026年」の入れ物にも**同時に**出る。
   */
  it('🔴 タグを 3 つ付けると、絞った入れ物にも広い入れ物にも同時に出る', () => {
    let st = booted();
    st = withHit(st, 's1', ['2026年', '8月', '26日'], []);
    st = withHit(st, 's2', ['2026年'], []);
    st = rewritten(st, 'a', '---\ntags: [2026年, 8月, 26日]\n---\nあ\n');
    expect(st.smartHits.get('s1')?.lids, '全部付いているのに出ない').toEqual(['a']);
    expect(st.smartHits.get('s2')?.lids, '広いほうに出ない').toEqual(['a']);
  });

  it('⚠ 条件を 1 つでも欠くと、絞ったほうには出ない(広いほうには出る)', () => {
    let st = booted();
    st = withHit(st, 's1', ['2026年', '8月', '26日'], []);
    st = withHit(st, 's2', ['2026年'], []);
    st = rewritten(st, 'a', '---\ntags: [2026年, 8月]\n---\nあ\n');
    expect(st.smartHits.get('s1')?.lids, '欠けているのに出た').toEqual([]);
    expect(st.smartHits.get('s2')?.lids, '広いほうに出ない').toEqual(['a']);
  });

  /** 🔑 並ぶ順は worker と同じ(`entry_order`)── 付けた瞬間だけ末尾に出ない。 */
  it('🔴 割り込む位置が worker と同じ(付けた瞬間だけ末尾に出ない)', () => {
    const s0 = withHit(booted(), 's1', ['請求'], ['b']); // b は entryOrder 4
    const s1 = rewritten(s0, 'a', '---\ntags: [請求]\n---\nあ\n'); // a は 3
    expect(s1.smartHits.get('s1')?.lids, '順が worker と違う').toEqual(['a', 'b']);
  });

  it('⚠ その入れ物自身の本文が変わっても、自分は集めない', () => {
    const s0 = withHit(booted(), 's1', ['請求'], []);
    const s1 = rewritten(s0, 's1', '---\ntags: [請求]\nsmart-tags: [請求]\n---\n説明\n');
    expect(s1.smartHits.get('s1')?.lids, '自分自身が中に並んだ').toEqual([]);
  });

  /**
   * ⚠ **切れている一覧は手で継ぎ足さない** ── 1 件外しても「次の 1 件」が
   * 分からないので、数と中身が食い違う(次に開くまで待つ)。
   */
  it('⚠ 上限で切れている一覧は触らない(数と中身を食い違わせない)', () => {
    let st = booted();
    st = reduce(st, {
      type: 'SMART_SCANNED',
      lid: 's1',
      lids: ['a'],
      total: 9, // 上限で切れている
      tags: ['請求'],
    }).state;
    st = rewritten(st, 'b', '---\ntags: [請求]\n---\nい\n');
    expect(st.smartHits.get('s1')?.lids, '切れている一覧に継ぎ足した').toEqual(['a']);
    expect(st.smartHits.get('s1')?.total).toBe(9);
  });

  /**
   * ⚠ **集められない版では触らない**(集まったふりをしない)。
   *
   * 🔴 **条件を先に立ててから失敗させる**(変異試験 T4 が SURVIVED で教えた)。
   *   `SMART_SCAN_FAILED` は**条件をそのまま残す**ので、失敗した入れ物は
   *   「条件は在るのに中身が空」という姿になる ── そこへ手で継ぎ足すと、
   *   帯は「この版では集められません」なのに**行だけ並ぶ**。
   * ⚠ 条件が空のまま失敗させると、`matchesSmart` が常に false を返して
   *   **この門を通らずに済んでしまう**(門を消しても落ちない)。
   */
  it('⚠ 集められない版では触らない(集まったふりをしない)', () => {
    let st = withHit(booted(), 's1', ['請求'], []); // 一度は集められた = 条件が在る
    st = reduce(st, { type: 'SMART_SCAN_FAILED', lid: 's1' }).state;
    expect(st.smartHits.get('s1')?.tags, '前提: 条件は残っている').toEqual(['請求']);
    st = rewritten(st, 'a', '---\ntags: [請求]\n---\nあ\n');
    expect(st.smartHits.get('s1')?.failed).toBe(true);
    expect(st.smartHits.get('s1')?.lids, '集められない版に行が並んだ').toEqual([]);
  });

  /** ⚠ 入れ物を 1 つも開いていなければ、何もしない(実費 0)。 */
  it('⚠ 入れ物を開いていなければ、当たりの表は同じものが返る', () => {
    const s0 = booted();
    const s1 = rewritten(s0, 'a', '---\ntags: [請求]\n---\nあ\n');
    expect(s1.smartHits, '開いていないのに表が組み直された').toBe(s0.smartHits);
  });

  /**
   * 🔴 **本文に `tags:` を直接書いて保存した回も落ちる**(情報ペインだけ直すのは片手落ち)。
   * ⚠ こちらは `COMMIT_EDIT`(`buildPersist` 経由)── 別の口である。
   */
  it('🔴 本文を編集して保存した回も、その場で落ちる', () => {
    let st = withHit(booted(), 's1', ['請求'], []);
    st = reduce(st, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    st = reduce(st, {
      type: 'BODY_LOADED',
      lid: 'a',
      body: 'あ の本文\n',
    }).state;
    st = reduce(st, { type: 'START_EDIT' }).state;
    st = reduce(st, {
      type: 'UPDATE_OPEN_BODY',
      body: '---\ntags: [請求]\n---\nあ の本文\n',
    }).state;
    const out = reduce(st, { type: 'COMMIT_EDIT' });
    expect(out.state.smartHits.get('s1')?.lids, '保存しても落ちてこない').toEqual(['a']);
  });

  /**
   * 🔴 **入れ物自身を保存したら、条件が変わったかもしれないので集め直す**
   * ── `refreshSmartHits` は自分自身を触らないので、ここでしか拾えない。
   */
  it('🔴 入れ物の本文を保存すると、集め直しを頼む', () => {
    let st = withHit(booted(), 's1', ['請求'], []);
    st = reduce(st, { type: 'SELECT_ENTRY', lid: 's1' }).state;
    st = reduce(st, { type: 'BODY_LOADED', lid: 's1', body: '説明\n' }).state;
    st = reduce(st, { type: 'START_EDIT' }).state;
    st = reduce(st, {
      type: 'UPDATE_OPEN_BODY',
      body: `---\n${SMART_TAGS_KEY}: [家事]\n---\n説明\n`,
    }).state;
    const out = reduce(st, { type: 'COMMIT_EDIT' });
    expect(out.events, '条件を変えたのに集め直さない').toContainEqual({
      type: 'REQUEST_SMART_SCAN',
      lid: 's1',
    });
  });

  /** ⚠ **対照群** ── 普通のノートを保存しただけでは走査を頼まない。 */
  it('⚠ 普通のノートの保存では、走査を頼まない', () => {
    let st = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    st = reduce(st, { type: 'BODY_LOADED', lid: 'a', body: 'あ\n' }).state;
    st = reduce(st, { type: 'START_EDIT' }).state;
    st = reduce(st, { type: 'UPDATE_OPEN_BODY', body: 'あ い\n' }).state;
    const out = reduce(st, { type: 'COMMIT_EDIT' });
    expect(
      out.events.filter((e) => e.type === 'REQUEST_SMART_SCAN'),
      '普通の保存で全件走査が走っている',
    ).toEqual([]);
  });
});

/**
 * 🔴 **配線**(#421 段①)── reducer と面の test は、どちらも
 * 「A と B が合意していること」を見られない(CLAUDE.md §7)。実物を繋ぐ。
 */
describe('配線(effect 層まで)', () => {
  const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

  function setup(disk: Record<string, string>) {
    const d = new Dispatcher();
    const scans: { lid: string; tags: readonly string[] }[] = [];
    const errors: string[] = [];
    d.onState((s) => {
      if (s.error !== null && !errors.includes(s.error)) errors.push(s.error);
    });
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async (lid) => disk[lid] ?? null,
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async (e) => {
        disk[e.lid] = e.body;
        return stubStamps();
      },
      smartScan: async (lid, tags) => {
        scans.push({ lid, tags: [...tags] });
        // ⚠ **本物と同じ意味論**(§3)── 条件が空なら 1 件も返さない
        if (tags.length === 0) return { lids: [], total: 0 };
        const lids = Object.entries(disk)
          .filter(([l, body]) => l !== lid && tags.every((t) => readTags(body).includes(t)))
          .map(([l]) => l);
        return { lids, total: lids.length };
      },
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    return { d, scans, errors, disk };
  }

  it('🔴 開くと、本文から条件を読んで集め、条件も一緒に返る', async () => {
    const s = setup({
      s1: `---\n${SMART_TAGS_KEY}: [請求]\n---\n説明\n`,
      a: '---\ntags: [請求]\n---\nあ\n',
      b: '---\ntags: [家事]\n---\nい\n',
    });
    s.d.dispatch({ type: 'SET_SCOPE', lid: 's1' });
    await tick();
    expect(s.scans, '条件を読んで渡していない').toEqual([{ lid: 's1', tags: ['請求'] }]);
    const hit = s.d.getState().smartHits.get('s1');
    expect(hit?.lids).toEqual(['a']);
    // 🔑 効いていた条件も届く(画面が「何で絞っているか」を出すのに要る)
    expect(hit?.tags, '条件が届いていない').toEqual(['請求']);
  });

  /**
   * 🔴 **条件が 0 件なら、走査そのものを頼まない**(変異試験 S5 が教えた)。
   *
   * ⚠ 頼むと worker が **entries を 500 件ずつ全部舐めて 0 件**を返す ──
   *   `matchesSmart` が空を false にするので、当たりようがない走査である。
   * ⚠ そしてこれは**作った直後のスマートフォルダの姿**なので、
   *   「作って開く」たびに全件走査が走ることになる。
   * 🔑 観測点は「**頼まなかったこと**」(`scans` が空)── 返り値だけ見ると
   *   「舐めて 0 件だった」と見分けが付かない。
   */
  it('🔴 条件が 1 つも無いときは、worker に頼まない(画面は「条件を選んでください」のまま)', async () => {
    const s = setup({
      s1: '---\ntitle: 請求ぜんぶ\n---\nまだ条件を選んでいない\n',
      a: '---\ntags: [請求]\n---\nあ\n',
    });
    s.d.dispatch({ type: 'SET_SCOPE', lid: 's1' });
    await tick();
    expect(s.scans, '条件が空なのに全件走査を頼んでいる').toEqual([]);
    // 🔑 **対照群** ── 経路は通っている(通っていなければ当たりが置かれない)
    const hit = s.d.getState().smartHits.get('s1');
    expect(hit, '当たりが置かれていない ── 帯が「集めています…」で止まる').not.toBeUndefined();
    expect(hit?.failed, '集められない扱いにしてはいけない').toBe(false);
    expect(hit?.tags, '条件は空である').toEqual([]);
    expect(hit?.lids).toEqual([]);
  });

  /** ⚠ **対の主張** ── 条件が在るときは、ちゃんと頼んでいる(上の門の空振り防止)。 */
  it('⚠ 条件が 1 つでも在れば頼む', async () => {
    const s = setup({ s1: `---\n${SMART_TAGS_KEY}: [請求]\n---\n説明\n` });
    s.d.dispatch({ type: 'SET_SCOPE', lid: 's1' });
    await tick();
    expect(s.scans).toEqual([{ lid: 's1', tags: ['請求'] }]);
  });

  it('🔴 条件を足すと本文に書かれ、その場で集め直す', async () => {
    const s = setup({
      s1: `---\n${SMART_TAGS_KEY}: \n---\n説明の文\n`,
      a: '---\ntags: [請求]\n---\nあ\n',
    });
    s.d.dispatch({ type: 'SMART_COND', lid: 's1', tag: '請求', mode: 'add' });
    await tick(30);
    expect(readSmartSpec(s.disk.s1!).tags, '条件が本文に書かれていない').toEqual(['請求']);
    expect(s.disk.s1, '説明文が壊れた').toContain('説明の文');
    // 🔑 書いた後に集め直す ── 条件だけ変わって並びが古いままにしない
    expect(s.scans.at(-1), '集め直していない').toEqual({ lid: 's1', tags: ['請求'] });
    expect(s.d.getState().smartHits.get('s1')?.lids).toEqual(['a']);
  });

  /**
   * 🔴 **押しても同じだったときも、集め直す**(変異試験 S14b が教えた)。
   *
   * ⚠ 本文は変わらないが、**当たりのほうは古いかもしれない**(別の窓が
   *   その条件のタグを付けた / 外した)。user は押しているので、いまの姿を出す。
   * 🔑 観測点は「**書いていないのに、集め直しは走った**」の 2 つ ── 片方だけ
   *   見ると「何もしなかった」と区別が付かない。
   */
  it('🔴 同じ条件をもう一度足しても、書かないが集め直す', async () => {
    const s = setup({
      s1: `---\n${SMART_TAGS_KEY}: [請求]\n---\n説明の文\n`,
      a: '---\ntags: [請求]\n---\nあ\n',
    });
    const before = s.disk.s1;
    s.d.dispatch({ type: 'SMART_COND', lid: 's1', tag: '請求', mode: 'add' });
    await tick(30);
    expect(s.disk.s1, '同じ条件で本文を書き換えている').toBe(before);
    expect(s.scans.at(-1), '集め直していない').toEqual({ lid: 's1', tags: ['請求'] });
    expect(s.errors, '黙ってよい場面で赤い帯を出している').toEqual([]);
  });

  /**
   * 🔴 **受けられなかったときは、なぜかを出す**(黙って捨てない)。
   * ⚠ 「押しても同じ」と違い、こちらは user の頼みが**通っていない**。
   */
  it('🔴 条件が上限に達していたら、理由を出して書かない', async () => {
    const full = Array.from({ length: MAX_SMART_TAGS }, (_, i) => `t${String(i)}`).join(', ');
    const s = setup({ s1: `---\n${SMART_TAGS_KEY}: [${full}]\n---\n説明\n` });
    const before = s.disk.s1;
    s.d.dispatch({ type: 'SMART_COND', lid: 's1', tag: '請求', mode: 'add' });
    await tick(30);
    expect(s.disk.s1, '上限を超えて書いている').toBe(before);
    expect(s.errors.join(' / '), '断った理由が出ていない').toContain(String(MAX_SMART_TAGS));
  });

  /**
   * 🔴 **落とすと条件のタグが本文に付く**(user 裁定 2026-08-26)。
   * ⚠ 「入れ物に入れた」のではない ── 本文が条件に合う形へ変わるから当たる。
   */
  it('🔴 落とすと、条件のタグが本文に付いて、集め直される', async () => {
    const s = setup({
      s1: `---\n${SMART_TAGS_KEY}: [請求]\n---\n説明\n`,
      a: 'あ の本文\n',
    });
    s.d.dispatch({ type: 'SMART_TAGS', smartLid: 's1', lids: ['a'], mode: 'add' });
    await tick(40);
    expect(readTags(s.disk.a!), 'タグが付いていない').toEqual(['請求']);
    expect(s.d.getState().smartHits.get('s1')?.lids, '集め直していない').toEqual(['a']);
  });

  it('🔴 「ここから外す」で、条件のタグが本文から消える', async () => {
    const s = setup({
      s1: `---\n${SMART_TAGS_KEY}: [請求]\n---\n説明\n`,
      a: '---\ntags: [請求, 他]\n---\nあ\n',
    });
    s.d.dispatch({ type: 'SMART_TAGS', smartLid: 's1', lids: ['a'], mode: 'remove' });
    await tick(40);
    expect(readTags(s.disk.a!), '条件のタグが消えていない').toEqual(['他']);
  });

  /**
   * ⚠ **条件が空の入れ物へ落としたら断る** ── 黙って何もしないと、落とした user は
   * 「入ったはずなのに出てこない」を見る。
   */
  it('🔴 条件が空なら、落としても断り文が出る(無言で捨てない)', async () => {
    const s = setup({ s1: `---\n${SMART_TAGS_KEY}: \n---\n説明\n`, a: 'あ\n' });
    s.d.dispatch({ type: 'SMART_TAGS', smartLid: 's1', lids: ['a'], mode: 'add' });
    await tick(30);
    expect(s.errors.join(' '), '無言で捨てた').toContain('条件');
    expect(s.disk.a, '本文が書き換わった').toBe('あ\n');
  });

  /**
   * 🔴 **集められない版では黙らない** ── 面が「集めています…」のまま永久に
   * 止まって見えるのが最悪である(`REQUEST_QUERY_SCAN` と同じ規律)。
   */
  it('🔴 集める口を持たない配線では、そう画面に出る', async () => {
    const d = new Dispatcher();
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => `---\n${SMART_TAGS_KEY}: [請求]\n---\n`,
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
      // ⚠ `smartScan` を**渡さない**(旧い worker が残っている端末)
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    d.dispatch({ type: 'SET_SCOPE', lid: 's1' });
    await tick();
    expect(d.getState().smartHits.get('s1')?.failed, '黙って止まっている').toBe(true);
  });
});

describe('押し口の配線(#421 段①)', () => {
  it('🔴 「条件に足す」を押すと、欄の語が条件として撃たれる', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const region = document.createElement('div');
    root.append(region);
    const r = new FilerRenderer(region);
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    d.dispatch({ type: 'SET_SCOPE', lid: 's1' });
    const seen: string[] = [];
    d.onEvent((e) => seen.push(e.type));
    r.render(d.getState());
    bindActions(root, d, {});

    const box = region.querySelector<HTMLInputElement>('[data-pkc-field="smart-cond"]')!;
    box.value = '請求';
    region.querySelector<HTMLElement>('[data-pkc-action="smart-cond-add"]')!.click();
    expect(seen, '条件を書く要求が出ていない').toContain('REQUEST_SMART_COND');
    expect(box.value, '通ったのに欄が残っている').toBe('');
  });

  it('⚠ 空の欄で押しても無言にしない(理由を出す)', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const region = document.createElement('div');
    root.append(region);
    const r = new FilerRenderer(region);
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    d.dispatch({ type: 'SET_SCOPE', lid: 's1' });
    r.render(d.getState());
    bindActions(root, d, {});
    region.querySelector<HTMLElement>('[data-pkc-action="smart-cond-add"]')!.click();
    expect(d.getState().error ?? '', '押しても無反応').toContain('タグ');
  });

  it('🔴 スマートフォルダの行は、フォルダとは別の落とし先として印が付く', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const region = document.createElement('div');
    root.append(region);
    const r = new FilerRenderer(region);
    r.render(booted());
    const row = region.querySelector(
      '[data-pkc-region="filer-table"] [data-pkc-entry="s1"]',
    );
    expect(row?.getAttribute('data-pkc-drop'), '落とし先の印が違う').toBe('smart');
    const folder = region.querySelector(
      '[data-pkc-region="filer-table"] [data-pkc-entry="f1"]',
    );
    expect(folder?.getAttribute('data-pkc-drop'), 'フォルダと同じ印になっている').toBe('folder');
  });
});
