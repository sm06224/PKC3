/**
 * リポジトリ衛生 ── **人の注意力に頼らない**ための機械的な歯止め。
 *
 * 🔴 「制御文字を正規表現に直書きしない」と注意書きしている当の file で、
 * 生バイトの DEL を 3 回埋めた(その都度 grep では見えず、書いた本人も
 * 気づかなかった)。注意書きは 3 回とも効かなかったので、test にする。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 追跡対象のテキスト file を集める(生成物・依存は見ない)。
 *
 * ⚠ **追跡されない使い捨て(`zz` 始まり)は見ない** ── `.gitignore` が
 * それを無視すると決めているのに、この検査だけが拾っていた。
 * 計測用の probe(乱数 fixture を持つ)を置いた瞬間に**無関係な赤**が出て、
 * 「衛生の赤」が日常になると本物の赤が埋もれる。⚠ 無視の綴りは 1 か所に寄せる
 * ことができない(`.gitignore` は機械可読でない)ので、**同じ綴り**を使う
 */
function textFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    if (name.startsWith('zz') || name.startsWith('tmp-review-')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) textFiles(full, out);
    else if (/\.(ts|tsx|js|mjs|json|md|css|html|yml|yaml)$/.test(name)) out.push(full);
  }
  return out;
}

describe('リポジトリ衛生', () => {
  it('🔴 ソースに制御文字の生バイトが無い(タブ・改行を除く)', () => {
    const offenders: string[] = [];
    for (const f of [
      ...textFiles('src'),
      ...textFiles('tests'),
      ...textFiles('docs'),
      ...textFiles('scripts'), // CI の検品 script も同じ規律で縛る(P7 段①)
      ...textFiles('build'), // ビルド script も同じ規律で縛る(P7 段④)
      'CLAUDE.md',
      'README.md',
    ]) {
      let text: string;
      try {
        text = readFileSync(f, 'utf-8');
      } catch {
        continue;
      }
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        // \n(0x0a) / \t(0x09) だけ許す。\r は CRLF fixture が持つので許す
        if ((c < 0x20 && c !== 0x0a && c !== 0x09 && c !== 0x0d) || c === 0x7f) {
          offenders.push(`${f}:${i} = U+${c.toString(16).padStart(4, '0')}`);
          break;
        }
      }
    }
    // ⚠ 期待は**空配列**。file 名まで出す(「どこか」では直せない)
    expect(offenders).toEqual([]);
  });

  /**
   * 🔴 **`data-pkc-action` を書いたのに受け手が無い = 無言の dead click**
   * (2026-08-08、P11 で 3 つ足したときに機械化した)。
   *
   * binder は `ACTIONS[action]` が無ければ**黙って return する** ── 押しても
   * 何も起きず、エラーも出ない。この repo が繰り返し踏んできた形
   * (2026-08-07「保存直後の編集が無言の dead click になっていた」)なので、
   * 人の注意力ではなく機械で止める。
   *
   * ⚠ 逆向き(受け手は在るが誰も書かない)は**見ない** ── 面を作る前に受け手を
   *   置く順序(「実体を作ってから導線を書く」)を禁じてしまう。
   */
  it('🔴 画面に書いた data-pkc-action に、受け手が全部いる', () => {
    const binder = readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8');
    /**
     * ⚠ **`ACTIONS` の表だけを見る**(file 全体を `includes` で見ない)── 説明文や
     *   `BODY_WRITE_ACTIONS` の一覧に名前が在るだけで満たされてしまう
     *   (CLAUDE.md「ガードは代替物で満たせない条件にする」)。
     */
    const table = binder.slice(binder.indexOf('const ACTIONS: Record<string, ActionHandler> = {'));
    const handlers = new Set([...table.matchAll(/^\s{2}'([a-z0-9-]+)':/gm)].map((m) => m[1]!));
    expect(handlers.size, '受け手の表を読めていない(空振り)').toBeGreaterThan(20);

    const written = new Set<string>();
    for (const f of textFiles('src')) {
      const text = readFileSync(f, 'utf-8');
      // ⚠ **属性を実際に付けている所**を拾う(散文の中の語を拾わない)
      for (const m of text.matchAll(/'data-pkc-action',\s*'([a-z0-9-]+)'/g)) written.add(m[1]!);
      for (const m of text.matchAll(/data-pkc-action="([a-z0-9-]+)"/g)) written.add(m[1]!);
    }
    expect(written.size, '画面側を読めていない(空振り)').toBeGreaterThan(20);

    /**
     * 🔴 **見つかった実害**(2026-08-08、この検査を書いた初回)。
     *
     * markdown が `[題名](entry:<lid>)` / `pkc://…/asset/<key>` / `@card:` に
     * `data-pkc-action` を焼いているのに、**PKC3 の binder に受け手が無い** ──
     * つまり本文のリンクを押しても**無言で何も起きない**。焼く側のコメントは
     * PKC2 の `action-binder` を指しており、記法だけ移植して受け手を置き忘れた形。
     *
     * ⚠ **等値で pin する**(「既知は無視」の可変リストにしない)── 直したら
     *   ここから消さないと落ちるし、新しい dead click が増えても落ちる。
     * 🔑 この 3 件は P11 とは**別の主題**なので、別の変更で戻す(#起票済み)。
     */
    const KNOWN_DEAD = ['navigate-asset-ref', 'navigate-card-ref', 'navigate-entry-ref'];
    const dead = [...written].filter((a) => !handlers.has(a)).sort();
    expect(dead, `受け手のいない action がある(押しても無言で何も起きない)`).toEqual(KNOWN_DEAD);
  });
});
