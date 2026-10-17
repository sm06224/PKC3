/** @vitest-environment node */
/**
 * 🔴 **メッセージに添付名・題名が漏れない**(#1087)。
 *
 * メッセージは「ノートの中身・題名・添付名は書き込まれません」と約束している(画面とマニュアル)。
 * 守っているのは `sanitizeMessageText` が「…」『…』の中身を潰すことだけ ── だから
 * **user のデータの名前を文に埋め込むときは、必ず「」で囲む**。囲んでいないと、そのまま書かれる。
 *
 * ⚠ この検査は、断りの文(`OP_FAILED` の error / `fail(` / `notify(` / `showStatus(` / `why:` /
 *   `message:` / `new …Error(`)に続くテンプレート文字列を全数で走査し、`${…name}` / `${…title}` /
 *   `${…fileName}` の前後が「」『』でないものを探す。注釈は落としてから見る(`codeOnly`)。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './helpers/code-only';
import { sanitizeMessageText } from '@features/message/message-log';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const TRIGGER =
  /(?:OP_FAILED[^`;]{0,160}|\berror:\s*|\bfail\(\s*|\bnotify\(\s*|\bshowStatus\(\s*|\bsay\(\s*|\btell\(\s*|\bwhy:\s*|\bmessage:\s*|\b(?:warnings|notes|warn)\.push\(\s*|\bwarn\(\s*|new \w*Error\(\s*)`((?:[^`\\]|\\.)*)`/g;
const NAME_EXPR = /(?:^|\.)(?:name|title|fileName|filename)$/;

/**
 * user のデータの名前ではないもの(等値 pin ── 足すなら「なぜ user のデータではないか」を書く)。
 * ⚠ 全部、ファイルの名前ではなくアプリ自身の識別子・項目名。
 */
const NOT_USER_DATA: readonly string[] = [
  'kind.name', // 描画器の種類名(mermaid / math など)── 属性名に使うだけ
  'this.opts.name', // ワーカーの内部名
  'prop.name', // vCard の項目名(TEL / EMAIL など)── 利用者のデータではない
  'part.name', // 同梱パーツの名前(アプリが配る一式)
];

/**
 * ファイル単位の許可(等値 pin)。どれも**アプリが配る固定の名前**で、user のデータではない。
 * ⚠ 足すときは「なぜ user のデータではないか」を 1 行書く。
 */
const APP_OWNED_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['src/adapter/platform/duckdb/', 'DuckDB の拡張・同梱ファイルの名前(アプリが配る一式)'],
  ['src/adapter/platform/office/office-pack-', 'Office の一式のファイル名(アプリが配る一式)'],
  ['src/features/flags.ts', 'flag の名前(アプリの設定名)'],
  ['src/features/notation/caps.ts', '上限の名前(アプリの設定名)'],
  ['src/features/markdown/place-rect.ts', '位置の項目名(x / y / 幅 / 高さ)'],
  ['src/features/export/pkc3-archive.ts', 'PKC3 の書き出しが決めた固定のファイル名(manifest など)'],
  ['src/features/import/pkc2-bundle.ts', 'PKC2 の書き出しが決めた固定のファイル名(manifest など)'],
  ['src/features/markdown/markdown-render.ts', '診断の記録(メッセージには積まれない)'],
];

function leaks(): string[] {
  const hits: string[] = [];
  for (const file of walk('src')) {
    const src = codeOnly(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(TRIGGER)) {
      const tpl = m[1] ?? '';
      for (const e of tpl.matchAll(/\$\{([^{}]*)\}/g)) {
        const expr = (e[1] ?? '').trim();
        if (!NAME_EXPR.test(expr) || NOT_USER_DATA.includes(expr)) continue;
        if (APP_OWNED_NAMES.some(([prefix]) => file.replaceAll('\\', '/').startsWith(prefix))) continue;
        const before = tpl.slice(0, e.index).slice(-1);
        const after = tpl.slice((e.index ?? 0) + e[0].length).slice(0, 1);
        if ((before === '「' && after === '」') || (before === '『' && after === '』')) continue;
        hits.push(`${file}: \${${expr}} in \`${tpl.slice(0, 50)}\``);
      }
    }
  }
  return hits;
}

describe('メッセージに名前を漏らさない(#1087)', () => {
  it('🔴 断りの文に埋め込む name / title は、すべて 「」 『』 で囲んである', () => {
    expect(leaks()).toEqual([]);
  });

  it('空振り防止: 走査は「」で囲んだ側を実際に見つけている(囲んだ実例が 20 件以上ある)', () => {
    let wrapped = 0;
    for (const file of walk('src')) {
      const src = codeOnly(readFileSync(file, 'utf8'));
      for (const m of src.matchAll(TRIGGER)) {
        wrapped += (m[1] ?? '').match(/「\$\{[^{}]*(?:name|title|fileName)\}」/g)?.length ?? 0;
      }
    }
    expect(wrapped).toBeGreaterThan(20);
  });

  it('対照群: 囲んでいない名前は検査が拾い、囲めば潰れて書かれない', () => {
    // 囲んだ名前はメッセージに書かれない / 囲んでいない名前はそのまま書かれる(= 検査が要る理由)
    expect(sanitizeMessageText('PDF を開けませんでした: 「secret.pdf」')).not.toContain('secret');
    expect(sanitizeMessageText('PDF を開けませんでした: secret.pdf')).toContain('secret');
  });
});
