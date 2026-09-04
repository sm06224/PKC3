/** @vitest-environment happy-dom */
/**
 * 🔴 **本文の上でも右クリックを受ける**(#426 段② / #522)。
 *
 * ## なぜ要るか
 *
 * 段①(#477)は**行の上だけ**で受けていたので、本文を右クリックしても何も出なかった。
 * user 指示 2026-08-28(#522):
 *
 * > **段組表示を表示変更導線をセンターペインもしくはショートカット、
 * > コンテキストメニューに用意したいくらいには気に入った**
 *
 * ## 🔴 段① が置いた除外の門は、**ここで初めて効き始める**
 *
 * 段① の test はこう予告していた ── 「段② で本文の上でも受けるようになったら、
 * この test は**自動的に除外の門を見るようになる**」。
 * ⚠ つまりリンク・図・入力欄・選択範囲で**既定を残す**ことは、
 * いままで「行の判定がどのみち先に返す」に救われていた。**もう救われない。**
 */
import { afterEach, describe, expect, it } from 'vitest';
import { appPanes } from '../../src/adapter/ui/render/pane-visibility';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { BODY_MENU_ACTIONS, ENTRY_ACTION_HINTS } from '../../src/features/entry-actions';
import { openContextMenu } from '../../src/adapter/ui/render/context-menu';
import { sectionAt } from '../../src/features/markdown/append-target';
import { applyHeadingFold } from '../../src/adapter/ui/render/heading-fold';
import { applyPlaceLayout } from '../../src/adapter/ui/render/place-board';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { bodyBelowFrontmatter, frontmatterLineCount } from '../../src/features/markdown/frontmatter';

const MENU = '[data-pkc-region="context-menu"]';

/** 右クリック event(happy-dom に `MouseEvent` の座標つき実体は在る)。 */
function rightClick(el: Element): MouseEvent {
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
  el.dispatchEvent(e);
  return e;
}

function setup(over: Partial<BinderServices> = {}) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  root.innerHTML =
    '<div data-pkc-region="detail">' +
    '<div data-pkc-field="detail-body">' +
    '<p data-pkc-field="para">ふつうの段落</p>' +
    '<a href="https://example.com/x">そと</a>' +
    '<img alt="ず" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />' +
    '</div>' +
    /**
     * 🔴 **設定・ヘルプ・集計の面は、同じ `detail` の器の中に居る**
     *   (`center.ts` の `pane()` が `data-pkc-view-pane` で並べる)。
     * ⚠ 実物の DOM を読むまで、この器を組み忘れていた ── 面で切る実装だと
     *   **設定画面を右クリックしても段組みのメニューが出る**。
     */
    '<div data-pkc-view-pane="settings"><p data-pkc-field="settei">設定の中身</p></div>' +
    '</div>' +
    '<div data-pkc-region="entry-list">' +
    '<li data-pkc-entry="n1">行</li>' +
    // 🔴 **フォルダの行**(#500 案 C)── 条件つきの物が出る側の対照群
    '<li data-pkc-entry="f1">フォルダ</li>' +
    '</div>' +
    '<div data-pkc-region="jinou">地の上</div>';
  document.body.append(root);
  const said: string[] = [];
  const dispatcher = new Dispatcher();
  /**
   * ⚠ **起動まで進める**(`new Dispatcher()` は `initializing`)── 行の右クリックは
   *   `selectEntryOrExplain` を通るので、ノートが居ないと**断られてメニューが出ない**。
   * 🔑 2026-08-29 に同じ形を踏んだ(台が一度も `ready` にならず、見たつもりの test が
   *   別の側を見ていた)ので、ここでも先に起動させる。
   */
  dispatcher.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [
      {
        lid: 'n1',
        title: '行',
        archetype: 'text',
        created_at: null,
        updated_at: null,
        entry_order: 1,
        status: null,
        date: null,
        archived: 0,
      } as never,
      {
        lid: 'f1',
        title: 'フォルダ',
        archetype: 'folder',
        created_at: null,
        updated_at: null,
        entry_order: 2,
        status: null,
        date: null,
        archived: 0,
      } as never,
    ],
    relations: [],
  });
  bindActions(root, dispatcher, { showStatus: (t) => said.push(t), ...over });
  return {
    root,
    said,
    dispatcher,
    para: root.querySelector('[data-pkc-field="para"]')!,
    row: (lid: string) => root.querySelector(`[data-pkc-entry="${lid}"]`)!,
    link: root.querySelector('a')!,
    img: root.querySelector('img')!,
    jinou: root.querySelector('[data-pkc-region="jinou"]')!,
    settei: root.querySelector('[data-pkc-field="settei"]')!,
    menu: () => root.querySelector(MENU),
  };
}

describe('本文の右クリック(#426 段② / #522)', () => {
  it('🔴 本文の上で右クリックすると、メニューが出る', () => {
    const s = setup();
    expect(s.menu(), '押す前から出ている').toBeNull();
    const e = rightClick(s.para);
    expect(s.menu(), '本文で右クリックしても出ない').not.toBeNull();
    // ⚠ 既定を奪っている(奪わないとブラウザのメニューが重なる)
    expect(e.defaultPrevented, '既定を奪っていない').toBe(true);
  });

  it('🔴 出るのは**本文用の一覧**(行の一覧ではない)', () => {
    const s = setup();
    rightClick(s.para);
    const acts = [...s.menu()!.querySelectorAll('button[data-pkc-action]')].map((b) =>
      b.getAttribute('data-pkc-action'),
    );
    expect(acts).toEqual(BODY_MENU_ACTIONS.map((a) => a.action));
    /**
     * 🔴 **「削除」を出さない。**
     * ⚠ 本文を押したのに削除が出ると、消えるのは**選んでいるノート**である ──
     *   押した物と効く先が食い違う。
     */
    expect(acts, '本文のメニューに削除が出ている').not.toContain('delete-entry');
  });

  it('🔴 押すと段組みが実際に回る(配線が繋がっている)', () => {
    const s = setup();
    rightClick(s.para);
    const before = document.documentElement.getAttribute('data-pkc-read-columns');
    s.menu()!.querySelector<HTMLElement>('[data-pkc-action="cycle-read-columns"]')!.click();
    // ⚠ **メニューの外**で確かめる ── 器の属性と、画面に出た字
    expect(
      document.documentElement.getAttribute('data-pkc-read-columns'),
      '押しても段数が変わらない',
    ).not.toBe(before);
    expect(s.said.join(''), '何段になったか言っていない').toContain('段組み');
  });

  it('🔴 **リンクの上では出さない**(「リンクをコピー」を消さない)', () => {
    // ⚠ この門は段① から在ったが、行の判定に救われて**一度も効いていなかった**
    const s = setup();
    const e = rightClick(s.link);
    expect(s.menu(), 'リンクの上で自前のメニューを出した').toBeNull();
    expect(e.defaultPrevented, 'リンクの上で既定を奪った').toBe(false);
  });

  it('🔴 **図の上では出さない**(「画像を保存」を消さない)', () => {
    const s = setup();
    const e = rightClick(s.img);
    expect(s.menu(), '図の上で自前のメニューを出した').toBeNull();
    expect(e.defaultPrevented, '図の上で既定を奪った').toBe(false);
  });

  it('⚠ 本文の面の外(地)では、これまでどおり出さない', () => {
    const s = setup();
    const e = rightClick(s.jinou);
    expect(s.menu(), '地の上で出した(奪って何も出さない場所を増やした)').toBeNull();
    expect(e.defaultPrevented).toBe(false);
  });

  it('🔴 **設定の面では出さない** ── 同じ器の中に同居している', () => {
    /**
     * 🔴 **実物の DOM を読んで見つけた**(2026-08-29、着地前)。
     * ⚠ `[data-pkc-region="detail"]` は**中央の器**で、その中に設定 / フラグ /
     *   ヘルプ / 集計 / 2 ペインの面が同居している。面で切ると、
     *   **設定画面を右クリックしても段組みのメニューが出る**。
     * 🔑 見るのは**本文そのもの**(`detail-body`)。
     */
    const s = setup();
    const e = rightClick(s.settei);
    expect(s.menu(), '設定の面で段組みのメニューを出した').toBeNull();
    expect(e.defaultPrevented, '設定の面で既定を奪った').toBe(false);
  });

  it('⚠ 行の上は、これまでどおり**行の一覧**が出る(段① を壊していない)', () => {
    const s = setup();
    rightClick(s.root.querySelector('[data-pkc-entry]')!);
    const acts = [...(s.menu()?.querySelectorAll('button[data-pkc-action]') ?? [])].map((b) =>
      b.getAttribute('data-pkc-action'),
    );
    expect(acts, '行の右クリックが本文の一覧に変わった').toContain('delete-entry');
  });
});

/**
 * 🔴 **右ペインが唯一の入口だった、残りの 3 つ**(#500 案 C、2026-08-29)。
 *
 * 純関数の側(`tests/features/entry-actions.test.ts`)は「**どれを出すか**」を見る。
 * ⚠ こちらが見るのは「**押して実際に走るか**」である ── 出す物を決めただけでは
 *   足りない:右クリックのメニューのボタンは `data-pkc-action` **しか持たない**ので、
 *   `data-pkc-entry` を直に読む受け手に渡すと**押しても無言**になる
 *   (`adopt-external-images` が実際にその形だった)。
 */
describe('条件つきの操作が、右クリックから走る(#500 案 C)', () => {
  const actionsOf = (menu: Element | null): string[] =>
    [...(menu?.querySelectorAll('button[data-pkc-action]') ?? [])].map(
      (b) => b.getAttribute('data-pkc-action') ?? '',
    );

  it('🔴 フォルダの行では「フォルダを書き出す」が出て、押すと走る', () => {
    const called: string[] = [];
    const s = setup({ exportFolder: (lid) => called.push(lid) });
    rightClick(s.root.querySelector('[data-pkc-entry="f1"]')!);
    expect(actionsOf(s.menu()), 'フォルダなのに出ていない').toContain('export-folder');
    s.menu()!.querySelector<HTMLElement>('[data-pkc-action="export-folder"]')!.click();
    // 🔴 **押した物ではなく、選んだ物へ効く** ── メニューは行の外に居るので
    //    `data-pkc-entry` を持たない。解決規則が隣と揃っていないとここが空になる
    expect(called, '押しても走らない(無言の dead click)').toEqual(['f1']);
  });

  it('⚠ ふつうのノートの行では出ない(押すと必ず失敗する物を出さない)', () => {
    const s = setup();
    rightClick(s.root.querySelector('[data-pkc-entry="n1"]')!);
    expect(actionsOf(s.menu())).not.toContain('export-folder');
    // ⚠ 空振り防止 ── メニュー自体は出ている
    expect(actionsOf(s.menu()), 'そもそもメニューが出ていない').toContain('delete-entry');
  });

  it('🔴 元ファイルを開いた行では「書き戻す」が出て、押すと走る', () => {
    const called: string[] = [];
    const s = setup({ writeBackFile: (lid) => called.push(lid) });
    // ⚠ **フォルダではない行**で見る ── folder の門に救われない場面
    s.dispatcher.dispatch({ type: 'FILE_LINKED', lid: 'n1', name: 'memo.md' });
    rightClick(s.root.querySelector('[data-pkc-entry="n1"]')!);
    expect(actionsOf(s.menu()), '元ファイルが在るのに出ていない').toContain('write-back-file');
    s.menu()!.querySelector<HTMLElement>('[data-pkc-action="write-back-file"]')!.click();
    expect(called, '押しても走らない').toEqual(['n1']);
  });

  it('⚠ 元ファイルを開いていない行では出ない(上書きの口を常設しない)', () => {
    const s = setup();
    rightClick(s.root.querySelector('[data-pkc-entry="n1"]')!);
    expect(actionsOf(s.menu())).not.toContain('write-back-file');
  });

  it('🔴 本文に外部の画像が在ると、メニューに枚数つきで出て、押すと取りに行く', async () => {
    const asked: string[][] = [];
    const s = setup({
      adoptUrls: (urls) => {
        asked.push([...urls]);
        return Promise.resolve({ adopted: new Map(), failures: [] });
      },
    });
    // 本文を開く(`BODY_LOADED` は選んでいる 1 件にしか入らない)
    s.dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    s.dispatcher.dispatch({
      type: 'BODY_LOADED',
      lid: 'n1',
      body: '![a](https://example.com/a.png)\n\n![b](https://example.com/b.png)',
    });
    rightClick(s.para);
    const menu = s.menu();
    expect(actionsOf(menu), '外部の画像が 2 枚あるのに出ていない').toContain(
      'adopt-external-images',
    );
    // 🔴 **枚数が字に出ている**(押すとその数だけ外へ通信する)
    expect(
      menu!.querySelector('[data-pkc-action="adopt-external-images"]')?.textContent,
    ).toContain('2 枚');
    /**
     * 🔴 **押す前に「外へ通信する」と読める**(着地前レビュー ⚠3 / 動線レビュー 欠陥 2)。
     *
     * ⚠ #587 C-1 の 1 稿目は**行のメニューだけ**に説明を付けたので、
     *   **押すと外へ通信して本文を書き換える、いちばん重い 1 個**が黙ったままだった
     *   ── 取り消せる「削除」には説明が出て、取り消しにくいこれには出ない、という
     *   **説明の量が操作の重さと逆**になる形。
     * ⚠ この行が無いと、`bodyMenuActions` から `hint` を落とす変異が生き延びる
     *   (下の「説明を持たない項目には title を付けない」は、この項目が出ない
     *   fixture なので**この沈黙を pin していない**)。
     */
    const adopt = menu!.querySelector<HTMLElement>('[data-pkc-action="adopt-external-images"]')!;
    expect(adopt.getAttribute('data-pkc-hint'), '外へ通信することが押す前に読めない').toBe(
      ENTRY_ACTION_HINTS['adopt-external-images'],
    );
    // 🔑 指せば、下の欄にその字が出る(#587 C-3 ── tooltip ではなく欄)
    adopt.focus();
    expect(menu!.querySelector('[data-pkc-field="context-menu-hint"]')?.textContent).toBe(
      ENTRY_ACTION_HINTS['adopt-external-images'],
    );
    expect(adopt.getAttribute('title'), 'tooltip が残っている(下の項目に重なる箱)').toBeNull();

    menu!.querySelector<HTMLElement>('[data-pkc-action="adopt-external-images"]')!.click();
    /**
     * 🔴 **ここが本命** ── 直す前の受け手は `target.getAttribute('data-pkc-entry')`
     *   だけを見ていたので、メニューから押すと `lid` が `null` になり、
     *   **1 バイトも通信せずに黙って返っていた**。
     */
    expect(asked, '押しても取りに行かない(無言の dead click)').toEqual([
      ['https://example.com/a.png', 'https://example.com/b.png'],
    ]);
    expect(s.said.join(''), '押した合図が出ていない').toContain('2 枚');
  });

  it('⚠ 外部の画像が無い本文では出ない(押しても何も起きない物を出さない)', () => {
    const s = setup();
    s.dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    s.dispatcher.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: 'ただの本文' });
    rightClick(s.para);
    expect(actionsOf(s.menu())).not.toContain('adopt-external-images');
    // ⚠ 空振り防止 ── 本文のメニュー自体は出ている
    expect(actionsOf(s.menu()), 'そもそも出ていない').toContain('cycle-read-columns');
  });
});

/**
 * 🔴 **見出しを右クリックすると、その見出しにできることが増える**(#426 段② の残り)。
 *
 * ## なぜ別の rig を組むか
 *
 * この 3 つは**押した見出しの「原文の行」**を要る ── 上の rig の本文には
 * 刻印(`data-pkc-source-line`)が 1 つも無く、`bodySourceLineAt` が必ず `null` を返す。
 * ⚠ そのまま足すと**全部の it が「見出しではない」側を通り、緑のまま何も見ない**
 * (CLAUDE.md §2「経路が一度も通っていない」)。
 *
 * ## 🔴 ここで守りたいのは 2 つ
 *
 * 1. **運べているか** ── メニューの器は root の直下に出るので、押したボタンは
 *    押した物の中に居ない。`closest` に頼る受け手は**必ず外す**。
 * 2. **失っていないか** ── 見出しは本文の中に在るので、いまも本文のメニューが
 *    出ている。差し替えると**見出しの上でだけ段組みが切り替えられなくなる**。
 */
describe('見出しの右クリック(#426 段② の残り)', () => {
  /**
   * ⚠ **見出しは 3 段ぶん持つ** ── `##`(1 つ目)/ `##`(2 つ目)/ `####`。
   * 🔴 **2 つ目が要る理由**:1 稿目の fixture は行 0 の見出ししか押しておらず、
   *   運ぶ値を `'0'` に固定する変異が **6 件の assert を全部素通り**した
   *   (着地前レビュー 🔴2)── 「押した見出しの身元を運ぶ」という当の機構を、
   *   どの test も 1 度も見ていなかった。
   * 🔴 **`####` が要る理由**:追記の入り先は `#`〜`###` しか数えないので、
   *   そこで「ここに追記する」を出すと**上の見出し**が入り先になる(動線 ⚠6)。
   */
  const HEAD_BODY = [
    '## 章',
    '',
    '中身',
    '',
    '## つぎ',
    '',
    '#### こまかい',
    '',
    '![そと](https://example.com/a.png)',
    '',
  ].join('\n');

  function rig() {
    document.body.textContent = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    const host = document.createElement('div');
    host.setAttribute('data-pkc-field', 'detail-body');
    /**
     * ⚠ **刻印は本物と同じ属性**(`markdown-render.ts` が焼くもの)── 別の名前で
     *   組むと、この test だけ通って実物では 1 度も効かない。
     * ⚠ 見出しと配下は **host の直下**に並べる(`applyHeadingFold` の数え方)。
     */
    host.innerHTML =
      '<h2 data-pkc-source-line="0" id="h-a">章</h2>' +
      '<p data-pkc-source-line="2" id="p-in">中身</p>' +
      '<h2 data-pkc-source-line="4" id="h-b">つぎ</h2>' +
      '<h4 data-pkc-source-line="6" id="h-deep">こまかい</h4>' +
      /**
       * 🔴 **入れ子の見出し**(引用や `:::` の中は実在する)。
       * ⚠ 畳みの計算(`foldSpans`)は **host の直下**しか数えないので、
       * ここで「畳む」を出しても押して何も起きない ── 畳みだけ畳む。
       */
      '<blockquote data-pkc-source-line="8"><h3 data-pkc-source-line="8" id="h-nest">引用の中</h3></blockquote>';
    root.append(host);
    const sel = document.createElement('select');
    sel.setAttribute('data-pkc-field', 'append-target');
    /**
     * ⚠ **印は製品と同じ関数から引く**(`sectionAt`)── 手で綴りを書くと、
     * 印の作り方が変わった日に**この test だけが古い綴りを持つ**(そして
     * 「選べません」に落ちるのに、原因が fixture 側だと気づけない)。
     * 🔴 **2 つ入れる** ── 1 つだけだと `not.toBe('')` が実質「章」固定になり、
     *   運ぶ行を潰す変異を見逃す。
     */
    const slugA = sectionAt(HEAD_BODY, 0)?.slug ?? '';
    const slugB = sectionAt(HEAD_BODY, 4)?.slug ?? '';
    expect([slugA, slugB], '見出しの印が引けていない(fixture の前提が崩れている)').not.toContain('');
    expect(slugA, '2 つの見出しの印が同じ(区別できない)').not.toBe(slugB);
    for (const value of ['', slugA, slugB]) {
      const opt = document.createElement('option');
      opt.value = value;
      sel.append(opt);
    }
    root.append(sel);
    document.body.append(root);
    const said: string[] = [];
    const d = new Dispatcher();
    bindActions(root, d, { showStatus: (t) => said.push(t) });
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        {
          lid: 'n1',
          title: '章の在るノート',
          archetype: 'text',
          created_at: null,
          updated_at: null,
          entry_order: 1,
          status: null,
          date: null,
          archived: 0,
        } as never,
        // ⚠ 追記できない種類(添付)── 「ここに追記する」を畳む側の対照群
        {
          lid: 'a1',
          title: '添付',
          archetype: 'attachment',
          created_at: null,
          updated_at: null,
          entry_order: 2,
          status: null,
          date: null,
          archived: 0,
        } as never,
      ],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: HEAD_BODY });
    return {
      root,
      d,
      said,
      host,
      sel,
      head: root.querySelector('#h-a')!,
      head2: root.querySelector('#h-b')!,
      deep: root.querySelector('#h-deep')!,
      para: root.querySelector('#p-in')!,
      nested: root.querySelector('#h-nest')!,
      menu: () => root.querySelector(MENU),
      acts: (): string[] =>
        [...root.querySelectorAll(`${MENU} button[data-pkc-action]`)].map(
          (b) => b.getAttribute('data-pkc-action') ?? '',
        ),
      lines: (): (string | null)[] =>
        [...root.querySelectorAll(`${MENU} button[data-pkc-action]`)].map((b) =>
          b.getAttribute('data-pkc-menu-line'),
        ),
      press: (action: string): void => {
        root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="${action}"]`)!.click();
      },
      /** 添付のノートへ切り替える(追記できない側)。 */
      toAttachment: (): void => {
        d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
        d.dispatch({ type: 'BODY_LOADED', lid: 'a1', body: HEAD_BODY });
      },
    };
  }

  it('🔴 見出しの 3 つが**頭に**足され、本文の分も残る(動線を 1 つも失わない)', () => {
    const r = rig();
    rightClick(r.head);
    const acts = r.acts();
    // ⚠ 4 つ目「この章をコピー」は #677 で足した(既存の 3 つの**下**)
    expect(acts.slice(0, 4), '見出しの 4 つが出ていない').toEqual([
      'edit-from-heading',
      'append-at-heading',
      'toggle-heading-fold',
      'copy-chapter-md',
    ]);
    /**
     * 🔴 **差し替えていないことを、ここで見る。**
     * ⚠ 「頭 4 つが正しい」だけでは、本文の分を落とす変異が生き延びる
     *   ── 落ちるのは #522 で user が頼んだ段組み切替である。
     * 🔴 **条件つきの「取り込む」まで見る**(着地前レビュー 🔴3)── `BODY_MENU_ACTIONS`
     *   だけと突き合わせる変異は、fixture に外部画像が 0 枚だと素通りした。
     */
    expect(acts.slice(4), '本文のメニューが消えている / 取り込みが見出しの枝だけ落ちた').toEqual([
      ...BODY_MENU_ACTIONS.map((a) => a.action),
      'adopt-external-images',
    ]);
  });

  it('🔴 **段落の上では増えない**(対照群 ── 見出しの物が常に出る作りではない)', () => {
    const r = rig();
    rightClick(r.para);
    expect(r.acts(), '段落の上でも見出しの物が出た').toEqual([
      ...BODY_MENU_ACTIONS.map((a) => a.action),
      'adopt-external-images',
    ]);
  });

  it('🔴 押したボタンが「押した見出しの行」を運んでいる', () => {
    const r = rig();
    rightClick(r.head);
    expect(new Set(r.lines()), '1 つ目の見出しの行を運んでいない').toEqual(new Set(['0']));
  });

  /**
   * 🔴 **2 つ目の見出しを押す**(着地前レビュー 🔴2)。
   * ⚠ これが無いと、運ぶ値を `'0'` に固定する変異が**全部の assert を素通り**する
   *   ── 実害は「2 つ目以降の見出しを右クリックすると、先頭の章が畳まれ、
   *   先頭から編集に入る」。
   */
  it('🔴 2 つ目の見出しでは、2 つ目の行が運ばれ、2 つ目の章が畳まれる', () => {
    const r = rig();
    rightClick(r.head2);
    expect(new Set(r.lines()), '2 つ目の見出しの行を運んでいない').toEqual(new Set(['4']));
    r.press('toggle-heading-fold');
    // ⚠ **対照群**:1 つ目の章の中身は畳まれない(先頭を掴んでいない証拠)
    expect((r.para as HTMLElement).hidden, '2 つ目を押したのに 1 つ目が畳まれた').toBe(false);
    expect((r.deep as HTMLElement).hidden, '2 つ目の章の中身が畳まれていない').toBe(true);
  });

  it('🔴 2 つ目の見出しからは、2 つ目の行で編集に入る', () => {
    const r = rig();
    rightClick(r.head2);
    r.press('edit-from-heading');
    expect(r.d.getState().phase, '編集に入っていない').toBe('editing');
    expect(r.d.getState().editOpenAt, '先頭の行で開いている').toBe(4);
  });

  it('🔴 「ここから編集する」で、その行から編集に入る', () => {
    const r = rig();
    rightClick(r.head);
    r.press('edit-from-heading');
    expect(r.d.getState().phase, '編集に入っていない').toBe('editing');
    expect(r.d.getState().editOpenAt, '押した見出しの行を持っていっていない').toBe(0);
  });

  /**
   * 🔴 **編集の門を通っている**(着地前レビュー 🔴1)。
   * ⚠ 直す前は `START_EDIT` を直に撃っていたので、**別タブが編集中でも入れた**
   *   (帯の「編集」なら断られる = メニューからだけ門が無い形)。
   */
  it('🔴 別のタブが編集中なら、メニューからも入れない(理由が出る)', async () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    const host = document.createElement('div');
    host.setAttribute('data-pkc-field', 'detail-body');
    host.innerHTML = '<h2 data-pkc-source-line="0" id="h-a">章</h2>';
    root.append(host);
    document.body.append(root);
    const said: string[] = [];
    const d = new Dispatcher();
    bindActions(root, d, {
      showStatus: (t) => said.push(t),
      acquireEditLock: () => Promise.resolve('denied'),
    });
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        {
          lid: 'n1',
          title: 't',
          archetype: 'text',
          created_at: null,
          updated_at: null,
          entry_order: 1,
          status: null,
          date: null,
          archived: 0,
        } as never,
      ],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '## 章\n' });
    rightClick(root.querySelector('#h-a')!);
    root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="edit-from-heading"]`)!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(d.getState().phase, 'ロックを取れていないのに編集へ入った').toBe('ready');
    // ⚠ 断り文は state に載る(`OP_FAILED`)── 画面はそれを読む
    expect(d.getState().error ?? '', '断った理由が出ていない').toContain('別のタブ');
    void said;
  });

  /**
   * 🔴 **これが「運べているか」の本命**(#426 の設計上の障害)。
   *
   * ⚠ 畳みの受け手は `target.closest('h1,h2,...')` で見出しを探す ── メニューの
   *   ボタンは器の直下に居るので、**運ばなければ必ず `null`** になり、
   *   押しても無言で何も起きない(#500 案 C で実際に踏んだ形)。
   * 🔑 だから見るのは「畳んだか」ではなく **配下が実際に消えたか**である。
   */
  it('🔴 「中身を畳む」で、配下が本当に畳まれる(メニューから届いている)', () => {
    const r = rig();
    rightClick(r.head);
    expect((r.para as HTMLElement).hidden, '押す前から畳まれている').toBe(false);
    r.press('toggle-heading-fold');
    expect((r.para as HTMLElement).hidden, 'メニューから押しても畳まれない').toBe(true);
    // ⚠ 次の見出しは畳まない(章の外まで巻き込んでいない)
    expect((r.head2 as HTMLElement).hidden).toBe(false);
  });

  it('🔴 畳んでいるときは字が「出す」になる(押す前に起きることが読める)', () => {
    const r = rig();
    rightClick(r.head);
    r.press('toggle-heading-fold');
    rightClick(r.head);
    const btn = r.root.querySelector(`${MENU} [data-pkc-action="toggle-heading-fold"]`)!;
    expect(btn.textContent, '畳んでいるのに「畳む」と書いてある').toContain('出す');
    // 対照群 ── 開いている側では「畳む」
    r.press('toggle-heading-fold');
    rightClick(r.head);
    expect(
      r.root.querySelector(`${MENU} [data-pkc-action="toggle-heading-fold"]`)!.textContent,
    ).toContain('畳む');
  });

  /**
   * 🔴 **見出しの頭のボタンの上でも同じ 3 つが出る**(着地前レビュー ⚠4)。
   *
   * ⚠ 実物の見出しの**先頭ピクセルは畳みのボタン**である(`applyHeadingFold` が
   *   描画のたびに `prepend` する)。押した所から行を引くと `OWN_MEANING` に当たって
   *   `null` になり、**帯の上で右クリックしたときだけ 3 つが消えて**いた。
   */
  it('🔴 見出しの頭の畳みボタンの上で右クリックしても、3 つが出る', () => {
    const r = rig();
    applyHeadingFold(r.host);
    const btn = r.host.querySelector<HTMLElement>('#h-a [data-pkc-field="heading-fold"]');
    expect(btn, '畳みのボタンが出ていない(fixture の前提が崩れている)').not.toBeNull();
    rightClick(btn!);
    expect(r.acts().slice(0, 4), '帯の上で右クリックすると見出しの物が消える').toEqual([
      'edit-from-heading',
      'append-at-heading',
      'toggle-heading-fold',
      'copy-chapter-md',
    ]);
    expect(new Set(r.lines()), '帯の上では行を運べていない').toEqual(new Set(['0']));
  });

  it('🔴 見出しの頭のボタンからも、いままでどおり畳める(委譲を通して)', () => {
    const r = rig();
    applyHeadingFold(r.host);
    const btn = r.host.querySelector<HTMLElement>('#h-a [data-pkc-field="heading-fold"]');
    btn!.click();
    expect((r.para as HTMLElement).hidden, '見出しのボタンから畳めない').toBe(true);
  });

  /**
   * 🔴 **押しても何も起きない口だけを畳む**(着地前レビュー ⚠7)。
   * ⚠ 1 稿目は入れ子の見出しで 3 つとも落としていたが、その理由(畳めない)は
   *   **畳みにしか当たっていなかった** ── `Ctrl`+クリックは入れ子でも編集に入れる。
   */
  it('🔴 **入れ子の見出し**(引用の中)では「畳む」だけ出さない', () => {
    const r = rig();
    rightClick(r.nested);
    const acts = r.acts();
    expect(acts, '入れ子で編集の口まで落ちている').toContain('edit-from-heading');
    expect(acts, '入れ子で押しても何も起きない「畳む」を出した').not.toContain(
      'toggle-heading-fold',
    );
    // ⚠ 章の範囲も畳みと同じ数え方(直下の並び)なので、入れ子では出さない(#677)
    expect(acts, '入れ子で切り出せない「この章をコピー」を出した').not.toContain('copy-chapter-md');
  });

  /**
   * 🔴 **`####` 以下では「ここに追記する」を出さない**(動線レビュー ⚠6)。
   * ⚠ 入り先の一覧は `#`〜`###` しか数えないので、出すと**押した見出しではなく
   *   上の `###`** が入り先になる(押した物と効く先が食い違う)。
   */
  it('🔴 `####` の見出しでは「ここに追記する」を出さない', () => {
    const r = rig();
    rightClick(r.deep);
    const acts = r.acts();
    expect(acts, '編集の口まで落ちている').toContain('edit-from-heading');
    expect(acts, '入り先にできない見出しで追記の口を出した').not.toContain('append-at-heading');
  });

  /**
   * 🔴 **追記できない種類のノートでは出さない**(動線レビュー ⚠2)。
   * ⚠ 追記は `text` / `textlog` だけ。出しても `pickAppendTarget` が**黙って降りる**
   *   ので、押した人には何が起きるはずだったのかを推測する材料が 1 つも無い。
   */
  it('🔴 添付のノートでは「ここに追記する」を出さない', () => {
    const r = rig();
    r.toAttachment();
    rightClick(r.head);
    const acts = r.acts();
    expect(acts, '編集の口まで落ちている').toContain('edit-from-heading');
    expect(acts, '追記できないノートで追記の口を出した').not.toContain('append-at-heading');
  });

  it('🔴 「ここに追記する」で、追記の入り先が動く', () => {
    const r = rig();
    rightClick(r.head);
    expect(r.sel.value, '押す前から選ばれている').toBe('');
    r.press('append-at-heading');
    expect(r.sel.value, 'メニューから押しても入り先が動かない').toBe(
      sectionAt(HEAD_BODY, 0)?.slug ?? '',
    );
  });

  it('🔴 2 つ目の見出しからの追記は、2 つ目が入り先になる', () => {
    const r = rig();
    rightClick(r.head2);
    r.press('append-at-heading');
    expect(r.sel.value, '押した見出しではない所が入り先になった').toBe(
      sectionAt(HEAD_BODY, 4)?.slug ?? '',
    );
  });

  /**
   * 🔴 **畳んだ追記欄は開き、打つ欄にカーソルが入る**(#596 A / 設問③ C。
   * user 裁定 2026-08-30「推奨通り、畳んでいれば開き、打つ欄にカーソルが入る」)。
   * ⚠ 直す前は畳まれた `<select>` に値だけ入れて「〜にしました」と言い、
   *   **打つ所が画面のどこにも無かった**。
   */
  describe('畳んだ追記欄を開く(#596 A / ③ C)', () => {
    afterEach(() => {
      appPanes.setHidden([]);
    });
    /** 本物の器(`shell.ts`)と同じ印で、畳み状態の属性と打つ欄を足す。 */
    function withAppendPane(r: ReturnType<typeof rig>, folded: boolean) {
      const shell = document.createElement('div');
      shell.setAttribute('data-pkc-region', 'shell');
      const input = document.createElement('textarea');
      input.setAttribute('data-pkc-field', 'append-input');
      shell.append(input);
      r.root.append(shell);
      appPanes.setHidden(folded ? ['append'] : []);
      if (folded) shell.setAttribute('data-pkc-hidden-panes', 'append');
      return { shell, input };
    }

    it('🔴 畳んでいれば開いて、打つ欄にカーソルが入る(右クリック経路)', () => {
      const r = rig();
      const { shell, input } = withAppendPane(r, true);
      rightClick(r.head);
      r.press('append-at-heading');
      expect(r.sel.value, '入り先が動いていない(前提が崩れている)').toBe(
        sectionAt(HEAD_BODY, 0)?.slug ?? '',
      );
      expect(appPanes.getHidden(), '畳んだままになっている').not.toContain('append');
      expect(shell.getAttribute('data-pkc-hidden-panes') ?? '', '画面へ写っていない').not.toContain(
        'append',
      );
      expect(document.activeElement, '打つ欄にカーソルが入っていない').toBe(input);
      expect(r.d.getState().notice ?? '', '開いたことを言っていない').toContain('追記欄を開きました');
    });

    it('対照群 ── 畳んでいなければ、開く動作は起きず、カーソルだけ入る', () => {
      const r = rig();
      const { shell, input } = withAppendPane(r, false);
      rightClick(r.head);
      r.press('append-at-heading');
      expect(shell.hasAttribute('data-pkc-hidden-panes')).toBe(false);
      expect(document.activeElement).toBe(input);
      expect(r.d.getState().notice ?? '').not.toContain('追記欄を開きました');
    });

    it('⚠ 追記欄だけを開く(左右の列の畳みには触らない)', () => {
      const r = rig();
      const { shell } = withAppendPane(r, true);
      appPanes.setHidden(['sidebar', 'append']);
      shell.setAttribute('data-pkc-hidden-panes', 'sidebar append');
      rightClick(r.head);
      r.press('append-at-heading');
      expect(appPanes.getHidden()).toEqual(['sidebar']);
      expect(shell.getAttribute('data-pkc-hidden-panes')).toBe('sidebar');
    });
  });
});


/**
 * 🔴 **メニューが出た後にノートが替わっても、別のノートに効かない**(#596 D)。
 *
 * ⚠ メニューが閉じるのは **押した / スクロールした / `Escape`** の 3 つだけなので、
 * 出したまま本文が別のノートへ替わりうる。⚠ そのとき運んだ行は**別のノートに効く**
 * ── 畳む / 編集に入る / 追記の入り先、どれも「押した物と効く先が食い違う」形になる。
 */
describe('メニューの身元(#596 D)', () => {
  function rig() {
    document.body.textContent = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    const host = document.createElement('div');
    host.setAttribute('data-pkc-field', 'detail-body');
    host.innerHTML =
      '<h2 data-pkc-source-line="0" id="h-a">章</h2>' +
      '<p data-pkc-source-line="2" id="p-in">中身</p>';
    root.append(host);
    document.body.append(root);
    const d = new Dispatcher();
    bindActions(root, d, { showStatus: () => {} });
    const meta = (lid: string): never =>
      ({
        lid,
        title: lid,
        archetype: 'text',
        created_at: null,
        updated_at: null,
        entry_order: 1,
        status: null,
        date: null,
        archived: 0,
      }) as never;
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1'), meta('n2')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '## 章\n\n中身\n' });
    return {
      root,
      d,
      host,
      press: (action: string): void => {
        root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="${action}"]`)!.click();
      },
    };
  }

  it('🔴 ノートが替わった後に押しても、**畳まない**', () => {
    const r = rig();
    rightClick(r.root.querySelector('#h-a')!);
    // ⚠ メニューは出たまま ── ここで本文が別のノートへ替わる
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    r.d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: '## べつ\n' });
    r.press('toggle-heading-fold');
    expect(
      (r.host.querySelector('#p-in') as HTMLElement).hidden,
      '別のノートに替わったのに、前のノートの章を畳んだ',
    ).toBe(false);
  });

  it('🔴 ノートが替わった後に押しても、**編集に入らない**', () => {
    const r = rig();
    rightClick(r.root.querySelector('#h-a')!);
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    r.d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: '## べつ\n' });
    r.press('edit-from-heading');
    expect(r.d.getState().phase, '別のノートに替わったのに編集へ入った').toBe('ready');
  });

  it('🔴 断るときは**理由を出す**(押して無言にしない)', () => {
    const r = rig();
    rightClick(r.root.querySelector('#h-a')!);
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    r.d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: '## べつ\n' });
    r.press('toggle-heading-fold');
    /**
     * ⚠ 押した瞬間にメニューは畳まれるので、黙って返すと user から見て
     * 「メニューが消えて何も起きない」= dead click になる(着地前レビュー ⚠6)。
     */
    expect(r.d.getState().notice ?? '', '断った理由が出ていない').toContain('別のノート');
  });

  /**
   * 🔴 **本文を右クリックしたときも身元を運ぶ**(着地前レビュー ⚠5)。
   * ⚠ そこに載る「外部の画像を取り込む」は**外へ通信して本文を書き換える**ので、
   *   取り違えの実害がいちばん大きい。⚠ しかもボタンの**字**(枚数)は
   *   メニューを組んだ時のノートのものである。
   */
  it('🔴 本文の右クリックでも身元を運び、取り込みも同じ門をくぐる', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    const host = document.createElement('div');
    host.setAttribute('data-pkc-field', 'detail-body');
    host.innerHTML = '<p data-pkc-source-line="0" id="p-x">ふつうの段落</p>';
    root.append(host);
    document.body.append(root);
    const d = new Dispatcher();
    const meta = (lid: string): never =>
      ({
        lid,
        title: lid,
        archetype: 'text',
        created_at: null,
        updated_at: null,
        entry_order: 1,
        status: null,
        date: null,
        archived: 0,
      }) as never;
    let fetched = 0;
    bindActions(root, d, {
      showStatus: () => {},
      fetchExternalImage: () => {
        fetched += 1;
        return Promise.resolve(null);
      },
    } as never);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1'), meta('n2')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '![そと](https://example.com/a.png)\n' });

    rightClick(root.querySelector('#p-x')!);
    const btn = root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="adopt-external-images"]`);
    expect(btn, '取り込みが出ていない(台の前提が崩れている)').not.toBeNull();
    expect(btn!.getAttribute('data-pkc-menu-lid'), '本文の右クリックで身元を運んでいない').toBe(
      'n1',
    );

    // ⚠ ここで別のノートへ替わる
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: '![べつ](https://example.com/b.png)\n' });
    btn!.click();
    expect(fetched, '替わった後のノートの画像を取りに行った').toBe(0);
    expect(d.getState().notice ?? '', '断った理由が出ていない').toContain('別のノート');
  });

  it('🔴 **対照群** ── 替わっていなければ、これまでどおり効く', () => {
    const r = rig();
    rightClick(r.root.querySelector('#h-a')!);
    r.press('toggle-heading-fold');
    expect(
      (r.host.querySelector('#p-in') as HTMLElement).hidden,
      '同じノートなのに畳めない(身元の検査が強すぎる)',
    ).toBe(true);
  });
});

/**
 * 🔴 **右クリックの項目にも説明が出る**(#587 改善 C-1)。
 *
 * ⚠ ここは**配線を見る場所**である ── 表(`features/entry-actions.ts`)の test も、
 *   描く側(`openContextMenu`)の test も、**相手の綴りを 1 度も見ない**
 *   (CLAUDE.md §7「A と B が合意していることは、A の test にも B の test にも書けない」)。
 *   🔑 だから**実物の右クリックから DOM の `title` まで**を 1 本で通す。
 */
describe('右クリックの説明(#587 C-1)', () => {
  it('🔴 行を右クリックすると、出た項目が全部「何が起きるか」を持っている', () => {
    const { root } = setup();
    rightClick(root.querySelector('[data-pkc-entry="n1"]')!);
    const items = [...root.querySelectorAll<HTMLElement>(`${MENU} button`)];
    // ⚠ 空振り防止 ── 出ていないのに「全部持っている」が真になる形を潰す
    expect(items.length, 'メニューが出ていない(台の空振り)').toBeGreaterThanOrEqual(9);
    const silent = items
      .filter((b) => (b.getAttribute('data-pkc-hint') ?? '') === '')
      .map((b) => b.getAttribute('data-pkc-action'));
    expect(silent, '説明の無い項目が出ている').toEqual([]);
  });

  it('🔴 字は情報ペインと同じ表から来る(片方だけ直る日を作らない)', () => {
    const { root } = setup();
    rightClick(root.querySelector('[data-pkc-entry="n1"]')!);
    const del = root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="delete-entry"]`);
    expect(del?.getAttribute('data-pkc-hint')).toBe(ENTRY_ACTION_HINTS['delete-entry']);
  });

  /**
   * ⚠ **対照群** ── 説明を持たない項目には `data-pkc-hint` を付けない(空の属性を生やさない)。
   * 🔴 **名指しの等値にする**(2026-09-04)── 1 稿目は「本文のメニューは**全部**
   *   説明を持たない」を主張しており、説明を持つ項目を足した日に落ちた。
   *   ⚠ 守りたいのは「**空なら付けない**」であって「1 つも付けない」ではない。
   */
  it('⚠ **対照群** ── 説明を持たない項目には `data-pkc-hint` を付けない(空の属性を生やさない)', () => {
    const { root } = setup();
    rightClick(root.querySelector('[data-pkc-field="para"]')!);
    const items = [...root.querySelectorAll<HTMLElement>(`${MENU} button`)];
    expect(items.length, '本文のメニューが出ていない(台の空振り)').toBeGreaterThanOrEqual(2);
    expect(
      items.filter((b) => b.hasAttribute('data-pkc-hint')).map((b) => b.getAttribute('data-pkc-action')),
      '説明を持たないのに空の data-pkc-hint が生えている',
    ).toEqual(['open-note-window']);
  });
});

/**
 * 🔴 **説明の有無で `title` を出し分ける規則そのもの**(着地前レビュー ⚠4)。
 *
 * ⚠ `openContextMenu` には**直の unit が 1 つも無かった** ── だから
 *   `it.hint !== ''` を外す変異は**どの test にも殺されなかった**
 *   (実物を通る台では `hint` が全部非空 / 全部 `undefined` のどちらかで、
 *   **空文字が届く場面を 1 度も作っていない**)。
 * 🔑 CLAUDE.md §1「『これが無いと壊れる』と書いた規則が no-op だった」の形なので、
 *   規則が効く**唯一の場面**(空文字)をここで作る。
 */
describe('メニューの説明の出し分け(#587 C-1)', () => {
  it('🔴 空の説明には `data-pkc-hint` 属性そのものを生やさない(対照群つき)', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    openContextMenu(
      root,
      { x: 0, y: 0 },
      [
        { action: 'a', label: 'あ', hint: '' },
        { action: 'b', label: 'い', hint: '説明' },
        { action: 'c', label: 'う' },
      ],
      null,
    );
    const at = (n: string): HTMLElement =>
      root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="${n}"]`)!;
    expect(at('a').hasAttribute('data-pkc-hint'), '空の説明で data-pkc-hint が生えている').toBe(false);
    expect(at('c').hasAttribute('data-pkc-hint'), '説明を渡していないのに data-pkc-hint が生えている').toBe(false);
    // ⚠ 対照群 ── これが無いと「何も付けない」実装でも緑になる
    expect(at('b').getAttribute('data-pkc-hint'), '説明が付いていない(台の空振り)').toBe('説明');
  });
});

/**
 * 🔴 **メニューの下の説明欄**(#587 C-3。user 裁定 2026-08-30「一度推奨で入れて、
 * 使用感をテストしたい」)。指している項目の説明だけを、いちばん下の欄に出す。
 * ⚠ 指す手は 2 つ(乗せる / キーで焦点を移す)── 片方だけ効く形を作らない。
 */
describe('メニューの下の説明欄(#587 C-3)', () => {
  const HINT = '[data-pkc-field="context-menu-hint"]';
  function openRowMenu() {
    const s = setup();
    rightClick(s.root.querySelector('[data-pkc-entry="n1"]')!);
    const menu = s.menu();
    expect(menu, '行の右クリックでメニューが出ない(前提が崩れている)').not.toBeNull();
    const buttons = [...menu!.querySelectorAll<HTMLElement>('button[data-pkc-action]')];
    expect(buttons.length, '項目が無い(空振り)').toBeGreaterThan(2);
    return { s, menu: menu!, buttons, box: (): string => menu!.querySelector(HINT)?.textContent ?? '' };
  }

  it('🔴 開いた直後は、先頭(焦点)の項目の説明が出ている', () => {
    const r = openRowMenu();
    const first = r.buttons[0]!;
    expect(first.getAttribute('data-pkc-hint') ?? '', '先頭に説明が無い(前提が崩れている)').not.toBe('');
    expect(document.activeElement, '焦点が先頭に無い(前提が崩れている)').toBe(first);
    expect(r.box()).toBe(first.getAttribute('data-pkc-hint'));
  });

  it('🔴 乗せると、その項目の説明に変わる', () => {
    const r = openRowMenu();
    const del = r.buttons.find((b) => b.getAttribute('data-pkc-action') === 'delete-entry')!;
    del.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(r.box()).toBe(ENTRY_ACTION_HINTS['delete-entry']);
    // 外れたら、焦点の項目(先頭)へ戻る
    r.menu.dispatchEvent(new MouseEvent('mouseleave'));
    expect(r.box()).toBe(r.buttons[0]!.getAttribute('data-pkc-hint'));
  });

  it('🔴 キーで焦点を移しても変わる(マウスを持たない人にも届く)', () => {
    const r = openRowMenu();
    const second = r.buttons[1]!;
    second.focus();
    expect(r.box()).toBe(second.getAttribute('data-pkc-hint'));
    expect(r.box(), '2 つ目の説明が先頭と同じ(区別できない)').not.toBe(
      r.buttons[0]!.getAttribute('data-pkc-hint'),
    );
  });

  it('⚠ tooltip(title)は 1 つも付けない(乗せて 1 秒待つ箱を残さない)', () => {
    const r = openRowMenu();
    expect(r.buttons.filter((b) => b.hasAttribute('title'))).toEqual([]);
  });

  /**
   * ⚠ **説明が 1 つも無いメニューには欄を出さない**(空の帯を残さない)。
   * 🔴 **台を作って見る**(2026-09-04)── 1 稿目は本文の右クリックを使っていたが、
   *   `open-note-window` を足した時点で**本文のメニューは説明を持つ**ようになり、
   *   この検査は「説明の無いメニュー」を 1 度も見なくなった(§2 の未実行)。
   */
  it('⚠ 説明が 1 つも無いメニューには欄を出さない', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    openContextMenu(root, { x: 0, y: 0 }, [{ action: 'a', label: 'あ' }], null);
    const menu = root.querySelector(MENU);
    expect(menu, '台が空振り(メニューが出ていない)').not.toBeNull();
    expect(menu!.querySelector(HINT), '説明の無いメニューに空の欄が出ている').toBeNull();
    expect(menu!.hasAttribute('data-pkc-with-hint')).toBe(false);
  });

  /** ⚠ **対照群** ── 説明が 1 つでもあれば欄は出る(上が「常に出さない」実装でも緑にならない)。 */
  it('⚠ 説明を持つメニューには欄が出る', () => {
    const s = setup();
    rightClick(s.para);
    const menu = s.menu();
    expect(menu!.querySelector(HINT), '説明を持つのに欄が出ていない').not.toBeNull();
    expect(menu!.hasAttribute('data-pkc-with-hint')).toBe(true);
  });

  /**
   * 🔴 **行の右クリックは「出す前に開いていたノート」を持たせる**
   *   (#685 動線レビュー 欠陥 2、2026-09-04)。
   *
   * ⚠ **順番そのものが主張である** ── `selectEntryOrExplain` は右クリックの時点で
   *   **その行を選ぶ**ので、控えるのが後だと**押した行そのもの**が入り、
   *   `open-note-window` は何も戻さない(= 読んでいた本文が退いたまま)。
   * 🔑 受け側(戻すこと)は `note-window-wiring.test.ts` が見る ──
   *   ここが見るのは**正しい値が載ること**である(両端の片方ずつ)。
   */
  describe('行の右クリックが持たせる「出す前のノート」(#685 欠陥 2)', () => {
    it('🔴 選び直す前の lid が載る(選び直した後ではない)', () => {
      const s = setup();
      s.dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
      expect(s.dispatcher.getState().selectedLid, '前提が崩れた(n1 を開いていない)').toBe('n1');
      rightClick(s.row('f1'));
      const b = s.menu()!.querySelector('button[data-pkc-action="open-note-window"]');
      expect(b, '別の窓で開くが一覧に無い').not.toBeNull();
      expect(
        b!.getAttribute('data-pkc-menu-prev-lid'),
        '控えるのが `selectEntryOrExplain` より後になっている(押した行が載っている)',
      ).toBe('n1');
      // ⚠ 対照群:右クリックで実際に選択が動いていること(動かないなら上は空振り)
      expect(s.dispatcher.getState().selectedLid, '右クリックで行が選ばれていない').toBe('f1');
    });

    /** ⚠ **対照群** ── 同じ行を右クリックした回は載せない(戻す相手が居ない)。 */
    it('⚠ いま開いている行なら載せない', () => {
      const s = setup();
      s.dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
      rightClick(s.row('n1'));
      const b = s.menu()!.querySelector('button[data-pkc-action="open-note-window"]');
      expect(b!.getAttribute('data-pkc-menu-prev-lid'), '要らない印が載っている').toBeNull();
    });
  });
});

/**
 * 🔴 **章 / `:::` の囲み / 板を、右クリックから原文の Markdown でまるごと写す**(#677)。
 *
 * ## なぜ本物の描画で台を組むか
 *
 * 上の rig は刻印を手で書いた。ここで守りたいのは「**`:::` の開きにしか刻印が無い**」
 * という描画の性質に対する振る舞い(章末が `:::` なら閉じまで写す / 塊は原文で判定する /
 * fence の中の `:::` を塊と読まない)なので、刻印は `renderMarkdown` に焼かせる ──
 * 手で書くと、この test だけ都合のよい刻印を持って通る(CLAUDE.md §3「stub は本物の意味論を真似る」)。
 *
 * ## ⚠ frontmatter を持たせる
 *
 * 刻印は frontmatter を剥いだ本文の行番号 ── 全文 body で切る実装は、frontmatter が 0 行の
 * fixture では**永久に緑**(測っていない次元)。期待値は**字面で書く**(実装と同じ切り方で
 * 組んだ期待値は、同じ盲点を共有する ── CLAUDE.md §1)。
 */
describe('ブロック単位のコピー ── 章 / 囲み / 板 (#677)', () => {
  /** fm.body の行番号を右に書く(刻印はこの座標)。 */
  const FULL = [
    '---',
    'align: left',
    '---',
    '## 章', // 0
    '', // 1
    '中身', // 2
    '', // 3
    ':::note', // 4
    '囲みの中', // 5
    '', // 6
    '```js', // 7
    'const a = 1;', // 8
    '```', // 9
    '', // 10
    ':::section', // 11
    '入れ子の中', // 12
    ':::', // 13
    ':::', // 14
    '', // 15
    '## つぎ', // 16
    '', // 17
    ':::format{.pkc-place x=40 y=40 w=320 h=200 entry=n2}', // 18
    '### 買い出し', // 19 ⚠ 板の中の見出し(host の直下ではない)
    '- 牛乳', // 20
    ':::', // 21
    '', // 22
    '段落', // 23
    '', // 24
  ].join('\n');
  const CHAPTER_1 =
    '## 章\n\n中身\n\n:::note\n囲みの中\n\n```js\nconst a = 1;\n```\n\n:::section\n入れ子の中\n:::\n:::\n';
  const CHAPTER_2 =
    '## つぎ\n\n:::format{.pkc-place x=40 y=40 w=320 h=200 entry=n2}\n### 買い出し\n- 牛乳\n:::\n\n段落\n';
  const NOTE = ':::note\n囲みの中\n\n```js\nconst a = 1;\n```\n\n:::section\n入れ子の中\n:::\n:::';
  const NESTED = ':::section\n入れ子の中\n:::';
  const BOARD = ':::format{.pkc-place x=40 y=40 w=320 h=200 entry=n2}\n### 買い出し\n- 牛乳\n:::';

  function rig(body = FULL) {
    document.body.textContent = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    const host = document.createElement('div');
    host.setAttribute('data-pkc-field', 'detail-body');
    // 🔑 読む面と同じ描き方(`detail.ts`): fm.body を anchors 付きで描き、畳み・板を当てる
    host.innerHTML = renderMarkdown(bodyBelowFrontmatter(body), { sourceLineAnchors: true });
    applyHeadingFold(host);
    applyPlaceLayout(host, (l) => (l === 'n2' ? 'ノート 2' : null), frontmatterLineCount(body));
    root.append(host);
    document.body.append(root);
    const copied: { text: string; done: string | undefined }[] = [];
    const d = new Dispatcher();
    bindActions(root, d, {
      showStatus: () => 0,
      copyText: (t, done) => {
        copied.push({ text: t, done });
      },
    });
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        {
          lid: 'n1',
          title: '板の在るノート',
          archetype: 'text',
          created_at: null,
          updated_at: null,
          entry_order: 1,
          status: null,
          date: null,
          archived: 0,
        } as never,
        {
          lid: 'n2',
          title: 'ノート 2',
          archetype: 'text',
          created_at: null,
          updated_at: null,
          entry_order: 2,
          status: null,
          date: null,
          archived: 0,
        } as never,
      ],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
    const q = (sel: string): Element => {
      const el = host.querySelector(sel);
      expect(el, `前提が崩れている: 台に ${sel} が無い`).not.toBeNull();
      return el!;
    };
    return {
      root,
      d,
      copied,
      host,
      q,
      acts: (): string[] =>
        [...root.querySelectorAll(`${MENU} button[data-pkc-action]`)].map(
          (b) => b.getAttribute('data-pkc-action') ?? '',
        ),
      label: (action: string): string =>
        root.querySelector(`${MENU} [data-pkc-action="${action}"]`)?.textContent ?? '',
      press: (action: string): void => {
        const b = root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="${action}"]`);
        expect(b, `メニューに ${action} が無い`).not.toBeNull();
        b!.click();
      },
    };
  }

  it('🔴 見出しの右クリックに「この章をコピー」が在り、押すと章の原文が byte 一致で渡る', () => {
    const r = rig();
    rightClick(r.q('h2[id="章"]'));
    expect(r.acts(), '「この章をコピー」が出ていない').toContain('copy-chapter-md');
    expect(r.label('copy-chapter-md')).toBe('この章をコピー');
    r.press('copy-chapter-md');
    expect(r.copied, 'clipboard へ 1 回渡っていない').toHaveLength(1);
    /**
     * 🔴 **章末が `:::` の囲み** ── 終端を刻印(`-end`)の最大で取る実装は、ここで
     *   `:::note` の開き行(4)までしか写さず、中身と閉じの `:::` が丸ごと落ちる。
     */
    expect(r.copied[0]!.text, '章の原文が丸ごと写っていない(閉じの ::: まで)').toBe(CHAPTER_1);
    expect(r.copied[0]!.done, '写した合図の字が違う').toBe('章をコピーしました(Markdown の原文)');
  });

  it('末尾の章は本文の末尾まで(板の中の `###` は章を閉じない)', () => {
    const r = rig();
    rightClick(r.q('h2[id="つぎ"]'));
    r.press('copy-chapter-md');
    expect(r.copied.map((c) => c.text)).toEqual([CHAPTER_2]);
  });

  it('⚠ 段落の上では章も塊も出ない(対照群)', () => {
    const r = rig();
    rightClick(r.q('p[data-pkc-source-line="2"]'));
    expect(r.acts()).not.toContain('copy-chapter-md');
    expect(r.acts()).not.toContain('copy-block-md');
    // ⚠ 本文のメニュー自体は出ている(出ないから含まない、ではない)
    expect(r.acts()).toContain('cycle-read-columns');
  });

  it('🔴 `:::` の囲みの中で右クリックすると「この塊をコピー」── 開きから閉じまで', () => {
    const r = rig();
    rightClick(r.q('p[data-pkc-source-line="5"]'));
    expect(r.acts(), '「この塊をコピー」が出ていない').toContain('copy-block-md');
    expect(r.acts(), '段落の上なのに章の物が出た').not.toContain('copy-chapter-md');
    expect(r.label('copy-block-md')).toBe('この塊をコピー');
    r.press('copy-block-md');
    expect(r.copied.map((c) => c.text)).toEqual([NOTE]);
    expect(r.copied[0]!.done).toBe('塊をコピーしました(Markdown の原文)');
  });

  it('🔴 入れ子の内側で右クリックすると、**内側**の塊(外側を写さない)', () => {
    const r = rig();
    rightClick(r.q('p[data-pkc-source-line="12"]'));
    r.press('copy-block-md');
    expect(r.copied.map((c) => c.text)).toEqual([NESTED]);
  });

  it('🔴 囲みの中の fence の上で右クリックすると、fence ではなく囲みの塊(刻印を外へ辿る)', () => {
    const r = rig();
    /**
     * ⚠ fence の中身に `:::` の字は置いていない ── `scanContainers` の深さ数えが囲みの中の
     *   fence を追跡しない既存の穴(2026-09-04 実測)を、この test の主張と混ぜない。
     */
    rightClick(r.q('code[data-pkc-source-line="7"]'));
    expect(r.acts(), 'fence の上で塊の口が消えた').toContain('copy-block-md');
    r.press('copy-block-md');
    expect(r.copied.map((c) => c.text), 'fence を塊と読んだ / 外側へ辿れていない').toEqual([NOTE]);
  });

  it('🔴 板の題名札の上で右クリックしても、行のメニューにならず「この板をコピー」が出る', () => {
    const r = rig();
    const card = r.q('[data-pkc-field="place-card"][data-pkc-entry="n2"]');
    rightClick(card);
    const acts = r.acts();
    expect(acts, '別ノートの行メニューが出た(削除が載っている)').not.toContain('delete-entry');
    expect(acts, '「この板をコピー」が出ていない').toContain('copy-block-md');
    expect(r.label('copy-block-md'), '板なのに「塊」と書いてある').toBe('この板をコピー');
    // 🔴 開いているノートが切り替わっていない(板が消えていない)
    expect(r.d.getState().selectedLid, '題名札の右クリックで別ノートへ切り替わった').toBe('n1');
    r.press('copy-block-md');
    expect(r.copied.map((c) => c.text), '板の原文(座標つき)が写っていない').toEqual([BOARD]);
    expect(r.copied[0]!.done).toBe('板をコピーしました(Markdown の原文)');
  });

  it('板の中の見出しでは、見出しの物と塊の物が**両方**出る(章は出ない)', () => {
    const r = rig();
    rightClick(r.q('h3[id="買い出し"]'));
    const acts = r.acts();
    expect(acts).toContain('edit-from-heading');
    expect(acts).toContain('copy-block-md');
    expect(acts, '直下でない見出しで章の口を出した').not.toContain('copy-chapter-md');
  });

  it('🔴 閉じていない囲みは写さずに理由を出す', () => {
    const r = rig(':::note\nまだ書いている\n');
    rightClick(r.q('p[data-pkc-source-line="1"]'));
    expect(r.acts()).toContain('copy-block-md');
    r.press('copy-block-md');
    expect(r.copied, '閉じていない塊を写した').toHaveLength(0);
    expect(r.d.getState().error ?? '', '断った理由が出ていない').toContain('閉じていない');
  });

  it('🔴 別のノートに切り替わったら、出ていたメニューの「この章をコピー」は効かない', () => {
    const r = rig();
    rightClick(r.q('h2[id="章"]'));
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    r.d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: '## 別\n\n別の中身\n' });
    r.press('copy-chapter-md');
    expect(r.copied, '別ノートの本文を写した').toHaveLength(0);
  });
});
