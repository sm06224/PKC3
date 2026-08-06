/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';

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
  };
}

/**
 * 🔴 **読む面はワーカーで描く**(2026-08-06。user 報告 2-8)ので、`render()` の
 * 直後には DOM がまだ無い。1 tick 待つ ── ワーカーの無い環境(happy-dom)でも
 * 結果は microtask で返る。
 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function stateWithBody(body: string) {
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a')],
    relations: [],
  }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body }).state;
  return s;
}

describe('detail: PKC-Markdown text presenter (P3-3)', () => {
  it('renders PKC-Markdown body (dialect included) as HTML', async () => {
    const root = document.createElement('div');
    const detail = new DetailRenderer(buildShell(root).detail);
    detail.render(stateWithBody('# 見出し\n\n==ハイライト== と **強調**'));
    await settle();
    const rendered = root.querySelector('[data-pkc-field="detail-body"]');
    expect(rendered?.querySelector('h1')?.textContent).toContain('見出し');
    expect(rendered?.querySelector('mark')?.textContent).toBe('ハイライト');
    expect(rendered?.querySelector('h1')?.hasAttribute('data-pkc-source-line')).toBe(
      true,
    ); // Split View 用 anchor 契約
  });

  /**
   * 🔴 **記法が無い本文も markdown として描く**(2026-08-06。user 報告 2-6)。
   *
   * かつてここは `<pre>` 等幅に落としていた(PKC2 と同じ門)。だが
   * **編集プレビューと書き出しは markdown で描く**ので、同じ本文が面によって
   * 別物に見えた ── しかも `<pre>` は折り返さないので**横にはみ出す**。
   * PKC3 の founding は「全 body = PKC-Markdown」なので、記法の有無で
   * 描き方を分けない。
   * ⚠ 改行は失われない(`breaks: true` で 1 個の改行が `<br>` になる)。
   */
  it('🔴 記法が無い本文も markdown で描く(面ごとに違う見え方にしない)', async () => {
    const root = document.createElement('div');
    const detail = new DetailRenderer(buildShell(root).detail);
    detail.render(stateWithBody('ただのテキスト 1234'));
    await settle();
    const body = root.querySelector('[data-pkc-field="detail-body"]');
    expect(body?.tagName, '`<pre>` に落ちている(横にはみ出す形)').not.toBe('PRE');
    expect(body?.querySelector('p')?.textContent).toBe('ただのテキスト 1234');
  });

  it('🔴 記法が無い本文でも改行が残る(`<pre>` を外した代償が出ていない)', async () => {
    const root = document.createElement('div');
    const detail = new DetailRenderer(buildShell(root).detail);
    detail.render(stateWithBody('1 行目\n2 行目\n3 行目'));
    await settle();
    const body = root.querySelector('[data-pkc-field="detail-body"]');
    expect(body?.querySelectorAll('br').length, '改行が畳まれた').toBe(2);
    expect(body?.textContent).toContain('2 行目');
  });

  it('applies document globals (attrs + dir) and heading numbers from frontmatter', async () => {
    const root = document.createElement('div');
    const detail = new DetailRenderer(buildShell(root).detail);
    detail.render(
      stateWithBody(
        '---\nwriting: vertical\ndirection: rtl\nheading-number: true\n---\n# 序\n\n## 本',
      ),
    );
    await settle();
    const rendered = root.querySelector('[data-pkc-field="detail-body"]');
    expect(rendered?.getAttribute('data-pkc-writing')).toBe('vertical');
    expect(rendered?.getAttribute('dir')).toBe('rtl');
    // heading-number: true → 見出しにアウトライン番号が前置される(text レベル)
    expect(rendered?.querySelector('h1')?.textContent).toMatch(/^1\.?\s*序|^1\s/);
    expect(rendered?.querySelector('h2')?.textContent).toMatch(/1\.1/);
  });

  /**
   * 🔴 **読む面もワーカーで描く**(2026-08-06。user 報告 2-8)。
   *
   * > user 指示 2026-08-03(不可侵)「基本的に重い処理はワーカーにしてください」
   *
   * ⚠ ここは**下流の結果**(HTML が出たか)だけでは守れない ── 同期に描いても
   * 同じ HTML が出るので、ワーカーを外す変異が素通りする。**口を通ったか**と
   * **通る前は描いていないこと**の両方を見る。
   */
  describe('読む面の描画をワーカーへ逃がす(2-8)', () => {
    /** 決着を test が握る stub(`MarkdownClient` の `render` だけ差す)。 */
    function stub() {
      const calls: string[] = [];
      const settlers: Array<{
        resolve: (html: string) => void;
        reject: (e: unknown) => void;
      }> = [];
      const client = {
        render(text: string): Promise<string> {
          calls.push(text);
          return new Promise((resolve, reject) => settlers.push({ resolve, reject }));
        },
        // 編集の面(プレビュー)は別の口。ここでは何もしない
        follower: () => ({ push: () => {}, flush: () => {}, dispose: () => {} }),
      };
      return { calls, settlers, client } as const;
    }

    function rig(body: string) {
      const s = stub();
      const root = document.createElement('div');
      // ⚠ **document へ繋ぐ** ── 繋がっていないと `bodyHost.isConnected` が
      //   false で毎回骨組みが作り直され、器の同一性の門だけで stale が止まる
      //   (= 世代の弁別を外しても緑になる。実際に変異試験 R2 がそう素通りした)
      document.body.append(root);
      const detail = new DetailRenderer(
        buildShell(root).detail,
        null,
        s.client as unknown as ConstructorParameters<typeof DetailRenderer>[2],
      );
      detail.render(stateWithBody(body));
      const host = () => root.querySelector('[data-pkc-field="detail-body"]');
      return { ...s, root, detail, host };
    }

    it('🔴 口を通る ── 結果が返るまでメインスレッドで描いていない', async () => {
      const r = rig('# ワーカー越し');
      expect(r.calls, 'ワーカーの口を通っていない(その場で描いた)').toEqual([
        '# ワーカー越し',
      ]);
      await settle();
      expect(r.host()?.querySelector('h1'), '結果を待たずに描いている').toBeNull();
      r.settlers[0]!.resolve('<h1>ワーカー越し</h1>');
      await settle();
      expect(r.host()?.querySelector('h1')?.textContent).toBe('ワーカー越し');
    });

    /**
     * ⚠ **器が同じまま**の追い越しを見る。
     *
     * 別のノートへ移る形では骨組みごと作り直すので、**器の同一性の門**
     * (`this.bodyHost !== host`)だけで止まってしまい、世代の弁別を外しても
     * 緑のままだった(変異試験 R2)。同じノートの本文が続けて変わる
     * (追記 → 追記 / 保存の ack)ときは器が同じなので、**世代しか頼りが無い**。
     */
    it('🔴 同じ器への追い越しでも古い結果は載せない(世代で弁別)', async () => {
      const r = rig('# 一');
      r.detail.render(stateWithBody('# 二'));
      expect(r.calls, '同じノートなのに 2 回描いていない').toEqual(['# 一', '# 二']);
      r.settlers[1]!.resolve('<h1>二</h1>');
      r.settlers[0]!.resolve('<h1>一</h1>');
      await settle();
      expect(r.host()?.querySelector('h1')?.textContent, '古い結果に上書きされた').toBe(
        '二',
      );
    });

    it('🔴 古い結果は載せない(選択を素早く動かすと逆順で届く)', async () => {
      const r = rig('# あ');
      let s = reduce(initialState, {
        type: 'SYS_BOOTED',
        cid: 'c1',
        metas: [meta('a'), meta('b')],
        relations: [],
      }).state;
      s = reduce(s, { type: 'SELECT_ENTRY', lid: 'b' }).state;
      s = reduce(s, { type: 'BODY_LOADED', lid: 'b', body: '# い' }).state;
      r.detail.render(s);
      expect(r.calls).toEqual(['# あ', '# い']);
      // 新しいほうが先に返り、古いほうが後から届く
      r.settlers[1]!.resolve('<h1>い</h1>');
      r.settlers[0]!.resolve('<h1>あ</h1>');
      await settle();
      expect(r.host()?.querySelector('h1')?.textContent, '古い結果に上書きされた').toBe(
        'い',
      );
    });

    /**
     * ⚠ **捨てた器へは描かない**。編集へ入ると骨組みごと捨てる(`dropSkeleton`)が、
     * 世代は進まない ── 飛んでいる結果が戻ってきたとき、**世代の門は通ってしまう**。
     * 器の同一性の門が無いと、外れた器へ描いて `<img>` の URL を借り
     * (画面に出ないので返す機会も無い)、`bodyView` と scroll の状態も食い違う。
     */
    it('🔴 編集へ抜けた後に届いた結果は、捨てた器へ描かない', async () => {
      const r = rig('# 読む面');
      const host = r.host()!;
      let s = stateWithBody('# 読む面');
      s = reduce(s, { type: 'START_EDIT' }).state;
      r.detail.render(s);
      r.settlers[0]!.resolve('<h1>読む面</h1>');
      await settle();
      expect(host.querySelector('h1'), '捨てた器へ描いた').toBeNull();
    });

    it('🔴 ワーカーが落ちたらその場で描く(白紙にしない)', async () => {
      const r = rig('# 落ちても出る');
      r.settlers[0]!.reject(new Error('worker died'));
      await settle();
      expect(r.host()?.querySelector('h1')?.textContent).toContain('落ちても出る');
    });
  });

  it('strips frontmatter and expands vars from it', async () => {
    const root = document.createElement('div');
    const detail = new DetailRenderer(buildShell(root).detail);
    detail.render(
      stateWithBody('---\nvars.name: PKC3\n---\n\n# {{vars.name}} の見出し'),
    );
    await settle();
    const rendered = root.querySelector('[data-pkc-field="detail-body"]');
    expect(rendered?.querySelector('h1')?.textContent).toContain('PKC3 の見出し');
    expect(rendered?.textContent).not.toContain('vars.name:');
  });
});
