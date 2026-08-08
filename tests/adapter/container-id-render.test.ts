/** @vitest-environment happy-dom */
/**
 * 🔴 **いま開いているコンテナの id が、markdown を描く面**すべて**へ届く**
 * (2026-08-08。Issue #100 段①)。
 *
 * ## 直す前に起きていたこと
 *
 * `markdown-render.ts` は `pkc://<cid>/entry/<lid>` を **`cid` が自分と一致した
 * ときだけ** `navigate-entry-ref` に焼く。ところが `currentContainerId` を
 * **`src/adapter/` からも `main.ts` からも 1 件も渡していなかった**(既定 `''`)。
 * 一致しないので必ず「別の PKC」の枝(`pkc-portable-reference-placeholder`、
 * action 無し)へ落ち、#97 で戻した受け手は**1 度も呼ばれなかった**。
 *
 * ## なぜ面ごとに書くのか
 *
 * > CLAUDE.md「同じ値を複数の描画経路へ渡すものは、経路ごとに pin する。
 * > 代表 1 経路の test は他の経路を 1 度も通らない」
 *
 * 面は `src/adapter/ui/render/` に **5 つ**ある(`pkc-md-rendered` を付ける所を
 * 数え上げた ── 下の「面の数」が機械で数える):
 *
 * | # | 面 | 材料を組む所 |
 * |---|---|---|
 * | ① | 読む面 | `detail.ts` の `opts` |
 * | ② | 分割プレビュー | `detail.ts` の `previewOpts` |
 * | ③ | ライブエディタ(flag `editor.live`)| 同上(**同じ object を共有**)|
 * | ④ | 添付の説明 | `detail.ts` の `renderAttachment` |
 * | ⑤ | ヘルプのマニュアル | `help.ts` ← `center.ts` が state から渡す |
 *
 * ⚠ **書き出し HTML(`pkc3-html.ts`)には渡していない**。配る HTML には
 * `navigate-*` の受け手が 1 つも無い(閲覧側 script は目次と添付だけを見る)ので、
 * 焼くと**押しても何も起きないリンク**になる ── いまの placeholder badge は
 * 「別の PKC の参照だ」と読める分だけ正しい。段②以降で書き出しに受け手を
 * 置くときに、まとめて考える。
 *
 * ## ⚠ 対照群を必ず置く
 *
 * 「リンクとして焼かれた」だけを見ると、**cid を見ずに全部焼く**実装でも通る。
 * だから同じ本文の `pkc://<外>/entry/<lid>` が **placeholder のままである**ことを
 * 対にして見る。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { HelpRenderer, MANUAL_TEXT } from '../../src/adapter/ui/render/help';
import { MarkdownClient } from '../../src/adapter/platform/render/markdown-client';

/** このコンテナの id(`SYS_BOOTED` から state に載る値)。 */
const CID = 'c-mine';

/** 本文:自分あて 1 本 + 外あて 1 本(対照群を同じ描画に混ぜる)。 */
const BODY = [
  '自分あて [題](pkc://c-mine/entry/b) と',
  '',
  '外あて [題](pkc://c-other/entry/b) を 1 つの本文に置く。',
].join('\n');

function meta(lid: string, archetype = 'text'): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
  };
}

/** ⚠ **本物の reducer を通す**(手組みの state は cid の経路を隠す)。 */
function viewing(body: string, archetype = 'text'): AppState {
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: CID,
    metas: [meta('a', archetype), meta('b')],
    relations: [],
  }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  return reduce(s, { type: 'BODY_LOADED', lid: 'a', body }).state;
}

function editing(body: string): AppState {
  return reduce(viewing(body), { type: 'START_EDIT' }).state;
}

/** ⚠ flag は URL から解決される(`live-editor.test.ts` と同じ差し方)。 */
function setLive(on: boolean): void {
  history.replaceState(null, '', on ? '/?pkc-flag=editor.live' : '/');
}

let root: HTMLElement;
beforeEach(() => {
  document.body.textContent = '';
  root = document.createElement('div');
  // ⚠ **document へ繋ぐ** ── `follower` の callback は `isConnected` で
  //    早期 return する(外れた器へ描かない規律)ので、繋がないと何も出ない
  document.body.append(root);
});
afterEach(() => setLive(false));

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function detailRenderer(): DetailRenderer {
  return new DetailRenderer(buildShell(root).detail, null, new MarkdownClient());
}

/**
 * その面の中で「自分あては押せるリンク / 外あては placeholder」を確かめる。
 *
 * @param scope その面の器(面を取り違えると、隣の面の結果で通ってしまう)
 */
function expectSelfLinkAndForeignBadge(scope: Element, face: string): void {
  const mine = scope.querySelector('[data-pkc-action="navigate-entry-ref"]');
  expect(mine, `${face}: 自分あての pkc:// が押せるリンクになっていない`).not.toBeNull();
  // ⚠ 受け手が読む属性まで見る(action の名前だけでは飛び先が空でも通る)
  expect(mine!.getAttribute('data-pkc-entry-ref'), `${face}: 飛び先が入っていない`).toBe(
    'entry:b',
  );
  const foreign = scope.querySelector('.pkc-portable-reference-placeholder');
  expect(foreign, `${face}: 外あてまでリンクにしている(cid を見ていない)`).not.toBeNull();
  expect(
    foreign!.getAttribute('data-pkc-portable-container'),
    `${face}: 外あての参照が別のものにすり替わっている`,
  ).toBe('c-other');
  expect(
    foreign!.hasAttribute('data-pkc-action'),
    `${face}: 外あてに受け手を付けている(押すと別コンテナの lid を開く)`,
  ).toBe(false);
}

describe('① 読む面', () => {
  it('🔴 自分あての pkc:// が押せるリンクになる(外あては placeholder のまま)', async () => {
    const detail = detailRenderer();
    detail.render(viewing(BODY));
    await settle();
    const host = root.querySelector('[data-pkc-field="detail-body"]');
    expect(host, '本文の器が無い').not.toBeNull();
    expectSelfLinkAndForeignBadge(host!, '読む面');
  });

  /**
   * 🔴 **未 boot(cid が `null`)では焼かない。** 「分からないなら外と見なす」が
   * 安全側 ── ここで `'default'` のような既定値を**でっち上げる**と、別の PKC の
   * 参照が自分のものとして押せてしまう。
   *
   * ⚠ **`default` を混ぜて撃つ**(変異試験 M7 が 1 巡目で生き延びた)。
   * `state.cid ?? 'default'` という変異は、`c-mine` / `c-other` しか無い本文では
   * **どちらとも一致しない**ので素通りする ── しかも `'default'` は
   * **このアプリが実際に使っている id**(`SYS_BOOTED`)なので、
   * でっち上げるといちばん当たりやすい値である。
   */
  it('🔴 cid が無いうちは、どの pkc:// も placeholder のまま', async () => {
    const body = BODY + '\n\nそして [題](pkc://default/entry/b) も混ぜる。';
    const detail = detailRenderer();
    const s = reduce(initialState, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    detail.render({
      ...s,
      phase: 'ready',
      cid: null,
      selectedLid: 'a',
      entryMetas: new Map([['a', meta('a')]]),
      openBody: { lid: 'a', body, baseline: body, persisted: body, diskAhead: false },
    } as AppState);
    await settle();
    const host = root.querySelector('[data-pkc-field="detail-body"]')!;
    expect(
      host.querySelector('[data-pkc-action="navigate-entry-ref"]'),
      'cid が無いのに焼いた(既定値をでっち上げていないか)',
    ).toBeNull();
    expect(host.querySelectorAll('.pkc-portable-reference-placeholder')).toHaveLength(3);
  });
});

describe('② 分割プレビュー', () => {
  it('🔴 書いている最中も、読む面と同じ見え方になる', async () => {
    setLive(false);
    const detail = detailRenderer();
    detail.render(editing(BODY));
    await settle();
    const preview = root.querySelector('[data-pkc-region="editor-preview"]');
    expect(preview, 'プレビューの器が無い').not.toBeNull();
    expectSelfLinkAndForeignBadge(preview!, '分割プレビュー');
  });
});

describe('③ ライブエディタ(flag `editor.live`)', () => {
  /**
   * ⚠ ②と**同じ object**(`previewOpts`)を受けるので、いまは片方を直せば
   * 両方直る。それでも別に見るのは、**面ごとに材料を組み直す変更**が入った
   * ときに片方だけ落ちる形にしておくためである。
   */
  it('🔴 1 面のライブエディタでも同じ', async () => {
    setLive(true);
    const detail = detailRenderer();
    detail.render(editing(BODY));
    await settle();
    const pane = root.querySelector('[data-pkc-region="editor-live"]');
    expect(pane, 'ライブエディタの器が無い').not.toBeNull();
    // ⚠ 分割が組めないと原文の入力欄へ退避する ── そのときは主題を見ていない
    expect(pane!.querySelector('textarea'), '退避先に落ちている(主題を見ていない)').toBeNull();
    expectSelfLinkAndForeignBadge(pane!, 'ライブエディタ');
  });
});

describe('④ 添付の説明', () => {
  /**
   * 🔴 添付の説明は**その場で同期に描く別経路**(ワーカーを通らない)。
   * 渡し忘れると「説明に書いたリンクだけ押せない」という一貫性の穴になる。
   */
  it('🔴 説明文の中の pkc:// も同じ扱い', async () => {
    const body =
      '---\nattachment.name: a.bin\nattachment.mime: application/octet-stream\n---\n' + BODY;
    const detail = detailRenderer();
    detail.render(viewing(body, 'attachment'));
    await settle();
    const info = root.querySelector('[data-pkc-field="attachment-info"]');
    expect(info, '添付の面になっていない').not.toBeNull();
    const desc = root.querySelector('.pkc-md-rendered[data-pkc-field="detail-body"]');
    expect(desc, '説明の器が無い').not.toBeNull();
    expectSelfLinkAndForeignBadge(desc!, '添付の説明');
  });
});

describe('⑤ ヘルプのマニュアル', () => {
  /**
   * ⚠ **ここだけ「配線の pin」である。** 同梱マニュアルに `pkc://` は 1 件も
   * 無いので、描いた HTML を見ても違いが出ない ── 出力ではなく**口へ渡る値**を
   * 見る。⚠ だから「マニュアルに `pkc://` を書けば効く」という主張までしか
   * 守っていない(そこは正直に書く)。
   */
  it('🔴 マニュアルを描く口へ cid が渡る', async () => {
    const seen: Array<{ text: string; opts?: { currentContainerId?: string } }> = [];
    const region = document.createElement('div');
    root.append(region);
    new HelpRenderer(region, {
      render: (text, opts) => {
        seen.push({ text, opts });
        return Promise.resolve('<p data-probe="1"></p>');
      },
    }).render('c-help');
    await settle();
    expect(seen, 'マニュアルを描いていない').toHaveLength(1);
    expect(seen[0]!.text, 'マニュアル全文を渡していない').toBe(MANUAL_TEXT);
    expect(seen[0]!.opts?.currentContainerId, 'cid を渡していない').toBe('c-help');
  });

  /**
   * 🔴 **配線の側も見る**(`center.ts` が state から取って渡す)。
   * ⚠ `HelpRenderer` の unit だけだと、`this.help.render()` と**引数を落とす**
   *   変異が生き延びる ── 既定 `''` で型も通る。
   */
  it('🔴 中央の router が state の cid を渡す', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const seen: Array<{ currentContainerId?: string } | undefined> = [];
    const port = {
      render: (_t: string, opts?: { currentContainerId?: string }) => {
        seen.push(opts);
        return Promise.resolve('<p></p>');
      },
    };
    const router = new CenterRouter(host, undefined, null, port as never);
    router.render({ ...initialState, phase: 'ready', cid: CID, viewMode: 'help' });
    await settle();
    expect(seen, 'ヘルプが共有の口を使っていない').toHaveLength(1);
    expect(seen[0]?.currentContainerId, 'router が cid を渡していない').toBe(CID);
  });
});

/**
 * 🔴 **面が増えたら鳴る。**
 *
 * ⚠ これは「配線が正しい」ことは守らない ── 守るのは「**面の数が変わった**」
 * ことだけである(数が動いたら、上の ①〜⑤ に対応する test を足す)。
 * 数え方は `class = 'pkc-md-rendered'` を付けている所 ── markdown の器はこの
 * class を持つ約束になっている(CSS の正本が `.pkc-md-rendered` 起点)。
 */
describe('面の数', () => {
  it('🔴 markdown を描く面は 5 つ(増えたら cid の配線を見直す)', () => {
    const dir = 'src/adapter/ui/render';
    const found: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue;
      const text = readFileSync(join(dir, f), 'utf-8');
      const n = [...text.matchAll(/className = 'pkc-md-rendered'/g)].length;
      for (let i = 0; i < n; i++) found.push(f);
    }
    expect(found.length, `面が増減した: ${found.join(', ')}`).toBe(5);
    // ⚠ 空振り防止 ── 数え方が壊れたら「0 件で合格」にならないよう、
    //    ヘルプと本文の**両方**から拾えていることを見る
    expect(new Set(found)).toEqual(new Set(['detail.ts', 'help.ts']));
  });
});
