/** @vitest-environment happy-dom */
/**
 * 🔴 **録音・録画の最中と切り出し 6 件 + 検索の帯を閉じる 1 件を「操作を探す」に足した**(#582 段③ 第 4 群。
 * 第 1〜3 群は `palette-scene-batch*.test.ts`、同じ作法)。
 *
 * 守るもの(どれも「壊れたら鳴る」形にしてある):
 *  ① **命令 = 画面のボタン**:一覧から呼ぶと、そのボタンが 1 回押され、直接押したときと同じ dispatch 列になる。
 *  ② **押せないときは灰色 + 理由の 1 行**:ボタンが無い間 / `hidden` の中 / `disabled`。
 *  ③ **字は画面のボタンの字と同じ**(ボタンを組む所の近くの字から引く ── 期待値を手で書かない)。
 *  ④ **鍵は付けない**・命令 id は押しボタンの `data-pkc-action` と同じ綴り。
 *  ⑤ **切り出しの端は、押したボタンと同じ行の再生器の時刻を読む**(別の行の録音の位置にならない)。
 *  ⑥ **見送った `discard-capture`**(取り消せない)は登記されていない。
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, commandRowsFor, runGlobalCommand, SHORTCUT_BUTTON } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { NOT_READY_PREFIX } from '../../src/features/palette/palette-rows';
import { KEY_COMMANDS, findCommand } from '../../src/features/keymap';

interface Row {
  readonly id: string;
  /** 画面のボタンの字が書いてある source。 */
  readonly source: string;
  /** 「押せない間」の理由に含まれるべき場面の言葉。 */
  readonly scene: string;
  /** 一覧から呼んだとき、必ず撃たれる dispatch(空 = 空で緑にならないための期待)。`null` は services へ渡る物(収録を止める)/ 再生器が要る物(印 ── ⑤ で見る)。 */
  readonly fires: string | null;
}

const R = 'src/adapter/ui/render/';
const BATCH4: readonly Row[] = [
  { id: 'stop-capture', source: R + 'shell.ts', scene: '録音・録画の最中だけ', fires: null },
  { id: 'capture-stop', source: R + 'captures.ts', scene: '一覧で再生しているとき', fires: 'SET_CAPTURE_PLAYING' },
  { id: 'capture-trim-start', source: R + 'captures.ts', scene: '一覧で再生しているとき', fires: null },
  { id: 'capture-trim-end', source: R + 'captures.ts', scene: '一覧で再生しているとき', fires: null },
  { id: 'capture-trim-run', source: R + 'captures.ts', scene: '始まりと終わりを選んであるとき', fires: null },
  { id: 'capture-trim-clear', source: R + 'captures.ts', scene: '始まりか終わりを選んであるとき', fires: 'CLEAR_CAPTURE_TRIM' },
  { id: 'search-jump-end', source: R + 'search-jump.ts', scene: '一致した所を巡っているとき', fires: 'SEARCH_JUMP_END' },
];

function meta(lid: string, title: string): EntryMeta {
  return {
    lid, title, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1,
    status: null, date: null, archived: false, bodyChars: 0,
  };
}

function setup() {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  const said: string[] = [];
  const store = new KeymapStore();
  bindActions(root, d, { showStatus: (t) => said.push(t) }, store);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', '議事録')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  sent.length = 0;
  return { root, d, sent, said, store };
}
type Env = ReturnType<typeof setup>;

/** 押しボタンを画面に組む。 */
function mount(root: HTMLElement, id: string, opts: { hidden?: boolean } = {}): HTMLButtonElement {
  const wrap = document.createElement('div');
  if (opts.hidden === true) wrap.hidden = true;
  const b = document.createElement('button');
  b.setAttribute('data-pkc-action', id);
  wrap.append(b);
  root.append(wrap);
  return b;
}

const noop = (): void => {};
const run = (env: Env, id: string, dry = false): boolean =>
  runGlobalCommand(id, env.root, env.d, env.store, noop, (t) => env.said.push(t), dry);
const rowOf = (env: Env, id: string) => commandRowsFor(env.root, env.d, env.store, '', null).find((r) => r.id === id);
const shape = (xs: readonly Dispatchable[]): string[] => xs.map((a) => a.type);

beforeEach(() => {
  document.body.innerHTML = '';
  resetAppDialogForTest();
});

describe('第 4 群 7 件の登記(#582 段③)', () => {
  it('④ 全部が KEY_COMMANDS に在り、鍵を持たず、受け手は押しボタン(id = data-pkc-action)', () => {
    expect(BATCH4.length).toBe(7);
    for (const { id } of BATCH4) {
      const c = findCommand(id);
      expect(c, `${id} が KEY_COMMANDS に無い`).toBeDefined();
      expect(c?.defaults, `${id} に鍵が付いている`).toEqual([]);
      expect(c?.contexts, `${id} は全域`).toEqual(['global']);
      expect((c?.note ?? '').length, `${id} に説明(押せない理由を兼ねる)が無い`).toBeGreaterThan(0);
      expect(SHORTCUT_BUTTON[id], `${id} の受け手(押しボタン)が無い`).toBe(`[data-pkc-action="${id}"]`);
    }
    expect(new Set(KEY_COMMANDS.map((c) => c.id)).size).toBe(KEY_COMMANDS.length);
  });

  it('⑥ 見送った `discard-capture`(取り消せない)は登記していない', () => {
    expect(findCommand('discard-capture')).toBeNull();
    expect(SHORTCUT_BUTTON['discard-capture']).toBeUndefined();
  });

  /** ボタンを組んでいる所(その action を属性として置く行の近く)。⚠ file 全体の `includes` にしない(別のボタンの字に満たされる)。 */
  const NEAR = 700;
  const builtAt = (src: string, id: string): string[] => {
    const re = new RegExp(`(?:data-pkc-action['"\`],\\s*|action:\\s*|iconButton\\(\\s*|button\\(\\s*)['"]${id}['"]`, 'g');
    return [...src.matchAll(re)].map((m) => src.slice(Math.max(0, m.index! - NEAR), m.index! + NEAR));
  };

  it('③ 一覧の字は、そのボタンを組んでいる所の近くに在る画面の字と同じ', () => {
    for (const r of BATCH4) {
      const label = findCommand(r.id)?.label ?? '';
      expect(label, `${r.id} の字が空`).not.toBe('');
      const spots = builtAt(readFileSync(r.source, 'utf-8'), r.id);
      expect(spots.length, `${r.id}: 画面(${r.source})に、この action のボタンを組む所が無い`).toBeGreaterThan(0);
      expect(spots.some((w) => w.includes(`'${label}'`)), `${r.id}: ボタンを組む所の近くに「${label}」が無い`).toBe(true);
    }
  });

  it('③ 空振り防止:近くの字で見る門は、同じ file の別のボタンの字では満たされない', () => {
    const spots = builtAt(readFileSync(R + 'captures.ts', 'utf-8'), 'capture-trim-start');
    expect(spots.some((w) => w.includes("'ここを始まりにする'")), '前提:自分の字は近くに在る').toBe(true);
    expect(spots.some((w) => w.includes("'選んだ範囲を消す'")), '離れた別のボタンの字に満たされている').toBe(false);
  });

  it('① 一覧から呼ぶと、画面のボタンが 1 回押され、直接押したときと同じ dispatch 列になる', () => {
    for (const r of BATCH4) {
      const viaBtn = setup();
      const b1 = mount(viaBtn.root, r.id);
      b1.click();
      const direct = shape(viaBtn.sent);

      const viaPalette = setup();
      const b2 = mount(viaPalette.root, r.id);
      let n = 0;
      b2.addEventListener('click', () => n++);
      expect(run(viaPalette, r.id), `${r.id}: 呼べなかった`).toBe(true);
      expect(n, `${r.id}: ボタンが 1 回押されていない`).toBe(1);
      expect(shape(viaPalette.sent), `${r.id}: ボタンを直接押したときと違う`).toEqual(direct);
    }
  });

  it('① 空振り防止:撃つはずの物は、本当にその dispatch を撃っている(空 = 空で緑にしない)', () => {
    for (const r of BATCH4.filter((x) => x.fires !== null)) {
      const env = setup();
      mount(env.root, r.id);
      expect(run(env, r.id)).toBe(true);
      expect(shape(env.sent), r.id).toContain(r.fires);
    }
  });

  it('① 切り出し:印が揃っていれば受け手に届き(配線が無い台では理由を言う)、揃っていなければ何も撃たない', () => {
    const marked = (): Env => {
      const env = setup();
      env.d.dispatch({ type: 'SET_CAPTURE_PLAYING', lid: 'a' });
      env.d.dispatch({ type: 'SET_CAPTURE_TRIM_MARK', edge: 'start', ms: 1000 });
      env.d.dispatch({ type: 'SET_CAPTURE_TRIM_MARK', edge: 'end', ms: 3000 });
      mount(env.root, 'capture-trim-run');
      env.sent.length = 0;
      return env;
    };
    const env = marked();
    expect(run(env, 'capture-trim-run')).toBe(true);
    expect(shape(env.sent), '印が揃っているのに切り出しの受け手へ届いていない').toContain('OP_FAILED');
    // 対照群:印が無ければ(同じ台で消してから)受け手は何も撃たない
    const none = marked();
    none.d.dispatch({ type: 'CLEAR_CAPTURE_TRIM' });
    none.sent.length = 0;
    run(none, 'capture-trim-run');
    expect(shape(none.sent), '印が無いのに切り出そうとした').toEqual([]);
    // 消す側:印が在れば消える
    const clr = marked();
    mount(clr.root, 'capture-trim-clear');
    run(clr, 'capture-trim-clear');
    expect(clr.d.getState().captureTrim, '一覧から呼んだのに印が残っている').toBeNull();
  });

  it('⑤ 切り出しの端は、押したボタンと同じ行の再生器の時刻を読む(別の行の位置にならない)', () => {
    for (const [id, edge] of [['capture-trim-start', 'start'], ['capture-trim-end', 'end']] as const) {
      const env = setup();
      // 先に別の行(1 行目)に再生器を置く ── 2 行目のボタンを呼んだとき、こちらを読んではならない
      const mk = (lid: string, sec: number, withButton: boolean): void => {
        const li = document.createElement('li');
        li.setAttribute('data-pkc-capture', lid);
        const media = document.createElement('audio');
        media.setAttribute('data-pkc-field', 'capture-media');
        Object.defineProperty(media, 'currentTime', { value: sec, configurable: true });
        li.append(media);
        if (withButton) {
          const b = document.createElement('button');
          b.setAttribute('data-pkc-action', id);
          li.append(b);
        }
        env.root.append(li);
      };
      mk('other', 99, false);
      mk('mine', 2, true);
      expect(run(env, id)).toBe(true);
      expect(env.sent.find((a) => a.type === 'SET_CAPTURE_TRIM_MARK'), id).toMatchObject({ edge, ms: 2000 });
    }
  });
});

describe('② 押せないときは灰色 + 理由の 1 行', () => {
  it('ボタンが画面に無い間は、7 件とも押せず、理由は説明の末尾から引く(場面の言葉が出る)', () => {
    const env = setup();
    const rows = commandRowsFor(env.root, env.d, env.store, '', null);
    for (const r of BATCH4) {
      const row = rows.find((x) => x.id === r.id);
      expect(row, `${r.id} が一覧に無い`).toBeDefined();
      expect(row?.ready, `${r.id}: ボタンが無いのに押せる顔`).toBe(false);
      expect(row?.why.startsWith(NOT_READY_PREFIX), `${r.id}: 理由が無い`).toBe(true);
      expect(row?.why, `${r.id}: 場面の言葉が理由に無い`).toContain(r.scene);
      expect(run(env, r.id, true), `${r.id}: dry が真`).toBe(false);
    }
  });

  it('ボタンが在れば押せる(灰色が「在るのに押せない」になっていない)', () => {
    const env = setup();
    for (const r of BATCH4) mount(env.root, r.id);
    const rows = commandRowsFor(env.root, env.d, env.store, '', null);
    for (const r of BATCH4) expect(rows.find((x) => x.id === r.id)?.ready, r.id).toBe(true);
  });

  it('`hidden` の中に居るボタンは押せない(別のタブへ移った後の面を「押せます」と言わない)', () => {
    for (const r of BATCH4) {
      const env = setup();
      mount(env.root, r.id, { hidden: true });
      expect(rowOf(env, r.id)?.ready, `${r.id}: 隠れているのに押せる顔`).toBe(false);
      expect(run(env, r.id), `${r.id}: 隠れているのに走った`).toBe(false);
      expect(env.sent, `${r.id}: 隠れた物が動いた`).toEqual([]);
    }
  });

  it('`disabled` のボタン(切り出し中は印を打たせない)は押せない', () => {
    const env = setup();
    const b = mount(env.root, 'capture-trim-start');
    b.disabled = true;
    expect(rowOf(env, 'capture-trim-start')?.ready).toBe(false);
    expect(run(env, 'capture-trim-start', true)).toBe(false);
  });
});
