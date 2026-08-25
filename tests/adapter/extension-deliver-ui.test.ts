/** @vitest-environment happy-dom */
/**
 * 🔴 **「このアプリへ送る」の動線**(#195 / C-5 段②-b)。
 *
 * ⚠ 封筒と台帳の規則は `tests/features/ext-*.test.ts` /
 *   `tests/adapter/extension-links.test.ts` が見る。**ここが見るのは繋がり**である ──
 *   押した所から、待って、読んで、渡すまで届くか。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import type { ExtDeliveredEntry } from '../../src/features/extension/ext-delivery';

const meta = (lid: string, title: string): EntryMeta => ({
  lid,
  title,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: 3,
});

function setup(opts: { deliverOk?: boolean; withServices?: boolean } = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  /**
   * ⚠ **情報ペインだけを本物で組む** ── shell 全部を建てると、この test が
   *   見たいもの(押した所から渡すまでの繋がり)と関係ない面の事情で落ちる。
   * 🔑 押す口は `bindActions` の root の中に居ればよい。
   */
  const region = document.createElement('div');
  root.append(region);
  const inspector = new InspectorRenderer(region);
  const d = new Dispatcher();
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;

  /** 🔑 **呼ばれた順**を採る ── この test の主眼はそこである。 */
  const calls: string[] = [];
  const delivered: ExtDeliveredEntry[] = [];
  const status: string[] = [];
  const services = opts.withServices === false
    ? {}
    : {
        settle: () => {
          calls.push('settle');
          // ⚠ **すぐ解決しない** ── 同期に解決すると「待った」と「待たなかった」が
          //    区別できず、`settle` を外す変異が生き延びる
          return new Promise<void>((r) => setTimeout(r, 0));
        },
        readBodies: (lids: readonly string[]) => {
          calls.push('readBodies');
          return Promise.resolve(new Map(lids.map((l) => [l, `本文:${l}`])));
        },
        deliverToExtension: (id: string, entry: ExtDeliveredEntry) => {
          calls.push(`deliver:${id}`);
          delivered.push(entry);
          return opts.deliverOk !== false;
        },
        showStatus: (t: string) => status.push(t),
      };
  bindActions(root, d, services);
  // ⚠ **state が動いたら描き直す** ── 実物の配線と同じ形にしないと、
  //    「憶えても画面が変わらない」(#393)をこの test が見逃す
  d.onState((st) => inspector.render(st));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', '買い物')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  sent.length = 0;
  return { root, d, sent, calls, delivered, status };
}

const openOne = (d: Dispatcher): void => {
  d.dispatch({
    type: 'SET_OPEN_EXTENSIONS',
    open: [{ id: 'ext-1', appId: 'app-a', title: '地図アプリ' }],
  });
};

/** ⚠ `void Promise…` を待つ ── 同期の `it` から呼ぶと空振りする(CLAUDE.md §1)。 */
const settleTicks = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
};

describe('情報ペインから拡張へ送る (#195 段②-b)', () => {
  it('🔴 開いている拡張が 0 件のときは、行ごと畳む', () => {
    const { root } = setup();
    const box = root.querySelector<HTMLElement>('[data-pkc-field="inspector-ext-send"]');
    expect(box, '器そのものは 1 度だけ組む作りなので在るはず').not.toBeNull();
    expect(box!.hidden, '送り先が無いのに行が出ている').toBe(true);
    expect(
      root.querySelectorAll('[data-pkc-action="deliver-to-extension"]'),
      '押せない送り先が出ている',
    ).toHaveLength(0);
  });

  it('🔴 窓が開くと、その窓の名前のボタンが出る', () => {
    const { root, d } = setup();
    openOne(d);
    const btns = root.querySelectorAll<HTMLElement>('[data-pkc-action="deliver-to-extension"]');
    expect(btns, '開いたのにボタンが出ていない').toHaveLength(1);
    expect(btns[0]!.textContent).toBe('地図アプリ');
    expect(btns[0]!.getAttribute('data-pkc-ext-link')).toBe('ext-1');
    // ⚠ 文言は**起きること**で書く(user 指示 2026-08-21)
    expect(btns[0]!.title).toContain('「買い物」の本文を「地図アプリ」へ送ります');
    expect(
      root.querySelector<HTMLElement>('[data-pkc-field="inspector-ext-send"]')!.hidden,
    ).toBe(false);
  });

  /**
   * 🔴 **この test がこの file の主眼である。**
   *
   * ⚠ 書込は effect 層の chain に直列化されるが、**読みはその外**に在る
   *   (CLAUDE.md §7、2026-08-17 に書き出しが 11/12 で古い本文を出した)。
   *   待たずに読むと、保存の直後に押したとき**保存前の本文**が拡張へ渡る。
   * 🔑 だから観測点は「送れたこと」ではなく **`settle` → `readBodies` の順**である。
   *   ⚠ 「送れたこと」だけ見る test は、`settle` を外す変異を 1 つも殺さない。
   */
  it('🔴 飛んでいる書込を待ってから本文を読む(順番で見る)', async () => {
    const { root, d, calls, delivered } = setup();
    openOne(d);
    root.querySelector<HTMLElement>('[data-pkc-action="deliver-to-extension"]')!.click();
    await settleTicks();
    expect(calls, '待つ前に読んでいる(古い本文が渡る)').toEqual([
      'settle',
      'readBodies',
      'deliver:ext-1',
    ]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.lid).toBe('n1');
    expect(delivered[0]!.body).toBe('本文:n1');
    expect(delivered[0]!.title).toBe('買い物');
  });

  it('送れたら、そう言う', async () => {
    const { root, d, status } = setup();
    openOne(d);
    root.querySelector<HTMLElement>('[data-pkc-action="deliver-to-extension"]')!.click();
    await settleTicks();
    expect(status.join('')).toContain('「買い物」を「地図アプリ」へ送りました');
  });

  /**
   * 🔴 **押しても無言、を作らない。** 窓が閉じた直後は `false` が返る ──
   * ⚠ そこで黙ると、user は「送った」と思ったまま何も起きない。
   */
  it('🔴 送れなかったら、理由を出す', async () => {
    const { root, d, sent, status } = setup({ deliverOk: false });
    openOne(d);
    sent.length = 0;
    root.querySelector<HTMLElement>('[data-pkc-action="deliver-to-extension"]')!.click();
    await settleTicks();
    const failed = sent.find((a) => a.type === 'OP_FAILED');
    expect(failed, '送れなかったのに黙っている').toBeDefined();
    expect(JSON.stringify(failed)).toContain('地図アプリ');
    expect(status, '送れていないのに送ったと言っている').toHaveLength(0);
  });

  /** ⚠ 口の無い配線(旧い版 / test の fake)では、断るだけで他は壊れない。 */
  it('口が無い版では「送れません」と断る', async () => {
    const { root, d, sent } = setup({ withServices: false });
    openOne(d);
    sent.length = 0;
    root.querySelector<HTMLElement>('[data-pkc-action="deliver-to-extension"]')!.click();
    await settleTicks();
    expect(sent.some((a) => a.type === 'OP_FAILED')).toBe(true);
  });
});
