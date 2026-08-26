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
  EMPTY_SMART,
  MAX_SMART_TAGS,
  readSmartSpec,
  SMART_FIELDS,
  SMART_KIND_KEY,
  SMART_TAGS_KEY,
  SMART_UPDATED_KEY,
  withSmartField,
} from '../../src/features/smart/smart-spec';
import { readTags } from '../../src/features/flavor/tags';
import { extractSchedule } from '../../src/features/schedule/schedule-keys';
import type { SmartQuery } from '../../src/features/smart/smart-spec';

/** 走査に渡された条件の記録(`lid` + 条件ぜんぶ)。 */
type SmartQuery0 = SmartQuery & { lid: string };

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
    s = reduce(s, { type: 'SMART_SCANNED', lid: 's1', lids: ['a'], total: 1, spec: { ...EMPTY_SMART, tags: ['請求'] } }).state;
    s = reduce(s, { type: 'SMART_SCANNED', lid: 'f1', lids: ['b'], total: 1, spec: { ...EMPTY_SMART, tags: ['x'] } }).state;
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
      spec: { ...EMPTY_SMART, tags: ['請求'] },
    }).state;
    s = reduce(s, { type: 'SMART_SCAN_FAILED', lid: 's1' }).state;
    expect(s.smartHits.get('s1')?.failed).toBe(true);
    expect(s.smartHits.get('s1')?.spec.tags, '条件まで消えた').toEqual(['請求']);
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
    s = reduce(s, { type: 'SMART_SCANNED', lid: 's1', lids: ['a', 'b'], total: 2, spec: { ...EMPTY_SMART, tags: ['請求'] } })
      .state;
    r.render(s);
    // 🔑 **b は「はこ」の中に在る**が、条件で当たったので出る(場所を動かさない)
    expect(rows(), '当たりが出ていない').toEqual(['a', 'b']);
    expect(why()).toContain('2 件');
  });

  it('🔴 条件が空なら「条件を選んでください」と出す(全部は集めない)', () => {
    const r = mount();
    let s = reduce(booted(), { type: 'SET_SCOPE', lid: 's1' }).state;
    s = reduce(s, { type: 'SMART_SCANNED', lid: 's1', lids: [], total: 0, spec: EMPTY_SMART }).state;
    r.render(s);
    expect(why()).toContain('条件を選んでください');
    expect(rows(), '条件が無いのに集めている').toEqual([]);
  });

  /**
   * 🔴 **集めている最中に打った条件が、走査の返りで消えない**
   * (CI の smoke が 2 本落ちて判明。2026-08-26)。
   *
   * ⚠ 帯は当たりが届くたびに**丸ごと組み直る**ので、直す前は打ちかけの字が
   *   **入っていた欄ごと捨てられていた** ── 押しても
   *   「集める条件にするタグを入力してください」が出るだけで、何も起きない。
   * ⚠ **速い機械では出ない** ── 走査が返るのが打つより先だからである
   *   (手元では 3/3 緑、CI では 2/3 赤)。だから**時間ではなく順番**で見る。
   */
  it('🔴 集めている最中に打った条件が、走査の返りで消えない', () => {
    const r = mount();
    let s = reduce(booted(), { type: 'SET_SCOPE', lid: 's1' }).state;
    r.render(s); // まだ集めていない(「集めています…」)
    const field = (): HTMLInputElement =>
      region.querySelector<HTMLInputElement>('[data-pkc-field="smart-cond"]')!;
    expect(field(), '条件の欄が出ていない').not.toBeNull();
    field().value = '請求'; // user が打った
    // ここで初回の走査が返る(条件は空なので 0 件)
    s = reduce(s, { type: 'SMART_SCANNED', lid: 's1', lids: [], total: 0, spec: EMPTY_SMART }).state;
    r.render(s);
    expect(field().value, '打った字が消えた(押しても何も起きない)').toBe('請求');
  });

  /**
   * ⚠ **同じ穴は「まとめて付けるタグ」の欄にも在る** ── 直しは帯ぜんぶに
   *   掛けたので、こちらも守られていることを見る(§7 の「1 か所で直した」の裏取り)。
   */
  it('⚠ まとめて付けるタグの欄も、組み直しで字が消えない', () => {
    const r = mount();
    let s = reduce(booted(), { type: 'SET_SCOPE', lid: 's1' }).state;
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'a' }).state;
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'b' }).state;
    s = reduce(s, { type: 'SMART_SCANNED', lid: 's1', lids: ['a', 'b'], total: 2, spec: { ...EMPTY_SMART, tags: ['請求'] } })
      .state;
    r.render(s);
    const field = (): HTMLInputElement =>
      region.querySelector<HTMLInputElement>('[data-pkc-field="bulk-tag"]')!;
    expect(field(), '前提: まとめての帯が出ていない').not.toBeNull();
    field().value = '家事';
    // 当たりが届き直す(別の窓がタグを付けた等)
    s = reduce(s, { type: 'SMART_SCANNED', lid: 's1', lids: ['a', 'b'], total: 2, spec: { ...EMPTY_SMART, tags: ['請求'] } })
      .state;
    r.render(s);
    expect(field().value, '打った字が消えた').toBe('家事');
  });

  /**
   * ⚠ **行を選び直しただけでも帯は組み直る**(この面は選択の変化を
   *   「属性 patch だけ」で済ませるが、帯は毎回作り直す)── 変異試験 B1 が
   *   SURVIVED で教えた、**もう 1 つの組み直しの口**である。
   */
  it('⚠ 行を選び直しただけでも、打ちかけの字は消えない', () => {
    const r = mount();
    let s = reduce(booted(), { type: 'SET_SCOPE', lid: 's1' }).state;
    s = reduce(s, { type: 'SMART_SCANNED', lid: 's1', lids: ['a', 'b'], total: 2, spec: { ...EMPTY_SMART, tags: ['請求'] } })
      .state;
    r.render(s);
    const field = (): HTMLInputElement =>
      region.querySelector<HTMLInputElement>('[data-pkc-field="smart-cond"]')!;
    field().value = '家事';
    // 行に印を付けるだけ(一覧も場所も変わらない = 速い経路)
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'a' }).state;
    r.render(s);
    expect(field().value, '選び直しただけで字が消えた').toBe('家事');
  });

  /**
   * 🔴 **戻したら忘れる**(変異試験 B5)。⚠ 覚えたままにすると、
   *   user が欄を**空にしても、次の組み直しで字が甦る** ── 消せない欄になる。
   */
  it('🔴 欄を空にしたら、組み直しで字が甦らない', () => {
    const r = mount();
    let s = reduce(booted(), { type: 'SET_SCOPE', lid: 's1' }).state;
    s = reduce(s, { type: 'SMART_SCANNED', lid: 's1', lids: ['a'], total: 1, spec: { ...EMPTY_SMART, tags: ['請求'] } }).state;
    r.render(s);
    const field = (): HTMLInputElement =>
      region.querySelector<HTMLInputElement>('[data-pkc-field="smart-cond"]')!;
    field().value = '家事';
    s = reduce(s, { type: 'SMART_SCANNED', lid: 's1', lids: ['a', 'b'], total: 2, spec: { ...EMPTY_SMART, tags: ['請求'] } })
      .state;
    r.render(s);
    expect(field().value, '前提: 一度は運ばれている').toBe('家事');
    // user が消した
    field().value = '';
    s = reduce(s, { type: 'SMART_SCANNED', lid: 's1', lids: ['a'], total: 1, spec: { ...EMPTY_SMART, tags: ['請求'] } }).state;
    r.render(s);
    expect(field().value, '消した字が甦った(欄を空にできない)').toBe('');
  });

  /**
   * 🔴 **列で引く条件は `<select>` そのものが状態を出す**(#421 段②)。
   * ⚠ 札を別に出すと、同じ情報が 2 か所になる(片方だけ古くなる)。
   */
  it('🔴 いま効いている列の条件が、選択肢に映っている', () => {
    const r = mount();
    let s = reduce(booted(), { type: 'SET_SCOPE', lid: 's1' }).state;
    s = reduce(s, {
      type: 'SMART_SCANNED',
      lid: 's1',
      lids: [],
      total: 0,
      spec: { ...EMPTY_SMART, kind: 'attachment', updatedDays: 30, dated: false },
    }).state;
    r.render(s);
    const val = (f: string): string =>
      region.querySelector<HTMLSelectElement>(`[data-pkc-field="smart-${f}"]`)?.value ?? '?';
    expect(val('kind'), '種類が映っていない').toBe('attachment');
    expect(val('updated'), '更新が映っていない').toBe('30d');
    expect(val('created'), '指定していないのに値が入っている').toBe('');
    expect(val('dated'), '日付が映っていない').toBe('false');
  });

  /**
   * ⚠ **選択肢の語が、読める綴りと同じ** ── 食い違うと「選べるのに 1 件も
   * 集まらない」入れ物ができる(理由は画面のどこにも出ない)。
   */
  it('🔴 選択肢の値が、そのまま条件として読める', () => {
    const r = mount();
    r.render(reduce(booted(), { type: 'SET_SCOPE', lid: 's1' }).state);
    for (const field of SMART_FIELDS) {
      const sel = region.querySelector<HTMLSelectElement>(`[data-pkc-field="smart-${field}"]`);
      expect(sel, `${field} の選択肢が出ていない`).not.toBeNull();
      const values = [...sel!.options].map((o) => o.value).filter((v) => v !== '');
      expect(values.length, `${field} に選べる値が無い`).toBeGreaterThan(0);
      for (const v of values) {
        expect(
          withSmartField(EMPTY_SMART, field, v).ok,
          `${field} の選択肢「${v}」が条件として読めない`,
        ).toBe(true);
      }
    }
  });

  it('🔴 選ぶと、その条件を書きに行く', () => {
    let s = reduce(booted(), { type: 'SET_SCOPE', lid: 's1' }).state;
    s = reduce(s, {
      type: 'SMART_SCANNED',
      lid: 's1',
      lids: [],
      total: 0,
      spec: EMPTY_SMART,
    }).state;
    const out = reduce(s, { type: 'SMART_FIELD', lid: 's1', field: 'kind', value: 'folder' });
    expect(out.events, '書きに行っていない').toEqual([
      {
        type: 'REQUEST_SMART_FIELD',
        target: { lid: 's1', title: '請求ぜんぶ', archetype: 'smart', entryOrder: 1 },
        field: 'kind',
        value: 'folder',
      },
    ]);
  });

  it('⚠ スマートフォルダでないものに、列の条件を書かない', () => {
    expect(
      reduce(booted(), { type: 'SMART_FIELD', lid: 'f1', field: 'kind', value: 'text' }).events,
    ).toEqual([]);
  });

  it('⚠ 上限で切ったことを画面に出す(「これで全部」と嘘をつかない)', () => {
    const r = mount();
    let s = reduce(booted(), { type: 'SET_SCOPE', lid: 's1' }).state;
    s = reduce(s, { type: 'SMART_SCANNED', lid: 's1', lids: ['a'], total: 9, spec: { ...EMPTY_SMART, tags: ['請求'] } }).state;
    r.render(s);
    expect(why(), '切ったことが読めない').toContain('9 件中 1 件');
  });

  it('🔴 条件が札で出て、1 つずつ外せる', () => {
    const r = mount();
    let s = reduce(booted(), { type: 'SET_SCOPE', lid: 's1' }).state;
    s = reduce(s, { type: 'SMART_SCANNED', lid: 's1', lids: [], total: 0, spec: { ...EMPTY_SMART, tags: ['請求'] } }).state;
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
    s = reduce(s, { type: 'SMART_SCANNED', lid: 's1', lids: ['a'], total: 1, spec: { ...EMPTY_SMART, tags: ['請求'] } }).state;
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
    reduce(state, { type: 'SMART_SCANNED', lid: smartLid, lids, total: lids.length, spec: { ...EMPTY_SMART, tags } })
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
      spec: { ...EMPTY_SMART, tags: ['請求'] },
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
    expect(st.smartHits.get('s1')?.spec.tags, '前提: 条件は残っている').toEqual(['請求']);
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
   * 🔴 **列の条件を持つ入れ物は、その場で継ぎ足さない**(#421 段②。変異試験 P8)。
   *
   * ⚠ 継ぎ足すと嘘になる ── 種類 / 作成 / 日付は本文からは決まらないし、
   *   「更新が N 日以内」は**保存した瞬間に変わる**。
   * 🔑 **reducer だけで見る**(effect を通さない)── 通すと集め直しが後から
   *   上書きしてしまい、**間違った継ぎ足しが画面に出ていた時間**が見えない
   *   (変異試験 P8 が SURVIVED でそれを教えた)。
   */
  it('🔴 列の条件を持つ入れ物は、行を書いてもその場では変えない', () => {
    const s0 = withHit(booted(), 's1', ['請求'], []);
    // 種類の条件を足す(タグはそのまま)
    const withKind = reduce(s0, {
      type: 'SMART_SCANNED',
      lid: 's1',
      lids: [],
      total: 0,
      spec: { ...EMPTY_SMART, tags: ['請求'], kind: 'text' },
    }).state;
    const s1 = rewritten(withKind, 'a', '---\ntags: [請求]\n---\nあ\n');
    expect(
      s1.smartHits.get('s1')?.lids,
      '列の条件を持つのに、その場で継ぎ足した(集め直しが来るまで嘘の行が出る)',
    ).toEqual([]);
  });

  /** ⚠ **対照群** ── タグだけなら、その場で落ちる(門が効きすぎていない)。 */
  it('⚠ タグだけの入れ物は、これまでどおりその場で落ちる', () => {
    const s0 = withHit(booted(), 's1', ['請求'], []);
    const s1 = rewritten(s0, 'a', '---\ntags: [請求]\n---\nあ\n');
    expect(s1.smartHits.get('s1')?.lids).toEqual(['a']);
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
const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 行の時刻(worker が持つもの)。⚠ 書いていない行は「一度も保存していない」扱い。 */
function setup(disk: Record<string, string>, times: Record<string, string> = {}) {
  const d = new Dispatcher();
  const scans: SmartQuery0[] = [];
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
    /**
     * 🔴 **本物と同じ意味論**(§3)── stub を本物より甘くしない。
     * ⚠ 甘くすると、列の条件を落とす取り違えが**両方緑のまま**通る。
     *   ここは worker の SQL と同じ規則で落とす:
     *   種類は `archetype = ?` / 時刻は **`IS NOT NULL AND >= ?`**
     *   (一度も保存していない行は「N 日以内」ではない)/ 日付は `date` 列の有無。
     */
    smartScan: async (lid, q) => {
      scans.push({ lid, ...q, tags: [...q.tags] });
      if (q.tags.length === 0 && q.kind === null && q.updatedFrom === null &&
          q.createdFrom === null && q.dated === null)
        return { lids: [], total: 0 };
      const lids = Object.entries(disk)
        .filter(([l, body]) => {
          if (l === lid) return false;
          if (!q.tags.every((t) => readTags(body).includes(t))) return false;
          const kind = METAS.find((m) => m.lid === l)?.archetype ?? 'text';
          if (q.kind !== null && kind !== q.kind) return false;
          const at = times[l];
          if (q.updatedFrom !== null && (at === undefined || at < q.updatedFrom)) return false;
          if (q.createdFrom !== null && (at === undefined || at < q.createdFrom)) return false;
          if (q.dated !== null) {
            const hasDate = extractSchedule(body).date !== null;
            if (hasDate !== q.dated) return false;
          }
          return true;
        })
        .map(([l]) => l);
      return { lids, total: lids.length };
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
  return { d, scans, errors, disk };
}

describe('配線(effect 層まで)', () => {

  it('🔴 開くと、本文から条件を読んで集め、条件も一緒に返る', async () => {
    const s = setup({
      s1: `---\n${SMART_TAGS_KEY}: [請求]\n---\n説明\n`,
      a: '---\ntags: [請求]\n---\nあ\n',
      b: '---\ntags: [家事]\n---\nい\n',
    });
    s.d.dispatch({ type: 'SET_SCOPE', lid: 's1' });
    await tick();
    expect(
      s.scans.map((q) => ({ lid: q.lid, tags: q.tags })),
      '条件を読んで渡していない',
    ).toEqual([{ lid: 's1', tags: ['請求'] }]);
    const hit = s.d.getState().smartHits.get('s1');
    expect(hit?.lids).toEqual(['a']);
    // 🔑 効いていた条件も届く(画面が「何で絞っているか」を出すのに要る)
    expect(hit?.spec.tags, '条件が届いていない').toEqual(['請求']);
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
    expect(hit?.spec.tags, '条件は空である').toEqual([]);
    expect(hit?.lids).toEqual([]);
  });

  /** ⚠ **対の主張** ── 条件が在るときは、ちゃんと頼んでいる(上の門の空振り防止)。 */
  it('⚠ 条件が 1 つでも在れば頼む', async () => {
    const s = setup({ s1: `---\n${SMART_TAGS_KEY}: [請求]\n---\n説明\n` });
    s.d.dispatch({ type: 'SET_SCOPE', lid: 's1' });
    await tick();
    expect(s.scans.map((q) => ({ lid: q.lid, tags: q.tags }))).toEqual([
      { lid: 's1', tags: ['請求'] },
    ]);
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
    expect(
      s.scans.at(-1) === undefined
        ? null
        : { lid: s.scans.at(-1)!.lid, tags: s.scans.at(-1)!.tags },
      '集め直していない',
    ).toEqual({ lid: 's1', tags: ['請求'] });
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
    expect(
      s.scans.at(-1) === undefined
        ? null
        : { lid: s.scans.at(-1)!.lid, tags: s.scans.at(-1)!.tags },
      '集め直していない',
    ).toEqual({ lid: 's1', tags: ['請求'] });
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

/**
 * 🔴 **列で引く条件**(#421 段②)── 走査が要らない分の配線。
 */
describe('列で引く条件(#421 段②)', () => {
  it('🔴 選ぶと本文に書かれ、その場で集め直す', async () => {
    const s = setup({ s1: '---\ntitle: 添付ぜんぶ\n---\n説明の文\n' });
    s.d.dispatch({ type: 'SMART_FIELD', lid: 's1', field: 'kind', value: 'attachment' });
    await tick(30);
    expect(readSmartSpec(s.disk.s1!).kind, '条件が本文に書かれていない').toBe('attachment');
    expect(s.disk.s1, '説明文が壊れた').toContain('説明の文');
    expect(s.scans.at(-1)?.kind, '条件を渡していない').toBe('attachment');
  });

  it('🔴 「指定しない」で外れる(片道にしない)', async () => {
    const s = setup({ s1: `---\n${SMART_KIND_KEY}: attachment\n---\n説明\n` });
    s.d.dispatch({ type: 'SMART_FIELD', lid: 's1', field: 'kind', value: '' });
    await tick(30);
    expect(readSmartSpec(s.disk.s1!).kind, '外れていない').toBeNull();
  });

  it('🔴 受けられない値は書かず、理由を出す(黙って捨てない)', async () => {
    const s = setup({ s1: '---\ntitle: 名前\n---\n説明\n' });
    const before = s.disk.s1;
    s.d.dispatch({ type: 'SMART_FIELD', lid: 's1', field: 'updated', value: 'あした' });
    await tick();
    expect(s.disk.s1, '受けられない値を書いた').toBe(before);
    expect(s.errors.length, '理由が出ていない').toBeGreaterThan(0);
  });

  /**
   * 🔴 **境目の時刻は主スレッドで作って渡す**(worker に時計を持ち込まない)。
   * ⚠ 渡し忘れると、worker は「指定なし」と読んで**全件当ててしまう**。
   */
  it('🔴 「N 日以内」は境目の時刻になって worker へ渡る', async () => {
    const s = setup({ s1: `---\n${SMART_UPDATED_KEY}: 7d\n---\n説明\n` });
    s.d.dispatch({ type: 'SET_SCOPE', lid: 's1' });
    await tick();
    const q = s.scans.at(-1);
    expect(q?.updatedFrom, '境目が渡っていない').not.toBeNull();
    // ⚠ 7 日前あたり(走らせた時刻に依るので、範囲で見る)
    const from = Date.parse(q?.updatedFrom ?? '');
    const days = (Date.now() - from) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect(q?.createdFrom, '指定していないほうにも境目が付いた').toBeNull();
  });

  /**
   * 🔴 **列の条件を持つ入れ物は、行を書いたら worker に集め直しを頼む**。
   * ⚠ その場で当て直すと嘘になる(`updated_at` は保存のたびに変わる)。
   */
  it('🔴 行を書くと、列の条件を持つ入れ物は集め直される', async () => {
    const s = setup(
      { s1: `---\n${SMART_KIND_KEY}: text\n---\n説明\n`, a: 'あ\n' },
      { a: new Date().toISOString() },
    );
    s.d.dispatch({ type: 'SET_SCOPE', lid: 's1' });
    await tick();
    const before = s.scans.length;
    // 別のノートにタグを付ける(= 行を書く)
    s.d.dispatch({ type: 'BULK_TAG', lids: ['a'], tag: '請求', mode: 'add' });
    await tick(50);
    expect(s.scans.length, '書いたのに集め直していない').toBeGreaterThan(before);
  });

  /** ⚠ **対照群** ── タグだけの入れ物は、その場で当て直すので走査を頼まない。 */
  it('⚠ タグだけの入れ物は、行を書いても走査を頼まない', async () => {
    const s = setup({ s1: `---\n${SMART_TAGS_KEY}: [請求]\n---\n説明\n`, a: 'あ\n' });
    s.d.dispatch({ type: 'SET_SCOPE', lid: 's1' });
    await tick();
    const before = s.scans.length;
    s.d.dispatch({ type: 'BULK_TAG', lids: ['a'], tag: '請求', mode: 'add' });
    await tick(50);
    expect(s.scans.length, 'その場で当て直せるのに走査を頼んだ').toBe(before);
    expect(s.d.getState().smartHits.get('s1')?.lids, 'その場で落ちていない').toEqual(['a']);
  });

  /**
   * 🔴 **まとめて書いても、走査は積み上がらない**(#421 段② の畳み込み)。
   * ⚠ 畳まないと、100 件にタグを付けた回に**全件走査が 100 回**走る。
   */
  it('🔴 まとめて書いても、集め直しは列の中で 1 つに畳まれる', async () => {
    const s = setup(
      {
        s1: `---\n${SMART_KIND_KEY}: text\n---\n説明\n`,
        a: 'あ\n',
        b: 'い\n',
      },
      { a: new Date().toISOString(), b: new Date().toISOString() },
    );
    s.d.dispatch({ type: 'SET_SCOPE', lid: 's1' });
    await tick();
    const before = s.scans.length;
    s.d.dispatch({ type: 'BULK_TAG', lids: ['a', 'b'], tag: '請求', mode: 'add' });
    await tick(60);
    // ⚠ **2 件書いたのに走査は 1 回**(0 では困る ── 集め直しは起きなければならない)
    expect(s.scans.length - before, '走査が積み上がっている').toBe(1);
  });
});
