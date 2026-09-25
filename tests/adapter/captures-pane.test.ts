/** @vitest-environment happy-dom */
/**
 * 🔴 **録ったものの面**(#683 段①、2026-09-09)。
 *
 * ⚠ 見るのは **user が何を見て、何を押せるか** ──
 *   ①「まだ」と「駄目だった」を取り違えない ②中身が無い行に「聞く」を出さない
 *   ③**同時に鳴るのは 1 件だけ**(録音 1 本は数百 MB になりうる)
 *   ④面から出たら**器へ返す**(不可侵指示 2026-07-27)。
 */
import { describe, expect, it, vi } from 'vitest';
import { CapturesRenderer } from '../../src/adapter/ui/render/captures';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { captureItemsFrom, type CaptureItem } from '../../src/features/capture/capture-item';
import { BROWSE_MODES, browseScanOf, homeTabOf } from '../../src/adapter/ui/render/browse-mode';
import { BROWSE_TABS } from '../../src/adapter/ui/render/browse';
import { BROWSE_ICONS } from '../../src/adapter/ui/render/icons';
import { VIEW_MODES } from '../../src/adapter/state/app-state';

function body(name: string, mime: string, key: string | null = 'k-1'): string {
  return [
    '---',
    `attachment.name: ${name}`,
    `attachment.mime: ${mime}`,
    'attachment.size: 2048',
    ...(key === null ? [] : [`attachment.asset_key: ${key}`]),
    '---',
    '',
  ].join('\n');
}

const ITEMS = (): CaptureItem[] =>
  captureItemsFrom([
    { lid: 'a', title: 'a', body: body('録音-2026-09-09-030102.webm', 'audio/webm') },
    { lid: 'b', title: 'b', body: body('画面収録-2026-09-09-030102.webm', 'video/webm', 'k-2') },
  ]);

/** 借りる口の偽物。⚠ **返した回数を数える**(返し忘れを見るのがここの仕事)。 */
function lender(): {
  lend: (k: string) => Promise<{ url: string; dispose: () => void } | null>;
  getBlob: () => Promise<Blob | null>;
  lent: string[];
  disposed: string[];
} {
  const lent: string[] = [];
  const disposed: string[] = [];
  return {
    lent,
    disposed,
    getBlob: async () => null,
    lend: async (k: string) => {
      lent.push(k);
      return { url: `blob:${k}`, dispose: () => void disposed.push(k) };
    },
  };
}

function pane(
  state: Partial<AppState>,
  assets: ReturnType<typeof lender> | null = null,
  onReady: () => void = () => {},
): { host: HTMLElement; r: CapturesRenderer; paint: (s?: Partial<AppState>) => void } {
  const host = document.createElement('div');
  document.body.append(host);
  const r = new CapturesRenderer(host, assets, onReady);
  let cur = { ...initialState, ...state } as AppState;
  const paint = (s: Partial<AppState> = {}): void => {
    cur = { ...cur, ...s } as AppState;
    r.render(cur);
  };
  paint();
  return { host, r, paint };
}

const note = (h: HTMLElement): string =>
  h.querySelector('[data-pkc-field="captures-note"]')?.textContent ?? '';
const rows = (h: HTMLElement): HTMLElement[] => [
  ...h.querySelectorAll<HTMLElement>('[data-pkc-capture]'),
];

describe('録ったものの面 ── 何が見えるか(#683 段①)', () => {
  /**
   * 🔴 **「まだ」と「駄目だった」を取り違えない**(`contacts.ts` の 2 巡目レビューで
   *   判明した形)── 取り違えると「集めています…」で**永久に止まって見える**。
   */
  it('🔴 集める前・失敗・0 件・件数で、字が全部違う', () => {
    expect(note(pane({}).host), 'まだ集めていない').toBe('音と動画を集めています…');
    expect(note(pane({ captureScanFailed: true }).host)).toContain('集められませんでした');
    expect(note(pane({ captureItems: [] }).host)).toContain('まだありません');
    expect(note(pane({ captureItems: ITEMS() }).host)).toBe('2 件');
  });

  /**
   * 🔴 **初回の走査が失敗した回**は `captureItems` が `null` のままなので、
   *   指紋に `failed` を入れないと「まだ集めていない」と**同じ指紋**になり、
   *   **断り文が一度も画面に出ない**(`contacts.ts` が実際に踏んだ形)。
   */
  it('🔴 集める前 → 失敗 で、画面の字が入れ替わる(指紋が潰していない)', () => {
    const p = pane({});
    expect(note(p.host)).toBe('音と動画を集めています…');
    p.paint({ captureScanFailed: true });
    expect(note(p.host), '失敗が「まだ」と同じ指紋になっている').toContain('集められませんでした');
  });

  it('🔴 行には名前・呼び名・大きさが出る', () => {
    const { host } = pane({ captureItems: ITEMS() });
    expect(rows(host)).toHaveLength(2);
    const first = rows(host)[0]!;
    expect(first.querySelector('[data-pkc-field="capture-name"]')?.textContent).toBe(
      '録音-2026-09-09-030102.webm',
    );
    const about = first.querySelector('[data-pkc-field="capture-about"]')?.textContent ?? '';
    expect(about, '呼び名が出ていない').toContain('録音');
    expect(about, '大きさが出ていない').toMatch(/\d/);
  });

  /** 🔑 名前を押すと**そのノートが開く**(開く口を増やさない ── `select-entry` を通す)。 */
  it('🔴 名前は select-entry で、その行の lid を持つ', () => {
    const { host } = pane({ captureItems: ITEMS() });
    const btn = rows(host)[1]!.querySelector('[data-pkc-field="capture-name"]')!;
    expect(btn.getAttribute('data-pkc-action')).toBe('select-entry');
    expect(btn.getAttribute('data-pkc-entry')).toBe('b');
  });

  /**
   * 🔴 **行き止まりを作らない**(#536 ②)── 絞りのせいで 0 件なら外す道を出す。
   * ⚠ 絞りが無いときは出さない(押しても何も起きない口を作らない)。
   */
  it('🔴 絞りで 0 件のときだけ「絞りを外す」が出る', () => {
    const withQuery = pane({ captureItems: ITEMS(), filterQuery: 'ぜったい無い' }).host;
    expect(note(withQuery)).toContain('絞り込みに当たる');
    expect(
      withQuery.querySelector('[data-pkc-field="captures-clear-filter"]'),
      '絞りを外す道が無い(user は一覧タブへ戻るしかない)',
    ).not.toBeNull();
    // 対照群 ── 本当に 0 件のときは出さない
    const empty = pane({ captureItems: [] }).host;
    expect(
      empty.querySelector('[data-pkc-field="captures-clear-filter"]'),
      '外す物が無いのにボタンが出ている(dead click)',
    ).toBeNull();
  });
});

describe('その場で聞く ── 借りと返し(#683 段①)', () => {
  /**
   * 🔴 **中身の鍵が無い行には「聞く」を出さない** ── 押しても何も起きない
   *   ボタンは、user から見て「壊れている」と同じである。
   */
  it('🔴 鍵の無い行には押し所が出ない(対照群つき)', () => {
    const items = captureItemsFrom([
      { lid: 'a', title: 'a', body: body('鍵あり.webm', 'audio/webm') },
      { lid: 'b', title: 'b', body: body('鍵なし.webm', 'audio/webm', null) },
    ]);
    const { host } = pane({ captureItems: items }, lender());
    expect(
      rows(host)[0]!.querySelector('[data-pkc-field="capture-play"]'),
      '鍵が在るのに押し所が出ていない(空振り)',
    ).not.toBeNull();
    expect(
      rows(host)[1]!.querySelector('[data-pkc-field="capture-play"]'),
      '鍵が無い行に押し所が出ている',
    ).toBeNull();
  });

  /** ⚠ 借りる口が無い(渡されていない)なら、押し所そのものを出さない。 */
  it('🔴 借りる口が無ければ押し所を出さない', () => {
    const { host } = pane({ captureItems: ITEMS() }, null);
    expect(host.querySelector('[data-pkc-field="capture-play"]')).toBeNull();
  });

  it('🔴 state が指した 1 件を借りて、器を出す', async () => {
    const a = lender();
    const ready = vi.fn();
    const p = pane({ captureItems: ITEMS() }, a, ready);
    p.paint({ capturePlayingLid: 'a' });
    await Promise.resolve();
    await Promise.resolve();
    expect(a.lent, '借りに行っていない').toEqual(['k-1']);
    expect(ready, '借り終えたことを外へ知らせていない').toHaveBeenCalled();
    p.paint();
    const media = rows(p.host)[0]!.querySelector<HTMLMediaElement>(
      '[data-pkc-field="capture-media"]',
    );
    expect(media, '器が出ていない').not.toBeNull();
    expect(media!.getAttribute('src')).toBe('blob:k-1');
    // ⚠ 鳴っている行には「閉じる」が出る(やめる道が無いと片道になる)
    expect(rows(p.host)[0]!.querySelector('[data-pkc-field="capture-stop"]')).not.toBeNull();
  });

  /**
   * 🔴 **同時に鳴るのは 1 件だけ** ── 返してから借りないと、2 本ぶんの bytes が重なる。
   */
  it('🔴 別の行を押すと、前の 1 件を返してから借りる', async () => {
    const a = lender();
    const p = pane({ captureItems: ITEMS() }, a);
    p.paint({ capturePlayingLid: 'a' });
    await Promise.resolve();
    await Promise.resolve();
    p.paint({ capturePlayingLid: 'b' });
    await Promise.resolve();
    await Promise.resolve();
    expect(a.lent).toEqual(['k-1', 'k-2']);
    expect(a.disposed, '前の 1 件を返していない(2 本ぶん器に残る)').toEqual(['k-1']);
    // ⚠ 器も 1 つだけ(2 つ出ると音が重なる)
    p.paint();
    expect(p.host.querySelectorAll('[data-pkc-field="capture-media"]')).toHaveLength(1);
  });

  it('🔴 やめると返す(`capturePlayingLid` が null)', async () => {
    const a = lender();
    const p = pane({ captureItems: ITEMS() }, a);
    p.paint({ capturePlayingLid: 'a' });
    await Promise.resolve();
    await Promise.resolve();
    p.paint({ capturePlayingLid: null });
    expect(a.disposed, 'やめたのに返していない').toEqual(['k-1']);
    p.paint();
    expect(p.host.querySelector('[data-pkc-field="capture-media"]')).toBeNull();
  });

  /**
   * 🔴 **面を捨てるとき返す** ── 返し忘れると、タブを切り替えただけで URL が残る
   *   (`mermaid-hydrate.ts` が実測で踏んだ形)。
   */
  it('🔴 面を捨てると返す', async () => {
    const a = lender();
    const p = pane({ captureItems: ITEMS() }, a);
    p.paint({ capturePlayingLid: 'a' });
    await Promise.resolve();
    await Promise.resolve();
    p.r.dispose();
    expect(a.disposed, '面を捨てたのに借りたままである').toEqual(['k-1']);
  });

  /**
   * 🔴 **行が消えたら返す** ── 絞り込みで消えた / ノートが消えた場合も同じで、
   *   鳴りっぱなしにしない。
   */
  it('🔴 絞り込みで行が消えたら返す', async () => {
    const a = lender();
    const p = pane({ captureItems: ITEMS() }, a);
    p.paint({ capturePlayingLid: 'a' });
    await Promise.resolve();
    await Promise.resolve();
    p.paint({ filterQuery: '画面収録' });
    expect(a.disposed, '画面から消えたのに鳴ったままである').toEqual(['k-1']);
  });

  /**
   * 🔴 **届くまでの間に別の行を押されたら、借りた瞬間に返す**
   *   ── でないと、後から届いた古い音が鳴る。
   */
  it('🔴 借りている最中に押し替えたら、古いほうは届いた瞬間に返る', async () => {
    const a = lender();
    const p = pane({ captureItems: ITEMS() }, a);
    p.paint({ capturePlayingLid: 'a' });
    p.paint({ capturePlayingLid: 'b' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(a.lent).toEqual(['k-1', 'k-2']);
    expect(a.disposed, '追い越された借りが残っている').toContain('k-1');
    p.paint();
    const media = p.host.querySelectorAll<HTMLMediaElement>('[data-pkc-field="capture-media"]');
    expect(media, '器が 1 つでない').toHaveLength(1);
    expect(media[0]!.getAttribute('src'), '古いほうが鳴っている').toBe('blob:k-2');
  });

  /** ⚠ 同じ state で 2 度描いても、借り直さない(押している間に器を作り直さない)。 */
  it('⚠ 同じ状態で描き直しても借り直さない', async () => {
    const a = lender();
    const p = pane({ captureItems: ITEMS() }, a);
    p.paint({ capturePlayingLid: 'a' });
    await Promise.resolve();
    await Promise.resolve();
    p.paint();
    p.paint();
    await Promise.resolve();
    expect(a.lent, '描き直すたびに借りている').toEqual(['k-1']);
  });
});

describe('面の置き場(不可侵指示「左に置き場 / 別窓 / 塞がれたら戻る」)', () => {
  it('🔴 左のタブに在る', () => {
    expect(BROWSE_MODES).toContain('captures');
    expect(BROWSE_TABS.find((t) => t.mode === 'captures')?.label).toBe('音/動画');
    expect(BROWSE_ICONS['captures'], '図案が無い(タブが字だけになる)').toBeDefined();
  });

  it('🔴 別窓で開ける(`ViewMode` に在る)', () => {
    expect(VIEW_MODES).toContain('captures');
  });

  it('🔴 別窓が塞がれたら左のタブへ戻る(中央へ落とさない)', () => {
    expect(homeTabOf('captures'), '中央へ落ちる(本文が消える)').toBe('captures');
  });

  it('🔴 開いたときに集める(起動でも押したときでも同じ口)', () => {
    expect(browseScanOf('captures')).toBe('REFRESH_CAPTURE_SCAN');
  });
});

describe('状態の移り(#683 段①)', () => {
  it('🔴 集め直しは、添付だけを載せて頼む(全文を舐めない)', () => {
    const metas = [
      { lid: 'a', title: 'a.webm', archetype: 'attachment' },
      { lid: 'b', title: 'ふつうのノート', archetype: 'text' },
    ].map((m) => ({
      ...m,
      createdAt: null,
      updatedAt: null,
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
      bodyChars: null,
    }));
    const booted = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas,
      relations: [],
    }).state;
    const r = reduce(booted, { type: 'REFRESH_CAPTURE_SCAN' });
    const ev = r.events.find((e) => e.type === 'REQUEST_CAPTURE_ITEMS');
    expect(ev, '集める頼みが出ていない').toBeDefined();
    expect(
      (ev as { entries: { lid: string }[] }).entries.map((e) => e.lid),
      '添付以外まで読もうとしている(全ノートの本文を舐める)',
    ).toEqual(['a']);
  });

  /** ⚠ **前の一覧を消さない** ── 消すと集め直すたびに行が飛ぶ。 */
  it('⚠ 集め直しても、前の一覧は消えない', () => {
    const s = { ...initialState, captureItems: ITEMS() } as AppState;
    expect(reduce(s, { type: 'REFRESH_CAPTURE_SCAN' }).state.captureItems).toHaveLength(2);
  });

  it('🔴 同じ行をもう一度押すとやめる(押す口を 2 つ作らない)', () => {
    let s = reduce(initialState, { type: 'SET_CAPTURE_PLAYING', lid: 'a' }).state;
    expect(s.capturePlayingLid).toBe('a');
    s = reduce(s, { type: 'SET_CAPTURE_PLAYING', lid: 'a' }).state;
    expect(s.capturePlayingLid, 'もう一度押しても止まらない').toBeNull();
    // 対照群 ── 別の行なら乗り換える
    s = reduce(s, { type: 'SET_CAPTURE_PLAYING', lid: 'a' }).state;
    s = reduce(s, { type: 'SET_CAPTURE_PLAYING', lid: 'b' }).state;
    expect(s.capturePlayingLid).toBe('b');
  });

  it('🔴 集め終えたら「駄目だった」は下ろす(直ったのに断り文が残らない)', () => {
    const s = { ...initialState, captureScanFailed: true } as AppState;
    const r = reduce(s, { type: 'SET_CAPTURE_ITEMS', items: ITEMS() });
    expect(r.state.captureScanFailed).toBe(false);
    expect(r.state.captureItems).toHaveLength(2);
  });
});

describe('読み直し(取込・別タブの書込)でどうなるか(#683 段①)', () => {
  const metaOf = (lid: string, title: string, archetype = 'attachment') => ({
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

  /**
   * 🔴 **消えたノートの行を落とす** ── 落とさないと、押しても何も起きない行が残る
   *   (`SELECT_ENTRY` は居ない lid を黙って捨てる)。
   * ⚠ **丸ごと `null` にしない** ── `SYS_BOOTED` は別タブが書くたびに飛ぶので、
   *   捨てると一覧が「集めています…」へ落ちて**行が飛ぶ**。
   */
  it('🔴 消えたノートの行だけ落ちる(残りは消えない)', () => {
    const s = { ...initialState, cid: 'c1', captureItems: ITEMS() } as AppState;
    const r = reduce(s, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [metaOf('a', 'a.webm')],
      relations: [],
    });
    expect(r.state.captureItems?.map((i) => i.lid), '消えた行が残っている').toEqual(['a']);
  });

  /** ⚠ 別の PKC(cid 違い)なら全部捨てる ── lid の偶然衝突を持ち越さない。 */
  it('⚠ 別の入れ物を開いたら、一覧は捨てる', () => {
    const s = { ...initialState, cid: 'c1', captureItems: ITEMS() } as AppState;
    const r = reduce(s, { type: 'SYS_BOOTED', cid: 'c2', metas: [], relations: [] });
    expect(r.state.captureItems).toBeNull();
  });

  /**
   * 🔴 **取り込んだ録音が、その場で並ぶ**(この枝の本命)。
   * ⚠ 頼みに載せる目録は**新しいほう**である ── `state`(古い方)から採ると、
   *   いま取り込んだ添付が 1 件も載らない(取込はこの枝を通る)。
   */
  it('🔴 取り込んだ直後、新しい添付を載せて集め直す', () => {
    const s = { ...initialState, cid: 'c1', captureItems: ITEMS() } as AppState;
    const r = reduce(s, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [metaOf('a', 'a.webm'), metaOf('z', '取り込んだ.webm'), metaOf('t', 'メモ', 'text')],
      relations: [],
    });
    const ev = r.events.find((e) => e.type === 'REQUEST_CAPTURE_ITEMS');
    expect(ev, '取り込んだのに集め直しを頼んでいない').toBeDefined();
    expect(
      (ev as { entries: { lid: string }[] }).entries.map((e) => e.lid).sort(),
      '古い目録から数えている(取り込んだ分が載らない)',
    ).toEqual(['a', 'z']);
  });

  /**
   * ⚠ **一度も開いていない user には撃たない** ── 添付の本文の走査を、
   *   この面を使わない人に負わせない(予定・連絡先と同じ流儀)。
   */
  it('🔴 一度も開いていなければ、集め直しを頼まない', () => {
    const r = reduce({ ...initialState, cid: 'c1' } as AppState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [metaOf('a', 'a.webm')],
      relations: [],
    });
    expect(
      r.events.some((e) => e.type === 'REQUEST_CAPTURE_ITEMS'),
      '開いていない人に添付の走査を負わせている',
    ).toBe(false);
  });
});

/**
 * 🔴 **前後を削る**(#683 段②a。user 裁定 2026-09-14)。
 *
 * ⚠ 見るのは 3 つ ──
 *   ①**押し所は切り出せる行にだけ出る**(出さない代わりに理由を書く)
 *   ②**印が片方だけなら「切り出す」を出さない**(範囲が決まらない)
 *   ③**印は鳴らしている 1 件にだけ付く**(別の行に古い時刻が見えない)。
 */
describe('前後を削る ── 画面に何が出るか(#683 段②a)', () => {
  const playing = (lid: string, trim?: AppState['captureTrim']): Partial<AppState> => ({
    captureItems: ITEMS(),
    capturePlayingLid: lid,
    ...(trim === undefined ? {} : { captureTrim: trim }),
  });
  /** ⚠ **借り終わるまで `<audio>` は出ない** ── 借りを 1 往復させてから見る。 */
  async function paneReady(state: Partial<AppState>): Promise<HTMLElement> {
    const p = pane(state, lender());
    await Promise.resolve();
    await Promise.resolve();
    p.paint();
    return p.host;
  }
  const field = (h: HTMLElement, lid: string, name: string): HTMLElement | null =>
    h.querySelector<HTMLElement>(`[data-pkc-capture="${lid}"] [data-pkc-field="${name}"]`);

  it('🔴 鳴らしている音の行に「ここから」「ここまで」が出る', async () => {
    const host = await paneReady(playing('a'));
    expect(field(host, 'a', 'capture-media'), '器がまだ出ていない(前提が崩れている)').not.toBeNull();
    expect(field(host, 'a', 'capture-trim-start')?.textContent).toBe('ここを始まりにする');
    expect(field(host, 'a', 'capture-trim-end')?.textContent).toBe('ここを終わりにする');
    expect(field(host, 'a', 'capture-trim')?.textContent).toContain('「ここを始まりにする」');
  });

  it('🔴 鳴らしていない行には 1 つも出ない(押しても時刻が無い)', async () => {
    const host = await paneReady(playing('a'));
    expect(field(host, 'b', 'capture-trim-start')).toBeNull();
  });

  it('🔴 印が片方だけなら「切り出す」を出さない(範囲が決まらない)', async () => {
    const host = await paneReady(playing('a', { lid: 'a', startMs: 12_000, endMs: null }));
    expect(field(host, 'a', 'capture-trim')?.textContent).toContain('ここから 0:12');
    expect(field(host, 'a', 'capture-trim-run'), '範囲が決まっていないのに押せる').toBeNull();
  });

  it('🔴 両方そろったら「切り出す」と「印を消す」が出る(片道にしない)', async () => {
    const host = await paneReady(playing('a', { lid: 'a', startMs: 12_000, endMs: 65_000 }));
    expect(field(host, 'a', 'capture-trim-run')?.textContent).toContain('切り出す');
    expect(field(host, 'a', 'capture-trim-clear'), '印を消す道が無い').not.toBeNull();
    expect(field(host, 'a', 'capture-trim')?.textContent).toBe('0:12〜1:05(0:53)');
  });

  /**
   * 🔴 **印を付けても、聞いている器は作り直さない**(#683 段②a、実ブラウザ smoke で判明)。
   *
   * ⚠ 直す前は印を**一覧の指紋**に入れていたので、「ここから」を押すたびに
   *   一覧ごと組み直し、その中の `<audio>` も作り直されていた ──
   *   **聞いている音が止まって頭へ戻る**。🔴 印は「聞きながら」押すものなので、
   *   これは動線そのものを壊す(#300「補助的な物が主の作業を奪う」と同じ形)。
   * 🔑 だから見るのは 2 つ ── **字は変わる**こと、**器は同じ物のまま**であること。
   */
  it('🔴 印を付けると字は変わり、聞いている器は作り直されない', async () => {
    const p = pane(playing('a'), lender());
    await Promise.resolve();
    await Promise.resolve();
    p.paint();
    expect(field(p.host, 'a', 'capture-trim')?.textContent).toContain('「ここを始まりにする」');
    const before = field(p.host, 'a', 'capture-media');
    expect(before, '前提が崩れている(器が出ていない)').not.toBeNull();

    p.paint({ captureTrim: { lid: 'a', startMs: 12_000, endMs: null } });
    expect(
      field(p.host, 'a', 'capture-trim')?.textContent,
      '押しても画面の字が変わらない',
    ).toContain('ここから 0:12');
    expect(
      field(p.host, 'a', 'capture-media'),
      '印を付けたら器が作り直された ── 聞いている音が止まる',
    ).toBe(before);

    // ⚠ 「この範囲を切り出しています…」でも同じ(こちらも帯だけ差し替える)
    p.paint({ captureTrim: { lid: 'a', startMs: 12_000, endMs: 65_000 }, captureTrimBusy: true });
    expect(field(p.host, 'a', 'capture-trim-run')?.textContent).toBe('この範囲を切り出しています…');
    expect(field(p.host, 'a', 'capture-media'), '走り出したら器が作り直された').toBe(before);
  });

  /** 🔴 **切り出せない形には口を出さず、理由を書く**(押したら断る、にしない)。 */
  /**
   * 🔴 **走っている間は、押した所で分かる**(着地前の動線レビュー 欠陥 3)。
   * ⚠ 長い録音は数秒かかる ── ボタンが何も言わないと「効かなかった」と読まれる。
   */
  it('🔴 切り出している間はボタンがそう言い、押せない', async () => {
    const p = pane(playing('a', { lid: 'a', startMs: 12_000, endMs: 65_000 }), lender());
    await Promise.resolve();
    await Promise.resolve();
    p.paint();
    const run = (): HTMLButtonElement | null =>
      p.host.querySelector<HTMLButtonElement>('[data-pkc-field="capture-trim-run"]');
    expect(run()?.textContent).toBe('この範囲で切り出す');
    expect(run()?.disabled, '走っていないのに押せない').toBe(false);

    p.paint({ captureTrimBusy: true });
    expect(
      run()?.textContent,
      '走っているのに、押した所が何も言わない(指紋に入っていない)',
    ).toBe('この範囲を切り出しています…');
    expect(run()?.disabled, '走っている最中も押せてしまう').toBe(true);
    expect(
      p.host.querySelector<HTMLButtonElement>('[data-pkc-field="capture-trim-clear"]')?.disabled,
      '走っている最中に印を消せる ── 消したのに増える、が起きる',
    ).toBe(true);

    // ⚠ 対照群 ── 終われば戻る(押せなくなったままにしない)
    p.paint({ captureTrimBusy: false });
    expect(run()?.disabled, '終わったのに押せないまま').toBe(false);
  });

  it('🔴 切り出せない形の音は、理由が 1 行出るだけ', async () => {
    const items = captureItemsFrom([
      { lid: 'a', title: 'a', body: body('録音.m4a', 'audio/mp4') },
    ]);
    const host = await paneReady({ captureItems: items, capturePlayingLid: 'a' });
    expect(field(host, 'a', 'capture-trim-start'), '切れないのに押し所が出ている').toBeNull();
    expect(field(host, 'a', 'capture-trim-note')?.textContent).toContain('まだ切り出せません');
  });

  /**
   * 🔴 **鳴らしていない「音」の行**(変異試験 C4 が SURVIVED で教えた)。
   *
   * ⚠ `ITEMS()` は音 1 件・動画 1 件しか無いので、「鳴らしていない**音**の行」が
   *   fixture に 1 つも無かった ── 動画の行は `trimUnavailableText` が
   *   無条件に `null` を返すので、**押し所を出す / 出さないの判定を壊しても
   *   DOM が 1 ドットも変わらない**(§2「fixture のゼロ件次元」)。
   */
  it('🔴 鳴らしていない音の行には、切り出しの字が 1 つも出ない', async () => {
    const items = captureItemsFrom([
      { lid: 'a', title: 'a', body: body('録音A.webm', 'audio/webm') },
      { lid: 'c', title: 'c', body: body('録音C.webm', 'audio/webm', 'k-3') },
    ]);
    const host = await paneReady({ captureItems: items, capturePlayingLid: 'a' });
    // 対照群 ── 鳴らしている側には出ている(空振りでないこと)
    expect(field(host, 'a', 'capture-trim-start'), '鳴らしている行にも出ていない').not.toBeNull();
    expect(field(host, 'c', 'capture-trim-start'), '鳴っていない音の行に押し所が出ている').toBeNull();
    expect(field(host, 'c', 'capture-trim'), '鳴っていない行に印の字が出ている').toBeNull();
  });

  it('🔴 走っている間は「ここから」「ここまで」も押せない(打ち直しが消える)', async () => {
    const p = pane(playing('a', { lid: 'a', startMs: 12_000, endMs: 65_000 }), lender());
    await Promise.resolve();
    await Promise.resolve();
    p.paint();
    const mark = (): HTMLButtonElement | null =>
      p.host.querySelector<HTMLButtonElement>('[data-pkc-field="capture-trim-start"]');
    expect(mark()?.disabled, '走っていないのに押せない').toBe(false);
    p.paint({ captureTrimBusy: true });
    // ⚠ 打ち直しても、走っている物が終わると `CLEAR_CAPTURE_TRIM` で消える
    expect(mark()?.disabled, '走っている間に印を打ち直せる').toBe(true);
  });

  it('⚠ 動画には切り出しの字を 1 つも出さない(いまは音だけ)', async () => {
    const host = await paneReady(playing('b'));
    expect(field(host, 'b', 'capture-trim-start')).toBeNull();
    expect(field(host, 'b', 'capture-trim-note')).toBeNull();
  });
});

/** 🔴 **印の決まり**(#683 段②a)── reducer 側。 */
describe('前後を削る ── 印の決まり(#683 段②a)', () => {
  const play = (lid: string): AppState =>
    reduce({ ...initialState, captureItems: ITEMS() } as AppState, {
      type: 'SET_CAPTURE_PLAYING',
      lid,
    }).state;

  it('🔴 鳴らしている行にだけ印が付く', () => {
    const s = reduce(play('a'), { type: 'SET_CAPTURE_TRIM_MARK', edge: 'start', ms: 1234 }).state;
    expect(s.captureTrim).toEqual({ lid: 'a', startMs: 1234, endMs: null });
  });

  it('🔴 何も鳴っていなければ印は付かない(時刻が意味を持たない)', () => {
    const s = reduce({ ...initialState, captureItems: ITEMS() } as AppState, {
      type: 'SET_CAPTURE_TRIM_MARK',
      edge: 'start',
      ms: 1234,
    }).state;
    expect(s.captureTrim, '鳴っていないのに印が付いた').toBeNull();
  });

  it('🔴 鳴らす物を変えたら印は消える(別の録音の時刻を残さない)', () => {
    let s = reduce(play('a'), { type: 'SET_CAPTURE_TRIM_MARK', edge: 'start', ms: 1234 }).state;
    s = reduce(s, { type: 'SET_CAPTURE_PLAYING', lid: 'b' }).state;
    expect(s.captureTrim, '別の行へ移っても印が残っている').toBeNull();
  });

  it('🔴 逆転は残さない ── 後から押したほうを採る', () => {
    let s = reduce(play('a'), { type: 'SET_CAPTURE_TRIM_MARK', edge: 'start', ms: 5000 }).state;
    s = reduce(s, { type: 'SET_CAPTURE_TRIM_MARK', edge: 'end', ms: 9000 }).state;
    expect(s.captureTrim).toEqual({ lid: 'a', startMs: 5000, endMs: 9000 });
    // ⚠ 始まりを終わりより後ろへ動かしたら、終わりが落ちる(押し直せば戻る)
    s = reduce(s, { type: 'SET_CAPTURE_TRIM_MARK', edge: 'start', ms: 12_000 }).state;
    expect(s.captureTrim).toEqual({ lid: 'a', startMs: 12_000, endMs: null });
    // 対照群 ── 終わりを始まりより前へ動かしたら、始まりが落ちる
    s = reduce(s, { type: 'SET_CAPTURE_TRIM_MARK', edge: 'end', ms: 3000 }).state;
    expect(s.captureTrim).toEqual({ lid: 'a', startMs: null, endMs: 3000 });
  });

  it('⚠ 時刻は 0 より下へ行かない / 整数に丸める', () => {
    const s = reduce(play('a'), { type: 'SET_CAPTURE_TRIM_MARK', edge: 'start', ms: -5.4 }).state;
    expect(s.captureTrim?.startMs).toBe(0);
    const t = reduce(play('a'), { type: 'SET_CAPTURE_TRIM_MARK', edge: 'end', ms: 1234.6 }).state;
    expect(t.captureTrim?.endMs).toBe(1235);
  });

  it('🔴 印を消す道が在る(片道の操作を作らない)', () => {
    let s = reduce(play('a'), { type: 'SET_CAPTURE_TRIM_MARK', edge: 'start', ms: 1234 }).state;
    s = reduce(s, { type: 'CLEAR_CAPTURE_TRIM' }).state;
    expect(s.captureTrim).toBeNull();
  });
});
