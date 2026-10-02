/** @vitest-environment happy-dom */
/**
 * 🔴 **板に置いたノートの中身を、読み取り専用で描く**(#529 W3-①)。
 *
 * ## 守る主張(画面で起きること)
 *
 * 1. 題名の帯の下に、置いたノートの本文(文・表・チェック)が出る
 * 2. 🔴 **押せるものが増えていない**:チェックは押せず、表のセルは打てない(旗を渡していない)。
 *    帯と「続きは元のノートで」だけが、元のノートを開く
 * 3. 大きさは `w=` `h=` で固定、省略時は既定(中身で伸びない)
 * 4. 長い本文は先頭から切って「続きは元のノートで」(切る量は暫定 = W3-③ で測る)。超えなければ出ない
 * 5. 入れ子の板は展開しない(中の「置いたノート」は題名だけの行)
 * 6. 消えたノート / 自分自身 / フォルダ・添付は、中身を出さない(帯だけ)
 * 7. 元のノートの書込に追随する(横に留めた枠と同じ口)
 * 8. 🔴 図・画像・添付ノート・id の衝突(W3-②):図は枠の中で「見えたとき」に焼かれ、本文の画像は枠ごとに貸して
 *    枠が消えれば返す。置いた添付ノートは画像なら絵そのもの、PDF は字、Office 等は帯だけ。
 *    同じノートを 2 枚置いても `id` が重複せず、目次・脚注の押しが同じ枠の中を指す
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects, type StorePort } from '../../src/adapter/state/store-effects';
import {
  initialState,
  placeBodiesOf,
  reduce,
  type AppState,
  type DomainEvent,
} from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { sanitizeEmbedded } from '../../src/adapter/ui/render/place-embed';
import type { AssetLender } from '../../src/adapter/ui/render/detail';
import { cacheKey, renderToPng } from '../../src/adapter/ui/render/mermaid-raster';
import { attachmentBody } from '../../src/features/flavor/attachment-flavor';
import {
  excerptOf,
  PLACE_BODY_CAP,
  PLACE_BODY_CLIP,
  PLACE_ENTRY_DEFAULT_H,
  PLACE_ENTRY_DEFAULT_W,
  placeEmbeddable,
  placeFramed,
  sameExcerpt,
} from '../../src/features/markdown/place-embed';
import { codeOnly } from '../helpers/code-only';

/**
 * 🔑 焼く所は差す ── ここで見たいのは**どこで・いつ・どの鍵で焼くか**であって、絵ではない
 * (`mermaid-hydrate.test.ts` と同じ手法)。⚠ `cacheKey` は**本物を通す**(鍵に幅が入るかを見るため)。
 */
vi.mock('../../src/adapter/ui/render/mermaid-raster', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/adapter/ui/render/mermaid-raster')>();
  return {
    cacheKey: real.cacheKey,
    renderToPng: vi.fn(async () => ({
      png: new Blob(['png'], { type: 'image/png' }),
      cssWidth: 200,
    })),
    readPalette: () => ({
      bg: '#fff',
      alt: '#eee',
      fg: '#000',
      line: '#666',
      border: '#ccc',
      accent: '#080',
      dark: false,
    }),
  };
});

/**
 * 🔴 **観測器の偽物**(`mermaid-hydrate.test.ts` と同じ手法)。**2 種類を見分ける**:
 *
 * - **板の近さ**(`rootMargin` を持つ ── `PlaceEmbeds` が 1 つだけ作る)。⚠ 既定は**観測を始めた瞬間に
 *   「近い」と答える**(`farLids` に入れた lid の塊だけ「遠い」)。`manualNear` なら**勝手に答えない**
 *   (近さを手で動かす / 「答えが来る前」を見る)
 * - **図の「見えたとき」**(`watchVisible` ── 引数が callback だけ)。手で起こす(`seen`)
 *
 * ⚠ happy-dom 本物の `IntersectionObserver` は**何も通知しない** ── そのままだと板の枠が 1 つも
 *   「近い」にならず、中身を出す test が全部空振りする。
 */
const seen = new Map<Element, (el: Element) => void>();
const farLids = new Set<string>();
let manualNear = false;
interface FakeEntry {
  target: Element;
  isIntersecting: boolean;
}
class FakeIO {
  static place: FakeIO[] = [];
  readonly observed = new Set<Element>();
  disconnected = false;
  constructor(
    readonly cb: (e: FakeEntry[]) => void,
    readonly opts?: { root?: Element | null; rootMargin?: string },
  ) {
    if (opts?.rootMargin !== undefined) FakeIO.place.push(this);
  }
  observe(el: Element): void {
    this.observed.add(el);
    if (this.opts?.rootMargin === undefined) {
      seen.set(el, (t) => this.cb([{ target: t, isIntersecting: true }]));
      return;
    }
    if (manualNear) return;
    const lid = el.getAttribute('data-pkc-place-entry') ?? '';
    queueMicrotask(() => {
      if (!this.disconnected && this.observed.has(el)) this.cb([{ target: el, isIntersecting: !farLids.has(lid) }]);
    });
  }
  unobserve(el: Element): void {
    this.observed.delete(el);
  }
  disconnect(): void {
    this.disconnected = true;
    this.observed.clear();
  }
}
beforeEach(() => {
  seen.clear();
  farLids.clear();
  manualNear = false;
  FakeIO.place = [];
  vi.stubGlobal('IntersectionObserver', FakeIO);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────── 規則(features)

describe('切り出し(excerptOf)', () => {
  it('🔑 定数を pin する(暫定の量・既定の大きさ・持つ数。動かすときは理由を書いて直す)', () => {
    // ⚠ 4000 は**測った値ではない**(W3-③ で測って決める)── 勝手に動かさないための pin
    expect(PLACE_BODY_CLIP).toBe(4000);
    expect([PLACE_ENTRY_DEFAULT_W, PLACE_ENTRY_DEFAULT_H]).toEqual([320, 240]);
    expect(PLACE_BODY_CAP).toBe(40);
  });

  it('量以内ならそのまま・切ったと言わない', () => {
    expect(excerptOf('短い本文\n')).toEqual({ text: '短い本文\n', cut: false });
    const exact = 'a'.repeat(PLACE_BODY_CLIP);
    expect(excerptOf(exact)).toEqual({ text: exact, cut: false });
  });

  it('🔴 量を 1 字でも超えたら切って、切ったと言う', () => {
    const r = excerptOf('a'.repeat(PLACE_BODY_CLIP + 1));
    expect(r.cut).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(PLACE_BODY_CLIP);
  });

  it('切り口は直前の改行(行を途中で割らない)', () => {
    const line = '1234567890'.repeat(9) + '\n'; // 91 字
    const body = line.repeat(60); // 5460 字
    const r = excerptOf(body);
    expect(r.cut).toBe(true);
    expect(r.text.endsWith('1234567890'), '行の途中で切れている').toBe(true);
    expect(r.text.split('\n').every((l) => l.length === 90 || l === '')).toBe(true);
  });

  it('改行が無い長い 1 行は字数で切り、絵文字(サロゲートペア)を割らない', () => {
    const body = 'あ'.repeat(PLACE_BODY_CLIP - 1) + '😀' + 'い'.repeat(100);
    const r = excerptOf(body);
    expect(r.cut).toBe(true);
    const last = r.text.charCodeAt(r.text.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff, '上位サロゲートで終わっている').toBe(false);
  });

  it('frontmatter は描かない(本文の面と同じ切り方)', () => {
    const r = excerptOf('---\ntitle: x\n---\n本文');
    expect(r.text).not.toContain('title: x');
    expect(r.text).toContain('本文');
  });

  it('読んでよい型:フォルダだけが帯だけ(添付は読む ── 絵を出せるかは読んだ後に分かる)', () => {
    expect(placeEmbeddable('text')).toBe(true);
    expect(placeEmbeddable('todo')).toBe(true);
    expect(placeEmbeddable('folder')).toBe(false);
    expect(placeEmbeddable('attachment')).toBe(true);
  });

  /**
   * 🔴 **添付ノートの抜粋**(W3-②)。⚠ 絵を出せるのは画像と PDF だけ ── Office・zip・その他は
   * `att` が付かない(= 題名の帯だけ。W3-① のまま)。説明文(本文)は出さない。
   */
  describe('添付ノート(excerptOf / placeFramed)', () => {
    const att = (mime: string, key: string | null = 'k1'): string =>
      key === null
        ? '---\nattachment.name: x\nattachment.mime: ' + mime + '\n---\n説明文'
        : attachmentBody({ name: 'x', mime, size: 3, assetKey: key }) + '\n説明文';

    it('画像は絵、PDF は字、それ以外は何も付かない', () => {
      expect(excerptOf(att('image/png'), 'attachment').att).toEqual({ key: 'k1', mime: 'image/png', kind: 'image' });
      expect(excerptOf(att('image/svg+xml'), 'attachment').att?.kind).toBe('image');
      expect(excerptOf(att('application/pdf'), 'attachment').att?.kind).toBe('pdf');
      for (const mime of [
        'application/zip',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain',
        'video/mp4',
        'audio/mpeg',
      ])
        expect(excerptOf(att(mime), 'attachment').att, `${mime} に絵が付いた`).toBeUndefined();
    });

    it('⚠ 中身(asset_key)が無い添付 / 添付でない型には付かない / 説明文は出さない', () => {
      expect(excerptOf(att('image/png', null), 'attachment').att, 'asset_key が無いのに絵が付いた').toBeUndefined();
      // 添付でない型の本文に、たまたま同じ frontmatter が書かれていても絵にしない
      expect(excerptOf(att('image/png'), 'text').att).toBeUndefined();
      expect(excerptOf(att('image/png')).att).toBeUndefined();
      expect(excerptOf(att('image/png'), 'attachment').text, '説明文が出ている').toBe('');
    });

    it('既定の大きさを当てるのは「画像の添付」だけ(読む前は当てない)', () => {
      const img = excerptOf(att('image/png'), 'attachment');
      const pdf = excerptOf(att('application/pdf'), 'attachment');
      expect(placeFramed('attachment', img)).toBe(true);
      expect(placeFramed('attachment', pdf), 'PDF に既定の大きさが当たっている').toBe(false);
      expect(placeFramed('attachment', excerptOf(att('application/zip'), 'attachment'))).toBe(false);
      expect(placeFramed('attachment', undefined), '読む前に当たっている').toBe(false);
      expect(placeFramed('text', undefined)).toBe(true);
      expect(placeFramed('folder', undefined)).toBe(false);
    });

    it('🔑 指紋:絵の鍵・種類が変われば別物、同じなら同じ', () => {
      const a = excerptOf(att('image/png', 'k1'), 'attachment');
      expect(sameExcerpt(a, excerptOf(att('image/png', 'k1'), 'attachment'))).toBe(true);
      expect(sameExcerpt(a, excerptOf(att('image/png', 'k2'), 'attachment')), '鍵が違うのに同じ').toBe(false);
      expect(sameExcerpt(a, excerptOf(att('application/pdf', 'k1'), 'attachment')), '種類が違うのに同じ').toBe(false);
      expect(sameExcerpt(a, excerptOf(att('application/zip', 'k1'), 'attachment')), '絵が消えたのに同じ').toBe(false);
    });
  });
});

// ─────────────────────────── 状態(reducer / 効果層)

function meta(lid: string, archetype = 'text', title = `ノート ${lid}`): EntryMeta {
  return {
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
  };
}

function booted(metas: EntryMeta[]): AppState {
  return reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] }).state;
}

const requests = (events: readonly DomainEvent[]): string[] =>
  events.filter((e) => e.type === 'REQUEST_PLACE_BODY').map((e) => (e as { lid: string }).lid);

describe('state: 板のための本文', () => {
  const s0 = booted([meta('n1'), meta('f1', 'folder'), meta('a1', 'attachment')]);

  it('🔴 持っていない物だけ読みに行く / 居ない・フォルダは読まない(添付は読む ── 絵を出せるかは本文に在る)', () => {
    const r = reduce(s0, { type: 'PLACE_BODIES_WANTED', lids: ['n1', 'f1', 'a1', 'ghost', 'n1'] });
    expect(requests(r.events), '2 件(重複なし)だけ頼むはず').toEqual(['n1', 'a1']);
    const loaded = reduce(s0, { type: 'PLACE_BODY_LOADED', lid: 'n1', body: '本文' }).state;
    const again = reduce(loaded, { type: 'PLACE_BODIES_WANTED', lids: ['n1'] });
    expect(requests(again.events), '持っているのに読み直している').toEqual([]);
  });

  it('🔴 添付が届いたら、型(entryMetas)から絵を出せるかを引いて持つ(説明文は持たない)', () => {
    const body = attachmentBody({ name: 'a.png', mime: 'image/png', size: 3, assetKey: 'key1' }) + '\n説明';
    const s = reduce(s0, { type: 'PLACE_BODY_LOADED', lid: 'a1', body }).state;
    const ex = placeBodiesOf(s).get('a1')!;
    expect(ex.att, '画像の添付に絵が付いていない').toEqual({ key: 'key1', mime: 'image/png', kind: 'image' });
    expect(ex.text, '説明文が state に居座っている').toBe('');
    // 🔑 対照群 ── 同じ本文でも、型が添付でないノートは絵にならない(型は entryMetas から引く)
    const s2 = reduce(s0, { type: 'PLACE_BODY_LOADED', lid: 'n1', body }).state;
    expect(placeBodiesOf(s2).get('n1')!.att).toBeUndefined();
  });

  it('🔴 添付を差し替えたら(書込の口)、絵の鍵が追随する', () => {
    const mk = (key: string): string => attachmentBody({ name: 'a.png', mime: 'image/png', size: 3, assetKey: key });
    const loaded = reduce(s0, { type: 'PLACE_BODY_LOADED', lid: 'a1', body: mk('old') }).state;
    const s = reduce(loaded, { type: 'REMOTE_BODY_CHANGED', lid: 'a1', body: mk('new') }).state;
    expect(placeBodiesOf(s).get('a1')!.att?.key, '差し替えた添付に追随していない').toBe('new');
  });

  it('🔴 届いた本文は切って持つ(全文を持たない)', () => {
    const long = 'x'.repeat(PLACE_BODY_CLIP * 3);
    const s = reduce(s0, { type: 'PLACE_BODY_LOADED', lid: 'n1', body: long }).state;
    const ex = placeBodiesOf(s).get('n1')!;
    expect(ex.cut).toBe(true);
    expect(ex.text.length, '全文が state に居座っている').toBeLessThanOrEqual(PLACE_BODY_CLIP);
  });

  it('⚠ 持つ数に上限がある(古い物から手放す)', () => {
    let s = s0;
    for (let i = 0; i < PLACE_BODY_CAP + 5; i += 1)
      s = reduce(s, { type: 'PLACE_BODY_LOADED', lid: `k${String(i)}`, body: 'b' }).state;
    const have = placeBodiesOf(s);
    expect(have.size).toBe(PLACE_BODY_CAP);
    expect(have.has('k0'), '最古が残っている').toBe(false);
    expect(have.has(`k${String(PLACE_BODY_CAP + 4)}`), '最新が無い').toBe(true);
  });

  it('同じ内容が届き直しても state を差し替えない(指紋を動かさない)', () => {
    const s1 = reduce(s0, { type: 'PLACE_BODY_LOADED', lid: 'n1', body: '同じ' }).state;
    const s2 = reduce(s1, { type: 'PLACE_BODY_LOADED', lid: 'n1', body: '同じ' }).state;
    expect(s2).toBe(s1);
  });

  /**
   * 🔴 **書込に追随する口は、横に留めた枠と同じ全部**(§7)。
   * ⚠ 口を 1 つ選んで見ると、片方だけ直す変異が生き延びる ── 4 つの口を別々に撃つ。
   */
  describe('書込への追随', () => {
    const loaded = reduce(s0, { type: 'PLACE_BODY_LOADED', lid: 'n1', body: '古' }).state;
    const textOf = (s: AppState): string | undefined => placeBodiesOf(s).get('n1')?.text;

    it('🔴 BODY_REWRITTEN(チェック・升・日付)', () => {
      const s = reduce(loaded, {
        type: 'BODY_REWRITTEN',
        lid: 'n1',
        body: '新',
        rewrite: { kind: 'task' } as never,
        status: null,
        date: null,
        archived: false,
      } as never).state;
      expect(textOf(s)).toBe('新');
    });
    it('🔴 BODY_PERSISTED(保存の ack)', () => {
      expect(textOf(reduce(loaded, { type: 'BODY_PERSISTED', lid: 'n1', body: '新' }).state)).toBe('新');
    });
    it('🔴 REMOTE_BODY_CHANGED(別の窓が書いた)', () => {
      expect(textOf(reduce(loaded, { type: 'REMOTE_BODY_CHANGED', lid: 'n1', body: '新' }).state)).toBe(
        '新',
      );
    });
    it('🔴 ENTRY_APPENDED(追記)', () => {
      const s = reduce(loaded, {
        type: 'ENTRY_APPENDED',
        gen: 0,
        lid: 'n1',
        body: '古\n新',
        status: null,
        date: null,
        archived: false,
        inserted: ['新'],
      } as never).state;
      expect(textOf(s)).toBe('古\n新');
    });
    it('⚠ 対照群:板に置いていないノートの書込では、入れ物を作り直さない / 作らない', () => {
      const s = reduce(loaded, { type: 'BODY_PERSISTED', lid: 'n9', body: 'よそ' }).state;
      expect(placeBodiesOf(s)).toBe(placeBodiesOf(loaded));
      expect(placeBodiesOf(s).has('n9')).toBe(false);
    });
    it('🔴 切った本文は書込の元にならない:`screenBodyOf` が見る入れ物に混ざらない', () => {
      expect(loaded.splitBodies.has('n1')).toBe(false);
      expect(loaded.openBody).toBeNull();
    });
  });

  it('🔑 書込に追随する口は 1 本(`syncSplitBody` を直に呼ぶ所が残っていない)', () => {
    // ⚠ 呼び口を 2 本に割ると、片方だけ古いまま映す(#757 / #684 ㋑ で 2 度踏んだ形)
    const src = codeOnly(readFileSync('src/adapter/state/app-state.ts', 'utf8'));
    const calls = src.match(/syncSplitBody\(/g) ?? [];
    // 定義 1 + `syncShownBodies` の中の呼び 1
    expect(calls.length).toBe(2);
    expect((src.match(/syncShownBodies\(/g) ?? []).length, '追随の口の数が減っている').toBeGreaterThanOrEqual(10);
  });
});

describe('効果層: 板のための本文を読む(実物の配線)', () => {
  function wired(getBody: (lid: string) => Promise<string | null>): { d: Dispatcher; off: () => void } {
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')] as never, relations: [] });
    const off = connectStoreEffects(d, { getBody } as unknown as StorePort);
    return { d, off };
  }

  it('🔴 頼むと全文を読み、切って持つ', async () => {
    const { d, off } = wired(() => Promise.resolve('y'.repeat(PLACE_BODY_CLIP + 10)));
    try {
      d.dispatch({ type: 'PLACE_BODIES_WANTED', lids: ['n1'] });
      for (let i = 0; i < 10 && !placeBodiesOf(d.getState()).has('n1'); i += 1) await Promise.resolve();
      const ex = placeBodiesOf(d.getState()).get('n1');
      expect(ex, '読んだ本文が届いていない').toBeDefined();
      expect(ex!.cut).toBe(true);
    } finally {
      off();
    }
  });

  it('⚠ 読めなかった(本文 null / 例外)ときは、黙って持たない', async () => {
    for (const getBody of [
      () => Promise.resolve(null),
      () => Promise.reject(new Error('x')),
    ]) {
      const { d, off } = wired(getBody);
      try {
        d.dispatch({ type: 'PLACE_BODIES_WANTED', lids: ['n1'] });
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
        expect(placeBodiesOf(d.getState()).has('n1')).toBe(false);
        expect(d.getState().phase, '補助の読みの失敗で面が落ちている').toBe('ready');
      } finally {
        off();
      }
    }
  });
});

// ─────────────────────────── 描画(実物の DetailRenderer + 実物の reducer)

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 板のノート(`b`)。置いたノートを `n1`〜`n6` で指す。 */
const BOARD = [
  ':::format{#p1 .pkc-place entry=n1 x=0 y=0 w=400 h=300}',
  ':::',
  '',
  ':::format{#p2 .pkc-place entry=n2 x=420 y=700}',
  ':::',
  '',
  ':::format{#p3 .pkc-place entry=ghost x=0 y=320}',
  ':::',
  '',
  ':::format{#p4 .pkc-place entry=f1 x=420 y=320}',
  ':::',
  '',
  ':::format{#p5 .pkc-place entry=b x=0 y=640}',
  ':::',
  '',
  '- [ ] 板のノート自身のチェック',
].join('\n');

const BODIES: Record<string, string> = {
  n1: [
    '# 買い出し',
    '',
    '牛乳を買う。',
    '',
    '- [ ] 牛乳',
    '- [x] 卵',
    '',
    '| 品 | 数 |',
    '|---|---|',
    '| 牛乳 | 2 |',
    '',
    ':::format{.pkc-place entry=n3 x=10 y=10 w=100 h=50}',
    ':::',
  ].join('\n'),
  n2: '短いノート',
  n3: '入れ子の先の本文(これは出てはいけない)',
  f1: '',
  b: BOARD,
};

interface Rig {
  root: HTMLElement;
  wanted: string[];
  state: () => AppState;
  /** 板が頼んだ本文を、実物の reducer を通して届けるまで繰り返す。 */
  pump: () => Promise<void>;
  apply: (action: Parameters<typeof reduce>[1]) => Promise<void>;
  /** 状態を変えずに描き直させる(同じ本文の描き直し)。 */
  again: () => Promise<void>;
  host: () => HTMLElement;
  /** 板のノートが別のノートへ移るまでを辿る(面を捨てる = 寿命の終端)。 */
  leave: () => Promise<void>;
}

async function rig(
  bodies: Record<string, string> = BODIES,
  metas: EntryMeta[] = [
    meta('b', 'text', '板'),
    meta('n1', 'text', '買い出し帳'),
    meta('n2', 'text', '短いノート帳'),
    meta('n3', 'text', '入れ子の先'),
    meta('f1', 'folder', 'フォルダ'),
  ],
  /** `false` = 頼んだ本文を届けない(「まだ読めていない間」の形を見る)。 */
  deliver = true,
  /** 添付(画像)を借りる口。`null` = 添付の置き場が無い。 */
  lender: AssetLender | null = null,
): Promise<Rig> {
  const root = document.createElement('div');
  document.body.append(root);
  const wanted: string[] = [];
  const detail = new DetailRenderer(
    buildShell(root).detail,
    lender,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    null,
    null,
    (lids) => wanted.push(...lids),
  );
  let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'b' }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: 'b', body: bodies.b ?? '' }).state;
  const r: Rig = {
    root,
    wanted,
    state: () => s,
    host: () => root.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!,
    async apply(action) {
      s = reduce(s, action).state;
      detail.render(s);
      await settle();
    },
    async again() {
      detail.render(s);
      await settle();
    },
    async leave() {
      // ⚠ 行き先は図も画像も持たないノート(`n3`)── 行き先が借りる分が数に混ざらない
      s = reduce(s, { type: 'SELECT_ENTRY', lid: 'n3' }).state;
      s = reduce(s, { type: 'BODY_LOADED', lid: 'n3', body: bodies.n3 ?? '' }).state;
      detail.render(s);
      await settle();
    },
    async pump() {
      detail.render(s);
      await settle();
      for (let round = 0; round < 5 && wanted.length > 0; round += 1) {
        const lids = wanted.splice(0);
        const asked = reduce(s, { type: 'PLACE_BODIES_WANTED', lids });
        for (const lid of requests(asked.events)) {
          s = reduce(s, { type: 'PLACE_BODY_LOADED', lid, body: bodies[lid] ?? '' }).state;
        }
        detail.render(s);
        await settle();
        await settle();
      }
    },
  };
  if (deliver) await r.pump();
  else await r.again();
  return r;
}

const block = (r: Rig, id: string): HTMLElement => r.host().querySelector<HTMLElement>(`#${id}`)!;
const slotOf = (r: Rig, id: string): HTMLElement | null =>
  block(r, id).querySelector<HTMLElement>(':scope > [data-pkc-field="place-body"]');

describe('描画: 題名の帯 + 置いたノートの中身', () => {
  it('🔴 帯の下に、本文(見出し・文・表・チェック)が出る', async () => {
    const r = await rig();
    const card = block(r, 'p1').querySelector<HTMLElement>(':scope > [data-pkc-field="place-card"]')!;
    expect(card.textContent).toBe('買い出し帳');
    expect(card.getAttribute('data-pkc-action'), '帯の押し先が今までどおりでない').toBe('select-entry');
    const slot = slotOf(r, 'p1')!;
    expect(slot, '本文の器が無い').not.toBeNull();
    // 🔑 帯の直後に在る(帯 → 本文の順)
    expect(card.nextElementSibling).toBe(slot);
    expect(slot.textContent).toContain('牛乳を買う。');
    expect(slot.querySelector('table'), '表が出ていない').not.toBeNull();
    expect(slot.querySelectorAll('input[type="checkbox"]'), 'チェックが出ていない').toHaveLength(2);
    expect(slot.textContent).toContain('買い出し'); // 見出し(行になっている)
  });

  it('🔴 押せるものが増えていない:チェックは押せず、表のセルは打てない(旗が渡っていない)', async () => {
    const r = await rig();
    // 対照群 ── 板のノート自身のチェックは、押せる形で描かれている(この台が旗を立てていること)
    expect(
      r.host().querySelectorAll('[data-pkc-action="toggle-task"]').length,
      '台の前提:板のノート自身のチェックが押せる形になっていない',
    ).toBeGreaterThan(0);
    const slot = slotOf(r, 'p1')!;
    expect(slot.querySelector('[data-pkc-action="toggle-task"]'), '置いたノートのチェックが押せる').toBeNull();
    expect(slot.querySelector('[data-pkc-action="edit-cell"]'), '置いたノートの表が打てる').toBeNull();
    for (const cb of slot.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      expect(cb.disabled, 'チェックが無効になっていない').toBe(true);
    // 行番号が焼かれていない(右クリックや目次が板のノートの行と取り違えない)
    expect(slot.querySelector('[data-pkc-source-line]')).toBeNull();
    expect(slot.querySelector('[data-pkc-task-line]')).toBeNull();
    // 押し口は「元のノートへ飛ぶ」だけ
    for (const el of slot.querySelectorAll('[data-pkc-action]'))
      expect(['select-entry', 'navigate-entry-ref']).toContain(el.getAttribute('data-pkc-action'));
  });

  it('🔴 見出しは見出しでなく、id は枠の接頭辞つき(板のノートの目次・ジャンプと衝突しない)', async () => {
    const r = await rig();
    const slot = slotOf(r, 'p1')!;
    expect(slot.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    const row = slot.querySelector<HTMLElement>('[data-pkc-embedded-heading="1"]')!;
    expect(row.textContent).toBe('買い出し');
    // 🔑 id は残るが、枠の接頭辞つき(素の `買い出し` は無い)
    const ns = slot.getAttribute('data-pkc-place-ns')!;
    expect(ns, '枠が接頭辞を持っていない').toMatch(/^place-\d+-$/);
    expect(row.id).toBe(`${ns}買い出し`);
    for (const el of slot.querySelectorAll('[id]')) expect(el.id.startsWith(ns), `素の id: ${el.id}`).toBe(true);
    // ⚠ 板のノートの目次(`h1[id]`)が、置いたノートの見出しを拾っていない
    expect(r.host().querySelector('[data-pkc-field="place-body"] h1[id]')).toBeNull();
  });

  it('🔴 入れ子の板は展開しない(中の「置いたノート」は題名だけの行)', async () => {
    const r = await rig();
    const slot = slotOf(r, 'p1')!;
    // ⚠ 空振り防止:n1 の本文には入れ子の板が実際に在る
    expect(BODIES.n1).toContain('.pkc-place entry=n3');
    expect(slot.querySelector('.pkc-place'), '入れ子の板が展開されている').toBeNull();
    const link = slot.querySelector<HTMLElement>('[data-pkc-field="place-body-link"]')!;
    expect(link.textContent).toBe('入れ子の先');
    expect(link.getAttribute('data-pkc-action')).toBe('select-entry');
    expect(link.getAttribute('data-pkc-entry')).toBe('n3');
    expect(r.host().textContent, '入れ子の先の本文が出ている').not.toContain('これは出てはいけない');
    expect(r.wanted, '入れ子の先の本文まで頼んでいる').not.toContain('n3');
    expect(placeBodiesOf(r.state()).has('n3')).toBe(false);
  });

  it('🔴 w= h= で固定 / 省略時は既定の大きさ(中身では伸びない)', async () => {
    const r = await rig();
    const p1 = block(r, 'p1');
    expect([p1.style.width, p1.style.height]).toEqual(['400px', '300px']);
    const p2 = block(r, 'p2');
    expect(p2.style.width).toBe(`${String(PLACE_ENTRY_DEFAULT_W)}px`);
    expect(p2.style.height).toBe(`${String(PLACE_ENTRY_DEFAULT_H)}px`);
    // 🔑 板の高さは既定の高さで見積もる(いちばん下 = p2 の 700 + 既定 240、+ 余白 40)
    expect(r.host().style.minHeight).toBe(`${String(700 + PLACE_ENTRY_DEFAULT_H + 40)}px`);
  });

  it('🔴 消えたノート・自分自身・フォルダは中身を出さない(帯だけ。大きさも変えない)', async () => {
    const r = await rig();
    expect(block(r, 'p3').querySelector('[data-pkc-field="place-card"]')!.textContent).toBe('(見つかりません)');
    for (const id of ['p3', 'p4', 'p5']) {
      expect(slotOf(r, id), `${id} に本文の器が在る`).toBeNull();
      expect(block(r, id).hasAttribute('data-pkc-place-embedded')).toBe(false);
      expect(block(r, id).style.height, `${id} に既定の高さが当たっている`).toBe('');
    }
    expect(r.wanted).toEqual([]);
    expect(placeBodiesOf(r.state()).has('ghost')).toBe(false);
    expect(placeBodiesOf(r.state()).has('f1')).toBe(false);
    expect(placeBodiesOf(r.state()).has('b'), '自分自身の本文を読んでいる').toBe(false);
  });
});

describe('描画: まだ読めていない間', () => {
  it('🔑 本文が届く前に何度描き直しても、同じ lid を 2 度頼まない(頼むのは中身を出す塊の相手だけ)', async () => {
    const r = await rig(BODIES, undefined, false);
    expect([...r.wanted].sort(), '台の前提:中身を出す相手(n1 / n2)だけが頼まれていない').toEqual(['n1', 'n2']);
    // ⚠ 同じ state の `render` は指紋で止まり、板の器まで来ない ── **別の物の抜粋が届いた**回で
    //   板の器を当て直させる(n1 / n2 はまだ届いていない = 頼み直しうる場面)
    await r.apply({ type: 'PLACE_BODY_LOADED', lid: 'n3', body: 'あ' });
    await r.apply({ type: 'PLACE_BODY_LOADED', lid: 'n3', body: 'い' });
    // 🔑 空振り防止:その回に器の当て直しが実際に走っている(n3 は板に居ないので何も出ない)
    expect(placeBodiesOf(r.state()).get('n3')?.text, '台の前提:抜粋が届いていない').toBe('い');
    expect([...r.wanted].sort(), '描き直すたびに頼み直している').toEqual(['n1', 'n2']);
    // 届くまでは帯だけ(本文の器は出さない)
    expect(slotOf(r, 'p1')).toBeNull();
    expect(block(r, 'p1').querySelector('[data-pkc-field="place-card"]')!.textContent).toBe('買い出し帳');
  });
});

describe('描画: 長い本文は「続きは元のノートで」', () => {
  it('🔴 量を超えたときだけ、末尾に押せる「続きは元のノートで」が出る', async () => {
    const long = '# 長い\n\n' + Array.from({ length: 400 }, (_, i) => `行 ${String(i)} です。`).join('\n\n');
    expect(long.length, '台の前提:量を超えていない').toBeGreaterThan(PLACE_BODY_CLIP);
    const r = await rig({ ...BODIES, n1: long });
    const more = slotOf(r, 'p1')!.querySelector<HTMLElement>('[data-pkc-field="place-body-more"]');
    expect(more, '切ったのに「続きは…」が無い').not.toBeNull();
    expect(more!.textContent).toBe('続きは元のノートで');
    expect(more!.getAttribute('data-pkc-action')).toBe('select-entry');
    expect(more!.getAttribute('data-pkc-entry')).toBe('n1');
    expect(slotOf(r, 'p1')!.textContent, '切るはずの最後の行まで出ている').not.toContain('行 399 です');
    // 対照群 ── 短いノートには出ない
    expect(slotOf(r, 'p2')!.querySelector('[data-pkc-field="place-body-more"]')).toBeNull();
  });
});

describe('描画: 元のノートの書込に追随する', () => {
  it('🔴 置いたノートを直すと板の中身が変わり、板のノート自身は描き直されない', async () => {
    const r = await rig();
    const p2 = block(r, 'p2');
    expect(slotOf(r, 'p2')!.textContent).toContain('短いノート');
    await r.apply({
      type: 'BODY_PERSISTED',
      lid: 'n2',
      body: '直したあとの本文',
    });
    await settle();
    expect(slotOf(r, 'p2')!.textContent, '板が古いまま').toContain('直したあとの本文');
    expect(block(r, 'p2'), '抜粋が変わっただけで板のノートの本文を描き直している').toBe(p2);
    // 対照群 ── 板に置いていないノートが直っても、他の板の中身は動かない
    const before = slotOf(r, 'p1')!;
    await r.apply({ type: 'BODY_PERSISTED', lid: 'n9', body: 'よそ' });
    expect(slotOf(r, 'p1')).toBe(before);
  });

  it('🔑 描き直し(同じ本文)を何度繰り返しても、器は 1 つ・頼み直さない', async () => {
    const r = await rig();
    for (let i = 0; i < 3; i += 1) await r.again();
    expect(r.host().querySelectorAll('[data-pkc-field="place-body"]')).toHaveLength(2);
    expect(r.wanted).toEqual([]);
  });
});

/** 添付(画像)を借りる口の偽物。⚠ 「借りた数」「返した数」を数える(生きている数 = 差)。 */
function fakeLender(): { lender: AssetLender; live: () => number; lent: string[] } {
  const live = new Set<number>();
  const lent: string[] = [];
  let seq = 0;
  const lender: AssetLender = {
    lend: (key) => {
      seq += 1;
      const id = seq;
      live.add(id);
      lent.push(key);
      return Promise.resolve({ url: `blob:fake/${key}/${String(id)}`, dispose: () => void live.delete(id) });
    },
    getBlob: () => Promise.resolve(null),
  };
  return { lender, live: () => live.size, lent };
}

describe('描画: 図と画像と添付ノート(W3-②)', () => {
  let made = 0;
  let revoked = 0;
  beforeEach(() => {
    made = 0;
    revoked = 0;
    vi.mocked(renderToPng).mockClear();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    // ⚠ 先読み(空き時間に 1 枚ずつ焼く)は止める ── 「見えたときに描く」を単独で見る
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:png/${String((made += 1))}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      revoked += 1;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const MERMAID = '```mermaid\ngraph TD; A-->B\n```';
  const hostsIn = (slot: HTMLElement): HTMLElement[] =>
    [...slot.querySelectorAll<HTMLElement>('[data-pkc-mermaid-src]')];

  it('🔴 図は枠の中に残り、見えたときに焼かれて PNG の <img> 1 枚になる(押せる物は増えない)', async () => {
    const r = await rig({ ...BODIES, n1: `前の文\n\n${MERMAID}\n\n後ろの文` });
    const slot = slotOf(r, 'p1')!;
    const hosts = hostsIn(slot);
    expect(hosts, '図の器が枠の中に無い(囲みごと 1 行へ降ろしていないか)').toHaveLength(1);
    expect(slot.textContent).toContain('前の文');
    expect(slot.textContent).toContain('後ろの文');
    // 🔑 見えたときに描く:観測を始めただけで、焼いてはいない
    expect(seen.has(hosts[0]!), '図が「見えたとき」の観測に乗っていない').toBe(true);
    expect(renderToPng, '見えていないのに焼いている').not.toHaveBeenCalled();
    seen.get(hosts[0]!)!(hosts[0]!);
    await settle();
    expect(renderToPng).toHaveBeenCalledTimes(1);
    const img = hosts[0]!.querySelector<HTMLImageElement>('img[data-pkc-field="mermaid-image"]');
    expect(img, '焼いた PNG が枠の中の図に入っていない').not.toBeNull();
    expect(slot.contains(img)).toBe(true);
    expect(made, 'PNG の URL を 1 本だけ作るはず').toBe(1);
    // 🔴 板のノート自身は図を持たない ── 焼かれたのは置いたノートの図だけ(別の面に漏れていない)
    expect(r.host().querySelectorAll('img[data-pkc-field="mermaid-image"]')).toHaveLength(1);
  });

  it('🔴 焼く鍵に「枠の幅」が入る(板の枠は狭いので、読む面とは別の絵を焼く)', async () => {
    const r = await rig({ ...BODIES, n1: MERMAID });
    const host = hostsIn(slotOf(r, 'p1')!)[0]!;
    // 器の親(= 描画の囲み)が枠の幅を知っている ── happy-dom は版面を持たないので値を決める
    Object.defineProperty(host.parentElement!, 'clientWidth', { value: 300, configurable: true });
    seen.get(host)!(host);
    await settle();
    const key = vi.mocked(renderToPng).mock.calls[0]![0];
    // 16px 刻みに丸める(300 → 304)。⚠ 読む面の既定(640)ではない
    expect(key.width, '枠の幅で焼いていない').toBe(304);
    expect(cacheKey(key), '幅が鍵に入っていない(読む面の絵と取り違える)').not.toBe(
      cacheKey({ ...key, width: 640 }),
    );
  });

  it('🔴 枠が画面から外れる(別のノートへ移る)と、図の URL を返す', async () => {
    const r = await rig({ ...BODIES, n1: MERMAID });
    const host = hostsIn(slotOf(r, 'p1')!)[0]!;
    seen.get(host)!(host);
    await settle();
    expect(made).toBe(1);
    expect(revoked, '焼いただけで返していない').toBe(0);
    await r.leave();
    expect(revoked, '面を捨てても PNG の URL が生きている').toBe(1);
  });

  it('🔴 板のノートの編集に入ると(読む面を捨てる)、板の中の図の URL・画像の貸出も返る', async () => {
    const f = fakeLender();
    const r = await rig({ ...BODIES, n1: `![写真](asset:abc)\n\n${MERMAID}` }, undefined, true, f.lender);
    await settle();
    const host = hostsIn(slotOf(r, 'p1')!)[0]!;
    seen.get(host)!(host);
    await settle();
    expect(made, '台の前提:図が焼かれていない').toBe(1);
    expect(f.live(), '台の前提:画像が借りられていない').toBe(1);
    await r.apply({ type: 'START_EDIT' });
    expect(r.state().phase, '台の前提:編集に入っていない').toBe('editing');
    expect(f.live(), '編集に入っても板の画像の貸出が残っている').toBe(0);
    expect(revoked, '編集に入っても板の図の URL が残っている').toBe(1);
  });

  it('🔴 板から枠を消す(本文の板を削る)と、その枠の図の URL も返る / 残した枠のは生きている', async () => {
    const two = [
      ':::format{#p1 .pkc-place entry=n1 x=0 y=0}',
      ':::',
      '',
      ':::format{#p2 .pkc-place entry=n2 x=420 y=0}',
      ':::',
    ].join('\n');
    const r = await rig({ ...BODIES, b: two, n1: MERMAID, n2: MERMAID });
    for (const id of ['p1', 'p2']) {
      const h = hostsIn(slotOf(r, id)!)[0]!;
      seen.get(h)!(h);
    }
    await settle();
    expect(made, '2 枚の枠でそれぞれ焼くはず').toBe(2);
    // 🔑 p2 の行を動かさない(動くと p2 の塊そのものが作り直され、「残した枠」の対照にならない)
    const one = two.replace('entry=n1 ', '');
    await r.apply({ type: 'BODY_LOADED', lid: 'b', body: one });
    await r.apply({ type: 'BODY_PERSISTED', lid: 'n9', body: 'よそ' });
    expect(slotOf(r, 'p1'), '台の前提:p1 の枠が消えていない').toBeNull();
    expect(revoked, '消えた枠の図の URL が生きている').toBe(1);
    expect(r.host().querySelectorAll('img[data-pkc-field="mermaid-image"]'), '残した枠の図まで壊れた').toHaveLength(1);
  });

  it('⚠ 数式の器も残る(1 行に降ろさない)/ 表のセルの数式で表が消えない', async () => {
    const r = await rig({ ...BODIES, n1: '$$x^2$$\n\n| 式 | 値 |\n|---|---|\n| $y$ | 1 |\n' });
    const slot = slotOf(r, 'p1')!;
    expect(slot.querySelectorAll('[data-pkc-math-src]').length, '数式の器が無い').toBeGreaterThan(0);
    expect(slot.querySelector('table'), '数式 1 つで表が消えた').not.toBeNull();
    expect(slot.querySelector('[data-pkc-field="place-body-skip"]'), '数式が 1 行へ降ろされている').toBeNull();
  });

  describe('本文の中の添付画像(貸出と返却)', () => {
    const IMG = '![写真](asset:abc)';
    const BOARD2 = [
      ':::format{#p1 .pkc-place entry=n1 x=0 y=0}',
      ':::',
      '',
      ':::format{#p2 .pkc-place entry=n2 x=420 y=0}',
      ':::',
      '',
      ':::format{#p3 .pkc-place entry=n3 x=0 y=300}',
      ':::',
    ].join('\n');
    const images = { n1: `前\n\n${IMG}`, n2: IMG, n3: '画像なし' };

    it('🔴 画像は枠の数だけ借り、src が差さり、「見つからない」の印は付かない', async () => {
      const f = fakeLender();
      const r = await rig({ ...BODIES, b: BOARD2, ...images }, undefined, true, f.lender);
      await settle();
      expect(f.lent, '画像のある 2 枠が 1 本ずつ借りるはず').toEqual(['abc', 'abc']);
      expect(f.live()).toBe(2);
      for (const id of ['p1', 'p2']) {
        const img = slotOf(r, id)!.querySelector<HTMLImageElement>('img[data-pkc-asset-key]')!;
        expect(img.getAttribute('src'), `${id} の画像に src が差さっていない`).toMatch(/^blob:fake\/abc\//);
        expect(img.hasAttribute('data-pkc-asset-missing')).toBe(false);
      }
      // 対照群 ── 画像を持たない枠は借りない
      expect(slotOf(r, 'p3')!.querySelector('img')).toBeNull();
    });

    it('🔴 枠を消すと、その枠の貸出だけ返る / 面を捨てると全部返る(0)', async () => {
      const f = fakeLender();
      const r = await rig({ ...BODIES, b: BOARD2, ...images }, undefined, true, f.lender);
      await settle();
      expect(f.live()).toBe(2);
      // 🔑 p2・p3 の行を動かさない(動くと塊そのものが作り直され、「残した枠」の対照にならない)
      const one = BOARD2.replace('entry=n1 ', '');
      await r.apply({ type: 'BODY_LOADED', lid: 'b', body: one });
      await r.apply({ type: 'BODY_PERSISTED', lid: 'n9', body: 'よそ' });
      await settle();
      expect(slotOf(r, 'p1'), '台の前提:p1 の枠が消えていない').toBeNull();
      expect(f.live(), '消えた枠の貸出が生きている').toBe(1);
      expect(slotOf(r, 'p2')!.querySelector('img')!.getAttribute('src'), '残した枠の画像まで返した').toMatch(/^blob:fake/);
      await r.leave();
      expect(f.live(), '面を捨てても貸出が残っている').toBe(0);
    });

    it('🔴 枠ごとに別の帳簿 ── 1 枚の描き直しが、別の枠の画像を落とさない', async () => {
      const f = fakeLender();
      const r = await rig({ ...BODIES, b: BOARD2, ...images }, undefined, true, f.lender);
      await settle();
      const keep = slotOf(r, 'p2')!.querySelector('img')!;
      // p1 の置いたノートだけを書き換える(= p1 の枠だけが描き直される)
      await r.apply({ type: 'BODY_PERSISTED', lid: 'n1', body: `直した\n\n${IMG}` });
      await settle();
      expect(slotOf(r, 'p1')!.textContent).toContain('直した');
      expect(slotOf(r, 'p2')!.querySelector('img'), '触っていない枠の画像が作り直された').toBe(keep);
      expect(keep.getAttribute('src'), '触っていない枠の画像の src が死んだ').toMatch(/^blob:fake/);
      expect(slotOf(r, 'p1')!.querySelector('img')!.getAttribute('src')).toMatch(/^blob:fake/);
      // 描き直しで古い画像のぶんが返っている(2 枚 + 1 = 3 本借りて、生きているのは 2 本)
      expect(f.live(), '描き直した枠の古い貸出が返っていない').toBe(2);
    });

    it('⚠ 借りられない画像は「見つからない」の印(黙って空にしない)', async () => {
      const r = await rig({ ...BODIES, b: BOARD2, ...images }, undefined, true, null);
      await settle();
      const img = slotOf(r, 'p1')!.querySelector('img')!;
      expect(img.hasAttribute('data-pkc-asset-missing'), '借りられないのに印が無い').toBe(true);
    });
  });

  describe('添付ノートを置いたとき', () => {
    const ATT = (mime: string, key = 'ak'): string =>
      attachmentBody({ name: 'f', mime, size: 3, assetKey: key }) + '\n説明文';
    const BOARD3 = [
      ':::format{#pi .pkc-place entry=ai x=0 y=0}',
      ':::',
      '',
      ':::format{#pp .pkc-place entry=ap x=420 y=0}',
      ':::',
      '',
      ':::format{#pz .pkc-place entry=az x=0 y=300}',
      ':::',
      '',
      ':::format{#pw .pkc-place entry=aw x=420 y=300 w=300 h=200}',
      ':::',
    ].join('\n');
    const metas = [
      meta('b', 'text', '板'),
      meta('n2', 'text', 'めも'),
      meta('ai', 'attachment', '写真'),
      meta('ap', 'attachment', '書類'),
      meta('az', 'attachment', '圧縮'),
      meta('aw', 'attachment', '資料'),
    ];
    const bodies = {
      b: BOARD3,
      n2: 'めも',
      ai: ATT('image/png', 'img1'),
      ap: ATT('application/pdf', 'pdf1'),
      az: ATT('application/zip', 'zip1'),
      aw: ATT('image/png', 'img2'),
    };

    it('🔴 画像の添付は絵そのもの(借りて src が差さる)/ 説明文は出ない / 既定の大きさが当たる', async () => {
      const f = fakeLender();
      const r = await rig(bodies, metas, true, f.lender);
      await settle();
      const slot = slotOf(r, 'pi')!;
      const img = slot.querySelector<HTMLImageElement>('img[data-pkc-field="place-attachment-image"]')!;
      expect(img, '画像の添付が絵で出ていない').not.toBeNull();
      expect(img.getAttribute('src')).toMatch(/^blob:fake\/img1\//);
      expect(img.alt).toBe('写真');
      expect(slot.getAttribute('data-pkc-place-attachment')).toBe('image');
      expect(slot.textContent, '説明文が出ている').not.toContain('説明文');
      // 読む前は帯だけの大きさだったが、読んだ後に既定の大きさへ置き直されている
      const b = block(r, 'pi');
      expect([b.style.width, b.style.height]).toEqual(['320px', '240px']);
      expect(b.hasAttribute('data-pkc-place-framed')).toBe(true);
      // 🔑 押すと大きく見られる(読む面の絵と同じ口)
      expect(img.getAttribute('data-pkc-action')).toBe('view-big');
      // w= h= を書いた塊は書いた大きさのまま
      expect([block(r, 'pw').style.width, block(r, 'pw').style.height]).toEqual(['300px', '200px']);
    });

    it('🔴 PDF は題名の帯 + 「PDF」の字だけ(絵は借りない / 大きさは帯のまま)', async () => {
      const f = fakeLender();
      const r = await rig(bodies, metas, true, f.lender);
      await settle();
      const slot = slotOf(r, 'pp')!;
      expect(slot.textContent).toBe('PDF は元のノートで');
      expect(slot.querySelector('img, object, iframe'), 'PDF を絵や埋め込みで出している').toBeNull();
      expect(f.lent, 'PDF まで借りている').not.toContain('pdf1');
      expect(block(r, 'pp').style.height, 'PDF に既定の高さが当たっている').toBe('');
      expect(block(r, 'pp').hasAttribute('data-pkc-place-framed')).toBe(false);
    });

    it('🔴 添付を差し替えたら絵も差し替わる(古い貸出は返る / 新しい鍵で借りる)', async () => {
      const f = fakeLender();
      const r = await rig(bodies, metas, true, f.lender);
      await settle();
      expect(f.lent).toEqual(['img1', 'img2']);
      expect(f.live()).toBe(2);
      await r.apply({ type: 'REMOTE_BODY_CHANGED', lid: 'ai', body: ATT('image/png', 'img9') });
      await settle();
      const img = slotOf(r, 'pi')!.querySelector('img')!;
      expect(img.getAttribute('data-pkc-asset-key'), '差し替えた添付の鍵になっていない').toBe('img9');
      expect(f.lent, '新しい鍵で借りていない').toContain('img9');
      expect(f.live(), '差し替え前の貸出が返っていない').toBe(2);
      // 対照群 ── 触っていない添付の枠は作り直されない
      expect(slotOf(r, 'pw')!.querySelector('img')!.getAttribute('data-pkc-asset-key')).toBe('img2');
    });

    it('🔴 Office・zip・その他は題名の帯だけ(W3-① のまま)', async () => {
      const r = await rig(bodies, metas, true, fakeLender().lender);
      await settle();
      expect(slotOf(r, 'pz'), '絵を出せない添付に器がある').toBeNull();
      expect(block(r, 'pz').style.height).toBe('');
      expect(block(r, 'pz').querySelector('[data-pkc-field="place-card"]')!.textContent).toBe('圧縮');
    });

    it('🔴 読む前は帯だけの大きさ、読んだら置き直す(板の高さも追随)', async () => {
      // 🔑 いちばん下の塊が添付なので、板の高さ = y + 高さ + 40 が置き直しで動く
      const low = { ...bodies, b: ':::format{#pi .pkc-place entry=ai x=0 y=700}\n:::\n' };
      const r = await rig(low, metas, false, fakeLender().lender);
      expect(slotOf(r, 'pi'), '読む前に器がある').toBeNull();
      expect(block(r, 'pi').style.height).toBe('');
      expect(r.host().style.minHeight).toBe('900px'); // 帯だけの見積もり 700 + 160 + 40
      await r.pump();
      await settle();
      expect(block(r, 'pi').style.height).toBe('240px');
      expect(r.host().style.minHeight, '置き直しで板の高さが追随していない').toBe('980px');
    });
  });

  describe('同じノートを 2 枚置く(id の衝突)', () => {
    const SAME = [
      ':::format{#p1 .pkc-place entry=n1 x=0 y=0}',
      ':::',
      '',
      ':::format{#p2 .pkc-place entry=n1 x=420 y=0}',
      ':::',
    ].join('\n');
    const NOTE = [':::toc', ':::', '', '# はじめに', '', '文[^1]', '', '## つづき', '', '[^1]: 注'].join('\n');

    it('🔴 どちらの枠にも中身が出て、id は文書の中で 1 つも重複しない', async () => {
      const r = await rig({ ...BODIES, b: SAME, n1: NOTE });
      const s1 = slotOf(r, 'p1')!;
      const s2 = slotOf(r, 'p2')!;
      expect(s1.textContent).toContain('はじめに');
      expect(s2.textContent, '2 枚目に中身が出ていない').toContain('はじめに');
      expect(s1.getAttribute('data-pkc-place-ns')).not.toBe(s2.getAttribute('data-pkc-place-ns'));
      const ids = [...r.host().querySelectorAll('[id]')].map((e) => e.id);
      // ⚠ 空振り防止:id が実際に出ている(見出し 2 枚ぶん)
      expect(ids.filter((i) => i.includes('はじめに')).length, '台の前提:id が出ていない').toBe(2);
      expect(new Set(ids).size, `id が重複している: ${ids.join(' / ')}`).toBe(ids.length);
    });

    it('🔴 目次と脚注のリンクは、同じ枠の中の相手を指す(別の枠・読む面の id へ飛ばない)', async () => {
      const r = await rig({ ...BODIES, b: SAME, n1: NOTE });
      for (const id of ['p1', 'p2']) {
        const slot = slotOf(r, id)!;
        const links = [...slot.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')];
        // 空振り防止:目次(2 件)と脚注(参照と戻り)が実際に在る
        expect(links.length, `${id}:台の前提 ― 文書内リンクが無い`).toBeGreaterThanOrEqual(3);
        for (const a of links) {
          const target = (a.getAttribute('href') ?? '').slice(1);
          const hit = [...r.host().querySelectorAll('[id]')].filter((e) => e.id === target);
          expect(hit, `${id}:${target} の行き先が 1 つに決まらない`).toHaveLength(1);
          expect(slot.contains(hit[0]!), `${id}:${target} が別の枠を指している`).toBe(true);
        }
      }
    });
  });
});

describe('掃除(sanitizeEmbedded)', () => {
  function box(html: string): HTMLElement {
    const b = document.createElement('div');
    b.innerHTML = html;
    return b;
  }

  it('見出し・id・コピーの帯・切替・押し口の掃除(1 つずつ)', () => {
    const b = box(
      '<h2 id="x">章</h2><div class="pkc-md-block"><button class="pkc-md-copy-btn" data-pkc-action="copy-md-block">⧉</button>' +
        '<input class="pkc-render-toggle-input" id="t"><label class="pkc-render-toggle" for="t">‹/›</label></div>' +
        '<a data-pkc-action="filter-by-tag">#t</a><a data-pkc-action="navigate-entry-ref" data-pkc-entry-ref="entry:z">z</a>' +
        '<a class="pkc-asset-link" data-pkc-asset-key="k">添付</a>',
    );
    sanitizeEmbedded(b, () => null, 'place-9-');
    expect(b.querySelector('h2')).toBeNull();
    expect(b.querySelector('[data-pkc-embedded-heading="2"]')!.textContent).toBe('章');
    expect(b.querySelector('[data-pkc-embedded-heading="2"]')!.id, '見出しの id が行へ写っていない').toBe('place-9-x');
    expect(b.querySelector('.pkc-md-copy-btn, .pkc-render-toggle-input, .pkc-render-toggle')).toBeNull();
    expect(b.querySelector('[data-pkc-action="filter-by-tag"]'), '受け手の居ない押し口が残っている').toBeNull();
    expect(b.querySelector('[data-pkc-action="navigate-entry-ref"]'), '飛ぶ口まで外している').not.toBeNull();
    expect(b.querySelector('a[data-pkc-asset-key]'), '押せない添付リンクが残っている').toBeNull();
    expect(b.textContent).toContain('添付');
  });

  it('🔴 id は全部接頭辞つきに、それを指す href / for / aria も同じ接頭辞に(片方だけだと宙に浮く)', () => {
    const b = box(
      '<div class="pkc-format-block" id="inner"><sup id="fnref1"><a href="#fn1">1</a></sup></div>' +
        '<li id="fn1">注 <a href="#fnref1">戻る</a></li>' +
        '<label for="c">ラベル</label><input id="c"><p aria-labelledby="a b" aria-describedby="c">x</p>' +
        '<a href="https://example.com/#top">外</a>',
    );
    sanitizeEmbedded(b, () => null, 'place-3-');
    expect([...b.querySelectorAll('[id]')].map((e) => e.id).sort()).toEqual([
      'place-3-c',
      'place-3-fn1',
      'place-3-fnref1',
      'place-3-inner',
    ]);
    expect([...b.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href')).sort()).toEqual([
      '#place-3-fn1',
      '#place-3-fnref1',
    ]);
    expect(b.querySelector('label')!.getAttribute('for')).toBe('place-3-c');
    const p = b.querySelector('p')!;
    expect(p.getAttribute('aria-labelledby')).toBe('place-3-a place-3-b');
    expect(p.getAttribute('aria-describedby')).toBe('place-3-c');
    // ⚠ 外のページへのリンクは触らない(断片が `#` で始まらない)
    expect(b.querySelector('a[href^="https"]')!.getAttribute('href')).toBe('https://example.com/#top');
    expect(b.textContent).toContain('注');
  });

  it('🔴 図・画像は「元のノートで」の 1 行に降ろさず、そのまま残す(描いた後に読む面の口が埋める)', () => {
    const b = box(
      '<div class="pkc-md-block" data-pkc-render-lang="mermaid"><div class="pkc-render-slot">' +
        '<div class="pkc-mermaid-placeholder" data-pkc-mermaid-src="g"></div></div></div>' +
        '<div class="pkc-chart-placeholder" data-pkc-chart-src="c"></div>' +
        '<span class="pkc-math" data-pkc-math-src="x"></span><img data-pkc-asset-key="k" alt="a">',
    );
    sanitizeEmbedded(b, () => null, 'place-1-');
    for (const sel of ['[data-pkc-mermaid-src]', '[data-pkc-chart-src]', '[data-pkc-math-src]', 'img[data-pkc-asset-key]'])
      expect(b.querySelector(sel), `${sel} が降ろされている`).not.toBeNull();
    expect(b.querySelector('[data-pkc-field="place-body-skip"]')).toBeNull();
  });

  it('入れ子の付箋(entry= 無し)は中身だけ残し、線の宣言は消す', () => {
    const b = box(
      '<div class="pkc-format-block pkc-place"><p>中身</p></div><div class="pkc-format-block pkc-line" data-pkc-from="a"></div>',
    );
    sanitizeEmbedded(b, () => null, 'place-1-');
    expect(b.querySelector('.pkc-place, .pkc-line')).toBeNull();
    expect(b.textContent).toBe('中身');
  });
});
