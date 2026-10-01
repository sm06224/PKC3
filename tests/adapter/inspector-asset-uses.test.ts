/** @vitest-environment happy-dom */
/**
 * 🔴 **右の列の「添付」の行 → 本文でそれを使っている場所へ飛んで光る**(#1170)。
 *
 * 守る主張:
 * 1. 本文が使っている添付が**本文の順**で並ぶ。使っていなければ**行ごと畳む**(`<dt>` も)
 * 2. 同じ添付を何度使っていても 1 行 ── 押すと**最初の場所**へ飛び、**そこだけ**光る
 * 3. 🔴 編集中は目次と**同じ断り文**で断る / 見つからなければ理由を出す(無言にしない)
 * 4. 畳んだ章の中でも、開いてから飛ぶ
 * 5. 🔴 飛んだ後に画像が読み込まれて位置がずれたら、送り直す(lazy な画像)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { bindActions } from '../../src/adapter/ui/actions/binder';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
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

const BODY = [
  '# 章',
  '',
  '![設計図](asset:ast-a)',
  '',
  '[仕様書.pdf](asset:ast-b)',
  '',
  '```md',
  '![in-fence](asset:ast-code)',
  '```',
  '',
  'もう一度 ![設計図 2](asset:ast-a)',
].join('\n');

beforeEach(() => {
  document.body.textContent = '';
});

function setup(body: string | null, resolver?: (key: string) => Promise<string | null>) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const inspector = new InspectorRenderer(regions.inspector);
  if (resolver) inspector.setAssetNameResolver(resolver);
  d.onState((s) => inspector.render(s));
  bindActions(root, d);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  if (body !== null) d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  return { root, d };
}

/** ⚠ 押した後は 1 tick 待つ(`jump-to-asset-use` は async ── 目次と同じ作法)。 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const rows = (root: HTMLElement): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('[data-pkc-action="jump-to-asset-use"]'),
];
const box = (root: HTMLElement): HTMLElement =>
  root.querySelector<HTMLElement>('[data-pkc-field="inspector-assets"]')!;

/** 本文の面に、描かれた添付参照(実物と同じ属性)を置く。 */
function plant(root: HTMLElement, specs: { key: string; tag?: 'img' | 'a' | 'fence' }[]) {
  const detail = root.querySelector<HTMLElement>('[data-pkc-region="detail"]')!;
  const host = document.createElement('div');
  host.setAttribute('data-pkc-field', 'detail-body');
  host.setAttribute('data-pkc-painted', 'n1');
  const made: HTMLElement[] = [];
  for (const s of specs) {
    let el: HTMLElement;
    if (s.tag === 'fence') {
      el = document.createElement('div');
      el.setAttribute('data-pkc-fence-asset-key', s.key);
    } else if (s.tag === 'a') {
      el = document.createElement('a');
      el.className = 'pkc-asset-link';
      el.setAttribute('data-pkc-asset-key', s.key);
    } else {
      el = document.createElement('img');
      el.className = 'pkc-asset-ref';
      el.setAttribute('data-pkc-asset-key', s.key);
    }
    el.scrollIntoView = vi.fn();
    host.append(el);
    made.push(el);
  }
  detail.append(host);
  return { host, made };
}

describe('添付の行(#1170)', () => {
  it('🔴 本文が使っている添付が本文の順に並ぶ(囲みの中の asset: は入らない / 同じ物は 1 行)', () => {
    const { root } = setup(BODY);
    expect(rows(root).map((b) => [b.textContent, b.getAttribute('data-pkc-asset-key')])).toEqual([
      ['設計図', 'ast-a'],
      ['仕様書.pdf', 'ast-b'],
    ]);
    expect(box(root).hidden).toBe(false);
  });

  it('🔴 使っていなければ行ごと畳む(<dt> も一緒に)', () => {
    const { root } = setup('添付なしの本文\n');
    expect(box(root).hidden).toBe(true);
    expect((box(root).previousElementSibling as HTMLElement).hidden, '見出しだけ残った').toBe(true);
    expect(rows(root)).toHaveLength(0);
  });

  it('本文が読めていないときも出さない', () => {
    const { root } = setup(null);
    expect(box(root).hidden).toBe(true);
  });

  it('🔴 足せばその場で出る', () => {
    const { root, d } = setup('なし\n');
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '![x](asset:k1)\n' });
    expect(box(root).hidden, '足したのに出ない').toBe(false);
    expect(rows(root).map((b) => b.textContent)).toEqual(['x']);
  });

  it('名前が空の参照は key を短くして出す(元の file 名を引く口が無いとき)', () => {
    const { root } = setup('![](asset:ast-0123456789abcdef)\n');
    expect(rows(root)[0]!.textContent).toBe('ast-0123…');
  });
});

/**
 * 🔴 **見出しは「本文で使う添付」、説明文が空なら元の file 名**(#1207 I4。🟣 Gemini 裁定 2026-10-01 = A)。
 *
 * 右の列の「添付」は、押すと添付ではなく本文の使っている場所へ飛ぶ ── 名前が「添付」だけだと、
 * 添付の一覧に見える。説明文の空の画像は、内部の id(`ast-0123…`)が行の字になっていた。
 */
describe('「本文で使う添付」の名前(#1207 I4)', () => {
  const EMPTY = '![](asset:ast-0123456789abcdef)\n';
  const headingOf = (root: HTMLElement): string =>
    (box(root).previousElementSibling as HTMLElement).textContent ?? '';

  it('🔴 見出しの字は「本文で使う添付」(「添付」だけだと一覧に見える)', () => {
    const { root } = setup(BODY);
    expect(headingOf(root)).toBe('本文で使う添付');
  });

  it('🔴 説明文が空なら、引けた元の file 名を出す(押す先の key は変わらない)', async () => {
    const resolve = vi.fn(async () => '現場写真.png' as string | null);
    const { root } = setup(EMPTY, resolve);
    await settle();
    expect(resolve, '元の名前を引いていない').toHaveBeenCalledWith('ast-0123456789abcdef');
    expect(rows(root)[0]!.textContent, '内部の id のまま').toBe('現場写真.png');
    expect(rows(root)[0]!.title, '説明も名前になっていない').toContain('「現場写真.png」');
    expect(rows(root)[0]!.getAttribute('data-pkc-asset-key')).toBe('ast-0123456789abcdef');
  });

  it('🔴 説明文が在るなら説明文を出し、名前は引かない(対照群)', async () => {
    const resolve = vi.fn(async () => '別の名前.png' as string | null);
    const { root } = setup('![設計図](asset:ast-a)\n', resolve);
    await settle();
    expect(rows(root)[0]!.textContent).toBe('設計図');
    expect(resolve, '説明文が在るのに名前を引いた').not.toHaveBeenCalled();
  });

  it('🔴 名前が分からない(null / 引けない)ときは今までどおり id を短くして出す', async () => {
    const none = setup(EMPTY, async () => null);
    await settle();
    expect(rows(none.root)[0]!.textContent).toBe('ast-0123…');
    document.body.textContent = '';
    const failed = setup(EMPTY, async () => {
      throw new Error('worker down');
    });
    await settle();
    expect(rows(failed.root)[0]!.textContent, '引けないときに行が消えた / 壊れた').toBe('ast-0123…');
  });

  it('🔴 描き直しのたびには引かない(1 つの key につき 1 度)/ 引けた名前は描き直しでも残る', async () => {
    const resolve = vi.fn(async () => '現場写真.png' as string | null);
    const { root, d } = setup(EMPTY, resolve);
    await settle();
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: EMPTY + '\n追記\n' });
    await settle();
    expect(resolve.mock.calls.length, '描き直しのたびに引いている').toBe(1);
    expect(rows(root)[0]!.textContent, '描き直したら名前が id へ戻った').toBe('現場写真.png');
  });
});

describe('押すと本文のその場所へ飛んで光る(#1170)', () => {
  it('🔴 同じ添付が 2 回在るとき、最初の 1 つへ飛び、そこだけ光る', async () => {
    const { root } = setup(BODY);
    const { made } = plant(root, [{ key: 'ast-a' }, { key: 'ast-b', tag: 'a' }, { key: 'ast-a' }]);
    rows(root)[0]!.click();
    await settle();
    expect(made[0]!.scrollIntoView, '最初の出現へ飛んでいない').toHaveBeenCalledWith({
      block: 'center',
    });
    expect(made[2]!.scrollIntoView, '最後の出現へ飛んだ').not.toHaveBeenCalled();
    expect(made[0]!.getAttribute('data-pkc-flash'), '光っていない').toBe('true');
    expect(made[2]!.hasAttribute('data-pkc-flash'), '別の出現が光った').toBe(false);
    expect(made[1]!.scrollIntoView, '別の添付へ飛んだ').not.toHaveBeenCalled();
  });

  it('🔴 2 行目は 2 つ目の添付(リンク)へ飛ぶ。囲みも飛び先になる', async () => {
    const { root } = setup(BODY + '\n\n```csv asset:ast-c\n```\n');
    const { made } = plant(root, [
      { key: 'ast-a' },
      { key: 'ast-b', tag: 'a' },
      { key: 'ast-c', tag: 'fence' },
    ]);
    expect(rows(root)).toHaveLength(3);
    rows(root)[1]!.click();
    await settle();
    expect(made[1]!.scrollIntoView).toHaveBeenCalled();
    rows(root)[2]!.click();
    await settle();
    expect(made[2]!.scrollIntoView, '囲みへ飛んでいない').toHaveBeenCalled();
  });

  it('🔴 同じ key が別の面(情報ペインなど)に在っても、本文の面へ飛ぶ', async () => {
    const { root } = setup(BODY);
    const other = document.createElement('img');
    other.className = 'pkc-asset-ref';
    other.setAttribute('data-pkc-asset-key', 'ast-a');
    other.scrollIntoView = vi.fn();
    root.querySelector('[data-pkc-region="inspector"]')!.prepend(other);
    const { made } = plant(root, [{ key: 'ast-a' }]);
    rows(root)[0]!.click();
    await settle();
    expect(made[0]!.scrollIntoView).toHaveBeenCalled();
    expect(other.scrollIntoView, '別の面へ飛んだ').not.toHaveBeenCalled();
  });

  it('🔴 見つからなければ理由を出す(無言にしない)。編集していないのに編集の断り文は出さない', async () => {
    const { root, d } = setup(BODY);
    rows(root)[0]!.click();
    await settle();
    expect(d.getState().notice ?? '', '押しても何も起きない').toContain('本文に見つかりませんでした');
    expect(d.getState().error ?? '', '編集していないのに断り文が出た').not.toContain('編集中');
  });

  it('🔴 編集中は目次と同じ断り文で断る(飛ばない)', async () => {
    const { root, d } = setup(BODY);
    d.dispatch({ type: 'START_EDIT' });
    rows(root)[0]!.click();
    await settle();
    expect(d.getState().error ?? '', '編集中の断り文が出ない').toContain(
      '編集中は本文が表示されていないので移動できません',
    );
    expect(d.getState().notice ?? '', '編集中なのに「見つからない」と言った').not.toContain(
      '見つかりませんでした',
    );
  });

  it('🔴 畳んだ章の中の添付へは、開いてから飛ぶ', async () => {
    const { root } = setup(BODY);
    const detail = root.querySelector<HTMLElement>('[data-pkc-region="detail"]')!;
    const host = document.createElement('div');
    host.setAttribute('data-pkc-field', 'detail-body');
    host.setAttribute('data-pkc-painted', 'n1');
    const chapter = document.createElement('h1');
    chapter.setAttribute('data-pkc-folded', '');
    const wrap = document.createElement('p');
    wrap.hidden = true;
    const img = document.createElement('img');
    img.className = 'pkc-asset-ref';
    img.setAttribute('data-pkc-asset-key', 'ast-a');
    img.scrollIntoView = vi.fn();
    wrap.append(img);
    host.append(chapter, wrap);
    detail.append(host);
    rows(root)[0]!.click();
    await settle();
    expect(wrap.hidden, '畳みを開いていない(hidden のままでは飛べない)').toBe(false);
    expect(img.scrollIntoView, '飛んでいない').toHaveBeenCalled();
  });

  it('🔴 飛んだ後に画像が読み込まれたら送り直す(lazy な画像で位置がずれる)', async () => {
    const { root } = setup(BODY);
    const { host, made } = plant(root, [{ key: 'ast-a' }]);
    rows(root)[0]!.click();
    await settle();
    const first = vi.mocked(made[0]!.scrollIntoView).mock.calls.length;
    expect(first).toBe(1);
    // 上のほうの画像が育った(load は bubble しない ── 捕まえる側で聞いている)
    const above = document.createElement('img');
    host.prepend(above);
    above.dispatchEvent(new Event('load'));
    expect(
      vi.mocked(made[0]!.scrollIntoView).mock.calls.length,
      '読み込みの後に送り直していない',
    ).toBe(first + 1);
    // user が自分で動かしたら、引き戻さない
    document.dispatchEvent(new Event('wheel'));
    above.dispatchEvent(new Event('load'));
    expect(
      vi.mocked(made[0]!.scrollIntoView).mock.calls.length,
      'user が動かした後も引き戻した',
    ).toBe(first + 1);
  });
});
