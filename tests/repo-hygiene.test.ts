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

describe('Office の起動引数', () => {
  /**
   * 🔴 **LO を起こす面は 1 つではない**(#158)。翻訳を一式へ詰めても、
   * `--language=ja` を渡す面が 1 つでも欠けると、そこだけ英語で開く。
   *
   * ⚠ **既知の 5 面を列挙する形にしない。** 6 つめが足された瞬間に、
   * 「主要な経路で効いているから大丈夫」で出荷される ── CLAUDE.md §7
   * 「同じ値を複数の経路へ渡すものは、経路ごとに pin する」の実体。
   * 🔑 **`callMain` を原文から数え上げ、数えた数だけ見る。**
   */
  it('🔴 callMain を呼ぶ面は、全部 --language=ja を渡している(#158)', () => {
    const sites: { file: string; line: number; text: string }[] = [];
    for (const f of [...textFiles('src'), ...textFiles('build'), ...textFiles('public')]) {
      const lines = readFileSync(f, 'utf-8').split('\n');
      lines.forEach((text, i) => {
        if (/\.callMain\(/.test(text)) sites.push({ file: f, line: i + 1, text });
      });
    }
    // ⚠ 空振り防止 ── 0 件なら「全部通っている」ではなく「1 つも見ていない」
    expect(sites.length, 'callMain が 1 件も見つからない = 何も検めていない').toBeGreaterThanOrEqual(
      5,
    );

    const bad: string[] = [];
    for (const s of sites) {
      // 引数がその行に在る形(`callMain(['…'])`)と、変数越しの形の両方を許す。
      // ⚠ 変数越しのときは、**その file の中で** args に ja が入っているかを見る
      const inline = /--language=ja/.test(s.text);
      const viaVar = /callMain\(\s*args\s*\)/.test(s.text)
        ? /--language=ja/.test(readFileSync(s.file, 'utf-8'))
        : false;
      if (!inline && !viaVar) bad.push(`${s.file}:${s.line}`);
    }
    expect(bad, `--language=ja を渡していない面が在る:\n${bad.join('\n')}`).toEqual([]);
  });
});

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

    /**
     * ⚠ **書き方は 2 通りある**(`setAttribute` と HTML 属性)。
     * 🔴 **形ごとに guard を持つ**(2026-08-08、変異試験の指摘)── 合算の
     * 「20 件以上」だけだと、**HTML 属性形の正規表現が壊れても気づかない**
     * (合算は `setAttribute` 形だけで満たされる)。実際、その変異は
     * `KNOWN_DEAD` の等値 pin に**たまたま**救われていただけで、3 件を直した
     * 瞬間に守り手を失うところだった。
     */
    const bySetAttr = new Set<string>();
    const byHtmlAttr = new Set<string>();
    for (const f of textFiles('src')) {
      const text = readFileSync(f, 'utf-8');
      // ⚠ **属性を実際に付けている所**を拾う(散文の中の語を拾わない)
      for (const m of text.matchAll(/'data-pkc-action',\s*'([a-z0-9-]+)'/g)) bySetAttr.add(m[1]!);
      for (const m of text.matchAll(/data-pkc-action="([a-z0-9-]+)"/g)) byHtmlAttr.add(m[1]!);
    }
    expect(bySetAttr.size, 'setAttribute 形を読めていない(空振り)').toBeGreaterThan(20);
    expect(byHtmlAttr.size, 'HTML 属性形を読めていない(空振り)').toBeGreaterThan(0);
    const written = new Set([...bySetAttr, ...byHtmlAttr]);

    /**
     * 🔴 **見つかった実害**(2026-08-08、この検査を書いた初回)。
     *
     * markdown が `[題名](entry:<lid>)` / `pkc://…/asset/<key>` / `@card:` に
     * `data-pkc-action` を焼いているのに、**PKC3 の binder に受け手が無かった** ──
     * つまり本文のリンクを押しても**無言で何も起きない**。焼く側のコメントは
     * PKC2 の `action-binder` を指しており、記法だけ移植して受け手を置き忘れた形。
     *
     * ✅ **`navigate-entry-ref` と `navigate-card-ref` は戻した**(2026-08-08)。
     *
     * 🔴 **`navigate-asset-ref` は「焼かない」ことで解いた**(2026-08-08、Issue #100 段①)。
     *
     * 段①で cid が届くようになり、条件だけ見れば `pkc://<自分>/asset/<key>` は
     * この action で焼ける。⚠ **だが受け手は無い**(② key→lid の逆引きが未着手)ので、
     * 焼くと `<a href>` の既定を止める #97 の配線に当たり、**押しても黙る** ──
     * #98 で 4 面ぶん潰したばかりの**無言の dead click を新設する**ことになる。
     * 🔑 だから `markdown-render.ts` の同一コンテナ枝を **`kind === 'entry'` に限った**。
     *   添付の携帯参照は今までどおり札(`pkc-portable-reference-placeholder`)で出る ──
     *   container / target が title に読めるので、**黙るリンクより情報が多い**。
     * ⚠ **これは「直した」ではなく「退行させなかった」である。** 段②(逆引きの口)が
     *   入ったら枝を戻し、この配列に戻す必要は無い(受け手ができるので dead でなくなる)。
     * ⚠ 逆引きに `scanAssetRefs` を流用しない(判定の向きが逆 ── 別ノートへ飛ぶ)。
     *
     * ⚠ **等値で pin する**(「既知は無視」の可変リストにしない)── 直したら
     *   ここから消さないと落ちるし、新しい dead click が増えても落ちる。
     */
    const KNOWN_DEAD: string[] = [];
    const dead = [...written].filter((a) => !handlers.has(a)).sort();
    expect(dead, `受け手のいない action がある(押しても無言で何も起きない)`).toEqual(KNOWN_DEAD);
  });
});
