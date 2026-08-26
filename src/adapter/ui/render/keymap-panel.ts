/**
 * 設定の面に置く **ショートカットキーの割当**(user 指示 2026-08-18
 * 「PKC2 相当以上のショートカットキー機能とショートカットキーのカスタマイズ機能」)。
 *
 * ## 🔴 一覧は「表」から出す。手書きしない
 *
 * PKC2 はヘルプの一覧を**手書きの配列**で持っていたため、実装とズレた
 * (2026-08-18 の全数調査で 2 件確認 ── `Ctrl+Shift+↑↓` は該当ハンドラが無く、
 * `Space` のチェック切替も存在しない。しかも一度 audit したのに再びズレた)。
 * 🔑 だから**ここは `KEY_COMMANDS` を描くだけ**にする ── 表を直せば一覧も鍵も同時に動く。
 *
 * ## 🔴 器は 1 度だけ組み、字だけ差し替える
 *
 * 設定の面は `hidden` で常駐する(閉じても捨てない)。組み直すと
 * **押している最中のボタンが作り直されて無言の dead click になる**
 * (2026-08-07 に 3 面で踏んだ形)。だから行は作り置きして、
 * 割当の字と押しボタンだけ `sync()` で書き換える。
 *
 * ## 🔴 捕まえている間は、アプリにキーを渡さない
 *
 * 「割り当て」を押したあとの 1 打鍵は**割当の材料**であって操作ではない。
 * capture 段で受けて `stopImmediatePropagation` する ── これを忘れると、
 * `Ctrl+N` を割り当てようとしただけで**ノートが 1 件できる**。
 */
import {
  chordLabel,
  chordOf,
  chordToString,
  CONTEXT_LABELS,
  KEY_COMMANDS,
  type KeyCommand,
  type KeyContext,
} from '@features/keymap';
import { appKeymap, type KeymapStore } from './keymap';

/**
 * ⚠ **実体は `@features/keymap`**(2026-08-26 に移した)── 操作を名前で探す面
 * (#425 段①)も同じ字で「なぜ押せないか」を言うので、純関数側が正本である。
 * 🔑 ここは**再輸出だけ** ── 既存の読み手(test)の import を切らないため。
 */
export { CONTEXT_LABELS };

/** 並びの順。⚠ `KEY_COMMANDS` の並びを尊重しつつ、文脈ごとに固める。 */
/**
 * ⚠ **`KeyContext` を 1 つ残らず並べる。** 抜けた文脈のコマンドは
 * `primaryContext` の既定で **`global`(「画面のどこでも」)へ落ちる** ──
 * 2026-08-18 に `filer` を足したとき実際に踏んだ:「行に焦点があるときだけ」が
 * 売りの 4 つの鍵が、設定画面で**「画面のどこでも Delete」**と名乗っていた
 * (= この面の中心的な安全主張の真逆)。全数は test が pin する。
 */
const CONTEXT_ORDER: readonly KeyContext[] = [
  'global',
  'filer',
  // ⚠ **`filer` の次に置く**(近い面どうしを離さない)。⚠ 足し忘れると、
  //   `dual` しか名乗らないコマンドが `primaryContext` の既定で
  //   **「画面のどこでも」の下へ落ちる**(嘘の見出し。test が全数で突き合わせる)。
  'dual',
  'editor',
  'append',
  'row',
  'live',
];

function primaryContext(cmd: KeyCommand): KeyContext {
  for (const c of CONTEXT_ORDER) if (cmd.contexts.includes(c)) return c;
  return 'global';
}

export interface KeymapPanel {
  readonly root: HTMLElement;
  /** 割当を描き直す(外から呼ぶ必要は無い ── 保存の変化は自分で購読する)。 */
  sync(): void;
  /** 購読と capture の後始末。⚠ 器と同じ寿命で使う。 */
  dispose(): void;
}

interface Row {
  readonly commandId: string;
  /** 割当を並べる場所。 */
  readonly chords: HTMLElement;
  /** 断り文・案内。 */
  readonly note: HTMLElement;
  /** 「既定に戻す」。⚠ 既定のままなら押せない(押しても何も起きないボタンを出さない)。 */
  readonly reset: HTMLButtonElement;
  readonly assign: HTMLButtonElement;
}

export function buildKeymapPanel(
  store: KeymapStore = appKeymap,
  doc: Document = document,
): KeymapPanel {
  const root = doc.createElement('section');
  root.setAttribute('data-pkc-region', 'settings-keymap');

  const h = doc.createElement('h3');
  h.textContent = 'ショートカットキー';
  root.append(h);

  const intro = doc.createElement('p');
  intro.setAttribute('data-pkc-field', 'settings-note');
  intro.textContent =
    'キーはここで割り当て直せます。1 つのコマンドに複数の割当を持てます。' +
    'Ctrl は Mac では ⌘ でも同じように効きます。' +
    '「割り当て」を押してから、使いたいキーを押してください(Esc でやめます)。';
  root.append(intro);

  const resetAll = doc.createElement('button');
  resetAll.type = 'button';
  resetAll.setAttribute('data-pkc-field', 'keymap-reset-all');
  resetAll.textContent = 'すべて既定に戻す';
  resetAll.title = '自分で割り当てた分を捨てて、最初の割当に戻します';
  resetAll.addEventListener('click', () => {
    store.resetAll();
  });
  root.append(resetAll);

  const rows = new Map<string, Row>();
  /** いま捕まえている相手。`null` = 捕まえていない。 */
  let capturing: string | null = null;

  const dl = doc.createElement('dl');
  dl.setAttribute('data-pkc-region', 'keymap-list');
  let shown: KeyContext | null = null;
  for (const c of CONTEXT_ORDER) {
    for (const cmd of KEY_COMMANDS) {
      if (primaryContext(cmd) !== c) continue;
      if (shown !== c) {
        const head = doc.createElement('dt');
        head.setAttribute('data-pkc-field', 'keymap-group');
        head.textContent = CONTEXT_LABELS[c];
        const empty = doc.createElement('dd');
        empty.setAttribute('data-pkc-field', 'keymap-group-note');
        dl.append(head, empty);
        shown = c;
      }
      const dt = doc.createElement('dt');
      dt.setAttribute('data-pkc-field', 'keymap-command');
      dt.setAttribute('data-pkc-command', cmd.id);
      dt.textContent = cmd.label;
      const dd = doc.createElement('dd');
      dd.setAttribute('data-pkc-field', 'keymap-row');
      dd.setAttribute('data-pkc-command', cmd.id);

      const chords = doc.createElement('span');
      chords.setAttribute('data-pkc-field', 'keymap-chords');
      const assign = doc.createElement('button');
      assign.type = 'button';
      assign.setAttribute('data-pkc-field', 'keymap-assign');
      assign.setAttribute('data-pkc-command', cmd.id);
      assign.textContent = '割り当て';
      const reset = doc.createElement('button');
      reset.type = 'button';
      reset.setAttribute('data-pkc-field', 'keymap-reset');
      reset.setAttribute('data-pkc-command', cmd.id);
      reset.textContent = '既定に戻す';
      const note = doc.createElement('p');
      note.setAttribute('data-pkc-field', 'settings-note');
      note.textContent = cmd.note ?? '';

      assign.addEventListener('click', () => {
        startCapture(cmd.id);
      });
      /**
       * 🔴 **面を離れたら捕獲をやめる**(着地前レビュー 1)。
       *
       * ⚠ 直す前、捕獲を落とすのは「Esc」「何か押した」「dispose」の 3 つだけで、
       * **面が `hidden` になっても生きていた** ── 割り当てを押したまま左の一覧を
       * クリックして本文へ移り、そこで `Ctrl+B` を押すと**その鍵が黙って
       * 「編集する」に化ける**(断り文も成功の表示も hidden の面の中なので、
       * 画面には何も出ない)。
       * 🔑 焦点が離れる = 面を離れる、なので `blur` 1 つで経路がまとめて塞がる。
       */
      assign.addEventListener('blur', () => {
        if (capturing !== cmd.id) return;
        stopCapture();
        sync();
      });
      reset.addEventListener('click', () => {
        store.resetCommand(cmd.id);
      });

      dd.append(chords, assign, reset, note);
      dl.append(dt, dd);
      rows.set(cmd.id, { commandId: cmd.id, chords, note, reset, assign });
    }
  }
  root.append(dl);

  /**
   * 🔴 **捕まえる**。capture 段で受けて**その場で止める** ──
   * ⚠ バブリング段だと、`document` に付いている全域の近道が**先に走る**
   * (`Ctrl+N` を割り当てようとしてノートができる)。
   */
  const onCapture = (ev: Event): void => {
    if (capturing === null) return;
    const ke = ev as KeyboardEvent;
    // ⚠ 変換中は IME のもの ── 割当の材料にしない
    if (ke.isComposing) return;
    const chord = chordOf(ke);
    if (chord === null) return; // 修飾キー単独 ── 押している途中
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const target = capturing;
    const s = chordToString(chord);
    // 🔑 **素の Escape はやめる合図**(割当の材料にしない)── 一般的な作法に合わせる。
    //    ⚠ その代わり Escape そのものは割り当て直せない(既定では使われている)。
    if (s === 'Escape') {
      stopCapture();
      sync();
      return;
    }
    const problem = store.addBinding(target, s);
    stopCapture();
    sync();
    if (problem !== null) {
      const row = rows.get(target);
      if (row) row.note.textContent = `${chordLabel(s)} は割り当てられません ── ${problem.message}`;
    }
  };

  function startCapture(commandId: string): void {
    capturing = commandId;
    sync();
    const row = rows.get(commandId);
    if (row) row.note.textContent = '使いたいキーを押してください(Esc でやめます)';
  }

  function stopCapture(): void {
    capturing = null;
  }

  function sync(): void {
    const bindings = store.getBindings();
    for (const cmd of KEY_COMMANDS) {
      const row = rows.get(cmd.id);
      if (!row) continue;
      const list = bindings[cmd.id] ?? cmd.defaults;
      row.chords.textContent = '';
      if (list.length === 0) {
        const none = doc.createElement('span');
        none.setAttribute('data-pkc-field', 'keymap-none');
        none.textContent = '割当なし';
        row.chords.append(none);
      }
      for (const chord of list) {
        const tag = doc.createElement('span');
        tag.setAttribute('data-pkc-field', 'keymap-chord');
        tag.setAttribute('data-pkc-chord', chord);
        const kbd = doc.createElement('kbd');
        kbd.textContent = chordLabel(chord);
        const drop = doc.createElement('button');
        drop.type = 'button';
        drop.setAttribute('data-pkc-field', 'keymap-drop');
        drop.setAttribute('data-pkc-command', cmd.id);
        drop.setAttribute('data-pkc-chord', chord);
        drop.textContent = '×';
        drop.title = `${chordLabel(chord)} の割当を外します`;
        drop.addEventListener('click', () => {
          store.removeBinding(cmd.id, chord);
        });
        tag.append(kbd, drop);
        row.chords.append(tag);
      }
      // ⚠ 既定のままなら「既定に戻す」は押せない(何も起きないボタンを出さない)
      const isDefault = store.isDefault(cmd.id);
      if (row.reset.disabled !== isDefault) row.reset.disabled = isDefault;
      const active = capturing === cmd.id;
      row.assign.textContent = active ? 'キー待ち…' : '割り当て';
      if (active) row.assign.setAttribute('data-pkc-capturing', '1');
      else row.assign.removeAttribute('data-pkc-capturing');
      // ⚠ 捕まえていない行は、コマンドの説明へ戻す(前の断り文を残さない)
      if (!active) row.note.textContent = cmd.note ?? '';
    }
  }

  doc.addEventListener('keydown', onCapture, true);
  const off = store.onChange(() => {
    sync();
  });
  sync();

  return {
    root,
    sync,
    dispose(): void {
      doc.removeEventListener('keydown', onCapture, true);
      off();
      capturing = null;
    },
  };
}
