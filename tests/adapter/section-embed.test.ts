/** @vitest-environment happy-dom */
/**
 * 🔴 **本文の中の `![説明](entry:ノート#h/見出し)` が、指した節の中身になる**(#1459 ①)。
 *
 * 実物の `DetailRenderer` + 実物の reducer で通す(板の test と同じ作り)。
 *
 * ## 守る主張(画面で起きること)
 * 1. 指した節の中身が出る(次の同格以上の見出しの手前まで)/ 題名のリンクが付く
 * 2. 🔴 ふつうのリンク(`!` 無し)・見出しを指さない画像形は**今までどおり**(展開しない)
 * 3. 見出しが無い → 「見出しが見つかりません」+ リンク / ノートが無い → 「ノートが見つかりません」
 * 4. 深さ ≤ 1:節の中の埋め込みは展開せずリンク。A→B→A の循環もリンクで止まる。自分自身はリンク
 * 5. 元のノートを直すと追随する(同じ書込の口)/ 関係の無い書込では器を作り直さない
 * 6. 本文のバイトは 1 つも変わらない / `id` は接頭辞つき(読む面の見出しと衝突しない)
 * 7. 効果層は節の鍵でも**ノートの本文**を読む
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects, type StorePort } from '../../src/adapter/state/store-effects';
import { initialState, placeBodiesOf, reduce, type AppState, type DomainEvent } from '../../src/adapter/state/app-state';
import { PLACE_BODY_CAP } from '../../src/features/markdown/place-embed';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import {
  SECTION_MISSING_NOTE,
  SECTION_NO_NOTE,
} from '../../src/adapter/ui/render/section-embed';

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

const requests = (events: readonly DomainEvent[]): string[] =>
  events.filter((e) => e.type === 'REQUEST_PLACE_BODY').map((e) => (e as { lid: string }).lid);

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const HOST = [
  '# Host',
  '文頭',
  '',
  '![A](entry:src#h/plan)',
  '',
  '[リンク](entry:src#h/plan)',
  '',
  '![無い見出し](entry:src#h/ghost)',
  '',
  '![無いノート](entry:zzz#h/plan)',
  '',
  '![自分](entry:host#h/host)',
  '',
  '![節ではない](entry:src)',
].join('\n');

const BODIES: Record<string, string> = {
  host: HOST,
  src: [
    '# Src',
    '## Plan',
    '計画 1',
    '![入れ子](entry:other#h/deep)',
    '### Detail',
    '詳細',
    '## Todo',
    'やること(Plan に入ってはいけない)',
  ].join('\n'),
  other: '## Deep\n深い(これは出てはいけない)',
  // 循環 a → b → a
  a: '## A1\nAの節\n![](entry:b#h/b1)',
  b: '## B1\nBの節\n![](entry:a#h/a1)',
};

interface Rig {
  root: HTMLElement;
  state: () => AppState;
  wanted: string[];
  host: () => HTMLElement;
  apply: (action: Parameters<typeof reduce>[1]) => Promise<void>;
  again: () => Promise<void>;
}

async function rig(
  open = 'host',
  bodies: Record<string, string> = BODIES,
  /** `false` = 頼んだ本文を届けない(「まだ読めていない間」の形)。 */
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
    (keys) => wanted.push(...keys),
  );
  const metas = [
    meta('host', 'text', '親ノート'),
    meta('src', 'text', '資料'),
    meta('other', 'text', '別の資料'),
    meta('a', 'text', 'ノートA'),
    meta('b', 'text', 'ノートB'),
    meta('other2', 'text', '無関係'),
  ];
  let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: open }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: open, body: bodies[open] ?? '' }).state;
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
  };
  // 頼んだ鍵を、実物の reducer を通して届ける
  detail.render(s);
  await settle();
  for (let round = 0; deliver && round < 6 && wanted.length > 0; round += 1) {
    const keys = wanted.splice(0);
    const asked = reduce(s, { type: 'PLACE_BODIES_WANTED', lids: keys });
    for (const key of requests(asked.events)) {
      const base = key.split('#')[0]!;
      s = reduce(s, { type: 'PLACE_BODY_LOADED', lid: key, body: bodies[base] ?? '' }).state;
    }
    detail.render(s);
    await settle();
    await settle();
  }
  return r;
}

const embeds = (r: Rig): HTMLElement[] => [...r.host().querySelectorAll<HTMLElement>('.pkc-section-embed')];
const embedOf = (r: Rig, ref: string): HTMLElement =>
  r.host().querySelector<HTMLElement>(`[data-pkc-embed-ref="${ref}"]`)!;

describe('描画: 指した節の中身が出る', () => {
  it('🔴 節の中身が出て、次の同格以上の見出しの手前で終わる(題名のリンクつき)', async () => {
    const r = await rig();
    const el = embedOf(r, 'entry:src#h/plan');
    expect(el.classList.contains('pkc-section-embed'), '展開した器になっていない').toBe(true);
    expect(el.textContent).toContain('計画 1');
    expect(el.textContent).toContain('詳細'); // 深い見出しは節の中身
    expect(el.textContent, '次の節が入っている').not.toContain('やること');
    const src = el.querySelector<HTMLElement>('[data-pkc-field="section-embed-source"]')!;
    expect(src.textContent).toBe('資料');
    expect(src.getAttribute('data-pkc-action')).toBe('select-entry');
    expect(src.getAttribute('data-pkc-entry')).toBe('src');
  });

  it('🔴 読み取り専用:見出しは見出しでなく、id は接頭辞つき(読む面と衝突しない)', async () => {
    const r = await rig();
    const el = embedOf(r, 'entry:src#h/plan');
    expect(el.querySelector('h1, h2, h3'), '見出しのまま入っている').toBeNull();
    const row = el.querySelector<HTMLElement>('[data-pkc-embedded-heading="2"]')!;
    expect(row.textContent).toBe('Plan');
    expect(row.getAttribute('id')).toMatch(/^sec-\d+-plan$/);
    // 読む面の見出しの id は素のまま
    expect(r.host().querySelector('h1')?.getAttribute('id')).toBe('host');
    // 押せる口は「別のノートを開く」だけ
    for (const a of el.querySelectorAll('[data-pkc-action]')) {
      expect(['select-entry', 'navigate-entry-ref']).toContain(a.getAttribute('data-pkc-action'));
    }
  });

  it('🔴 本文のバイトは変わらない(展開は表示だけ)', async () => {
    const r = await rig();
    expect(r.state().openBody?.body).toBe(HOST);
  });
});

describe('展開しないもの(今までどおり)', () => {
  it('🔴 ふつうのリンク `[字](entry:…)` は展開しない / 見出しを指さない画像形は空の器のまま', async () => {
    const r = await rig();
    const link = r.host().querySelector('a[data-pkc-action="navigate-entry-ref"]');
    expect(link, 'リンクが消えている').not.toBeNull();
    expect(link!.closest('.pkc-section-embed')).toBeNull();
    // 🔑 リンクの中身(字)を書き換えられていない = 展開の対象に数えられていない
    expect(link!.textContent).toBe('リンク');
    expect(link!.querySelector('[data-pkc-field]'), 'リンクの中へ展開している').toBeNull();
    const plain = embedOf(r, 'entry:src');
    expect(plain.classList.contains('pkc-transclusion-placeholder'), '見出しを指さない参照を展開している').toBe(true);
    // 🔴 展開しない参照は、説明の字が枠に残る(書き出しでも空の枠にならない)
    expect(plain.textContent).toBe('節ではない');
  });
});

describe('断り(黙って空にしない)', () => {
  it('🔴 見出しが無い → 断り + 元のノートへのリンク / ノートが無い → 断り', async () => {
    const r = await rig();
    const miss = embedOf(r, 'entry:src#h/ghost');
    expect(miss.textContent).toContain(SECTION_MISSING_NOTE);
    expect(miss.querySelector('[data-pkc-entry="src"]'), '元のノートへのリンクが無い').not.toBeNull();
    const none = embedOf(r, 'entry:zzz#h/plan');
    expect(none.textContent).toBe(SECTION_NO_NOTE);
    expect(none.querySelector('[data-pkc-action]')).toBeNull();
  });
});

describe('深さ ≤ 1 と循環', () => {
  it('🔴 節の中の埋め込みは展開せず、題名のリンクへ降りる', async () => {
    const r = await rig();
    const el = embedOf(r, 'entry:src#h/plan');
    expect(el.textContent, '二段目を展開している').not.toContain('深い');
    expect(el.querySelector('.pkc-transclusion-placeholder')).toBeNull();
    const link = el.querySelector('[data-pkc-field="place-body-link"]')!;
    expect(link.textContent).toBe('別の資料');
    expect(link.getAttribute('data-pkc-entry')).toBe('other');
    // 空の <p> を残さない
    expect([...el.querySelectorAll('p')].every((p) => p.childNodes.length > 0)).toBe(true);
  });

  it('🔴 A→B→A の循環:B の節は出て、その中の A への埋め込みはリンクで止まる', async () => {
    const r = await rig('a');
    const els = embeds(r);
    expect(els).toHaveLength(1);
    expect(els[0]!.textContent).toContain('Bの節');
    expect(els[0]!.querySelectorAll('.pkc-section-embed'), '入れ子に展開している').toHaveLength(0);
    const back = els[0]!.querySelector('[data-pkc-field="place-body-link"]')!;
    expect(back.getAttribute('data-pkc-entry')).toBe('a');
  });

  it('自分自身を指す埋め込みは展開せず題名のリンク', async () => {
    const r = await rig();
    const self = embedOf(r, 'entry:host#h/host');
    expect(self.querySelector('[data-pkc-field="section-embed-source"]')).toBeNull();
    expect(self.textContent).toBe('親ノート');
    expect(self.querySelector('[data-pkc-entry="host"]')).not.toBeNull();
  });
});

describe('元のノートを直すと追随する', () => {
  it('🔴 書込(保存の ack)で節が入れ替わる / 関係の無い書込では器を作り直さない', async () => {
    const r = await rig();
    const el = embedOf(r, 'entry:src#h/plan');
    const first = el.firstChild;
    // 🔑 板の抜粋の入れ物が動く(= 描き直しの口 `sync` が呼ばれる)のに、この節は変わっていない回
    await r.apply({ type: 'PLACE_BODY_LOADED', lid: 'other2', body: '無関係' });
    await settle();
    expect(embedOf(r, 'entry:src#h/plan').firstChild, '関係の無い書込で作り直している').toBe(first);

    await r.apply({
      type: 'BODY_PERSISTED',
      lid: 'src',
      body: '## Plan\n新しい計画\n## Todo\n別',
    });
    await settle();
    await settle();
    const after = embedOf(r, 'entry:src#h/plan');
    expect(after.textContent).toContain('新しい計画');
    expect(after.textContent).not.toContain('計画 1');
  });

  it('🔴 見出しを消すと「見つかりません」になり、戻すと中身が戻る', async () => {
    const r = await rig();
    await r.apply({ type: 'BODY_PERSISTED', lid: 'src', body: '## Other\n別の節' });
    await settle();
    await settle();
    expect(embedOf(r, 'entry:src#h/plan').textContent).toContain(SECTION_MISSING_NOTE);
    await r.apply({ type: 'BODY_PERSISTED', lid: 'src', body: '## Plan\n戻した' });
    await settle();
    await settle();
    expect(embedOf(r, 'entry:src#h/plan').textContent).toContain('戻した');
  });
});

describe('state / 効果層', () => {
  const s0 = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('n1'), meta('f1', 'folder')],
    relations: [],
  }).state;

  it('🔴 節の鍵を頼むと、鍵のまま読みに行く(居ないノート・フォルダは頼まない)', () => {
    const r = reduce(s0, { type: 'PLACE_BODIES_WANTED', lids: ['n1#h/plan', 'ghost#h/x', 'f1#h/x', 'n1#h/plan'] });
    expect(requests(r.events)).toEqual(['n1#h/plan']);
  });

  it('🔴 届いた本文から節だけを持つ / 同じ鍵は頼み直さない', () => {
    const s = reduce(s0, { type: 'PLACE_BODY_LOADED', lid: 'n1#h/plan', body: '## Plan\n中身\n## Todo\n別' }).state;
    expect(placeBodiesOf(s).get('n1#h/plan')?.text).toBe('## Plan\n中身');
    expect(requests(reduce(s, { type: 'PLACE_BODIES_WANTED', lids: ['n1#h/plan'] }).events)).toEqual([]);
    const miss = reduce(s0, { type: 'PLACE_BODY_LOADED', lid: 'n1#h/ghost', body: '## Plan\n' }).state;
    expect(placeBodiesOf(miss).get('n1#h/ghost')?.missing).toBe(true);
  });

  it('🔴 書込は板の抜粋と節の両方に追随する(別の口を作らない)', () => {
    let s = reduce(s0, { type: 'PLACE_BODY_LOADED', lid: 'n1', body: '古い' }).state;
    s = reduce(s, { type: 'PLACE_BODY_LOADED', lid: 'n1#h/plan', body: '## Plan\n古い節' }).state;
    s = reduce(s, { type: 'BODY_PERSISTED', lid: 'n1', body: '## Plan\n新しい節' }).state;
    expect(placeBodiesOf(s).get('n1')?.text).toBe('## Plan\n新しい節');
    expect(placeBodiesOf(s).get('n1#h/plan')?.text).toBe('## Plan\n新しい節');
  });

  it('🔴 効果層は節の鍵でも「ノートの本文」を読む', async () => {
    const asked: string[] = [];
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')] as never, relations: [] });
    const off = connectStoreEffects(d, {
      getBody: (lid: string) => {
        asked.push(lid);
        return Promise.resolve('## Plan\n本文');
      },
    } as unknown as StorePort);
    try {
      d.dispatch({ type: 'PLACE_BODIES_WANTED', lids: ['n1#h/plan'] });
      for (let i = 0; i < 10 && !placeBodiesOf(d.getState()).has('n1#h/plan'); i += 1) await Promise.resolve();
      expect(asked).toEqual(['n1']);
      expect(placeBodiesOf(d.getState()).get('n1#h/plan')?.text).toBe('## Plan\n本文');
    } finally {
      off();
    }
  });
});

describe('書込・上限・再読込(ほかのノートの鍵を巻き込まない)', () => {
  const s0 = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('n1'), meta('m1')],
    relations: [],
  }).state;

  it('🔴 書込は、そのノートの節の鍵だけ追随する(別のノートの同じ印の鍵は動かない)', () => {
    let s = reduce(s0, { type: 'PLACE_BODY_LOADED', lid: 'm1#h/a', body: '## A\nm1 の節' }).state;
    s = reduce(s, { type: 'PLACE_BODY_LOADED', lid: 'n1#h/plan', body: '## Plan\n古い' }).state;
    const m1Before = placeBodiesOf(s).get('m1#h/a');
    s = reduce(s, { type: 'BODY_PERSISTED', lid: 'n1', body: '## Plan\n新しい' }).state;
    expect(placeBodiesOf(s).get('n1#h/plan')?.text).toBe('## Plan\n新しい');
    // 🔑 n1 の書込で、m1 の鍵が(n1 の本文から)作り直されていない: 見つからない扱いにも、n1 の本文にもならない
    expect(placeBodiesOf(s).get('m1#h/a')).toBe(m1Before);
    expect(placeBodiesOf(s).get('m1#h/a')?.text).toBe('## A\nm1 の節');
  });

  it('🔴 別のタブの書込(REMOTE_BODY_CHANGED)も節の鍵に追随する', () => {
    let s = reduce(s0, { type: 'PLACE_BODY_LOADED', lid: 'n1#h/plan', body: '## Plan\n古い' }).state;
    s = reduce(s, { type: 'REMOTE_BODY_CHANGED', lid: 'n1', body: '## Plan\n別タブで直した' }).state;
    expect(placeBodiesOf(s).get('n1#h/plan')?.text).toBe('## Plan\n別タブで直した');
  });

  it('🔴 別の container を開き直したら、抜粋を捨てる / 同じ container の再読込では保つ', () => {
    const s = reduce(s0, { type: 'PLACE_BODY_LOADED', lid: 'n1#h/plan', body: '## Plan\n中身' }).state;
    const same = reduce(s, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] }).state;
    expect(placeBodiesOf(same).has('n1#h/plan'), '同じ container で捨てている').toBe(true);
    const other = reduce(s, { type: 'SYS_BOOTED', cid: 'c2', metas: [meta('n1')], relations: [] }).state;
    expect(placeBodiesOf(other).size, '別 container の抜粋が残っている').toBe(0);
  });

  it('🔴 201 件目を読んでも、いま開いている本文が求める節の鍵は手放さない', () => {
    const metas = [meta('host'), ...Array.from({ length: PLACE_BODY_CAP + 5 }, (_, i) => meta(`x${String(i)}`))];
    let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'host' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'host', body: '![a](entry:x0#h/plan)' }).state;
    s = reduce(s, { type: 'PLACE_BODY_LOADED', lid: 'x0#h/plan', body: '## Plan\n要る' }).state;
    // 古い順に手放す圧を、上限を超えるまでかける(要る鍵は最古)
    for (let i = 1; i <= PLACE_BODY_CAP + 1; i += 1) {
      s = reduce(s, { type: 'PLACE_BODY_LOADED', lid: `x${String(i)}`, body: 'b' }).state;
    }
    expect(placeBodiesOf(s).size).toBeLessThanOrEqual(PLACE_BODY_CAP);
    expect(placeBodiesOf(s).get('x0#h/plan')?.text, '要る節の鍵を手放した').toBe('## Plan\n要る');
    expect(placeBodiesOf(s).has('x1'), '対照群: 要らない最古の物は手放す').toBe(false);
  });

  it('🔴 留めた枠の本文が求める節の鍵も手放さない', () => {
    const metas = [meta('host'), meta('pin'), ...Array.from({ length: PLACE_BODY_CAP + 5 }, (_, i) => meta(`x${String(i)}`))];
    let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] }).state;
    s = reduce(s, { type: 'SPLIT_RESTORED', lids: ['pin'] }).state;
    s = reduce(s, { type: 'SPLIT_BODY_LOADED', lid: 'pin', body: '![a](entry:x0#h/plan)' }).state;
    s = reduce(s, { type: 'PLACE_BODY_LOADED', lid: 'x0#h/plan', body: '## Plan\n要る' }).state;
    for (let i = 1; i <= PLACE_BODY_CAP + 1; i += 1) {
      s = reduce(s, { type: 'PLACE_BODY_LOADED', lid: `x${String(i)}`, body: 'b' }).state;
    }
    expect(placeBodiesOf(s).has('x0#h/plan'), '留めた枠の求める鍵を手放した').toBe(true);
  });

  it('🔴 読めなかった(null)節の鍵は「読めなかった」と持つ / 板の鍵は何も持たない / 書込が届けば戻る', () => {
    let s = reduce(s0, { type: 'PLACE_BODY_LOADED', lid: 'n1#h/plan', body: null }).state;
    expect(placeBodiesOf(s).get('n1#h/plan')?.gone).toBe(true);
    expect(placeBodiesOf(reduce(s0, { type: 'PLACE_BODY_LOADED', lid: 'n1', body: null }).state).has('n1')).toBe(false);
    s = reduce(s, { type: 'BODY_PERSISTED', lid: 'n1', body: '## Plan\n戻った' }).state;
    expect(placeBodiesOf(s).get('n1#h/plan')?.text).toBe('## Plan\n戻った');
    expect(placeBodiesOf(s).get('n1#h/plan')?.gone).toBeUndefined();
  });
});

describe('頼む回数と、読めなかったときの画面', () => {
  it('🔴 まだ読めていない間に描き直しても、頼むのは 1 度だけ(読み込み中の字が出る)', async () => {
    const r = await rig('host', { ...BODIES }, false);
    const first = r.wanted.length;
    expect(first).toBeGreaterThan(0);
    const keys = r.wanted.filter((k) => k === 'src#h/plan');
    expect(keys).toHaveLength(1);
    // 🔑 抜粋の入れ物が動く回(= 描き直しの口 `sync` が呼ばれる)を 2 度作る
    await r.apply({ type: 'PLACE_BODY_LOADED', lid: 'other2', body: 'a' });
    await r.apply({ type: 'PLACE_BODY_LOADED', lid: 'other2', body: 'b' });
    expect(r.wanted.filter((k) => k === 'src#h/plan'), '描き直すたびに頼み直している').toHaveLength(1);
    expect(embedOf(r, 'entry:src#h/plan').textContent).toContain('読み込んでいます');
  });

  it('🔴 読めなかった(消えた / 失敗)節は「ノートが見つかりません」になる(読み込み中で止まらない)', async () => {
    const r = await rig('host', { ...BODIES }, false);
    await r.apply({ type: 'PLACE_BODY_LOADED', lid: 'src#h/plan', body: null });
    const el = embedOf(r, 'entry:src#h/plan');
    expect(el.textContent).toContain(SECTION_NO_NOTE);
    expect(el.textContent).not.toContain('読み込んでいます');
  });

  it('🔴 効果層:本文が null / 例外でも、節の鍵は結果を返す(板の鍵は今までどおり黙る)', async () => {
    for (const getBody of [() => Promise.resolve(null), () => Promise.reject(new Error('x'))]) {
      const d = new Dispatcher();
      d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')] as never, relations: [] });
      const off = connectStoreEffects(d, { getBody } as unknown as StorePort);
      try {
        d.dispatch({ type: 'PLACE_BODIES_WANTED', lids: ['n1#h/plan', 'n1'] });
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
        expect(placeBodiesOf(d.getState()).get('n1#h/plan')?.gone, '節の鍵が結果を返していない').toBe(true);
        expect(placeBodiesOf(d.getState()).has('n1'), '板の鍵が何か持っている').toBe(false);
      } finally {
        off();
      }
    }
  });
});

describe('展開しない面の字', () => {
  it('🔴 描画器の器に説明の字が入る(書き出し・下見で空の枠にならない)', () => {
    expect(renderMarkdown('![決定事項](entry:n1#h/x)')).toContain('>決定事項</div>');
    expect(renderMarkdown('![](entry:n1#h/x)')).toContain('>別のノートの内容</div>');
  });
});
