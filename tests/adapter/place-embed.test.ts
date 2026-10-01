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
 * 8. 図・画像は描かない(W3-②)── 1 行で「元のノートで」。落ちず、頼み直し続けない
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
import {
  excerptOf,
  PLACE_BODY_CAP,
  PLACE_BODY_CLIP,
  PLACE_ENTRY_DEFAULT_H,
  PLACE_ENTRY_DEFAULT_W,
  placeEmbeddable,
} from '../../src/features/markdown/place-embed';
import { codeOnly } from '../helpers/code-only';

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

  it('出してよい型:フォルダと添付は帯だけ', () => {
    expect(placeEmbeddable('text')).toBe(true);
    expect(placeEmbeddable('todo')).toBe(true);
    expect(placeEmbeddable('folder')).toBe(false);
    expect(placeEmbeddable('attachment')).toBe(false);
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

  it('🔴 持っていない物だけ読みに行く / 居ない・フォルダ・添付は読まない', () => {
    const r = reduce(s0, { type: 'PLACE_BODIES_WANTED', lids: ['n1', 'f1', 'a1', 'ghost', 'n1'] });
    expect(requests(r.events), '1 件(重複なし)だけ頼むはず').toEqual(['n1']);
    const loaded = reduce(s0, { type: 'PLACE_BODY_LOADED', lid: 'n1', body: '本文' }).state;
    const again = reduce(loaded, { type: 'PLACE_BODIES_WANTED', lids: ['n1'] });
    expect(requests(again.events), '持っているのに読み直している').toEqual([]);
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
): Promise<Rig> {
  const root = document.createElement('div');
  document.body.append(root);
  const wanted: string[] = [];
  const detail = new DetailRenderer(
    buildShell(root).detail,
    null,
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

  it('🔴 見出しは見出しでなく、id は 1 つも残らない(板のノートの目次・ジャンプと衝突しない)', async () => {
    const r = await rig();
    const slot = slotOf(r, 'p1')!;
    expect(slot.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    expect(slot.querySelector('[id]')).toBeNull();
    expect(slot.querySelector('[data-pkc-embedded-heading="1"]')!.textContent).toBe('買い出し');
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

describe('描画: 図と添付の画像は描かない(W3-②)', () => {
  const FIG = [
    '前の文',
    '',
    '```mermaid',
    'graph TD; A-->B',
    '```',
    '',
    '$$x^2$$',
    '',
    '| 式 | 値 |',
    '|---|---|',
    '| $y$ | 1 |',
    '',
    '![写真](asset:abc)',
    '',
    '後ろの文',
  ].join('\n');

  it('🔴 図・数式・画像は 1 行になり、本文と表は壊れない / 無限に頼まない', async () => {
    const r = await rig({ ...BODIES, n1: FIG });
    const slot = slotOf(r, 'p1')!;
    expect(slot.querySelector('.pkc-mermaid-placeholder, .pkc-chart-placeholder, .pkc-math')).toBeNull();
    expect(slot.querySelector('img')).toBeNull();
    const notes = [...slot.querySelectorAll('[data-pkc-field="place-body-skip"]')].map((e) => e.textContent);
    expect(notes).toContain('図は元のノートで');
    expect(notes).toContain('画像は元のノートで');
    expect(slot.textContent).toContain('前の文');
    expect(slot.textContent).toContain('後ろの文');
    // ⚠ 表のセルの中の数式で、表ごと消していない
    expect(slot.querySelector('table'), '数式 1 つで表が消えた').not.toBeNull();
    expect(r.wanted, '図を理由に頼み続けている').toEqual([]);
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
    sanitizeEmbedded(b, () => null);
    expect(b.querySelector('h2')).toBeNull();
    expect(b.querySelector('[data-pkc-embedded-heading="2"]')!.textContent).toBe('章');
    expect(b.querySelector('[id]')).toBeNull();
    expect(b.querySelector('.pkc-md-copy-btn, .pkc-render-toggle-input, .pkc-render-toggle')).toBeNull();
    expect(b.querySelector('[data-pkc-action="filter-by-tag"]'), '受け手の居ない押し口が残っている').toBeNull();
    expect(b.querySelector('[data-pkc-action="navigate-entry-ref"]'), '飛ぶ口まで外している').not.toBeNull();
    expect(b.querySelector('a[data-pkc-asset-key]'), '押せない添付リンクが残っている').toBeNull();
    expect(b.textContent).toContain('添付');
  });

  it('🔴 見出し以外の id(脚注・書式の塊)も剥がす(板のノートの `#章` ジャンプと衝突しない)', () => {
    const b = box('<div class="pkc-format-block" id="inner"><sup id="fnref1">1</sup></div><li id="fn1">注</li>');
    sanitizeEmbedded(b, () => null);
    expect(b.querySelector('[id]'), 'id が残っている').toBeNull();
    expect(b.textContent).toContain('注');
  });

  it('入れ子の付箋(entry= 無し)は中身だけ残し、線の宣言は消す', () => {
    const b = box(
      '<div class="pkc-format-block pkc-place"><p>中身</p></div><div class="pkc-format-block pkc-line" data-pkc-from="a"></div>',
    );
    sanitizeEmbedded(b, () => null);
    expect(b.querySelector('.pkc-place, .pkc-line')).toBeNull();
    expect(b.textContent).toBe('中身');
  });
});
