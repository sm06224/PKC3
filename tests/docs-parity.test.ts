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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildShell } from '../src/adapter/ui/render/shell';
import { showUpdateCard } from '../src/adapter/ui/render/update-card';
import { RENDERABLE_FENCE_LANGS } from '../src/features/markdown/markdown-render';
import { MARKDOWN_EXTENSIONS } from '../src/features/import/plain-markdown';
import { REVISION_KEEP_LATEST } from '../src/adapter/platform/storage/store-port';
import { THEMES } from '../src/adapter/ui/render/theme';
import { SEALED_ARCHETYPES, SEALED_VIEWS } from '../src/features/sealed';
import { buildFormatBar } from '../src/adapter/ui/render/format-bar';
import { FORMAT_OPS } from '../src/features/markdown/text-ops';
import { APPENDABLE_ARCHETYPES } from '../src/features/flavor/append-spec';

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
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const MANUAL = readFileSync('docs/manual.md', 'utf-8');

const SHELL = readFileSync('src/adapter/ui/render/shell.ts', 'utf-8');
const DETAIL = readFileSync('src/adapter/ui/render/detail.ts', 'utf-8');
const BINDER = readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8');
const INSPECTOR = readFileSync('src/adapter/ui/render/inspector.ts', 'utf-8');const MIGRATION = readFileSync('docs/migration-from-pkc2.md', 'utf-8');

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
  'pick-create-kind': ['ノート', 'ログ', '表', 'フォルダ'],
  // ⚠ **アプリ全体**のものだけ(P8 段⑤。P10 で上の帯は撤去され、左の列の下へ)
  //    フラグは P11 で追加 ── 設定(user 開放)とは**別の面**にする(user 裁定 2026-08-07)
  'set-view': ['設定', 'フラグ'],
  // 探し方は**左の列**が持つ
  'set-browse': ['一覧', 'フォルダ', 'アプリ'],
  'export-archive': ['バックアップ'],
  'export-html': ['閲覧用 HTML'],
  'export-markdown': ['Markdown'],
  'import-file': ['取り込む'],
  'purge-orphan-assets': ['使っていない添付を消す'],
  'attach-file': ['添付'],
} as const;

/**
 * 🔴 **選ぶもの**(`<select>` の option)も同じ規律で pin する。
 * ボタンだけ見ていると、種類の改名がマニュアルとずれても気づかない。
 */
const EXPECTED_OPTIONS = {
  'create-kind': ['ノート', 'ログ', '表', 'フォルダ'],
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

  it('🔴 ドラッグ&ドロップを受けないという記述が実態と合う', () => {
    // ⚠ これは「無い」ことの主張なので、**足した瞬間に嘘になる**。
    // 実装したらこの test が落ちる ── そのとき doc を直す。
    // ⚠ **src 全体**を見る(round-2 review L-4)── `binder.ts` だけを見ていると、
    // 別 file(`main.ts` / 新規 `dnd.ts` 等)で受けたときに緑のまま嘘になる
    const offenders = srcFiles().filter((f) => {
      const text = readFileSync(f, 'utf-8');
      return /addEventListener\(\s*['"](?:drop|dragover)['"]/.test(text);
    });
    expect(offenders, 'drop を受けるようになった ── マニュアルの記述を直すこと').toEqual([]);
    expect(MANUAL).toContain('ドラッグ&ドロップは受けません');
  });

  it('🔴 主要な導線を畳まない(業務画面の作法)', () => {
    // user 指示 2026-08-03「シンプルかつ高機能」── 主要な導線を `<details>` へ
    // 畳むと「どこにあるか探す」手間が増える。⚠ 以前は
    // `取り込む▾ 書き出す▾ 整理▾ 表示▾` と畳んでいた(その形へ戻ったら落とす)
    expect(root.querySelectorAll('details').length, '導線が畳まれている').toBe(0);
    for (const action of ['import-file', 'export-archive', 'purge-orphan-assets']) {
      const el = root.querySelector(`[data-pkc-action="${action}"]`);
      expect(el, `${action} が見当たらない`).not.toBeNull();
      expect(el?.closest('[hidden]'), `${action} が隠れている`).toBeNull();
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
    for (const label of ['書き出す', '履歴', '削除']) {
      expect(inspector, `情報ペインから「${label}」が消えた`).toContain(`'${label}'`);
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
    const labels = [...bar.querySelectorAll('button')].map(
      (b) => b.querySelector('[data-pkc-field="label"]')?.textContent ?? '',
    );
    expect(labels).toEqual(FORMAT_OPS.map((o) => o.label));
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(MANUAL, `マニュアルに書式「${label}」の説明が無い`).toContain(`**${label}**`);
    }
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
    for (const gone of ['いちばん上の帯', '上部の帯', '上の帯']) {
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
  it('🔴 版の在り処がマニュアルと一致する', () => {
    const settings = readFileSync('src/adapter/ui/render/settings.ts', 'utf-8');
    expect(settings, '設定画面が版を出していない').toContain('app-version');
    expect(MANUAL, 'マニュアルが版の在り処を案内していない').toMatch(
      /\*\*バージョン\*\*は\s*\*\*設定\*\*/,
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
    const src = readFileSync('src/features/import/pkc2-convert.ts', 'utf-8');
    const block = /const KNOWN_RELATION_KINDS = new Set\(\[([^\]]+)\]/.exec(src)?.[1] ?? '';
    const kinds = [...block.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(MIGRATION, `移行ガイドに kind \`${kind}\` が無い`).toContain(`\`${kind}\``);
    }
    expect(MIGRATION).toContain(`${kinds.length} 種`);
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
  it('🔴 マニュアルが「メニュー」を名乗らない(畳む UI は段① で外した)', () => {
    // ⚠ 代替物で満たせない条件にする ── 「メニュー」という語そのものを禁じる
    const lines = MANUAL.split('\n').filter((l) => l.includes('メニュー'));
    expect(lines, `存在しない「メニュー」を案内している:\n${lines.join('\n')}`).toEqual([]);
  });

  it('🔴 マニュアルが「上の帯」に書き出し・取込を置いていない', () => {
    for (const word of ['上の帯の **取り込む**', '上の帯のボタン', '上部の **整理**']) {
      expect(MANUAL, `${word} は画面に存在しない`).not.toContain(word);
    }
  });

  it('🔴 全体の操作は**左の列**にある(実装と突き合わせる)', () => {
    // shell.ts が持つラベルが、そのままマニュアル §5 / §7 に出ていること
    for (const label of ['取り込む', 'バックアップ', '閲覧用 HTML', '使っていない添付を消す']) {
      expect(SHELL, `${label} が実装から消えた`).toContain(`'${label}'`);
      expect(MANUAL, `${label} がマニュアルに無い`).toContain(label);
    }
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
    expect(INSPECTOR).toContain('.pkc3.zip');
    expect(INSPECTOR, 'Markdown と嘘を書いている').not.toContain('Markdown で保存します');
  });
});
