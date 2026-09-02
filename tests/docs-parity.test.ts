/** @vitest-environment happy-dom */
/**
 * P7 段⑥: **マニュアルが実装から遅れたら落とす**。
 *
 * 🔴 doc は「書いた時」ではなく「**次に読む時**」に正しくないと意味がない。
 * マニュアルは実装への主張の束であり、主張は黙って腐る ── PKC2 は
 * 「廃止済み flag への言及」「変わった手順」で実際に腐らせた。
 *
 * ⚠ **全部は縛れない**(散文は機械では読めない)。ここが縛るのは
 * **一覧・数・語彙**という、ずれたら user が確実に困るものだけである。
 * 縛っていない主張が嘘になる可能性は残る ── だから doc 側にも
 * 「いま動くものだけを書く」と明記してある。
 */
import { describe, expect, it } from 'vitest';
import { KEY_COMMANDS, chordLabel } from '../src/features/keymap';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildShell } from '../src/adapter/ui/render/shell';
import {
  COLLECTION_COMMANDS,
  SETTINGS_COMMANDS,
  buildSettingsCommands,
} from '../src/adapter/ui/render/commands';
import { showUpdateCard } from '../src/adapter/ui/render/update-card';
import { RENDERABLE_FENCE_LANGS } from '../src/features/markdown/markdown-render';
import { viewModeLabel, type ViewMode } from '../src/adapter/state/app-state';
import { openableViewNames } from '../src/adapter/platform/deep-link';
import { NOTICES, NOTICE_KEEP_MAX } from '../src/features/notice/notice-log';
import { PASTE_SOURCES } from '../src/features/markdown/paste-source';
import { MAX_TABS } from '../src/features/relation/dual-pane';
import { RELATION_KINDS } from '../src/features/relation/kinds';
import { MAX_SMART_TAGS, smartCondError } from '../src/features/smart/smart-spec';
import { MARKDOWN_EXTENSIONS } from '../src/features/import/plain-markdown';
import { REVISION_KEEP_LATEST } from '../src/adapter/platform/storage/store-port';
import { THEMES } from '../src/adapter/ui/render/theme';
import { PAGE_FORMATS } from '../src/features/page-format';
import { EDITOR_MODES } from '../src/features/editor-mode';
import { SEALED_ARCHETYPES, SEALED_VIEWS } from '../src/features/sealed';
import { buildFormatBar } from '../src/adapter/ui/render/format-bar';
import { BAR_FORMAT_OPS, FORMAT_OPS } from '../src/features/markdown/text-ops';
import { APPENDABLE_ARCHETYPES } from '../src/features/flavor/append-spec';
import { buildOfficePackPanel } from '../src/adapter/ui/render/office-pack-panel';
import { OfficePackState } from '../src/adapter/ui/render/office-entry-view';
import { codeOnly } from './helpers/code-only';
import { ENTRY_ACTION_LABELS } from '../src/features/entry-actions';
import { takeFenceAsset } from '../src/features/markdown/fence-asset';
import { readFenceAssetText } from '../src/features/asset/fence-asset-read';

/** src 配下の TS を全部集める(「無い」ことの主張を file 単位で逃さない)。 */
function srcFiles(dir = 'src', out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) srcFiles(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * コメント行を落とす。⚠ **「在る」ことを主張する検査**でだけ使う ──
 * 注釈が検査を満たしてしまうと、実装を消しても緑になる(P8 段⑦ で実際に踏んだ)。
 * ⚠ 逆に「**無い**」ことを主張する検査(drag&drop)には掛けない ── そちらは
 * 広く拾うほうが安全側(コメントで誤検知して落ちるのは、見逃すよりずっとよい)。
 */

const MANUAL = readFileSync('docs/manual.md', 'utf-8');

const SHELL = readFileSync('src/adapter/ui/render/shell.ts', 'utf-8');
const COMMANDS = readFileSync('src/adapter/ui/render/commands.ts', 'utf-8');
const DETAIL = readFileSync('src/adapter/ui/render/detail.ts', 'utf-8');
const BINDER = readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8');
/**
 * 🔴 **説明の正本は `features/entry-actions.ts`**(2026-08-29、#587 C-1)。
 * ⚠ 元は `inspector.ts` に在ったが、**右クリックにも同じ説明を出す**ために移した ──
 *   ここを向け直さないと、検査は**移した先を 1 度も読まない**(在るのに無いと言う)。
 */
const ENTRY_ACTION_SRC = readFileSync('src/features/entry-actions.ts', 'utf-8');const MIGRATION = readFileSync('docs/migration-from-pkc2.md', 'utf-8');

/** shell を 1 度だけ組んで、以後はこれを見る。 */
const root = ((): HTMLElement => {
  const el = document.createElement('div');
  buildShell(el);
  return el;
})();

/** shell が実際に描いたボタンの文言(`data-pkc-action` で引く)。 */
function buttonLabels(action: string): string[] {
  // ⚠ 図案(絵文字)は別の span に入っている ── **文字だけ**を読む
  // (`textContent` だと図案が混ざり、マニュアルとの突合が壊れる)
  return [...root.querySelectorAll(`[data-pkc-action="${action}"]`)]
    .filter((b) => b.tagName === 'BUTTON')
    .map((b) => b.querySelector('[data-pkc-field="label"]')?.textContent ?? b.textContent ?? '');
}

/**
 * 🔴 **文言そのものを pin する**。「マニュアルに `**<文言>**` が在るか」だけでは
 * 足りない ── `バックアップ` を `保存` に改名する変異が**生き残った**。
 * マニュアル §2 の「書く → **保存**」(編集ボタンの話)に**たまたま救われて**いた。
 * 散文は何にでも当たるので、**期待する一覧を literal で持つ**しかない。
 * 改名したらここが落ちる = マニュアルも直せ、という合図になる。
 */
const EXPECTED_LABELS = {
  // ⚠ 種類は `<select>` で選ぶので、ボタンは 1 つ(P8)
  // ⚠ P10 で**分割ボタン**になった ── 文言は「+ <いま選んでいる種類>」で、
  // 起動直後は先頭の種類(ノート)。⚠ 種類の一覧は `pick-create-kind` 側で見る
  'create-entry': ['+ ノート'],
  /**
   * 種類の一覧(分割ボタンの ▼ の中)。⚠ **等値**で見る ── 封印中のものが
   * 混ざったら落ちる(封印の pin と二重に効く)。
   */
  'pick-create-kind': ['ノート', 'ログ', '表', 'フォルダ', 'スマートフォルダ', '雛形'],
  // ⚠ **アプリ全体**のものだけ(P8 段⑤。P10 で上の帯は撤去され、左の列の下へ)
  //    フラグは P11 で追加 ── 設定(user 開放)とは**別の面**にする(user 裁定 2026-08-07)
  // ⚠ 集計(#184)は**一番上** ── 日々使う面を、困ったときに見る面より手前に置く
  // ⚠ **2 ペインはここに無い**(user 指摘 2026-08-19)── アプリの一覧の
  //    組み込みタイルが導線である(Office と同じ形)。ここはアプリ全体の操作だけ
  'set-view': ['集計', '設定', 'フラグ', 'ヘルプ'],
  // 探し方は**左の列**が持つ
  // ⚠ 2026-08-23 に「予定」を足した(#292 段③)── 等値なので足し忘れると落ちる
  // ⚠ 2026-08-27 に「連絡先」を足した(#278 段①)
  'set-browse': ['一覧', 'フォルダ', 'アプリ', '予定', '連絡先'],
  'export-archive': ['バックアップ'],
  'import-file': ['取り込む'],
  'attach-file': ['添付'],
} as const;

/**
 * 🔴 **選ぶもの**(`<select>` の option)も同じ規律で pin する。
 * ボタンだけ見ていると、種類の改名がマニュアルとずれても気づかない。
 */
const EXPECTED_OPTIONS = {
  'create-kind': ['ノート', 'ログ', '表', 'フォルダ', 'スマートフォルダ', '雛形'],
} as const;

describe('マニュアルと実装の突合', () => {
  it.each(Object.entries(EXPECTED_LABELS))(
    '🔴 %s のボタン文言が pin と一致し、マニュアルにも在る',
    (action, expected) => {
      const labels = buttonLabels(action);
      // ⚠ **等値**で見る(包含だと足したものが素通りする)
      expect(labels).toEqual([...expected]);
      for (const label of labels) {
        expect(MANUAL, `マニュアルに「${label}」の説明が無い`).toContain(`**${label}**`);
      }
    },
  );

  it.each(Object.entries(EXPECTED_OPTIONS))(
    '🔴 %s の選択肢が pin と一致し、マニュアルにも在る',
    (field, expected) => {
      const sel = root.querySelector(`[data-pkc-field="${field}"]`);
      const labels = [...(sel?.querySelectorAll('option') ?? [])].map(
        (o) => o.textContent ?? '',
      );
      expect(labels).toEqual([...expected]);
      for (const label of labels) {
        expect(MANUAL, `マニュアルに「${label}」の説明が無い`).toContain(`**${label}**`);
      }
    },
  );

  it('🔴 封印中のものは導線に出ない(user 指示 2026-08-03)', () => {
    // ⚠ 「消した」ではなく「畳んだ」ので、**戻せる形**であることも一緒に見る
    for (const view of SEALED_VIEWS) {
      expect(
        root.querySelector(`[data-pkc-view="${view}"]`),
        `封印したはずの ${view} が導線に出ている`,
      ).toBeNull();
    }
    for (const archetype of SEALED_ARCHETYPES) {
      const opts = [...root.querySelectorAll('[data-pkc-field="create-kind"] option')];
      expect(
        opts.some((o) => (o as HTMLOptionElement).value === archetype),
        `封印したはずの ${archetype} が作成の選択肢に出ている`,
      ).toBe(false);
    }
  });

  it('🔴 配色の選択肢が CSS の定義と 1 対 1 である', () => {
    // ⚠ 片方だけ増やしても壊れない ── 選べるのに CSS が無い(素の色が出る)/
    // CSS はあるのに選べない(死んだ規則)の両方を落とす
    const css = readFileSync('src/styles/tokens.css', 'utf-8');
    const inCss = new Set(
      [...css.matchAll(/\[data-pkc-theme='([a-z-]+)'\]/g)].map((m) => m[1]!),
    );
    const offered = THEMES.map((t) => t.id);
    expect([...offered].sort()).toEqual([...inCss].sort());
  });

  /**
   * 🔴 **紙面の選択肢と読み幅が、マニュアルと一致する**(2026-08-08)。
   *
   * ⚠ 変異試験で**名前の書き換えが 1 巡目に生き延びた** ── 設定画面の選択肢は
   * `PAGE_FORMATS` から作るので、表を書き換えると画面もマニュアル**以外**は
   * 一緒に動いてしまい、どの検査も鳴らない。user が読むのはマニュアルなので、
   * **画面の名前とマニュアルの名前が食い違う**のが実害である。
   * ⚠ 数字(読み幅)も pin する ── 「数字は真っ先に腐る」(履歴の保持件数と同じ)。
   */
  it('🔴 紙面の選択肢と読み幅がマニュアルと一致する', () => {
    expect(PAGE_FORMATS.length, '紙面が 1 つも無い(この検査は空振り)').toBeGreaterThan(4);
    for (const f of PAGE_FORMATS) {
      expect(MANUAL, `マニュアルに紙面「${f.label}」が無い`).toContain(`**${f.label}**`);
      if (f.readWidth.endsWith('rem')) {
        /**
         * ⚠ **行を特定して見る**(2026-08-08 のレビューで判明)。`toContain` で
         * 文書全体を見ると、**別の行が満たしてしまう** ── `62rem` は A4 横と
         * A3 縦の 2 行にあるので、A3 縦の値を 42rem に書き換える変異が
         * A4 横の行に救われて生き延びた。「マニュアルだけが嘘になる」型は、
         * この検査の存在理由そのものである。
         */
        const row = MANUAL.split('\n').find(
          (l) => l.startsWith('|') && l.includes(`**${f.label}**`),
        );
        expect(row, `マニュアルに紙面「${f.label}」の行が無い`).toBeDefined();
        expect(row!, `マニュアルの ${f.label} の読み幅が ${f.readWidth} でない`).toContain(
          f.readWidth,
        );
      }
    }
    // ⚠ cap を外す形式は**そう書いてある**こと(数字が無いので言葉で確かめる)
    expect(MANUAL, 'マニュアルに「上限なし」の説明が無い').toContain('**上限なし**');
  });

  /**
   * 🔴 **編集の仕方の選択肢が、マニュアルと一致する**(#104 第 2 弾)。
   * label は設定画面が `EDITOR_MODES` から作るので、名前を変えると
   * マニュアルだけが嘘になる ── 紙面と同じ型の pin。
   */
  it('🔴 編集の仕方の選択肢がマニュアルと一致する', () => {
    expect(EDITOR_MODES.length, '編集の仕方が 1 つも無い(この検査は空振り)').toBe(2);
    for (const m of EDITOR_MODES) {
      expect(MANUAL, `マニュアルに編集の仕方「${m.label}」が無い`).toContain(`**${m.label}**`);
    }
  });

  it('🔴 描画できる fence 言語が一致する', () => {
    expect(RENDERABLE_FENCE_LANGS.size).toBeGreaterThan(0);
    for (const lang of RENDERABLE_FENCE_LANGS) {
      expect(MANUAL, `マニュアルに fence \`${lang}\` の説明が無い`).toContain(`\`${lang}\``);
    }
  });

  it('受け取れる markdown の拡張子が一致する', () => {
    for (const ext of MARKDOWN_EXTENSIONS) {
      expect(MANUAL).toContain(`\`${ext}\``);
    }
  });

  it('履歴の保持件数が一致する(数字は真っ先に腐る)', () => {
    expect(MANUAL).toContain(`最新 ${REVISION_KEEP_LATEST} 件`);
  });

  it('🔴 書き出すファイルの拡張子が一致する', () => {
    // ⚠ 「どれがバックアップか」を取り違えると、**戻せない形を保存し続ける**
    const src = readFileSync('src/adapter/ui/actions/export-archive.ts', 'utf-8');
    for (const ext of ['.pkc3.zip', '.md.zip', '.html']) {
      expect(src, `実装が ${ext} を作らない`).toContain(`}${ext}\``);
      expect(MANUAL, `マニュアルに ${ext} が無い`).toContain(ext);
    }
  });

  it('🔴 ドラッグ&ドロップの記述が実態と合う(#250 で受けるようになった)', () => {
    // ⚠ 2026-08-18 まで「**受けません**」と書いてあり、この test がそれを pin して
    // いた ── #250 で drop を足した瞬間に落ちて気づけた。**同じ向きのまま裏返す**:
    // 今度は「受ける実装が消えたら」落ちる(マニュアルが嘘になる側で鳴る)。
    // ⚠ **src 全体**を見る(round-2 review L-4)── `binder.ts` だけを見ていると、
    // 別 file へ移したときに緑のまま嘘になる
    // ⚠ **`codeOnly` を通す**(2026-08-18、着地前レビュー)── 向きを裏返した
    //   ことで、この検査は「**在る**」ことの主張になった。注釈で満たされると
    //   `root.addEventListener('drop', …)` を**コメントアウトしても緑**になる
    //   (この file の `codeOnly` の docstring がまさにそう戒めている)
    const receivers = srcFiles().filter((f) =>
      /addEventListener\(\s*['"]drop['"]/.test(codeOnly(readFileSync(f, 'utf-8'))),
    );
    expect(receivers, 'drop を受ける実装が無い ── マニュアルの記述が嘘になる').not.toEqual([]);
    // ⚠ `dragover` を止めないと `drop` は**来ない** ── 片方だけでは動かない
    const over = srcFiles().filter((f) =>
      /addEventListener\(\s*['"]dragover['"]/.test(codeOnly(readFileSync(f, 'utf-8'))),
    );
    expect(over, 'dragover を受けていない ── drop は来ない').not.toEqual([]);
    expect(MANUAL).toContain('ドラッグ&ドロップでも入ります');
    expect(MANUAL, '「受けません」が残っている').not.toContain('ドラッグ&ドロップは受けません');
  });

  it('🔴 スクショの貼付の記述が実態と合う(#250)', () => {
    // ⚠ 「貼れます」はマニュアルの**約束**なので、受け口が消えたら嘘になる
    const receivers = srcFiles().filter((f) =>
      /addEventListener\(\s*['"]paste['"]/.test(codeOnly(readFileSync(f, 'utf-8'))),
    );
    expect(receivers, '貼付を受ける実装が無い').not.toEqual([]);
    expect(MANUAL, 'マニュアルに貼付の導線が無い').toContain('`Ctrl+V`');
    expect(MANUAL).toContain('スクリーンショットをそのまま貼れます');
  });

  it('🔴 主要な導線を畳まない(業務画面の作法)', () => {
    // user 指示 2026-08-03「シンプルかつ高機能」── 主要な導線を `<details>` へ
    // 畳むと「どこにあるか探す」手間が増える。⚠ 以前は
    // `取り込む▾ 書き出す▾ 整理▾ 表示▾` と畳んでいた(その形へ戻ったら落とす)
    expect(root.querySelectorAll('details').length, '導線が畳まれている').toBe(0);
    for (const action of COLLECTION_COMMANDS.map((c) => c.action)) {
      const el = root.querySelector(`[data-pkc-action="${action}"]`);
      expect(el, `${action} が見当たらない`).not.toBeNull();
      expect(el?.closest('[hidden]'), `${action} が隠れている`).toBeNull();
    }
    // 🔴 **移した先でも畳まれていない**(#239)── user 指示 2026-08-17 で
    //    低頻度の 3 つは設定へ逃がしたが、それは「畳む」ではない。
    //    ⚠ ここを見ないと、`SETTINGS_COMMANDS` を空にしても上のループが通るので
    //    **動線が丸ごと消えても全緑**になる(受け手だけが残るので dead-action 検査も鳴らない)
    const commands = buildSettingsCommands();
    expect(commands.querySelectorAll('details').length, '設定側で畳まれている').toBe(0);
    for (const action of SETTINGS_COMMANDS.map((c) => c.action)) {
      expect(
        commands.querySelector(`[data-pkc-action="${action}"]`),
        `${action} が設定の面にも無い`,
      ).not.toBeNull();
    }
  });

  /**
   * 🔴 **設定へ逃がした操作の文言**(#239)。
   *
   * ⚠ この 3 つは `buildShell` を見る上の突合には**もう掛からない** ──
   * 改名しても全緑で通り、マニュアルだけが嘘になる(Office 一式の節と同じ形)。
   * 🔑 **実際に描いたボタン**と突き合わせる(ソースを grep しない)。
   */
  it('🔴 設定へ逃がした操作が pin と一致し、マニュアルにも在る', () => {
    const commands = buildSettingsCommands();
    const labels = [...commands.querySelectorAll('button')].map(
      (b) => b.querySelector('[data-pkc-field="label"]')?.textContent ?? b.textContent ?? '',
    );
    // ⚠ **等値**で見る(包含だと足したものが素通りする)
    expect(labels).toEqual([
      '閲覧用 HTML',
      // 🔴 可搬単一 HTML(#400 段④)── **読むだけの隣**に置く。同じ「HTML 1 枚」
      //    なので、離すと user が違いに気づけない
      '持ち歩ける HTML 1 枚',
      'Markdown',
      // 🔴 構成をコピー(#429 段①)── 書き出しの仲間(PKC3 の外へ渡す形にする)
      '構成をコピー',
      '使っていない添付を消す',
      // 🔴 何が容量を食っているか(#415)── 片づけの**手前**(どれが重いか分からないと片づけられない)
      '調べる',
      // 🔴 整理案を適用する(#429 段③)── 「構成をコピー」の**後半**なので同じ面に置く
      //    ⚠ 畳んでいない(user 指示 2026-08-03「主要な導線は全部見えている」)
      '適用する',
      /**
       * 🔴 **設定だけの持ち出し**(#414)── バックアップとは別物(ノートは入らない)。
       * ⚠ 設定側の字を「適用する」にしない ── 同じ面に整理案の「適用する」が在るので、
       *   **同じ字のボタンが 2 つ**並んで user が見分けられなくなる
       *   (この等値 pin がそれを教えた)。
       */
      '設定を書き出す',
      '設定を適用',
    ]);
    for (const label of labels) {
      expect(MANUAL, `マニュアルに「${label}」の説明が無い`).toContain(`**${label}**`);
    }
  });

  it('🔴 本文まわり / 情報ペインのボタン文言が pin と一致し、マニュアルにも在る', () => {
    // ⚠ `buildShell` だけを見ていたので、`detail.ts` の文言は**1 つも縛られて
    // いなかった**(round-2 review M-7)── マニュアルは実際に 2 件間違えていた。
    // 🔑 P8 で**置き場所が変わった** ── 本文の上には「編集」だけを残し、
    // entry に対する操作(書き出す / 履歴 / 削除)は右の情報ペインへ移した
    // ⚠ 図案つきボタンは `iconButton(action, label)` で作る ── 文言はその第 2 引数
    const detail = readFileSync('src/adapter/ui/render/detail.ts', 'utf-8');
    for (const label of ['編集', '保存', 'キャンセル']) {
      expect(detail, `本文まわりから「${label}」が消えた`).toContain(`, '${label}')`);
    }
    // 🔴 **追記は本文の上に無い**(P8 段⑧)── 段⑥ ではここに置いたが、
    // 「編集に入って末尾へ飛ぶ」形は追記型の意味を成していなかった。
    // 追記は編集画面を通らない別の器が持つ(`append-box.ts`)
    expect(detail, '追記が本文の上に戻っている').not.toContain(", '追記')");
    const box = readFileSync('src/adapter/ui/render/append-box.ts', 'utf-8');
    expect(box, '追記の導線が消えた').toContain("'追記'");
    // ⚠ ロックの出口も pin する ── 無くなると「永久に追記できない」が作れる
    for (const label of ['保存して解放', '編集を破棄', '強制解放']) {
      expect(box, `ロックの出口「${label}」が消えた`).toContain(`'${label}'`);
      expect(MANUAL, `マニュアルに「${label}」が無い`).toContain(`**${label}**`);
    }
    expect(detail, '復元が消えた').toContain("textContent = '復元'");
    const inspector = readFileSync('src/adapter/ui/render/inspector.ts', 'utf-8');
    /**
     * ⚠ **字の在り処が変わった**(2026-08-27、#426 段①)── これらは
     * 右クリックのメニューにも出るので、**`features/entry-actions.ts` が字の正本**に
     * なった(情報ペインはそこから引く)。
     * 🔑 **見たいこと自体は変わっていない**:「情報ペインにこのボタンが在り、
     *   同じ字がマニュアルにも在る」。⚠ だから**正本の側で字を確かめ**、
     *   情報ペインは**その操作を出していること**で見る。
     */
    const ACTION_OF: Record<string, string> = {
      書き出す: 'export-entry',
      履歴: 'show-history',
      削除: 'delete-entry',
    };
    for (const label of ['書き出す', '履歴', '削除']) {
      const action = ACTION_OF[label]!;
      expect(ENTRY_ACTION_LABELS[action], `字の正本から「${label}」が消えた`).toBe(label);
      expect(inspector, `情報ペインから「${label}」が消えた`).toContain(
        `ENTRY_ACTION_LABELS['${action}']`,
      );
    }
    // ⚠ **2 か所に同じボタンを出さない**(押す場所が定まらなくなる)
    for (const label of ['削除', '履歴']) {
      expect(detail, `「${label}」が本文の上にも残っている`).not.toContain(`, '${label}')`);
    }
    for (const label of ['編集', '保存', 'キャンセル', '履歴', '書き出す', '追記']) {
      expect(MANUAL, `マニュアルに「${label}」が無い`).toContain(`**${label}**`);
    }
  });

  it('🔴 書式パネルの文言が表と 1 対 1 で、マニュアルにも在る', () => {
    // ⚠ **描いたボタン**と突き合わせる(`FORMAT_OPS` を 2 回読んでも何も
    // 分からない)── 表に足してボタンを出し忘れる / 出したのに表から漏れる、
    // どちらも落ちる
    const bar = buildFormatBar();
    // ⚠ 突き合わせ先は **`BAR_FORMAT_OPS`**(#425 段②-a)── 帯に出さない 4 つは
    //    `tests/adapter/format-append.test.ts` の「鍵から引ける」が守る
    const labels = [...bar.querySelectorAll('button')].map(
      (b) => b.querySelector('[data-pkc-field="label"]')?.textContent ?? '',
    );
    /**
     * ⚠ **書式そのもの以外も乗っている**(2026-08-15 / 2026-08-23 / 2026-08-25)──
     * 置換の切替(user 指示「中央の上を潰しすぎ」)、日付を入れる道具
     * (user 指示 2026-08-23「日付と時刻を簡単に入力できる…ツール」)、
     * 雛形の一覧(#196 段②-b ── 短縮語を覚えていない人の唯一の入口)。
     * ⚠ **どれも `FORMAT_OPS` には入れない** ── あちらは「その場で字を変える
     *   純関数」の表で、こちらは**先に聞く**(帯 / ダイアログが挟まる)。
     *   混ぜると「押したら何が起きるか」が表から読めなくなる。
     * ⚠ 等値で pin したままにする ── 増えたら**ここが落ちる**のが正しい
     *   (黙って増える帯にしない)。この等値は 2026-08-25 に実際に
     *   「1 つ増えた」を **2 度**捕まえた(雛形 / **番号**)。
     * ⚠ **番号**(#396)も `FORMAT_OPS` には入れない ── あちらは
     *   「その場で字を変える純関数」の表だが、こちらは**本文全体**を
     *   書き換える 1 手であって、選択に当てる書式ではない。
     */
    /**
     * ⚠ 2026-08-26 に **ノート**(#427 段②)が増えた ── 別のノートを題名で
     *   探してリンクを入れる。⚠ これも `FORMAT_OPS` には入れない
     *   (日付・雛形と同じく**先に聞く**)。
     */
    expect(labels).toEqual([
      ...BAR_FORMAT_OPS.map((o) => o.label),
      '日付',
      'ノート',
      '雛形',
      '番号',
      '置換',
    ]);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(MANUAL, `マニュアルに書式「${label}」の説明が無い`).toContain(`**${label}**`);
    }
    /**
     * 🔴 **帯に出さない記法も、マニュアルには載っている**(#425 段②-a)。
     * ⚠ 上の輪は**帯のボタン**しか回らないので、`onBar: false` を付けた瞬間に
     *   マニュアルの検査から**黙って外れる** ── そこを塞ぐ。
     */
    const offBar = FORMAT_OPS.filter((o) => o.onBar === false);
    expect(offBar.length, '帯に出さない記法が 1 つも無い(空振り)').toBeGreaterThan(0);
    for (const { label } of offBar) {
      expect(MANUAL, `マニュアルに「${label}」の説明が無い(帯に出ないので余計に要る)`)
        .toContain(`**${label}**`);
    }
  });

  /**
   * 🔴 **貼り付けの読み取り方の名前が、マニュアルと食い違わない**(#636)。
   *
   * ⚠ 直す前は **pin が 1 件も無かった** ── 実際に食い違っていた:設定画面は
   *   「ウェブページの形をそのまま(html の**囲み**)」、マニュアルは同じ字を
   *   逐語で引いた `#####` 見出しを持つのに、**どちらを直しても何も鳴らなかった**。
   * 🔑 書式パネル(上の輪)と同じ形で留める ── 選択肢を足した人が
   *   「マニュアルに書き忘れた」でそのまま出荷できないようにする。
   */
  it('🔴 貼り付けの読み取り方の名前が、マニュアルに在る', () => {
    expect(PASTE_SOURCES.length, '選択肢が 0 件(空振り)').toBeGreaterThan(0);
    for (const { label } of PASTE_SOURCES) {
      expect(MANUAL, `マニュアルに貼り付けの「${label}」の説明が無い`).toContain(`**${label}**`);
    }
  });

  /**
   * 🔴 **コードブロックが添付を読めなかったときの字が、マニュアルと 1 字も違わない**(#636)。
   *
   * ⚠ 直す前は pin が **0 件**で、実際に 1 件割れていた ── 製品は
   *   「`asset:` の後ろに添付の名前がありません」、マニュアルは「添付の ID が空です」。
   *   user は**画面に出た字でマニュアルを引く**ので、割れた瞬間に節ごと届かなくなる。
   * 🔑 期待値は**実装を呼んで作る**(字を test に書き写さない)── 書き写すと
   *   「同じ規則の 2 本目」になり、製品を直しても test は自分の綴りを守り続ける。
   * ⚠ 探すのは**その節の中だけ** ── マニュアル全体で探すと、別の章の散文に
   *   満たされる(CLAUDE.md §1)。
   */
  it('🔴 添付を読めなかったときの字が、マニュアルの節に在る', async () => {
    const head = MANUAL.indexOf('#### 中身を添付から取る');
    expect(head, 'マニュアルに「中身を添付から取る」の節が無い(空振り)').toBeGreaterThan(0);
    const next = MANUAL.indexOf('\n#### ', head + 1);
    expect(next, '節の終わりが見つからない(空振り)').toBeGreaterThan(head);
    const section = MANUAL.slice(head, next);

    // ⚠ 実装が出す 4 通りを、実装から取る
    const parse2 = takeFenceAsset('asset:a asset:b');
    const parseEmpty = takeFenceAsset('asset:');
    const missing = await readFenceAssetText(async () => null, 'k');
    const notText = await readFenceAssetText(
      async () => ({ text: () => Promise.reject(new Error('x')) }) as unknown as Blob,
      'k',
    );
    const whys = [
      parse2.kind === 'invalid' ? parse2.why : '',
      parseEmpty.kind === 'invalid' ? parseEmpty.why : '',
      missing.ok ? '' : missing.why,
      notText.ok ? '' : notText.why,
    ];
    expect(whys.filter((w) => w !== ''), '実装から理由を 4 通り取れていない(空振り)').toHaveLength(4);

    // 🔴 **表の 1 列目と「丸ごと」突き合わせる**(変異試験 M5 が SURVIVED で教えた)。
    // ⚠ `toContain` だと**部分一致で救われる** ── 製品を「字として読めません」から
    //   「読めません」へ縮める変異は、マニュアルの長いほうに含まれるので通ってしまう。
    // ⚠ 集合で見るので「マニュアルにだけ在る行」も落とす(製品が出さない字を
    //   読ませない)。
    // ⚠ 節には表が 2 つある ── **理由の表だけ**を取る(見出し行から数える)
    const lines = section.split('\n');
    const at = lines.findIndex((l) => l.startsWith('| 出る字 |'));
    expect(at, '節に「出る字」の表が無い(空振り)').toBeGreaterThanOrEqual(0);
    const listed: string[] = [];
    for (const line of lines.slice(at + 2)) {
      if (!line.startsWith('|')) break;
      listed.push(line.split('|')[1]!.trim());
    }
    expect(listed.length, '節に理由の表が無い(空振り)').toBeGreaterThan(0);
    expect([...listed].sort(), 'マニュアルの理由の表が、実装の出す字と一致しない').toEqual(
      [...whys].sort(),
    );
  });

  /**
   * 🔴 **user の言葉で引いて当たる**(#636 の user 報告そのもの)。
   *
   * > 「**マニュアルにコードフェンスにアセットを埋め込む方法が書いていない**」
   *
   * ⚠ 実際は 39 行書いてあったが、`アセット` が **0 件**で、画面に出る
   *   「コードブロック」も **0 件**だった ── **在るのに引けない**。
   * 🔑 ヘルプの探す欄は**見出しを結果として並べる**ので、見出しに両方入れておく。
   */
  it('🔴 添付を埋め込む節の見出しが、user の言葉で引ける', () => {
    const heading = MANUAL.split('\n').find((l) => l.startsWith('#### 中身を添付から取る'));
    expect(heading, '節の見出しが無い(空振り)').toBeTruthy();
    for (const word of ['アセット', 'コードブロック', '埋め込']) {
      expect(heading, `見出しに「${word}」が無い ── その語で探しても当たらない`).toContain(word);
    }
  });

  /**
   * 🔴 **表が途中で切れていない**(#636 で 2 件見つかった)。
   *
   * 実害:段落のすぐ後ろに `|` の行が続くと、markdown はそれを**段落の続き**として
   * 出すので、**生の `|` が並んだ行**が画面に出る。実際に:
   * - ショートカットの表が ⚠ 段落で切れ、**左右のペインを畳む等 4 行**が生で出ていた
   * - 書き出しの一覧が **9 行**まるごと別の節(設定の読み込み)の末尾に落ちており、
   *   本体の表は **1 行**しか無かった
   * ⚠ どちらも「見出しは在るのに中身が届かない」── この issue の当の症状である。
   */
  it('🔴 マニュアルの表に、見出しから切れた行が 1 つも無い', () => {
    const lines = MANUAL.split('\n');
    let inFence = false;
    const stranded: string[] = [];
    for (const [i, line] of lines.entries()) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence || !line.startsWith('|')) continue;
      if ((lines[i - 1] ?? '').startsWith('|')) continue;
      // 見出し行なら、次が区切り行(`|---|`)であるはず
      if (/^\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) continue;
      stranded.push(`${i + 1}: ${line.slice(0, 60)}`);
    }
    expect(stranded, '表から切れた行がある(生の | が画面に出る)').toEqual([]);
    // ⚠ 囲みの開閉が釣り合っていないと、走査は**中身を本文と読み違える** ──
    //   そのまま緑になると「切れた行が無い」が別の理由で成立する(空振り)
    expect(inFence, '囲みの開閉が釣り合っていない(走査がずれている)').toBe(false);
  });

  it('🔴 図の書き出しが**生きている**(死んだコードに戻らない)', () => {
    // 🔴 `renderToSvg()` は書かれたまま**呼び出し元が 0 件**だった(P8 段⑦ で発覚)。
    // user 指示 2026-08-03 は「エクスポート**させるとき以外は** PNG」── つまり
    // 書き出しの導線が在る前提だったのに、無かった。⚠ 「関数が在るか」ではなく
    // **呼ばれているか**を見る(在るだけなら前も在った)
    // 🔴 **コメントを外してから探す**。素の grep は 1 巡目で
    // `mermaid-hydrate.ts` の説明文(「`renderToSvg()` は呼び出し元が 0 件だった」)
    // に救われ、**呼び出しを消しても緑**だった ── 救い手が自分の注釈だった。
    // 「それらしい文字列が在るか」ではなく「**コードとして呼ばれているか**」で書く
    const callers = srcFiles().filter((f) => {
      if (f.endsWith('mermaid-raster.ts')) return false; // 定義元は呼び出し元ではない
      return /\brenderToSvg\s*\(/.test(codeOnly(readFileSync(f, 'utf-8')));
    });
    expect(callers, '図をベクタで書き出す呼び出し元が無い').not.toEqual([]);
    // 導線の文言もマニュアルと突き合わせる
    const hydrate = readFileSync('src/adapter/ui/render/mermaid-hydrate.ts', 'utf-8');
    expect(hydrate, '保存の導線が消えた').toContain("'図を保存'");
    expect(MANUAL, 'マニュアルに「図を保存」が無い').toContain('**図を保存**');
  });

  it('🔴 「追記できる種類」がマニュアルと一致する', () => {
    // マニュアルは「**ノート** と **ログ** には **追記** があります」と書いている。
    // 🔴 ここは**もともと doc が先に嘘をついていた**箇所である ── マニュアルも
    // `textlog-flavor.ts` も「追記型」と書きながら、その UI は存在しなかった
    expect([...APPENDABLE_ARCHETYPES].sort()).toEqual(['text', 'textlog']);
    expect(MANUAL).toContain('**ノート** と **ログ** には、本文の下に **追記欄** が出ます');
  });

  /**
   * 🔴 **Office 一式の導線が、マニュアルと 1 対 1**(#88 / O6-a)。
   *
   * ⚠ この節は**設定の面にしか無い**ので、`buildShell` を見る上の検査には
   * 1 つも掛からない ── 改名しても全緑で通り、マニュアルだけが嘘になる。
   * 🔑 **実際に描いたボタン**と突き合わせる(ソースの文字列を grep しない)。
   */
  it('🔴 Office 一式の導線が pin と一致し、マニュアルにも在る', () => {
    const panel = buildOfficePackPanel(new OfficePackState());
    const labels = [...panel.root.querySelectorAll('button')].map((b) => b.textContent ?? '');
    // ⚠ **等値**で見る(包含だと足したものが素通りする)
    // ⚠ 「設定を初期化」は #634 で足した ── 一式の削除では Office の設定が消えないため
    expect(labels).toEqual([
      '取得して入れる',
      'ファイルから入れる',
      '削除',
      'Office の設定を初期化',
    ]);
    for (const label of labels) {
      expect(MANUAL, `マニュアルに「${label}」の説明が無い`).toContain(`**${label}**`);
    }
    panel.dispose();
    // ⚠ **数字も pin する**(「数字は真っ先に腐る」)── 77MB は画面にも出る
    expect(MANUAL, 'マニュアルに一式の大きさが無い').toContain('77MB');
  });

  it('🔴 更新の案内の文言が pin と一致し、マニュアルにも在る', () => {
    // round-2 review L-1: 「再読込」→「今すぐ更新」に改名しても全緑だった ──
    // 段⑥ の趣旨(腐ったら落ちる)がこの feature にだけ効いていなかった
    const el = document.createElement('section');
    showUpdateCard(el);
    const labels = [...el.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(labels).toEqual(['再読込', 'あとで']);
    for (const label of labels) {
      expect(MANUAL, `マニュアルに「${label}」が無い`).toContain(`**${label}**`);
    }
  });

  /**
   * 🔴 **マニュアルが「もう無い場所」を案内していないか**(2026-08-07)。
   *
   * 直す前、マニュアルは 2 か所で**実装より古い案内**をしていた:
   * ① 「**いちばん上の帯**の設定から開きます」── 上の帯は P10 で撤去済みで、
   *    設定ボタンは**左の列**に在る(`shell.ts:44-59`)
   * ② 「画面下の status に常に出ているのは**バージョン**だけ…マウスを載せると出ます」
   *    ── status は通常 **hidden**(`main.ts:262`)で、版は設定画面へ移動済み
   *
   * ⚠ どちらも既存の pin(下の 3 語句)の網に掛からず、**素通りしていた**。
   * 🔑 ヘルプ画面からマニュアルを見せる(P11)と、**この嘘が user に直接届く**。
   *   だから「もう存在しない場所の名前」を機械的に禁じる。
   */
  it('🔴 マニュアルが撤去済みの場所を案内していない', () => {
    const shell = readFileSync('src/adapter/ui/render/shell.ts', 'utf-8');
    // 前提(空振り防止): 上の帯は実装から本当に消えている
    expect(shell, '上の帯が復活した ── 下の禁止は前提を失っている').not.toContain(
      "createElement('header')",
    );
    // ⚠ **見出しも見る**(2026-08-08)。本文だけ直して**見出しを直し忘れて**いた ──
    //    「## 4. 上部のならび」が残っており、同じ腐りの対称の反対側だった
    for (const gone of ['いちばん上の帯', '上部の帯', '上の帯', '上部のならび']) {
      expect(MANUAL, `マニュアルが撤去済みの「${gone}」を案内している`).not.toContain(gone);
    }
    /**
     * ⚠ status は「知らせることがあるときだけ」出る面である。
     * 「常に出ている」と書くと、user は無い物を探す。
     */
    expect(MANUAL, 'status が常に出ていると書いてある').not.toContain('status に常に出ている');
  });

  /**
   * 🔴 **版がどこに出ているか、マニュアルと実装が一致する**(2026-08-07)。
   * ⚠ 版の在り処は 2 度動いている(status → 設定画面)。動くたびに案内が腐るので pin する。
   */
  /**
   * 🔴 **マニュアルは user が読むもの**(2026-08-08。同梱するので 1 行目から目に入る)。
   * ⚠ 書き手向けの指示・手書きの日付を置かない ── 前者は読み手に意味が無く、
   *   後者は**必ず腐る**(実際に「最終更新 2026-08-03」の後 3 回改訂されていた)。
   */
  it('🔴 マニュアルに書き手向けの前置きと手書きの日付が無い', () => {
    const head = MANUAL.slice(0, 400);
    expect(head, '書き手向けの指示が残っている').not.toContain('この doc は');
    expect(head, '手書きの日付が残っている(必ず腐る)').not.toMatch(/最終更新/);
  });

  /**
   * 🔴 **左の列のボタンとマニュアルの表が一致する**(2026-08-08)。
   * ⚠ 「フラグ」を足したとき §4-3 は書いたのに**要約の表を直し忘れて**いた。
   */
  it('🔴 左の列の導線が、マニュアルの表に全部載っている', () => {
    /**
     * ⚠ **実際に描かれたボタンを見る**(ソースの `label:` を正規表現で拾わない)。
     * 拾うと封印済みの語(`Todo` 等)まで当たって、**マニュアルに無い物を要求する**
     * ── 1 巡目で実際に踏んだ。観測点は「shell が何を描いたか」である。
     */
    const labels = buttonLabels('set-view');
    expect(labels.length, '導線を 1 つも拾えていない').toBeGreaterThanOrEqual(2);
    for (const label of labels) {
      expect(MANUAL, `マニュアルの表に「${label}」が無い`).toContain(`**${label}**`);
    }
  });

  /**
   * 🔴 **版は 1 か所にだけ在る**(P11 で設定 → ヘルプへ移した)。
   * ⚠ 「ヘルプに在る」だけを見ると、**設定にも残ったまま**の二重表示を見逃す ──
   *   マニュアルは 1 か所しか案内しないので、片方が黙って古くなる。
   *   だから**在ることと、もう片方に無いこと**の両方を見る。
   */
  it('🔴 版の在り処がマニュアルと一致し、組み立ては 1 か所だけ', () => {
    const help = readFileSync('src/adapter/ui/render/help.ts', 'utf-8');
    expect(help, 'ヘルプ画面が版を出していない').toContain('help-version');
    /**
     * 🔴 **file 名指しにしない**(2026-08-08、レビュー指摘)。
     * ⚠ 直す前は `settings.ts` に `APP_VERSION` が無いことしか見ていなかったので、
     *   **他のどの面に版を生やしても素通り**した ── 題名は「2 か所に出ていない」
     *   なのに、守っていたのは「settings.ts に出ていない」だけだった
     *   (CLAUDE.md「それらしい 1 file を見る型の guard」)。
     * 🔑 いまは**面の file を全数走査**して、組み立てを持つ file が `help.ts`
     *   ただ 1 つであることを**等値**で pin する。
     */
    const dir = 'src/adapter/ui/render';
    const owners = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => readFileSync(join(dir, f), 'utf-8').includes('APP_VERSION'))
      .sort();
    expect(owners, '版を組み立てる file が 1 つではない(綴りが分かれると必ず食い違う)').toEqual([
      'help.ts',
    ]);
    expect(MANUAL, 'マニュアルが版の在り処を案内していない').toMatch(
      /\*\*バージョン\*\*は\s*\*\*ヘルプ\*\*/,
    );
  });

  it('🔴 削除の確認文言がマニュアルと矛盾しない', () => {
    // round-2 review M-8: 実装は「元に戻せません」、マニュアルは「戻せます」で
    // **どちらか一方が嘘**だった(実装のほうが古く、user を怖がらせる側だった)
    const binder = readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8');
    const msg = /を削除しますか\?\(([^)]+)\)/.exec(binder)?.[1];
    expect(msg, '削除の確認文言が読めない').toBeTruthy();
    expect(msg, 'マニュアルは「戻せます」と書いてある').not.toContain('元に戻せません');
    expect(MANUAL).toContain('消したノートはここに入り、**戻せます**');
  });
});

describe('確認の画面とマニュアルの突合(#299)', () => {
  /** マニュアル §4「確認の画面」の節だけを切り出す。⚠ 節ごと消えたら落ちる。 */
  function section(): string {
    const at = MANUAL.indexOf('### 確認の画面');
    expect(at, 'マニュアルに「確認の画面」の節が無い').toBeGreaterThan(-1);
    const next = MANUAL.indexOf('\n### ', at + 1);
    return MANUAL.slice(at, next === -1 ? MANUAL.length : next);
  }

  /**
   * 🔴 **「何が起きるかがボタンの字に出る」は、マニュアルの約束である。**
   *
   * 危険色を付けるのに `okLabel` を渡し忘れると、既定の **はい** が出る ──
   * 赤い **はい** は「何が起きるか」を何も言っていない。
   * ⚠ 字面の位置ではなく、**`danger: true` を含む object 全部**を数えて見る
   *   (新しい面を足したときに、その面だけ抜けるのを止めるため)。
   */
  /**
   * 🔴 **等値で pin する。「N 件以上」にしない**(#299 段⑤。着地前レビュー R10)。
   *
   * ⚠ 直す前は `toBeGreaterThanOrEqual(5)` で、実数は 7 件だった ── **2 件落としても
   *   緑**である。マニュアルは「不可逆な操作は実行する側のボタンに色が付き、
   *   何が起きるかが書いてある」と約束しているので、落ちた面は**画面と doc が割れる**。
   * 🔑 **足したら 1 行足す**形にする(直したら消さないと落ちるので、忘れられない)。
   */
  const DANGER_SITES: readonly string[] = [
    'binder.ts:削除', // まとめて削除(2 ペイン)
    'binder.ts:削除', // 1 件削除(情報ペイン)
    'binder.ts:打ち切る', // 他のタブの保存権を強制解放
    'binder.ts:空にする', // ゴミ箱を空にする
    'main.ts:上書きする', // md 書き出しの同名上書き
    'main.ts:ノートを渡して開く', // 素のまま起動(同一オリジン)
    'main.ts:整理する', // 使っていない添付を消す
    'main.ts:切り替える', // 編集中の下書きを捨てて新しい版へ(#312 ②)
  ];

  it('🔴 危険色の確認は、全部「何が起きるか」をボタンに書いている', () => {
    const files = ['src/adapter/ui/actions/binder.ts', 'src/main.ts'];
    const found: string[] = [];
    for (const f of files) {
      const base = f.slice(f.lastIndexOf('/') + 1);
      for (const m of codeOnly(readFileSync(f, 'utf-8')).matchAll(
        /\{[^{}]*danger:\s*true[^{}]*\}/g,
      )) {
        const label = /okLabel:\s*'([^']+)'/.exec(m[0])?.[1];
        // ⚠ 赤い「はい」は「何が起きるか」を何も言っていない
        expect(label, `危険色なのに字が既定のまま: ${base} ${m[0]}`).toBeTruthy();
        found.push(`${base}:${label ?? '(既定)'}`);
      }
    }
    expect(
      [...found].sort(),
      '危険色の面が増減した ── 足したなら DANGER_SITES に 1 行足す(落ちたなら、その面の警告色が消えている)',
    ).toEqual([...DANGER_SITES].sort());
  });

  /**
   * 🔴 **危険色の面は「例」ではなく**全部**マニュアルに出す**(着地前レビュー R11)。
   *
   * ⚠ 直す前のマニュアルは 4 つを挙げていたが、実装は 6 種類だった ──
   *   抜けていたのは **整理する**(添付の物理削除。**本当に戻せない**)と
   *   **打ち切る**(他のタブの保存権の強制解放)。向きが悪いほうが抜けていた。
   * ⚠ 2026-08-22 に **切り替える**(編集中の下書きを捨てて新しい版へ)が加わり
   *   7 種類になった(#312 ②)。
   */
  it('🔴 危険色のボタンの字が、7 種類とも マニュアルに出ている', () => {
    const labels = [...new Set(DANGER_SITES.map((x) => x.slice(x.indexOf(':') + 1)))];
    expect(labels.length, '危険色の字を 1 つも読めていない').toBe(7);
    const s = section();
    for (const label of labels)
      expect(s, `マニュアル §4「確認の画面」に「${label}」が無い`).toContain(`**${label}**`);
    // ⚠ 散文の数字も pin する(「数字を 2 か所に書いたら突き合わせる」── 上の
    //   タブ上限の検査と同じ理由。ラベルは全部在るのに数字だけ古い、を許さない)
    expect(s, 'マニュアルの「全部で N 種類」の数字が実装と食い違っている').toContain(
      `全部で ${labels.length} 種類`,
    );
  });

  it('🔴 マニュアルが「取り消しが左」と書き、実装もそう並べている', () => {
    // ⚠ 並びそのものは `tests/adapter/app-dialog.test.ts` が **実際の DOM の順**で
    //   見る。ここが見るのは**マニュアルと実装が同じことを言っているか**である
    const dlg = codeOnly(readFileSync('src/adapter/ui/render/app-dialog.ts', 'utf-8'));
    expect(dlg, '取り消しを先に append していない').toContain('row.append(cancel, ok)');
    expect(section()).toContain('取り消す側が左、実行する側が右');
  });

  it('🔴 ブラウザの確認は 1 つも残っていない(マニュアルの言うとおり)', () => {
    expect(section()).toContain('PKC 自身の画面');
    const main = codeOnly(readFileSync('src/main.ts', 'utf-8'));
    expect(main, 'window.confirm が残っている').not.toMatch(/\bwindow\.confirm\(/);
    expect(codeOnly(BINDER), 'window.confirm が残っている').not.toMatch(
      /\bwindow\.confirm\(/,
    );
  });
});

describe('ショートカットとマニュアルの突合(#256)', () => {
  /**
   * 🔴 **マニュアル §10 は 3 つ目の面である**(着地前レビュー 5)。
   *
   * 設定とヘルプの一覧は `KEY_COMMANDS` から出るのでズレようがないが、
   * **マニュアルは手書き**で、しかも焼き込まれてヘルプの中に出る。
   * ⚠ PKC2 はまさにここでズレた(一度 audit したのに再びズレた)ので、
   * **既定の割当と名前が、マニュアルに載っていること**を機械で見る。
   */
  it('🔴 既定の割当と名前が、マニュアルに全部載っている', () => {
    // 空振り防止 ── §10 が丸ごと消えたら落ちる
    const section = MANUAL.slice(MANUAL.indexOf('## 10. ショートカットキー'));
    expect(section.length, 'マニュアルに §10 が無い').toBeGreaterThan(500);
    const missing: string[] = [];
    for (const cmd of KEY_COMMANDS) {
      for (const chord of cmd.defaults) {
        // ⚠ 表示は `chordLabel`(win 表記)── user が読む形そのもので突き合わせる
        const label = chordLabel(chord, false);
        if (!section.includes(label)) missing.push(`${cmd.id}: ${label}`);
      }
    }
    expect(missing, 'マニュアルに載っていない既定の割当がある').toEqual([]);
  });

  it('🔴 割り当て直しの導線がマニュアルに書いてある', () => {
    const section = MANUAL.slice(MANUAL.indexOf('## 10. ショートカットキー'));
    for (const word of ['割り当て', '既定に戻す', 'すべて既定に戻す']) {
      expect(section, `マニュアルに「${word}」の説明が無い`).toContain(word);
    }
  });
});

describe('移行ガイドと実装の突合', () => {
  it('🔴 受理する PKC2 形式の**件数**が一致する(読めると書いて読めない、を落とす)', () => {
    // 🔴 かつて `MANIFEST_FORMAT` の 8 キーを数えていたが、それは **ZIP だけ**の
    // 母集団で、doc は単一 HTML を含めて数えていた(round-2 review M-6)──
    // `detectPkc2Format` が `'html'` を返さなくしても全緑だった。
    // → **受理しうる形式そのもの**(`Pkc2Format`)を数える
    const src = readFileSync('src/features/import/detect-format.ts', 'utf-8');
    const union = /export type Pkc2Format =([\s\S]*?);/.exec(src)?.[1] ?? '';
    const formats = [...union.matchAll(/\|\s*'([a-z-]+)'/g)]
      .map((m) => m[1]!)
      .filter((f) => f !== 'unknown'); // 「不明」は受理形式ではない
    expect(formats).toContain('html'); // ⚠ ZIP だけの母集団に戻らないよう固定
    expect(MIGRATION).toContain(`全 ${formats.length} 形式`);
    expect(MANUAL).toContain(`全 ${formats.length} 形式`);
  });

  it('🔴 relation の kind が一致する', () => {
    /**
     * ⚠ **正本を読む**(#185 で `features/relation/kinds.ts` へ寄せた)。
     * 初稿は取込 file の literal を正規表現で削り取っていたので、
     * **一覧を 1 か所へ寄せた瞬間に空になって落ちた** ── 実体を動かしたら
     * 指す先も同じ commit で張り替える(壊れたポインタを残さない)。
     * 🔑 import で取れば、そもそも削り取りに失敗しようが無い。
     */
    const kinds = [...RELATION_KINDS];
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(MIGRATION, `移行ガイドに kind \`${kind}\` が無い`).toContain(`\`${kind}\``);
    }
    expect(MIGRATION).toContain(`${kinds.length} 種`);
    // ⚠ 取込が**正本を使っている**ことも見る(literal を書き戻したら落とす)
    const src = readFileSync('src/features/import/pkc2-convert.ts', 'utf-8');
    expect(src, '取込が種類の一覧を自前で持っている').toContain('new Set(RELATION_KINDS)');
  });

  it('🔴 一方通行であることが両方に書いてある', () => {
    // user 裁定 2026-07-30。⚠ ここが曖昧だと user は PKC2 を消す
    expect(MIGRATION).toContain('片道');
    expect(MIGRATION).toContain('pkc3-archive');
  });
});

/**
 * P8 段⑱: 🔴 **導線の置き場所が腐らないようにする**(レビュー H)。
 *
 * 🔴 実際に腐っていた:段⑤ で「上の帯」から左の列へ移したのに、マニュアルは
 * 「上の帯のボタン」「上の帯の **取り込む**」「**整理** メニュー」「**新規** メニュー →
 * **+添付**」と書いたままだった ── どれも**画面に存在しない**。
 * 「メニュー」は `<details>` を外した段①で消えた語なので、機械的に止められる。
 */
describe('導線の置き場所(P8 段⑱)', () => {
  it('🔴 マニュアルが、存在しない「メニュー」を名乗らない', () => {
    /**
     * 🔴 **禁止の目的は「画面に無い物を案内しない」であって、語の抹殺ではない**
     *   (2026-08-27、#426 段① で前提が変わった)。
     *
     * ⚠ 直す前はこの検査が **「メニュー」という語そのもの**を禁じていた ──
     *   `<details>` を外した段① の時点では、画面にメニューが**1 つも無かった**ので
     *   それで正しかった。
     * 🔴 **いまは在る**:右クリックのメニュー(#426 段①)と、ブラウザ既定のメニュー。
     *   ⚠ 語ごと禁じたままにすると、**実在する動線を書けなくなる**
     *   ── それは「記法を減らすと動線が減る」と同じ向きである。
     *
     * 🔑 だから**在る物を等値で pin する**(`KNOWN_DEAD` と同じ作法)──
     *   ⚠ 新しく「メニュー」と書いたら**必ず落ちる**ので、
     *   書いた人は「それは本当に画面に在るか」を 1 度必ず問うことになる。
     */
    const ALLOWED_SUBSTRINGS: readonly string[] = [
      // #426 段①:行を右クリックすると出る(実在する)
      '右クリック',
      // ⚠ ブラウザ既定のメニュー ── 奪っていないことを案内する行
      'ブラウザのメニュー',
    ];
    const lines = MANUAL.split('\n')
      .filter((l) => l.includes('メニュー'))
      .filter((l) => !ALLOWED_SUBSTRINGS.some((ok) => l.includes(ok)));
    expect(lines, `存在しない「メニュー」を案内している:\n${lines.join('\n')}`).toEqual([]);
    // ⚠ 空振り防止 ── 許した語が**実際にマニュアルに在る**こと
    //   (在らないなら、この許しは死んでいる = 次に語ごと禁じ直すべき)
    for (const ok of ALLOWED_SUBSTRINGS) {
      expect(MANUAL, `許した「${ok}」がマニュアルに無い(許しが死んでいる)`).toContain(ok);
    }
  });

  it('🔴 マニュアルが「上の帯」に書き出し・取込を置いていない', () => {
    for (const word of ['上の帯の **取り込む**', '上の帯のボタン', '上部の **整理**']) {
      expect(MANUAL, `${word} は画面に存在しない`).not.toContain(word);
    }
  });

  it('🔴 全体の操作は**左の列**にある(実装と突き合わせる)', () => {
    // ⚠ **置き場は 2 つに分かれた**(#239)── 左の列に残したものと、設定へ
    //   逃がしたもの。どちらも `commands.ts` の 1 か所が持つので、そこと突き合わせる
    //   (shell.ts を grep する形のままだと、移した 3 つが**どこにも縛られない**)
    for (const label of [...COLLECTION_COMMANDS, ...SETTINGS_COMMANDS].map((c) => c.label)) {
      expect(COMMANDS, `${label} が実装から消えた`).toContain(`'${label}'`);
      expect(MANUAL, `${label} がマニュアルに無い`).toContain(label);
    }
    // 左の列が持つのは「よく押すもの」だけ ── 器そのものは shell.ts に在る
    expect(SHELL, '左の列が操作の帯を持たなくなった').toContain('COLLECTION_COMMANDS');
  });

  it('🔴 添付の参照を本文へ入れる導線が**実在する**(書ける形式なのに書けない、を作らない)', () => {
    // マニュアル §3 が「参照をコピー」を案内している以上、実装に無ければ嘘になる
    expect(MANUAL).toContain('参照をコピー');
    // ⚠ **文字列が在るか**では当てられない ── `data-pkc-field` にも同じ語が
    //    出るので、action を消しても満たされる(変異試験で実際に生き残った)。
    //    受け口(binder)と押した結果(smoke)の両端で見る
    expect(BINDER, 'copy-asset-ref を受ける口が無い').toContain("'copy-asset-ref':");
    // 組み立ては描画側(`asset-ref-format.ts`)── binder は**渡すだけ**にしてある
    expect(DETAIL, '貼れる形を作る経路が無い').toContain('formatAssetRef(');
  });

  it('🔴 1 件書き出しの説明が、実際に落ちる形式と合っている', () => {
    // 実装は可逆アーカイブ(.pkc3.zip)── かつて tooltip は「Markdown で保存します」だった
    expect(ENTRY_ACTION_SRC).toContain('.pkc3.zip');
    expect(ENTRY_ACTION_SRC, 'Markdown と嘘を書いている').not.toContain('Markdown で保存します');
  });
});

/**
 * 🔴 **書いたクラス名に、当たる規則が在る**(2026-08-08、レビュー指摘で追加)。
 *
 * ⚠ フラグ画面の説明文 5 か所が `class="settings-note"` で書かれていたのに、
 * `app.css` の規則は **`[data-pkc-field='settings-note']`** だけだった ──
 * `.settings-note` という規則はリポジトリに 1 本も無く、**フラグ画面の説明が
 * 全部無スタイル**(本文と同じ字の大きさ・同じ色)で出ていた。設定画面と
 * 並べたときに見た目が揃わない。
 *
 * 🔑 **綴りが 2 通りあること自体は悪くない**(属性は 1 要素 1 個なので、
 * `data-pkc-field` を別の用途で使う要素はクラスで書くしかない)。悪いのは
 * **片方に規則が無いこと**である。だから「クラスを書いたら規則が在る」を見る。
 * ⚠ `data-pkc-*` セレクタの規約(機能的な選択は属性で)には触れない ──
 *   ここが見るのは**見た目のクラス**だけである。
 */
describe('クラス名と CSS 規則の突合', () => {
  it('🔴 render 層が書いたクラス名に、当たる規則が在る', () => {
    const dir = 'src/adapter/ui/render';
    const used = new Set<string>();
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const text = readFileSync(join(dir, f), 'utf-8');
      for (const m of text.matchAll(/className = '([a-z0-9 -]+)'/g)) {
        for (const cls of (m[1] ?? '').split(' ').filter(Boolean)) used.add(cls);
      }
    }
    // ⚠ 空振り防止 ── 1 つも拾えていないなら、この検査は何も見ていない
    expect(used.size, 'クラス名を 1 つも拾えていない(空振り)').toBeGreaterThan(0);
    const css = readFileSync('src/styles/app.css', 'utf-8');
    const missing = [...used].filter((c) => !new RegExp(`\\.${c}[\\s,{:]`).test(css)).sort();
    expect(missing, '当たる規則が無いクラスを書いている(無スタイルで出る)').toEqual([]);
  });
});

/**
 * 🔴 **マニュアルの節を指す参照が、指す先とずれていない**(#261 で実際にずれた)。
 *
 * ⚠ 節を 1 つ挿すと**以降の番号が全部動く** ── #251 で §7-2 に「文字を貼る」を
 * 入れたとき、マニュアル内部の 4 か所は直したのに、**マニュアルの外から指していた
 * 4 か所**(コード 1 / smoke 1 / doc 2)が別の節を指したまま残った。
 * ⚠ 「その番号の節が在るか」だけを見ると**空振りする** ── §7-2 は在るのだから
 * 常に真になる。だから**引用句が当の節の中に在るか**まで見る(CLAUDE.md §1)。
 */
describe('マニュアルの節を指す参照', () => {
  /** `### 7-3. …` から次の `### ` までを 1 節として切る。 */
  const sections = ((): Map<string, string> => {
    const out = new Map<string, string>();
    const lines = MANUAL.split('\n');
    let key: string | null = null;
    let buf: string[] = [];
    for (const line of lines) {
      const m = /^### (\d+-\d+)\./.exec(line);
      if (m) {
        if (key) out.set(key, buf.join('\n'));
        key = m[1]!;
        buf = [];
        continue;
      }
      if (key) buf.push(line);
    }
    if (key) out.set(key, buf.join('\n'));
    return out;
  })();

  /** 参照を書いてよい場所(散文の doc も含めて**全数**見る)。 */
  const collect = (dir: string, ext: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) collect(full, ext, out);
      else if (name.endsWith(ext)) out.push(full);
    }
    return out;
  };
  const FILES = [
    ...collect('src', '.ts'),
    ...collect('tests', '.ts'),
    ...collect('docs', '.md'),
  ].filter((f) => f !== join('docs', 'manual.md'));

  /** コメントの行頭記号・改行を落として 1 本の文字列にする(引用句は行を跨ぐ)。 */
  const flatten = (s: string): string =>
    s.replace(/\n\s*(?:\*|\/\/|>)?\s*/g, '').replace(/\s+/g, '');

  it('🔴 指している節が実在し、引用句もその節の中に在る', () => {
    const bad: string[] = [];
    let refs = 0;
    for (const file of FILES) {
      const text = readFileSync(file, 'utf-8');
      // 節番号だけの参照と、引用句つきの参照の両方を拾う
      // ⚠ ここに**拾う形そのもの**を例として書かない ── 自分のコメントに
      //   当たって落ちる(1 稿目で実際に踏んだ)
      for (const m of text.matchAll(/マニュアル\s*§(\d+-\d+)\s*(「[^」]*」)?/gs)) {
        refs += 1;
        const num = m[1]!;
        const body = sections.get(num);
        if (body === undefined) {
          bad.push(`${file}: §${num} という節がマニュアルに無い`);
          continue;
        }
        const quote = m[2];
        if (quote === undefined) continue;
        // ⚠ 引用句は**先頭 8 字**で照合する(途中で切って書くことがある)
        const needle = flatten(quote.slice(1, -1)).slice(0, 8);
        if (needle !== '' && !flatten(body).includes(needle))
          bad.push(`${file}: §${num} に「${needle}…」が無い(節がずれている)`);
      }
    }
    // ⚠ 空振り防止 ── 参照を 1 件も拾えていないなら、この検査は何も守っていない
    expect(refs, 'マニュアルへの参照を 1 件も拾えていない(検査が空振り)').toBeGreaterThan(2);
    expect(bad).toEqual([]);
  });
});

/**
 * 🔴 **画面の説明(tooltip)を実装と突き合わせる**(2026-08-18)。
 *
 * ⚠ `ACTION_TITLES` は**どの test からも参照されていなかった** ── その結果、
 * Word 書き出しの説明が「**この版では画像は入りません**」のまま残り、
 * 実装(画像も図もグラフも入る)ともマニュアルとも食い違って、
 * **user に「押しても無駄」と思わせていた**。
 * 🔑 「空でないか」を数えるだけの検査は**中身が腐っても通る** ── 等値で pin する
 * (`tests/adapter/collection-commands.test.ts` が既にこの型を使っている)。
 */
describe('情報ペインの説明が実装と合っている(2026-08-18)', () => {
  /**
   * ⚠ **コメントを落としてから見る**(1 稿目で踏んだ)。直した理由を書いた
   * 解説コメントに旧文言(「この版では画像は入りません」)が入っているので、
   * file 全体を見ると**直したのに必ず落ちる**。CLAUDE.md §1「見るのは実行する行」。
   */
  const TITLES = codeOnly(readFileSync('src/features/entry-actions.ts', 'utf8'));

  it('🔴 Word の説明が「入らない」と言っていない(実装は入れている)', () => {
    // 空振り防止 ── ①説明そのものが在る ②コメント落としで本体まで消していない
    expect(TITLES, 'Word の説明が消えている').toContain("'export-entry-docx':");
    expect(TITLES.length, 'コメント落としが本体まで消した').toBeGreaterThan(2000);
    expect(TITLES, '画像が入らないという古い断りが残っている').not.toContain(
      'この版では画像は入りません',
    );
    // マニュアルは「入ります」と書いている ── 画面もそちらへ揃える
    expect(readFileSync('docs/manual.md', 'utf8'), 'マニュアルの側が変わっている').toContain(
      '本文に貼った添付の画像も、図(mermaid)もグラフも入ります',
    );
    expect(TITLES, '画面の説明が「入る」と言っていない').toContain('画像も、図はベクタで');
  });

  /**
   * 🔴 **PowerPoint の説明は「切れ方」を先に言う**(#187 段⑤)。
   * ⚠ Word と同じ顔のボタンが隣に並ぶので、**押す前に違いが分からない**と
   *   「なぜ 12 枚もあるのか」と後から驚く(user 指示 2026-08-21
   *   「画面で何が起きるかで書く」)。
   */
  it('🔴 PowerPoint の説明が、スライドの切れ方を言っている', () => {
    expect(TITLES, 'PowerPoint の説明が無い').toContain("'export-entry-pptx':");
    expect(TITLES, '切れ方を言っていない').toContain('スライドが切れます');
    // マニュアルの側にも切れ方の表が在ること(正本はマニュアル)
    expect(readFileSync('docs/manual.md', 'utf8'), 'マニュアルに書き方が無い').toContain(
      '#### PowerPoint(.pptx)で出す',
    );
  });
});

/**
 * 🔴 **落ちたお知らせが、どこにも残らない状態を作らない**(2026-08-18)。
 *
 * アプリの登記表は `NOTICE_KEEP_MAX` 件で頭打ちで、**古い方から静かに落ちる**。
 * 落ちた分の受け皿がどこにも無かったので、**42 件のうち 22 件が既に消えていた**
 * (git の履歴からしか読めない状態だった)。⚠ 受け皿を作っただけでは腐るので、
 * **登記表と CHANGELOG の対応をここで縛る**。
 */
/**
 * 🔴 **数字を 2 か所に書いたら、突き合わせる**(2026-08-18、着地前レビューの指摘)。
 * ⚠ マニュアルの「12 枚まで」は**直書き**で、実装の `MAX_TABS` を上げても
 *   誰も気づかない ── いま一致しているうちに縛る。
 */
describe('2 ペインの上限が、マニュアルと一致する', () => {
  it('🔴 タブの上限の数字が実装と同じ', () => {
    const manual = readFileSync('docs/manual.md', 'utf8');
    expect(manual, 'マニュアルに上限の記述が無い(空振り)').toContain('タブは 1 つのペインにつき');
    expect(manual, `実装は ${MAX_TABS} 枚だが、マニュアルの数字が違う`).toContain(
      `**${MAX_TABS} 枚**まで`,
    );
  });
});

describe('お知らせの受け皿(CHANGELOG)', () => {
  const CHANGELOG = readFileSync('CHANGELOG.md', 'utf8');
  /** ⚠ 見出し(`### <題名>`)だけを拾う ── 本文の行に満たされない形にする。 */
  const headings = [...CHANGELOG.matchAll(/^### (.+)$/gm)].map((m) => m[1]);

  it('🔴 いま配っているお知らせは、全部 CHANGELOG に在る', () => {
    expect(NOTICES.length, '登記表が空(空振り)').toBeGreaterThan(0);
    for (const n of NOTICES) {
      expect(headings, `CHANGELOG に「${n.title}」が無い(落ちたら読めなくなる)`).toContain(
        n.title,
      );
    }
  });

  /**
   * 🔴 **落ちた分は「身元」で pin する**(2026-08-19、リリース前監査で判明)。
   *
   * ⚠ 1 稿目は「見出しが `NOTICE_KEEP_MAX` より多い」という**数**しか見ておらず、
   *   **落ちた 22 件のうち 21 件を消しても緑**だった(受け皿の意味が消える)。
   *   `NOTICE_KEEP_MAX` は需要側の数なので、供給側を数で縛るのは同型の空振りである。
   * 🔑 `tests/adapter/announce.test.ts` の `KNOWN` と同じ作法 ── **等値の既知リスト**は
   *   「直したら消さないと落ちる」ので忘れられない。
   * ⚠ 新しく落ちた 1 件は、ここへ 1 行足すのが手順である
   *   (`.claude/skills/notice-writing/SKILL.md`)。
   */
  const DROPPED: readonly string[] = [
    // ⚠ 上限 10 を超えたので 2026-09-02 に落とした(原本は CHANGELOG)
    'マニュアルのウィンドウが、再読み込みしても消えなくなりました',
    // ⚠ 上限 10 を超えたので 2026-09-02 に落とした(原本は CHANGELOG)
    'マニュアルを、マニュアルだけのウィンドウで読めるようになりました',
    // ⚠ 上限 10 を超えたので 2026-09-02 に落とした(原本は CHANGELOG)
    'マニュアルの抜けを直しました',
    // ⚠ 上限 10 を超えたので 2026-09-02 に落とした(原本は CHANGELOG)
    'ヘルプでマニュアルの中を探せるようになりました',
    // ⚠ 上限 10 を超えたので 2026-09-02 に落とした(原本は CHANGELOG)
    'コードの囲みの呼び名を「コードブロック」にそろえました',
    // ⚠ 上限 10 を超えたので 2026-09-02 に落とした(原本は CHANGELOG)
    'タグを 2 つ以上まとめて打てるようになりました',
    // ⚠ 上限 10 を超えたので 2026-09-02 に落とした(原本は CHANGELOG)
    'Office の設定を初期状態に戻せるようになりました',
    // ⚠ 上限 10 を超えたので 2026-09-02 に落とした(原本は CHANGELOG)
    'ヘルプと設定の日本語を、ふだんの言い方に直しました',
    // ⚠ 上限 10 を超えたので 2026-09-02 に落とした(原本は CHANGELOG)
    '2 ペイン編集でも、押した見出しのところから開きます',
    // ⚠ 上限 10 を超えたので 2026-09-02 に落とした(原本は CHANGELOG)
    '見出しを右クリックすると、その章にできることが出ます',
    // ⚠ 上限 10 を超えたので 2026-09-02 に落とした(原本は CHANGELOG)
    '板の付箋が、PowerPoint でも置いたとおりの場所に出ます',
    // ⚠ 上限 10 を超えたので 2026-08-31 に落とした(原本は CHANGELOG)
    '画面が狭いときの横ずれと、一覧を畳んだときの Ctrl+F を直しました',
    // ⚠ 上限 10 を超えたので 2026-08-31 に落とした(原本は CHANGELOG)
    '押しても何も起きなかった所と、画面が狭いときに消えていた所を直しました',
    // ⚠ 上限 10 を超えたので 2026-08-31 に落とした(原本は CHANGELOG)
    'Office 表示の一式が LibreOffice 26.8 になりました',
    // ⚠ 上限 10 を超えたので 2026-08-31 に落とした(原本は CHANGELOG)
    '読んでいるノートを横に留めて、2 つ並べて読めるようになりました',
    // ⚠ 上限 10 を超えたので 2026-08-31 に落とした(原本は CHANGELOG)
    '本文を右クリックすると、段組みを切り替えられるようになりました',
    // ⚠ 上限 10 を超えたので 2026-08-31 に落とした(原本は CHANGELOG)
    '消したノートが、予定・連絡先・雛形の一覧から消えるようになりました',
    // ⚠ 上限 10 を超えたので 2026-08-30 に落とした(原本は CHANGELOG)
    '連絡先や Markdown を、PKC3 の画面に落として取り込めるようになりました',
    // ⚠ 上限を 10 へ揃えたので 2026-08-29 に落とした(原本は CHANGELOG)
    'Word / PowerPoint / PDF が、右クリックからも出せるようになりました',
    // ⚠ 上限を 10 へ揃えたので 2026-08-29 に落とした(原本は CHANGELOG)
    'タグの取りこぼしと呼び名をそろえました',
    // ⚠ 上限を 10 へ揃えたので 2026-08-29 に落とした(原本は CHANGELOG)
    '本文に書いたタグが、右の情報ペインにも出るようになりました',
    // ⚠ 上限を 10 へ揃えたので 2026-08-29 に落とした(原本は CHANGELOG)
    '本文のタグの拾い方をそろえました(画面に出るものだけを集めます)',
    // ⚠ 上限を 10 へ揃えたので 2026-08-29 に落とした(原本は CHANGELOG)
    'タグの集計に、本文の中に書いたタグも入るようになりました',
    // ⚠ 上限を 10 へ揃えたので 2026-08-29 に落とした(原本は CHANGELOG)
    '絞り込みで連絡先が 0 件でも、その場で戻れるようになりました',
    // ⚠ 上限を 10 へ揃えたので 2026-08-29 に落とした(原本は CHANGELOG)
    '本文の中に書いたタグが、札で出るようになりました',
    // ⚠ 上限を 10 へ揃えたので 2026-08-29 に落とした(原本は CHANGELOG)
    '段組みが幅で畳まれたとき、理由が画面に出るようになりました',
    // ⚠ 上限を 10 へ揃えたので 2026-08-29 に落とした(原本は CHANGELOG)
    '本文の中にタグを書けるようになりました(編集中でも打てます)',
    // ⚠ 上限を 10 へ揃えたので 2026-08-29 に落とした(原本は CHANGELOG)
    'ヘルプを閉じてしばらくすると、マニュアルの分のメモリを返します',
    // ⚠ 上限 20 を超えたので 2026-08-29 に落とした(原本は CHANGELOG)
    '本文の画像も別の窓で大きく見られ、掴んで送れます',
    // ⚠ 上限 20 を超えたので 2026-08-29 に落とした(原本は CHANGELOG)
    '図を押すと、別の窓で実寸で開けます',
    // ⚠ 上限 20 を超えたので 2026-08-29 に落とした(原本は CHANGELOG)
    '段組みのまま、その場で書き替えられます',
    // ⚠ 上限 20 を超えたので 2026-08-29 に落とした(原本は CHANGELOG)
    'UML の図が選ぶだけで入り、SVG も貼れば絵になります',
    // ⚠ 上限 20 を超えたので 2026-08-29 に落とした(原本は CHANGELOG)
    'HTML の中で外から取ってこられなかったとき、理由が出ます',
    // ⚠ 上限 20 を超えたので 2026-08-29 に落とした(原本は CHANGELOG)
    '段と段のあいだの線を、はっきりさせられます',
    // ⚠ 上限 20 を超えたので 2026-08-29 に落とした(原本は CHANGELOG)
    'Alt+C で段組みを切り替えられ、いま何段かが出ます',
    // ⚠ 上限 20 を超えたので 2026-08-29 に落とした(原本は CHANGELOG)
    '段組みで、縦に長い図や写真が切れなくなりました',
    // ⚠ 上限 20 を超えたので 2026-08-29 に落とした(原本は CHANGELOG)
    '行の編集で、下(上)まで来てもう 1 回押すと隣の行へ移ります',
    // ⚠ 上限 20 を超えたので 2026-08-29 に落とした(原本は CHANGELOG)
    'クラス図・シーケンス図・状態遷移図・ER 図が描けます',
    // ⚠ 上限 20 を超えたので 2026-08-29 に落とした(原本は CHANGELOG)
    '連絡先の取り込みが、失ったものをきちんと言うようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-29 に落とした(原本は CHANGELOG)
    '断り方と、目次の飛び方が良くなりました',
    // ⚠ 上限 20 を超えたので 2026-08-29 に落とした(原本は CHANGELOG)
    '連絡先を vCard で出し入れできるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-29 に落とした(原本は CHANGELOG)
    '付箋を自由に置ける「板」が作れるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-29 に落とした(原本は CHANGELOG)
    '見出しから目次が自動で出るようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-29 に落とした(原本は CHANGELOG)
    'タグを、その場で打てるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-29 に落とした(原本は CHANGELOG)
    'ペインと追記欄の大きさを、自分で決められるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-29 に落とした(原本は CHANGELOG)
    '予定の面で、外すのと足すのが分かるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-29 に落とした(原本は CHANGELOG)
    'ノート 1 件を、相手が開けるだけの HTML で渡せるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    '段組みが、文字の大きさに合わせて広がるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    '大きなウェブページも、そのまま貼れるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    'ウルトラワイドで、本文を段組みにして読めるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    '文字の大きさを、自分で変えられるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    '読んでいる本文から編集に入る押し方が変わりました(Ctrl+クリック)',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    'ノートが、どのスマートフォルダに集まっているか分かるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    '生成 AI の返答を、見た目のまま貼れるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    '左の列の下の帯が 3 段から 2 段になり、一覧が広がりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    '見出しが、本文と見分けやすくなりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    '「操作を探す」の説明が、切れずに読めるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    '種類の札が、押した面ですぐ応えるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    'ノートの行を右クリックすると、できることが出るようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    '連絡先のタブができました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    '作業時間を計って、ノートに残せるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    'スマートフォルダに期日と状態が書けるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    '録音が、本文に入らないことがあったのを直しました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    '左の列のタブの字が、隣に重ならなくなりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    '本文の音・動画が、その場で聞けるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    '録音と画面収録ができるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    '表の升に式が書けるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    '表の升を押して、そのまま打てるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    '書き出したファイルにも、囲みの中身が入るようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-28 に落とした(原本は CHANGELOG)
    '囲みの中身を、添付から取れるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    '手元の Word / Excel / PowerPoint を、そのまま開いて直せるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    'サイドバーで、種類を選んで絞れるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    '書きながら、別のノートへのリンクを選んで入れられるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    '大きな写真を添付すると「縮めますか」と聞くようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    'ノートの並びを、AI に相談できる形でコピーできるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    'ハイライト・ルビ・圏点・打ち消しを、鍵で入れられるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    '操作を名前で探せるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    'ノートから別のノートへ、リンクを張れるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    'スマートフォルダが、タグ以外でも絞れるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    '表や箇条書きの 1 行を直すとき、まわりが消えなくなりました',
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    'スマートフォルダ ── 条件に合うノートが自動で集まります',
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    '2 ペインで整理するとき、場所を扱う道具が増えました',
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    'リッチテキストで貼っても、書式もコードも残るようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-26 に落とした(原本は CHANGELOG)
    'PKC3 ごと 1 つのファイルに入れて、持ち歩けるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-26 に落とした(原本は CHANGELOG)
    '本文を Alt クリックすると、その行から編集に入ります',
    // ⚠ 上限 20 を超えたので 2026-08-26 に落とした(原本は CHANGELOG)
    'フォルダごと書き出せるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-26 に落とした(原本は CHANGELOG)
    '同じものを 2 回取り込んだことが分かるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-26 に落とした(原本は CHANGELOG)
    '書くときの手つきが 4 つ増えました',
    // ⚠ 上限 20 を超えたので 2026-08-26 に落とした(原本は CHANGELOG)
    'アプリにノートの目次を見せられるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-26 に落とした(原本は CHANGELOG)
    '雛形を一覧から選んで入れられるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-26 に落とした(原本は CHANGELOG)
    '自分の雛形を作って、短縮語で呼び出せるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-26 に落とした(原本は CHANGELOG)
    '毎日・毎週・毎月・毎年の予定が書けるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-26 に落とした(原本は CHANGELOG)
    'つながりの図に、本文のリンクも出るようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-26 に落とした(原本は CHANGELOG)
    '見ている頁を、ブックマーク 1 つで取り込めるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-26 に落とした(原本は CHANGELOG)
    'つながりが図で見えるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-26 に落とした(原本は CHANGELOG)
    'Word や Excel の形式のまま、Office から保存できるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-26 に落とした(原本は CHANGELOG)
    '2 ペインで整理しながら、その場でノートを作れます',
    // ⚠ 上限 20 を超えたので 2026-08-25 に落とした(原本は CHANGELOG)
    '何日かにまたがる予定を書けるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-25 に落とした(原本は CHANGELOG)
    '左の列に「予定」が増えました(本文は消えません)',
    // ⚠ 上限 20 を超えたので 2026-08-25 に落とした(原本は CHANGELOG)
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    'AI に考えてもらった整理案を、まとめて当てられるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    '何が容量を食っているかが分かるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    'スマートフォルダを、語でも絞れるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    'スマートフォルダで「まだ終わっていない仕事」を集められるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    '書式を「操作を探す」から入れられるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    '設定だけを別の端末へ持っていけるようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-27 に落とした(原本は CHANGELOG)
    '本文の外部の画像を、手元に取り込めるようになりました',
    'やることの板に出るのは、日付を書いた項目だけになりました',
    // ⚠ 上限 20 を超えたので 2026-08-25 に落とした(原本は CHANGELOG)
    '別の窓の変更と重なったとき、黙って上書きしなくなりました',
    // ⚠ 上限 20 を超えたので 2026-08-25 に落とした(原本は CHANGELOG)
    'カレンダー・やることの板・2 ペインが、別の窓で開くようになりました',
    // ⚠ 上限 20 を超えたので 2026-08-25 に落とした(原本は CHANGELOG)
    'https:// の無いアドレスはリンクになりません。文中の URL は壊れなくなりました',
    // ⚠ 上限 20 を超えたので 2026-08-25 に落とした(原本は CHANGELOG)
    'アプリの面を開いても、書きかけと読んでいた場所が消えなくなりました',
    // ⚠ 上限 20 を超えたので 2026-08-25 に落とした(原本は CHANGELOG)
    '文書の情報が壊れていても、黙って消さなくなりました',
    // ⚠ 上限 20 を超えたので 2026-08-24 に落とした(原本は CHANGELOG)
    'カレンダーの日のセルと、いくつかの取りこぼしを直しました',
    // ⚠ 上限 20 を超えたので 2026-08-24 に落とした(原本は CHANGELOG)
    '行の色分けと、確認の色を直しました',
    '素のまま起動を一度許すと、次から聞かれなくなりました',
    '起動できなくなる不具合を直しました(本文の検索も効くようになりました)',
    '括弧を閉じると二重になっていたのを直しました',
    '確認の画面が PKC 自身のものになりました',
    // ⚠ 上限 20 を超えたので 2026-08-23 に落とした(原本は CHANGELOG)
    '2 ペインの面を作り直しました(列・操作の並び・カーソル)',
    'やることの板が戻りました(札はチェックリストの行です)',
    'チェックリストの印が、押せるようになりました',
    'カレンダーが戻りました(日付は文書の情報に書きます)',
    '文書の情報(タグなど)が、編集中に消えなくなりました',
    'このアプリの入れ物に、端末ごとの名前が付きました',
    '2 ペインで、キーボードと整理の操作が使えます',
    'カレンダーが使えるようになりました(日付が効かない穴と、面の直し)',
    'やることの板で、完了したものを下に畳むようにしました',
    // ⚠ 上限 20 を超えたので 2026-08-22 に落とした(原本は CHANGELOG)
    '「2 ペインで整理」は、アプリの一覧から開きます',
    '2 ペインで整理できるようになりました',
    'フォルダの表を上下キーで送れます。Enter は「読む」から始まります',
    'フォルダの操作を OS のファイラに合わせ、貼った図も残るようになりました',
    '左の列が「フォルダ」で開くようになり、まとめて選べます',
    'ショートカットキーが増え、自分で割り当て直せるようになりました',
    'スクリーンショットを本文にそのまま貼れるようになりました',
    'Word に入る図が、拡大しても粗くならなくなりました',
    '「閲覧用 HTML」「Markdown」「使っていない添付を消す」が設定へ移りました',
    'Word の書き出しが画面の紙面に合うようになりました',
    'Word の書き出しに図とグラフが入るようになりました',
    'Word の書き出しに画像が入るようになりました',
    'Office で保存すると、PKC のノートに残るようになりました',
    'Office で同じ文書を 2 回保存しても、ノートが増えなくなりました',
    'ノートを Word(.docx)で書き出せるようになりました',
    'PDF が読める大きさで出るようになりました(別の窓でも開けます)',
    '1 面編集で、行の箱の高さと上下キーを直しました',
    'ボタンの見た目を整えました(本文の面が広くなりました)',
    '項目ごとに束ねて数える「集計」が使えるようになりました',
    'ノート同士をつなげるようになりました',
    'グラフ(chart)を本文に書けるようになりました',
    '本文から探せるようになりました(並び順とタグも)',
    '戻る・進むと、ペインの開閉ができるようになりました',
    '複数のタブで同時に使えるようになりました',
    'アプリの一覧から Office を開けるようになりました',
    'Office の設定が、窓を閉じても残るようになりました',
    'Office のメニューやドロップダウンが、マウスで選べるようになりました',
    'Office の画面が日本語になりました',
    '1 面で編集(ライブエディタ)が最初の設定になりました',
    '添付の説明でも、文書の寄せの宣言が効くようになりました',
    '本文の添付参照から、その添付のノートへ飛べるようになりました',
    'お知らせの「閉じる」が見出しの行に移りました',
    'Office の窓が固まったとき、お知らせするようになりました',
    'Office でダイアログを閉じると止まる問題を直しました',
    'Office でコピーすると操作が効かなくなる問題を直しました',
    'Office の窓が画面いっぱいで開くようになりました',
    'Office の窓の不具合を直しました',
    'Word / Excel / PowerPoint の添付を読めるようになりました',
    '本文の読み幅と印刷の紙を選べるようになりました',
    'フラグ画面とヘルプ画面ができました',
    '本文のコピーと、1 面編集の操作が増えました',
    '本文のリンクが押せるようになりました',
    '本文の寄せと幅が、画面と配布物で揃いました',
    '設定に「このアプリのデータ」が増えました',
    '右の列に「PDF」が増えました(紙に出す)',
    '別の窓と重なったとき、板のチェックと設定が本文を消さなくなりました',
    '右の列に「参照元」が増えました',
    '左の列に「今日」が増えました',
    'Office で表示言語を変えたとき、開き直す道ができました',
    'Office で保存できない形式を、開いた時点でお知らせします',
    'ノートを PowerPoint(.pptx)で書き出せるようになりました',
    'ノートへのリンクを貼ると、押せるリンクになります',
    'Markdown の書き出しが、何のための形か分かるようになりました',
    '追記を、節の中へ入れられるようになりました',
    '履歴で、戻す前に中身を見られるようになりました',
    '面をまたいで作業が続くようになりました',
    'アプリへ渡したノートを、アプリから書き戻せるようになりました',
    '予定の時刻に、音で知らせられるようになりました',
    'お知らせが 1 件ずつ出るようになりました',
  ];

  it('🔴 アプリから落ちた分が、1 件残らず CHANGELOG に在る', () => {
    expect(DROPPED.length, '既知リストが空(空振り)').toBeGreaterThan(0);
    for (const title of DROPPED) {
      expect(headings, `落ちたお知らせ「${title}」が CHANGELOG から消えている`).toContain(title);
    }
  });

  it('🔴 CHANGELOG = いま配っている分 + 落ちた分(過不足なし)', () => {
    const want = new Set([...NOTICES.map((n) => n.title), ...DROPPED]);
    expect(want.size, '登記表と既知リストが重複している').toBe(NOTICES.length + DROPPED.length);
    // ⚠ **等値**で見る ── 「足りない」も「身に覚えのない見出しが増えた」も落とす
    expect([...headings].sort()).toEqual([...want].sort());
    // ⚠ 受け皿が登記表のコピーになっていないこと(落ちた分を本当に持っている)
    expect(headings.length, '受け皿が登記表のコピーになっている').toBeGreaterThan(
      NOTICE_KEEP_MAX,
    );
  });

  it('CHANGELOG の見出しが重複していない(同じ題名を 2 回残さない)', () => {
    expect(new Set(headings).size, `重複: ${headings.length - new Set(headings).size} 件`).toBe(
      headings.length,
    );
  });
});

/**
 * 🔴 **近道が指すボタンは、画面に実在する**(2026-08-19、`Alt+6` の死で判明)。
 *
 * 近道は「押しボタンを探して押す」形なので、⚠ **ボタンを帯から外した瞬間に無反応**
 * になる(`preventDefault` すらしないので手がかりが無い)。実際 2 ペインは #241 の
 * 訂正で帯から外れ、`Alt+6` は**1 度も効いていなかった**のに、お知らせ・マニュアル・
 * `shell.ts` のコメントが**3 つとも「効きます」**と言っていた。
 *
 * ⚠ **見るのは「常に画面に在る帯」だけ**(`set-view` / `toggle-pane`)── 本文の
 *   「編集」ボタンのように**ノートを開いていないと出ない**ものまで要求すると、
 *   成り立たない条件になる(§1「主張そのものが成り立たない」)。
 *   🔑 そして**実際に壊れたのは帯の側**である。
 */
describe('近道の押し先が画面に在る', () => {
  it('🔴 帯を指す近道は、全部その帯に当たる', () => {
    const body = /const SHORTCUT_BUTTON: Readonly<Record<string, string>> = \{([\s\S]*?)\n\};/
      .exec(BINDER)?.[1];
    expect(body, '近道の対応表を読めていない(空振り)').toBeDefined();
    const table = [...body!.matchAll(/'([a-z0-9-]+)':\s*'([^']+)'/g)].map(
      (m) => [m[1]!, m[2]!] as const,
    );
    expect(table.length, '対応表が空(空振り)').toBeGreaterThan(5);
    // 帯(常設)を指すものだけ ── 状態で出たり消えたりする押し先は対象外
    const band = table.filter(([, sel]) => /set-view|toggle-pane/.test(sel));
    expect(band.length, '帯を指す近道を 1 つも読めていない(空振り)').toBeGreaterThan(2);
    const dead = band
      .filter(([, sel]) => root.querySelector(sel) === null)
      .map(([cmd, sel]) => `${cmd} → ${sel}`);
    expect(dead, '押す先が帯に無い近道がある(無反応になる)').toEqual([]);
  });

  /**
   * 🔴 **`#pkc?view=` の表が、いま開ける面と 1 対 1**(#300 段②、2026-08-22)。
   *
   * ⚠ 面を足すと `deep-link.test.ts` の全数 test は `VIEW_MODES` を読むので
   *   **自動で追随して緑**になる ── マニュアルの表にだけ載らない。
   *   逆に面を畳むと、**存在しない名前を案内し続ける**。
   * 🔑 だから**両向きを等値で**見る(片方だけ増やしても落ちる)。
   */
  it('🔴 マニュアル §4-1 の表が、アドレスから開ける面と 1 対 1', () => {
    const manual = readFileSync('docs/manual.md', 'utf-8');
    const at = manual.indexOf('### 4-1.');
    expect(at, 'マニュアルに §4-1 が無い').toBeGreaterThan(-1);
    const section = manual.slice(at, manual.indexOf('### 4-2.', at));
    const rows = [...section.matchAll(/^\| `([a-z]+)` \| (.+?) \|$/gm)];
    expect(
      rows.map((m) => m[1]!).sort(),
      'マニュアル §4-1 の名前が、アドレスから開ける面と食い違う',
    ).toEqual([...openableViewNames()].sort());
    for (const m of rows) {
      expect(m[2], `${m[1]} の呼び名がマニュアルと食い違う`).toBe(viewModeLabel(m[1] as ViewMode));
    }
  });

  /**
   * 🔴 **数はコードから引く**(#421 段①。CLAUDE.md §7)。
   *
   * ⚠ マニュアルに「8 つまで」と**書き写した**時点で、同じ値が 2 か所に在る ──
   *   `MAX_SMART_TAGS` を動かしても doc は黙って古いままで、user は
   *   **在りもしない上限**を読むことになる。
   * 🔑 見るのは**断り文そのもの**(`smartCondError`)── 製品が画面に出す字と
   *   マニュアルが約束する数を、同じ 1 か所から引かせる。
   */
  it('🔴 マニュアルの「条件は N つまで」が、実装の上限と一致する', () => {
    const manual = readFileSync('docs/manual.md', 'utf-8');
    const at = manual.indexOf('### スマートフォルダ');
    expect(at, 'マニュアルにスマートフォルダの節が無い').toBeGreaterThan(-1);
    const section = manual.slice(at, manual.indexOf('\n### ', at + 1));
    const m = /条件は \*\*(\d+) つまで\*\*/.exec(section);
    expect(m, 'マニュアルが条件の上限を書いていない').not.toBeNull();
    expect(m?.[1], 'マニュアルの上限が実装と食い違う').toBe(String(MAX_SMART_TAGS));
    // 🔑 画面に出る断り文も同じ数から作る(user が読む字と doc を割らない)
    expect(smartCondError('limit'), '断り文が上限を言っていない').toContain(
      String(MAX_SMART_TAGS),
    );
  });
});

/**
 * 🔴 **マニュアルだけの窓の節(§4-4)は、起きないことを書かない**(2026-09-02 hotfix、#648 の
 * 着地前レビューが拾った)。1 稿目は「窓で F5 を押しても同じです」と書いていたが、F5 は
 * 読んでいた所を**保たない**(節の印があればその節の頭、無ければ先頭)。user はその行を読んで
 * F5 を押し、読んでいた所を失う。
 * ⚠ 変異試験で SURVIVED になった(M8)ので pin を置く ── 節に**閉じて**見る(file 全体だと
 *   別の面の「同じです」に満たされる ── CLAUDE.md §1「面へスコープする」)。
 */
describe('マニュアルだけの窓の節(§4-4)の主張', () => {
  const from = MANUAL.indexOf('#### 🔴 マニュアルだけのウィンドウで読む');
  const to = MANUAL.indexOf('#### マニュアルの中を探す');
  const section = from >= 0 && to > from ? MANUAL.slice(from, to) : '';

  it('🔴 F5 で読んでいた所が残るとは言わない(残らない)', () => {
    expect(section.length, '節が見つからない(空振り)').toBeGreaterThan(500);
    expect(section, 'F5 を「同じ」と言っている(読んでいた所は保たない)').not.toMatch(
      /F5\*{0,2} を押しても同じ/,
    );
    expect(section, 'F5 で読んでいた所へ戻らないことを書いていない').toContain(
      '読んでいた所を保ちません',
    );
  });

  it('「入れ替えました」の説明は 1 か所(同じことを 2 度書かない)', () => {
    expect(section.split('入れ替えました').length - 1).toBe(1);
  });
});
