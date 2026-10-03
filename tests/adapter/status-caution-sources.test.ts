/** @vitest-environment happy-dom */
/**
 * 🔴 **断り・失敗の知らせは、出す側で「注意」と宣言して渡す**(#1305 の着地後レビュー)。
 *
 * ## 何が画面で変わるか
 * 直す前は、「コピーできませんでした(ブラウザが断りました)」「この操作はいま実行できません」
 * 「本文が開いていません」等が **種類なし(= 結果)** で `showStatus` へ渡り、**6 秒で消えて未読にもならなかった**
 * (読む前に消える / メッセージの未読に数えられない)。いまは `caution` を渡すので、次の知らせまで残り、未読に数える。
 *
 * ## 数えた範囲(2026-10-03、`grep -n showStatus src/adapter/ui/actions/*.ts src/main.ts` = 100 行を全数)
 * - 断りとして `caution` を付けた(binder.ts 10 か所):最近開いた他のノートが無い / スタックに載せる(載せてある)
 *   ノートが無い / この操作はいま実行できない ×2 / コピーできませんでした(履歴の「使う」)/ 追記の欄が見つからない /
 *   本文が開いていない / コードの枠が見つからない / 書庫の一覧を組めなかった
 * - 結果のまま残した(理由つき):`OFFICE_DECLINED_NOTICE`(user が「やめる」を選んだ結果 ── `status-notice.test.ts` が
 *   対照として pin 済み)/ 音を出せなかった(帯でお知らせする代わりの案内)/「選んだ物が空だったので、何も入れていません」/
 *   「未参照の添付データはありません」(用が無かっただけ)/ 「開けます ── …」(案内)
 * - ⚠ 失敗の多くは元から `OP_FAILED`(エラーの欄)か `kind` つきで出ている ── ここの対象は**種類を付け忘れていた物**だけ
 *
 * ⚠ 守っていないもの:字の末尾から推定する sink は**意図して作っていない**(字が変わった日に黙って外れるので、出す側で宣言)。
 *   だから**新しい断りを足した人が `caution` を忘れる**ことは、この test では止められない(上の census の更新が要る)。
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appCopyHistory } from '../../src/adapter/platform/copy-history-store';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, runCommandRow, runGlobalCommand } from '../../src/adapter/ui/actions/binder';
import type { CommandEnv } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import type { StatusOptions } from '../../src/adapter/ui/render/status-notice';
import { buildShell } from '../../src/adapter/ui/render/shell';
import type { KeyCommand } from '../../src/features/keymap';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: lid,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: 0,
});

interface Said {
  text: string;
  opts: StatusOptions | undefined;
}

function setup(metas: EntryMeta[] = [meta('n1'), meta('n2')]) {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  const said: Said[] = [];
  const store = new KeymapStore();
  bindActions(root, d, { showStatus: (text, opts) => said.push({ text, opts }) }, store);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  return { root, d, said, store };
}

const click = (root: Element, action: string, attrs: Record<string, string> = {}): void => {
  const b = document.createElement('button');
  b.setAttribute('data-pkc-action', action);
  for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
  root.append(b);
  b.click();
};

afterEach(() => {
  vi.restoreAllMocks();
  appCopyHistory.clear();
  document.body.innerHTML = '';
});

describe('断りは caution で出る(挙動)', () => {
  it('🔴 他に開いたノートが無い(最近開いた)', () => {
    const { root, said } = setup([meta('n1'), meta('n2')]);
    click(root, 'open-recent');
    expect(said).toEqual([{ text: '最近開いた他のノートがありません', opts: { kind: 'caution' } }]);
  });

  it('🔴 スタックに載せるノートが無い / 載せてあるノートが無い(鍵・パレットの共通の道)', () => {
    const { root, d, store } = setup();
    const said: Said[] = [];
    const notify = (text: string, opts?: StatusOptions): void => void said.push({ text, opts });
    // 何も選んでいない = 載せる対象が無い
    expect(runGlobalCommand('stack-push', root, d, store, () => {}, notify)).toBe(true);
    expect(runGlobalCommand('stack-open', root, d, store, () => {}, notify)).toBe(true);
    expect(said.map((s) => s.text)).toEqual([
      'スタックに載せるノートがありません(先にノートを開いてください)',
      'スタックに載せてあるノートがありません',
    ]);
    for (const s of said) expect(s.opts, `${s.text}: 注意で渡していない`).toEqual({ kind: 'caution' });
  });

  describe('左の列の操作の行(runCommandRow)', () => {
    const WITH: KeyCommand = {
      id: 'x-with-entry',
      label: '相手を選ぶ操作',
      contexts: ['global'],
      defaults: [],
      needs: 'entry',
    };
    const UNKNOWN: KeyCommand = {
      id: 'x-not-runnable',
      label: '押せなくなった操作',
      contexts: ['global'],
      defaults: [],
    };
    function envOf() {
      const { root, d, store } = setup();
      const said: Said[] = [];
      const env: CommandEnv = {
        root,
        dispatcher: d,
        keymap: store,
        notify: (text, opts) => void said.push({ text, opts }),
      };
      return { env, said };
    }

    it('🔴 実体が無い操作 / 描いた後に押せなくなった操作は、注意で断る', () => {
      const a = envOf();
      expect(runCommandRow(WITH.id, a.env, { commands: [WITH], withEntry: {} })).toBe(false);
      const b = envOf();
      expect(runCommandRow(UNKNOWN.id, b.env, { commands: [UNKNOWN], withEntry: {} })).toBe(false);
      for (const s of [...a.said, ...b.said]) {
        expect(s.text).toBe('この操作はいま実行できません');
        expect(s.opts, '断りを結果のまま渡した(6 秒で消える)').toEqual({ kind: 'caution' });
      }
      expect(a.said).toHaveLength(1);
      expect(b.said).toHaveLength(1);
    });
  });

  /**
   * 🔴 **配線を通す**(着地後レビューの変異 G2)。上の 2 つは `runGlobalCommand` / `runCommandRow` を**直に**呼ぶので、
   * `binder` の押し・鍵が `showStatus` へ渡す**薄い包み**(`(t, o) => showStatus(t, o)`)が `opts` を落としても緑だった。
   * ここは本物の押し(`run-command-row`)と本物の鍵(`Alt+Shift+S` = スタックに載せる)から通す。
   */
  it('🔴 押しから(左の列の操作の行)も、鍵からも、断りが caution のまま画面下の口へ届く', () => {
    const a = setup();
    // 左の列の行: 「ルビ」は本文の欄が無いと実行できない(= 描いた後に押せなくなった回と同じ断り)
    click(a.root, 'run-command-row', { 'data-pkc-command': 'format-ruby' });
    expect(a.said).toEqual([{ text: 'この操作はいま実行できません', opts: { kind: 'caution' } }]);

    // 鍵: 何も選んでいないときの「スタックに載せる」
    const b = setup();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'S', code: 'KeyS', altKey: true, shiftKey: true }),
    );
    expect(b.said.map((x) => x.text)).toEqual(['スタックに載せるノートがありません(先にノートを開いてください)']);
    expect(b.said[0]!.opts, '鍵から渡した断りが結果のまま届いた').toEqual({ kind: 'caution' });
  });

  it('🔴 本文が開いていない / コードの枠が見つからない(コードの枠の編集)', () => {
    const a = setup();
    click(a.root, 'edit-code-block'); // 本文を開いていない
    expect(a.said).toEqual([
      { text: '本文が開いていません(ノートを開いてから押してください)', opts: { kind: 'caution' } },
    ]);
    const b = setup();
    b.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    b.d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文' });
    click(b.root, 'edit-code-block'); // 開いているが、刻印のある塊の中ではない
    expect(b.said).toEqual([
      { text: 'このコードの枠が見つかりません(本文を開き直してください)', opts: { kind: 'caution' } },
    ]);
  });

  it('🔴 コピー履歴の「使う」でブラウザが断ったら、注意で言う(対照:成功は結果のまま)', async () => {
    appCopyHistory.push({ at: 1, text: 'あいう', html: '' });
    const { root, said } = setup();
    // 書込が断られる環境(clipboard が投げ、`execCommand` も無い)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
    click(root, 'use-copied', { 'data-pkc-copied': '0' });
    await vi.waitFor(() => expect(said).toHaveLength(1));
    expect(said[0]!.text).toBe('コピーできませんでした(ブラウザが断りました)');
    expect(said[0]!.opts).toEqual({ kind: 'caution' });

    said.length = 0;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });
    click(root, 'use-copied', { 'data-pkc-copied': '0' });
    await vi.waitFor(() => expect(said).toHaveLength(1));
    expect(said[0]!.text).toContain('をコピーしました');
    expect(said[0]!.opts, '成功まで注意にした').toBeUndefined();
  });
});

/**
 * ⚠ 原文 pin(弱い)── 挙動で通せない 2 か所(相手を選ぶ小窓 / 書庫の一覧)。
 * `showStatus` の第 2 引数に `CAUTION` を渡す形を見る。注釈は落としてから(解説に書いた綴りに満たされない)。
 */
describe('挙動で通せない断り(原文 pin ── 弱い)', () => {
  const code = readFileSync('src/adapter/ui/actions/binder.ts', 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');

  it.each([
    "'追記の欄が見つかりません(ノートを開いてから押してください)', CAUTION",
    "'書庫の一覧を組めませんでした', CAUTION",
  ])('🔴 %s', (frag) => {
    expect(code).toContain(frag);
  });

  it('🔴 `CAUTION` の中身は caution 1 つだけ(結果へ戻っていない)', () => {
    expect(code).toContain("const CAUTION: StatusOptions = { kind: 'caution' };");
  });
});
