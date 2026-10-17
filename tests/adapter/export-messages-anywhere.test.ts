/** @vitest-environment happy-dom */
/**
 * 🔴 **「メッセージを書き出す」は、どの画面からでも撃てる**(台帳 #1852 束 L1。依頼 92-1 B)。
 *
 * 直す前は、押しボタンがシステムの画面の中にしか無く、「操作を探す」の「メッセージを書き出す」も
 * 「システムの画面で『メッセージ』を開いているときだけ」押せた ── 未読から開いたメッセージのノートを
 * 読んでいる最中は、バグ報告に出す手が無かった。
 * 守るもの:
 *   ① 押しボタンが画面に無くても、読み出しの口(`readBodies`)が在れば撃てる(一覧で押せる顔になる)
 *   ② 撃つと「メッセージ」の本文を読み、`.md` として落とす
 *   ③ 読み出しの口が無い版では、押せない(嘘の「押せます」を出さない)
 * 守っていないもの:ファイルが実際にディスクへ落ちること(`<a download>` のクリックまで)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { bindActions, commandRowsFor, runGlobalCommand } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { SYSTEM_MESSAGE_LID } from '../../src/features/message/message-log';

const tick = (ms = 30): Promise<unknown> => new Promise((r) => setTimeout(r, ms));
const noop = (): void => {};

function setup(withReader: boolean) {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const store = new KeymapStore();
  const asked: string[] = [];
  const said: string[] = [];
  bindActions(
    root,
    d,
    {
      showStatus: (t) => said.push(t),
      ...(withReader
        ? {
            readBodies: async (lids: readonly string[]) => {
              asked.push(...lids);
              return new Map(lids.map((l) => [l, '## 2026-10-17 10:00:00\n**問題** 書き出す本文\n\n']));
            },
          }
        : {}),
    },
    store,
  );
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  return { root, d, store, asked, said };
}

let clicked = 0;
let realClick: typeof HTMLAnchorElement.prototype.click;
beforeEach(() => {
  clicked = 0;
  realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    clicked += 1;
  };
});
afterEach(() => {
  HTMLAnchorElement.prototype.click = realClick;
  vi.restoreAllMocks();
});

describe('「メッセージを書き出す」は押しボタンが無くても撃てる(依頼 92-1)', () => {
  it('🔴 ① 画面にボタンが 1 つも無いのに、一覧では押せる顔(読み出しの口が在るとき)', () => {
    const env = setup(true);
    expect(env.root.querySelector('[data-pkc-action="export-messages"]'), '前提:ボタンが画面に在る').toBeNull();
    const row = commandRowsFor(env.root, env.d, env.store, '', null).find((r) => r.id === 'export-messages');
    expect(row, '一覧に行が無い').toBeDefined();
    expect(row?.ready, 'ボタンが無いと押せない顔のまま(システムの画面でしか押せない)').toBe(true);
    expect(runGlobalCommand('export-messages', env.root, env.d, env.store, noop, noop, true)).toBe(true);
  });

  it('🔴 ② 撃つと「メッセージ」の本文を読み、.md として落とす', async () => {
    const env = setup(true);
    expect(runGlobalCommand('export-messages', env.root, env.d, env.store, noop, noop)).toBe(true);
    await tick();
    expect(env.asked, 'メッセージの本文を読んでいない').toEqual([SYSTEM_MESSAGE_LID]);
    expect(clicked, '落としていない').toBe(1);
    expect(env.said.some((t) => /^メッセージを書き出しました\(メッセージ-\d{4}-\d{2}-\d{2}\.md\)$/.test(t)), `言っていない: ${env.said.join('/')}`).toBe(true);
  });

  it('🔴 ③ 読み出しの口が無い版(古いタブ)では押せない。撃っても理由を言う', () => {
    const env = setup(false);
    const row = commandRowsFor(env.root, env.d, env.store, '', null).find((r) => r.id === 'export-messages');
    expect(row?.ready, '口が無いのに押せる顔').toBe(false);
    expect(runGlobalCommand('export-messages', env.root, env.d, env.store, noop, noop, true)).toBe(false);
    const said: string[] = [];
    expect(runGlobalCommand('export-messages', env.root, env.d, env.store, noop, (t) => said.push(t))).toBe(true);
    expect(said.join('')).toContain('再読み込み');
    expect(clicked).toBe(0);
  });
});
