/**
 * 名前の門(#1017 段⑤-1)── `src/features/ui-terms.ts` を正本にして、
 * 画面の字が §6.1(名前の規則)から外れていないかを見る。
 *
 * 🔴 **この PR は画面の字を 1 文字も変えていない。** 3 つの門は、
 * ①使わない語 ②動詞句のボタン名 ③メッセージの英語識別子 を**いまの残りとして
 * 等値 pin する**(burn-down)。増えたら落ちる / 減ったら pin の側も直さないと落ちる
 * ── 直したことが必ず記録に残る(CLAUDE.md「等値 pin の既知リストは良く効いた」)。
 *
 * ⚠ **走査対象は文字列リテラルだけ**(`codeOnly` で comment を剥いでから抜く)。
 * comment に書いた解説文が検査を満たしてしまう罠は、CLAUDE.md §1 の
 * 「5 度目・10 度目」がまさにこれ ── だから抜き出した**リテラルの中身だけ**を見る。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { codeOnly } from '../helpers/code-only';
import { BANNED_TERMS } from '../../src/features/ui-terms';
import {
  COLLECTION_COMMANDS,
  COLLECTION_PANE_COMMANDS,
  SETTINGS_COMMANDS,
} from '../../src/adapter/ui/render/commands';

const ROOTS = ['src/adapter/ui', 'src/features'];

/**
 * ⚠ **正本 `ui-terms.ts` は走査から除く**(#1017 段⑤-1)。BANNED_TERMS の
 * `banned` / `excludes` は「使わない語」そのものをデータとして持つので、
 * 除かないと**登記簿が自分自身を違反として検出する**(自己言及の空振り)。
 * ⚠ 除外は**この 1 file だけ**にする ── 走査対象を広く除くほど、
 * 直したはずの残りが見えなくなる。
 */
const REGISTRY_FILE = 'src/features/ui-terms.ts';

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (
      name.endsWith('.ts') &&
      !name.endsWith('.d.ts') &&
      full.split('\\').join('/') !== REGISTRY_FILE
    )
      out.push(full);
  }
  return out;
}

/** 文字列・テンプレートリテラルの中身だけを抜く(囲みの引用符は含めない)。 */
function extractLiterals(code: string): string[] {
  const out: string[] = [];
  const re = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) out.push(m[0].slice(1, -1));
  return out;
}

/** 走査対象 file と、file ごとの「comment を剥いだリテラル本文」を 1 度だけ作る。 */
function scanTargets(): { files: string[]; literalsByFile: Map<string, string> } {
  const files = ROOTS.flatMap((r) => walkTs(r));
  const literalsByFile = new Map<string, string>();
  for (const f of files) {
    const stripped = codeOnly(readFileSync(f, 'utf8'));
    literalsByFile.set(f, extractLiterals(stripped).join('\n'));
  }
  return { files, literalsByFile };
}

describe('画面の字に使わない語(ui-terms.ts の BANNED_TERMS)', () => {
  const { files, literalsByFile } = scanTargets();

  it('空振り防止:走査対象は 50 file・500 リテラルを超える', () => {
    expect(files.length).toBeGreaterThan(50);
    const totalLiterals = [...literalsByFile.values()].reduce(
      (n, text) => n + (text.length > 0 ? text.split('\n').length : 0),
      0,
    );
    expect(totalLiterals).toBeGreaterThan(500);
  });

  it('self-test:わざと入れた 1 件は検出できる', () => {
    const term = BANNED_TERMS.find((t) => t.banned === '壊れ');
    if (!term) throw new Error('BANNED_TERMS に「壊れ」が無い(自己診断が壊れている)');
    expect(term.pattern().test('この file は壊れています')).toBe(true);
    // ⚠ 除外の対照群:同じ pattern を「面」に当て、"画面" を誤検知しないことを見る
    const menTerm = BANNED_TERMS.find((t) => t.banned === '面');
    if (!menTerm) throw new Error('BANNED_TERMS に「面」が無い');
    expect(menTerm.pattern().test('画面に出します')).toBe(false);
    expect(menTerm.pattern().test('本文の面へ移ります')).toBe(true);
  });

  /**
   * 🔑 **`[file, banned, count][]` の等値 pin**(burn-down)。
   * ⚠ 直したら、この行を消す(件数を減らすだけで assert には触れない書き方をしない
   * ── 減らしても表を直さないと落ちる形にしてある)。
   *
   * 2026-09-21 実測(#1017 段⑤-1)。新しく増えたら落ちる。
   */
  const KNOWN_BANNED: readonly [file: string, banned: string, count: number][] = [
    ['src/adapter/ui/actions/adopt-favicon.ts', '印', 4],
    ['src/adapter/ui/actions/binder.ts', '印', 4],
    ['src/adapter/ui/actions/binder.ts', '捨てる', 1],
    ['src/adapter/ui/actions/binder.ts', '面', 1],
    ['src/adapter/ui/actions/capture-trim.ts', '印', 1],
    ['src/adapter/ui/actions/export-archive.ts', '口', 2],
    ['src/adapter/ui/actions/export-portable.ts', '雛形', 1],
    ['src/adapter/ui/actions/import-pkc2.ts', '壊れ', 2],
    ['src/adapter/ui/actions/import-pkc2.ts', '破損', 1],
    ['src/adapter/ui/render/app-dialog.ts', '雛形', 1],
    ['src/adapter/ui/render/append-box.ts', '解放', 2],
    ['src/adapter/ui/render/captures.ts', '印', 2],
    ['src/adapter/ui/render/captures.ts', '器', 1],
    ['src/adapter/ui/render/commands.ts', '壊れ', 3],
    ['src/adapter/ui/render/commands.ts', '紙面', 2],
    ['src/adapter/ui/render/detail.ts', '印', 1],
    ['src/adapter/ui/render/dual-filer.ts', '印', 2],
    ['src/adapter/ui/render/filer.ts', '居場所', 1],
    ['src/adapter/ui/render/format-bar.ts', '雛形', 3],
    ['src/adapter/ui/render/schedule-drag.ts', '札', 2],
    ['src/adapter/ui/render/search.ts', '小窓', 1],
    ['src/adapter/ui/render/settings.ts', '印', 1],
    ['src/adapter/ui/render/settings.ts', '紙面', 4],
    ['src/adapter/ui/render/settings.ts', '面', 1],
    ['src/adapter/ui/render/shell.ts', '捨てる', 2],
    ['src/adapter/ui/render/shell.ts', '雛形', 1],
    ['src/features/contact/vcard.ts', '壊れ', 1],
    ['src/features/editor-mode.ts', '面', 1],
    ['src/features/entry-actions.ts', '印', 1],
    ['src/features/export/pkc3-archive.ts', '壊れ', 1],
    ['src/features/export/pkc3-markdown-zip.ts', '居場所', 1],
    ['src/features/export/portable-bundle.ts', '印', 1],
    ['src/features/export/portable-bundle.ts', '雛形', 2],
    ['src/features/export/zip-int.ts', '壊れ', 1],
    ['src/features/extension/ext-wire.ts', '口', 1],
    ['src/features/flavor/archetype-label.ts', '雛形', 1],
    ['src/features/flavor/snippet-flavor.ts', '雛形', 1],
    ['src/features/import/pkc2-bundle.ts', '壊れ', 3],
    ['src/features/import/pkc2-container-bundle.ts', '壊れ', 3],
    ['src/features/import/pkc2-convert.ts', '器', 2],
    ['src/features/import/pkc2-entry-bundle.ts', '器', 1],
    ['src/features/import/pkc2-entry-bundle.ts', '壊れ', 1],
    ['src/features/import/pkc2-folder-export.ts', '器', 1],
    ['src/features/import/pkc2-folder-export.ts', '壊れ', 1],
    ['src/features/import/pkc2-package.ts', '壊れ', 4],
    ['src/features/import/zip-reader.ts', '壊れ', 12],
    ['src/features/import/zip-reader.ts', '札', 1],
    ['src/features/keymap.ts', '印', 7],
    ['src/features/keymap.ts', '小窓', 1],
    ['src/features/keymap.ts', '雛形', 2],
    ['src/features/keymap.ts', '面', 13],
    ['src/features/markdown/source-blocks.ts', '印', 1],
    ['src/features/markdown/source-ranges.ts', '壊れ', 1],
    ['src/features/markdown/text-ops.ts', '雛形', 4],
    ['src/features/notice/notice-log.ts', '印', 2],
    ['src/features/notice/notice-log.ts', '壊れ', 31],
    ['src/features/notice/notice-log.ts', '居場所', 1],
    ['src/features/notice/notice-log.ts', '拾う', 1],
    ['src/features/notice/notice-log.ts', '捨てる', 7],
    ['src/features/notice/notice-log.ts', '最後の手', 3],
    ['src/features/notice/notice-log.ts', '札', 2],
    ['src/features/notice/notice-log.ts', '面', 10],
    ['src/features/portable/bundle.ts', '器', 8],
    ['src/features/query/duckdb-guard.ts', '面', 2],
    ['src/features/query/sql-guard.ts', '面', 3],
    ['src/features/relation/kinds.ts', '居場所', 1],
    ['src/features/sealed.ts', '面', 1],
    ['src/features/settings/settings-file.ts', '紙面', 1],
    ['src/features/snippet/snippet-menu.ts', '雛形', 6],
    ['src/features/storage/container-rebuild.ts', '区画', 2],
    ['src/features/storage/container-rebuild.ts', '印', 2],
    ['src/features/storage/container-rebuild.ts', '壊れ', 1],
    ['src/features/storage/container-reset.ts', '区画', 2],
    ['src/features/storage/container-reset.ts', '壊れ', 1],
    ['src/features/storage/db-corruption.ts', '壊れ', 3],
    ['src/features/storage/db-corruption.ts', '面', 1],
    ['src/features/storage/db-rescue.ts', '壊れ', 5],
    ['src/features/storage/integrity-schedule.ts', '壊れ', 3],
    ['src/features/storage/quota-watch.ts', '壊れ', 1],
    ['src/features/storage/rescue-archive.ts', '区画', 2],
    ['src/features/storage/rescue-archive.ts', '壊れ', 1],
    ['src/features/storage/storage-profile.ts', '印', 1],
    ['src/features/storage/write-quota.ts', '壊れ', 1],
  ];

  it('いまの残りと一致する(増えたら落ちる。直したら KNOWN_BANNED から消す)', () => {
    const rows: [string, string, number][] = [];
    for (const f of files) {
      const text = literalsByFile.get(f) ?? '';
      for (const t of BANNED_TERMS) {
        const matches = text.match(t.pattern());
        if (matches && matches.length > 0) {
          rows.push([relative('.', f).split('\\').join('/'), t.banned, matches.length]);
        }
      }
    }
    rows.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
    expect(rows).toEqual([...KNOWN_BANNED].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)));
  });
});

describe('ボタンの label に動詞句(「て、」)を禁止', () => {
  const VERB_PHRASE = /て、/;

  function findsVerbPhrases(labels: readonly string[]): string[] {
    return labels.filter((l) => VERB_PHRASE.test(l));
  }

  it('空振り防止:検める label は 5 件を超える', () => {
    const all = [...COLLECTION_COMMANDS, ...SETTINGS_COMMANDS, ...COLLECTION_PANE_COMMANDS];
    expect(all.length).toBeGreaterThan(5);
  });

  it('self-test:わざと入れた 1 件は検出できる', () => {
    expect(findsVerbPhrases(['拾って、戻せる形で書き出す'])).toEqual([
      '拾って、戻せる形で書き出す',
    ]);
    expect(findsVerbPhrases(['バックアップ'])).toEqual([]);
  });

  /**
   * 🔑 **画面の字から引く**(CLAUDE.md #996「押してください、と書いた物が画面に
   * 実在するか」と同じ作法)── 期待値を手で書かない。3 つの登記簿の `label` を
   * そのまま検める。2026-09-21 実測:0 件(§1017 段④b で既に直っている)。
   */
  const KNOWN_VERB_PHRASES: readonly string[] = [];

  it('登記された label に動詞句が残っていない(増えたら落ちる)', () => {
    const labels = [...COLLECTION_COMMANDS, ...SETTINGS_COMMANDS, ...COLLECTION_PANE_COMMANDS].map(
      (c) => c.label,
    );
    expect(findsVerbPhrases(labels)).toEqual([...KNOWN_VERB_PHRASES]);
  });

  /**
   * 🔴 `iconButton(action, label)` の呼び出しと、`document.createElement('button')`
   * で作った変数への `.textContent = '…'` も同じ規則で検める(登記簿の外にも
   * ボタンが在るため ── `container-repair` の `toggle` 等)。
   */
  it('src/adapter/ui の iconButton(...) / ボタンの textContent にも動詞句が無い', () => {
    const files = walkTs('src/adapter/ui');
    expect(files.length).toBeGreaterThan(30);
    const found: string[] = [];
    for (const f of files) {
      const stripped = codeOnly(readFileSync(f, 'utf8'));
      const btnVars = new Set<string>();
      const declRe = /const\s+(\w+)\s*=\s*document\.createElement\(\s*['"`]button['"`]\s*\)/g;
      let dm: RegExpExecArray | null;
      while ((dm = declRe.exec(stripped))) if (dm[1] !== undefined) btnVars.add(dm[1]);
      for (const v of btnVars) {
        const tcRe = new RegExp(`${v}\\.textContent\\s*=\\s*(['"\`])((?:[^\\\\]|\\\\.)*?)\\1`, 'g');
        let m: RegExpExecArray | null;
        while ((m = tcRe.exec(stripped))) {
          const val = m[2] ?? '';
          if (VERB_PHRASE.test(val)) found.push(`${f}:${v}=${val}`);
        }
      }
      const iconRe = /iconButton\([^,]+,\s*(['"`])((?:[^\\]|\\.)*?)\1/g;
      let im: RegExpExecArray | null;
      while ((im = iconRe.exec(stripped))) {
        const val = im[2] ?? '';
        if (VERB_PHRASE.test(val)) found.push(`${f}:iconButton=${val}`);
      }
    }
    expect(found).toEqual([]);
  });
});

describe('メッセージの文に英語の識別子を禁止', () => {
  /**
   * ⚠ **`STANDARD_TERMS` に加えて、この門だけの追加許可が要る**(§6.1 の 24 語の
   * 表を勝手に増やさない ── ここは「型・ボタンの名前」ではなく「文中に出てよい
   * 固有名詞・プロトコル名」なので別枠にする):
   * - `PKC` / `PKC2` / `PKC3` … アプリ自身の名前(製品名は識別子ではない)
   * - `http` / `https` … アドレスの書き方を説明する文に出る、プロトコルの名前
   * - `vCard` … user が扱う既知の外部形式名(.vcf の正式名)
   */
  const MESSAGE_ENGLISH_ALLOW = new Set(
    ['Markdown', 'HTML', 'PDF', 'Word', 'PowerPoint', 'zip', 'CSV', 'SQL', 'JSON', 'URL',
      'PKC', 'PKC2', 'PKC3', 'http', 'https', 'vCard'].map((s) => s.toUpperCase()),
  );

  const LIT = "(['\"`])((?:[^\\\\]|\\\\.)*?)\\1";
  const PATTERNS: readonly [RegExp, string][] = [
    [new RegExp(`type:\\s*'OP_FAILED'[\\s\\S]{0,300}?error:\\s*${LIT}`, 'g'), 'OP_FAILED.error'],
    [new RegExp(`type:\\s*'OP_NOTICE'[\\s\\S]{0,300}?message:\\s*${LIT}`, 'g'), 'OP_NOTICE.message'],
    [new RegExp(`showStatus\\??\\.?\\(\\s*${LIT}`, 'g'), 'showStatus(...)'],
    [new RegExp(`appMessagePost\\.post\\([\\s\\S]{0,300}?text:\\s*${LIT}`, 'g'), 'appMessagePost.post().text'],
  ];

  function englishIdentifiers(literal: string): string[] {
    const withoutInterpolation = literal.replace(/\$\{[^}]*\}/g, ' ');
    const idents = withoutInterpolation.match(/[A-Za-z_][A-Za-z_]{2,}/g) ?? [];
    return idents.filter((w) => !MESSAGE_ENGLISH_ALLOW.has(w.toUpperCase()));
  }

  it('self-test:わざと入れた 1 件は検出できる', () => {
    expect(englishIdentifiers('worker がまだ起動していません')).toEqual(['worker']);
    expect(englishIdentifiers('PKC2 の書出しは 1 つずつ')).toEqual([]);
  });

  const KNOWN_ENGLISH_IN_MESSAGES: readonly [file: string, place: string, literal: string][] = [];

  it('OP_FAILED.error / OP_NOTICE.message / showStatus / appMessagePost.post().text に英語識別子が無い', () => {
    const files = ROOTS.flatMap((r) => walkTs(r));
    let opFailedHits = 0;
    const found: [string, string, string][] = [];
    for (const f of files) {
      const stripped = codeOnly(readFileSync(f, 'utf8'));
      opFailedHits += (stripped.match(/type:\s*'OP_FAILED'/g) ?? []).length;
      for (const [re, label] of PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(stripped))) {
          const val = m[2] ?? '';
          if (englishIdentifiers(val).length > 0) {
            found.push([relative('.', f).split('\\').join('/'), label, val]);
          }
        }
      }
    }
    // 空振り防止:設計 doc §7 が言う「OP_FAILED(241 か所)」の規模を裏取りする
    expect(opFailedHits).toBeGreaterThan(100);
    found.sort((a, b) => (a[0] === b[0] ? (a[2] < b[2] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
    expect(found).toEqual([...KNOWN_ENGLISH_IN_MESSAGES]);
  });
});
