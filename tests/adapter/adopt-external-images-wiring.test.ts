/** @vitest-environment happy-dom */
/**
 * #264 段①+②: **外部の画像を「押して」手元へ取り込む**が、押した所から
 * disk へ届くまで。
 *
 * 🔴 **配線の test を別に置く理由**:純関数(`externalImageUrls` /
 * `rewriteAdopted`)も、書換の規則(`applyBodyRewrite`)も、それぞれの test が
 * 見ている。⚠ **その間の配線**は誰も通らない(CLAUDE.md §7「A と B が合意して
 * いることは、A の test にも B の test にも書けない」)。
 *
 * 見るのは 6 点:
 * ① 外部の画像が在るときだけ**見えて**、文言に**枚数**が出る
 * ② 本文が読めていないときは**畳む**(嘘の「0 枚」を出さない)
 * ③ 押すと **画像の宛先だけ**で呼ばれる(リンクは含まない = 外へ飛ぶ数が変わる)
 * ④ 取り込めたら `REQUEST_BODY_REWRITE` が出て、当てると**画像だけ**が `asset:` になる
 * ⑤ 🔴 1 枚も読めなかったら**撃たない**(effect の「本文が変わっている」という
 *    **嘘の理由**を user に見せない)── 代わりに**本当の理由**が `state.error` に出る
 * ⑥ 名乗りは `取込画像`(貼付と取り違えない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import type { AdoptOutcome } from '../../src/adapter/ui/actions/adopt-urls';

function meta(lid: string, order: number): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const METAS = [meta('n1', 1), meta('n2', 2)];
const IMG = 'https://e.com/a.png';
const SAME = 'https://e.com/same.png';

beforeEach(() => {
  document.body.textContent = '';
});

function rig(outcome?: (urls: readonly string[]) => AdoptOutcome) {
  const root = document.createElement('div');
  document.body.append(root);
  const inspector = new InspectorRenderer(buildShell(root).inspector);
  const asked: { urls: readonly string[]; prefix: string }[] = [];
  const status: string[] = [];
  const d = new Dispatcher(initialState);
  const events: DomainEvent[] = [];
  d.onEvent((e) => void events.push(e));
  bindActions(root, d, {
    showStatus: (t) => void status.push(t),
    adoptUrls: async (urls, namePrefix) => {
      asked.push({ urls, prefix: namePrefix });
      return (
        outcome?.(urls) ?? {
          adopted: new Map(urls.map((u, i) => [u, `asset:k${i + 1}`])),
          failures: [],
        }
      );
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
  /** 選んで本文まで読めた状態にする。⚠ `body` が `null` なら**読めていない**側。 */
  const open = (lid: string, body: string | null): AppState => {
    let s = reduce(d.getState(), { type: 'SELECT_ENTRY', lid }).state;
    if (body !== null) s = reduce(s, { type: 'BODY_LOADED', lid, body }).state;
    d.dispatch({ type: 'SELECT_ENTRY', lid });
    if (body !== null) d.dispatch({ type: 'BODY_LOADED', lid, body });
    inspector.render(s);
    return s;
  };
  const btn = (): HTMLButtonElement | null =>
    root.querySelector<HTMLButtonElement>('[data-pkc-action="adopt-external-images"]');
  return { root, asked, open, btn, d, events, status };
}

describe('#264 段① ボタンの出し方', () => {
  it('🔴 外部の画像が在るときだけ見えて、**枚数**が出る', () => {
    const r = rig();
    r.open('n1', `![ず](${IMG})\n![や](https://e.com/b.png)`);
    expect(r.btn()!.hidden, '外部の画像が在るのに畳まれている').toBe(false);
    expect(r.btn()!.textContent, '押す前に規模が分からない').toContain('2 枚');
  });

  it('🔴 数えるのは**宛先**(同じ URL が 2 回出ても 1 枚)', () => {
    const r = rig();
    r.open('n1', `![あ](${IMG})\n![い](${IMG})`);
    expect(r.btn()!.textContent).toContain('1 枚');
  });

  it('🔴 リンクは数えない(押した瞬間に外へ飛ぶ数が変わる)', () => {
    const r = rig();
    r.open('n1', `[記事](https://e.com/b.html)\n![ず](${IMG})`);
    expect(r.btn()!.textContent, 'リンクまで数えている').toContain('1 枚');
  });

  it('外部の画像が 1 枚も無ければ畳む(押しても何も起きない物を常設しない)', () => {
    const r = rig();
    r.open('n1', '# 題\n\n![手元](asset:k1)\n[記事](https://e.com/b.html)');
    expect(r.btn()!.hidden, '取り込む物が無いのに常設した').toBe(true);
  });

  it('🔴 本文が読めていないときも畳む ── 嘘の「0 枚」を出さない', () => {
    const r = rig();
    r.open('n1', null);
    expect(r.btn()!.hidden, '本文を読んでいないのに断定した').toBe(true);
  });

  it('🔴 選び直すと畳みも枚数も切り替わる(前のノートのまま残さない)', () => {
    const r = rig();
    r.open('n1', `![ず](${IMG})`);
    expect(r.btn()!.hidden).toBe(false);
    r.open('n2', '# 題');
    expect(r.btn()!.hidden, '選び直したのに前のノートのまま').toBe(true);
  });

  /**
   * 🔴 **枚数は憶えてあるが、本文が変われば数え直す**(#264 段①)。
   *
   * ⚠ この面は状態が動くたびに render するので、`scanLinks`(1MB で 15.9ms)を
   *   毎回は回さず、**本文そのもの**を鍵に憶えている。⚠ 鍵を **lid** にすると、
   *   同じノートを書き換えたときに**古い枚数が残る**(押すと枚数と実際が食い違う)。
   */
  it('🔴 同じノートの本文が変われば、枚数を数え直す(憶えたまま古い数を出さない)', () => {
    const r = rig();
    r.open('n1', `![ず](${IMG})`);
    expect(r.btn()!.textContent).toContain('1 枚');
    r.open('n1', `![ず](${IMG})\n![や](https://e.com/b.png)`);
    expect(r.btn()!.textContent, '本文が変わったのに古い枚数のまま').toContain('2 枚');
    r.open('n1', '# 題(画像を消した)');
    expect(r.btn()!.hidden, '画像を消したのに畳まれない').toBe(true);
  });

  it('⚠ 説明に「外へ通信する」と書いてある(押す前に分かる)', () => {
    const r = rig();
    r.open('n1', `![ず](${IMG})`);
    expect(r.btn()!.title, '外へ通信することを言っていない').toContain('通信');
    expect(r.btn()!.title, '読めなかったときのことを言っていない').toContain('元の URL のまま');
  });
});

describe('#264 段① 押してから disk へ届くまで', () => {
  it('🔴 **画像の宛先だけ**で呼ばれる(リンクは渡さない)', async () => {
    const r = rig();
    r.open('n1', `![ず](${SAME})\n[記事](${SAME})\n[他](https://e.com/b.html)`);
    r.btn()!.click();
    await vi.waitFor(() => expect(r.asked).toHaveLength(1));
    expect(r.asked[0]!.urls, 'リンクの URL まで外へ取りに行った').toEqual([SAME]);
    // ⑥ 名乗りは取り込みの側(置けなかったときの断り文で読み分けられる)
    expect(r.asked[0]!.prefix).toBe('取込画像');
  });

  it('🔴 取り込めたら書換要求が出て、当てると**画像だけ**が `asset:` になる', async () => {
    const r = rig();
    const body = `![ず](${SAME})\n[記事](${SAME})`;
    r.open('n1', body);
    r.btn()!.click();
    await vi.waitFor(() => expect(r.events.some((e) => e.type === 'REQUEST_BODY_REWRITE')).toBe(true));
    const ev = r.events.find((e) => e.type === 'REQUEST_BODY_REWRITE')!;
    if (ev.type !== 'REQUEST_BODY_REWRITE') throw new Error('unreachable');
    expect(ev.lid).toBe('n1');
    /**
     * 🔴 **effect が disk から読み直した本文に当てる**ところまで通す ──
     * 「要求が出た」だけでは、当たるかどうかを 1 バイトも見ていない。
     */
    expect(applyBodyRewrite(body, ev.rewrite)).toBe(`![ず](asset:k1)\n[記事](${SAME})`);
    // ⚠ 入ったときは**枚数つきで**一報する(上の「0 枚を言わない」の対照群)
    expect(r.status.some((t) => t.includes('1 枚を手元に取り込みました')), '入ったのに黙っている').toBe(
      true,
    );
  });

  it('🔴 1 枚も読めなかったら**撃たない**(嘘の「本文が変わっている」を出さない)', async () => {
    const r = rig((urls) => ({
      adopted: new Map(),
      failures: urls.map((url) => ({ url, why: '置き場所が 404 を返しました', fixable: false })),
    }));
    r.open('n1', `![ず](${IMG})`);
    r.btn()!.click();
    await vi.waitFor(() => expect(r.d.getState().error).toBeTruthy());
    expect(
      r.events.some((e) => e.type === 'REQUEST_BODY_REWRITE'),
      '1 枚も入っていないのに書換を撃った(effect が別の理由を出す)',
    ).toBe(false);
    // ⑤ **本当の理由**が届いている
    expect(r.d.getState().error).toContain('404');
    expect(r.d.getState().error, '消していないことを言っていない').toContain('元の URL のまま');
    /**
     * 🔴 **「0 枚を取り込みました」を出さない**(変異試験 M23 が SURVIVED で教えた)。
     *
     * ⚠ 撃つ / 撃たないは reducer 側にも門が在る(空の対応は no-op)ので、
     *   binder の `adopted.size > 0` を外しても**上の assert は落ちない** ──
     *   守っていたのは reducer のほうだった(CLAUDE.md §1「門を N 個置いたら、
     *   N 個目だけが鳴る場面を N 通り作る」)。
     * 🔑 binder の門だけが決めているのは**この一報**である ── 外すと user は
     *   「0 枚を手元に取り込みました」と「404」を**同時に**読まされる。
     */
    expect(
      r.status.filter((t) => t.includes('取り込みました')),
      '1 枚も入っていないのに「取り込みました」と言った',
    ).toEqual([]);
    // ⚠ 対照群 ── 押した合図そのものは出ている(この test が黙っていないこと)
    expect(r.status.some((t) => t.includes('取りに行っています')), '押した合図が無い').toBe(true);
  });

  it('🔴 一部だけ読めたときは、読めたぶんを当てて**残りの理由も言う**', async () => {
    const good = 'https://e.com/ok.png';
    const r = rig((urls) => ({
      adopted: new Map(urls.filter((u) => u === good).map((u) => [u, 'asset:k9'])),
      failures: urls
        .filter((u) => u !== good)
        .map((url) => ({ url, why: '置き場所が 404 を返しました', fixable: false })),
    }));
    const body = `![あ](${good})\n![い](${IMG})`;
    r.open('n1', body);
    r.btn()!.click();
    await vi.waitFor(() => expect(r.d.getState().error).toBeTruthy());
    const ev = r.events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev, '読めたぶんの書換が出ていない').toBeDefined();
    if (ev?.type !== 'REQUEST_BODY_REWRITE') throw new Error('unreachable');
    expect(applyBodyRewrite(body, ev.rewrite)).toBe(`![あ](asset:k9)\n![い](${IMG})`);
    expect(r.d.getState().error, '残った 1 件を黙って捨てた').toContain('1 件');
  });
});
