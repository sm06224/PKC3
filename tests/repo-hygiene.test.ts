/**
 * リポジトリ衛生 ── **人の注意力に頼らない**ための機械的な歯止め。
 *
 * 🔴 「制御文字を正規表現に直書きしない」と注意書きしている当の file で、
 * 生バイトの DEL を 3 回埋めた(その都度 grep では見えず、書いた本人も
 * 気づかなかった)。注意書きは 3 回とも効かなかったので、test にする。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { codeOnly as stripComments } from './helpers/code-only';

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
      // 🔴 変数越しは「file のどこかに ja」では**緩すぎる**(レビュー指摘 E)──
      //    コメントに書いてあるだけでも通り、args を組み直す refactor が生き延びる。
      //    見るのは **args の代入行そのもの**(コメント行は先に落とす)。
      const inline = /--language=ja/.test(s.text);
      const code = readFileSync(s.file, 'utf-8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      // ⚠ 宣言が ja でも、callMain までに**再代入**されたら意味が無い(変異試験で
      //    実際に生き延びた形)── 素の `args = …` を ja 以外へ張る行が無いことまで見る
      const decl = /(?:var|const|let)\s+args\s*=\s*\[\s*'--language=ja'/.test(code);
      const reassigned = /^\s*args\s*=\s*(?!\[\s*'--language=ja')/m.test(code);
      const viaVar = /callMain\(\s*args\s*\)/.test(s.text) ? decl && !reassigned : false;
      if (!inline && !viaVar) bad.push(`${s.file}:${s.line}`);
    }
    expect(bad, `--language=ja を渡していない面が在る:\n${bad.join('\n')}`).toEqual([]);
  });

  /**
   * ⚠ **LO を起こす面は callMain だけではない**(レビュー指摘 F)── probe 群は
   * `qt_soffice.html`(上流の素の page)を直接開くので、上の数え上げに入らない。
   * それらは**英語 UI で起動する**。I/O の機構(crash / focus / 当たり判定)を測る
   * 面なので言語非依存として許すが、🔑 **既知リストの等値 pin** にする ──
   * 新しい面が増えたら、ここで「ja を渡すか、理由を書いてこの表に載せるか」を
   * 選ばせる(黙って英語の面が増えない)。
   *
   * ⚠ **この検査は file 全体を見る ── 注釈の中の言及でも当たる**(2026-08-23 に踏んだ)。
   *   `host.html` に「実物で確かめたのは `qt_soffice.html` を直に配信する probe だ」と
   *   **注記を書いただけ**で、その file が「直接開く面」として数えられた。
   * 🔑 **`codeOnly` で剥ぐのが素直に見えるが、それをやると既知 6 件のうち 2 件が消える**
   *   ── つまり `office-pack-acquire.ts` と `office-real-path-probe.mjs` は
   *   **元から注釈で満たされていた**。剥ぐと**表の意味が変わる**ので、既存の判断を
   *   勝手に覆さず、**書く側が字面を避ける**ことにした(この注記自身も
   *   `qt_soffice` と `.html` を離して書いてある)。
   * ⚠ ここを厳しくするなら、表の 6 件を「**実際に開く**」だけへ絞り直すのが筋である
   *   ── それは user の裁定案件。
   */
  it('⚠ qt_soffice.html を直接開く面は、既知リストと一致する(#158)', () => {
    const KNOWN_ENGLISH_BOOT = [
      'build/office-wasm/boot-probe.mjs', // 起動可否だけを見る(言語非依存)
      'build/office-wasm/dialog-crash-probe.mjs', // ダイアログの停止を測る(同上)
      'build/office-wasm/ime-probe.mjs', // IME の配管の有無を測る(同上)
      'build/office-wasm/io-layer-probe.mjs', // event 登録の層を解剖する(同上)
      'build/office-wasm/office-real-path-probe.mjs', // 実 user 経路(host 経由 = ja 済み)+ 対照で直も開く
      'src/adapter/platform/office/office-pack-acquire.ts', // 一式の file 名として言及するだけ(起動しない)
    ].sort();
    const found: string[] = [];
    for (const f of [...textFiles('src'), ...textFiles('build'), ...textFiles('public')]) {
      if (readFileSync(f, 'utf-8').includes('qt_soffice.html')) found.push(f);
    }
    // office-real-path-probe は io-layer 経由なので qt_soffice.html の字面を持つ場合のみ載る
    expect(found.sort(), 'qt_soffice.html を開く面が増減した ── ja を渡すか、理由つきで表へ').toEqual(
      KNOWN_ENGLISH_BOOT,
    );
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
   *
   * - ⚠ **その逆向きが 1 度実害を出した**(2026-08-23、記録として残す)。
   *   #292 段⑤ で**中央のカレンダーを落としたとき**、`calendar-set-date` の
   *   ハンドラと `BODY_WRITE_ACTIONS` の登録が**そのまま残った** ──
   *   属性を書き出す場所は `src` に 0 件になっていたのに、**tsc も lint も
   *   この検査も鳴らなかった**(表の要素としては使われているため)。
   *   実地調査で見つかるまで残り、⚠ 次に読む人が「日付付けはここ」と読むと
   *   **存在しない面を追う**ところだった。
   *   🔑 上の理由(開発途中の順序を禁じない)は**いまも正しい**ので、検査は
   *   足していない ── ⚠ ただし **`KNOWN_DEAD` と同じ等値 pin にすれば
   *   両立しうる**(開発途中は名前を 1 行足す)。**入れるかは user の裁定**
   *   (既存の判断を覆す提案になるため)。
   */
  it('🔴 画面に書いた data-pkc-action に、受け手が全部いる', () => {
    const binder = readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8');
    /**
     * ⚠ **`ACTIONS` から下だけを見る**(file 全体を `includes` で見ない)── 説明文に
     *   名前が在るだけで満たされてしまう(CLAUDE.md「ガードは代替物で満たせない条件に」)。
     *
     * 🔴 **注釈の訂正**(2026-08-29、#582 の全数調査で判明)。ここは 1 稿目に
     *   「**`ACTIONS` の表だけを見る**」と書いてあったが、**事実と違った** ──
     *   `slice` は **file の末尾まで**取るので、表の**下**に在る別の表
     *   (`SHORTCUT_BUTTON` / `FORMAT_OF` の **19 種**:`format-bold` `open-settings`
     *   `toggle-sidebar` ほか)も一緒に入る。
     * 🔑 **そして、入っていて正しい** ── それらも「押されたら何かが起きる」受け手だからで、
     *   narrow すると `format-bold` などが「受け手がいない」と**偽陽性**になる。
     * ⚠ つまり 1 稿目は**結果は正しく、理由が間違っていた**。理由を直しておかないと、
     *   次に読む人が「表だけのはずなのに 197 種ある」で 30 分溶かす(実際に溶かした)。
     * 🔑 **表の中だけ**を数えたいときは `scripts/action-outlets.mjs` の `receivers()`
     *   (中括弧で終端を決める)を使うこと ── そちらは **183 種**を返す。
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

/**
 * 🔴 **閲覧 HTML のテンプレート文字列にバッククォートを書かない**(2026-08-15)。
 *
 * `pkc3-html.ts` の `viewer()` は**巨大な template literal 1 本**で、そこに
 * バッククォートを 1 つ書くと**その場で閉じて**、遠くの行が構文エラーになる。
 * ⚠ file の中に注意書きが在るのに **6 度踏んだ**(直近は 2026-08-15、注記に
 * 書いた `calc(...)` の囲みで)。tsc は止めてくれるが、出るのは
 * 「This expression is not callable」という**原因と無関係な message** で、
 * 毎回 1〜2 往復を捨てる。
 * 🔑 **文言を 7 か所目にせず、機械に名指しさせる**(CLAUDE.md の型)。
 */
describe('閲覧 HTML のテンプレート文字列', () => {
  it('🔴 viewer() の template literal の中にバッククォートが無い', () => {
    const src = readFileSync('src/features/export/pkc3-html.ts', 'utf-8').split('\n');
    const start = src.findIndex((l) => l.trimEnd().endsWith('return `'));
    expect(start, '前提: viewer() の template literal を見つけられていない').toBeGreaterThan(0);
    // 閉じは行頭が `</script>`; の行(この 1 本しか無い)
    const end = src.findIndex((l, i) => i > start && l.includes('</script>`;'));
    expect(end, '前提: template literal の閉じを見つけられていない').toBeGreaterThan(start);
    const bad = src
      .slice(start + 1, end)
      .map((l, i) => ({ line: start + 2 + i, l }))
      .filter((x) => x.l.includes('`'));
    expect(
      bad.map((x) => `${x.line}: ${x.l.trim().slice(0, 60)}`),
      'template literal の中にバッククォートがある(その場で閉じて build が壊れる)',
    ).toEqual([]);
  });
});

/**
 * 🔒 **文書を受け取る probe は、撮影の口を「渡さない」形にする**(#220-2)。
 *
 * user 指示(機密資料の取り扱い 6、2026-08-15。不可侵):
 * 「**スクショを撮ってよいのは自作の file を開いたときだけ。** 同じハーネスで機密資料を
 * 扱う日は、撮影の口を**呼ばない**のではなく**渡さない**(引数を与えなければ撮れない
 * 形にする)」。
 *
 * ⚠ **消すのではなく門にした**理由: 版面の絵は、この harness で唯一生きている
 * 「一手が届いたか」の観測点である(題名は死んでいる / 打っても FS は動かない /
 * 窓の枚数も動かない)。消すと 2026-08-13 の失敗 ──「差が無い」を「actuate して
 * いない」と区別できず、**存在しない結論**を書きかけた ── へ戻る。
 * 🔑 だから既定 OFF の env 門にし、**それが在ることを機械で守る**。
 */
describe('🔒 文書を扱う probe の撮影の口', () => {
  /**
   * **等値 pin の既知リスト**(CLAUDE.md「等値 pin の既知リストは良く効く ──
   * 直したら消さないと落ちるので忘れられない」)。文書を引数に取る probe を足したら、
   * ここへ足す。⚠ 足さないと下の「全数」検査が落ちる。
   */
  const DOC_PROBES = [
    'build/office-wasm/open-doc-probe.mjs',
    'build/office-wasm/save-existing-probe.mjs',
  ];

  /** コメント行を落とした「実行する行」だけ返す(§1 で 5 回踏んだ型)。 */
  const codeLines = (rel: string): string[] =>
    readFileSync(rel, 'utf-8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));

  it('🔴 一覧が全数である(user の文書を読む probe を取りこぼしていない)', () => {
    /**
     * 判定は「**引数から来た path の bytes を読んでいるか**」で採る。
     * ⚠ `process.argv[3]` だけを見ると、出力先(`OUT`)に使っている probe が
     * 12 件並んで全数検査にならない ── **user の文書に触るか**が争点である。
     */
    const found = readdirSync('build/office-wasm')
      .filter((f) => f.endsWith('.mjs'))
      .filter((f) => {
        const lines = codeLines(join('build/office-wasm', f));
        const fromArgv = new Set(
          lines
            .flatMap((l) => [...l.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*[^;]*process\.argv\[3\]/g)])
            .map((m) => m[1]!),
        );
        return lines.some((l) => [...fromArgv].some((n) => new RegExp(`readFile\\(\\s*${n}\\b`).test(l)));
      })
      .map((f) => join('build/office-wasm', f))
      .sort();
    // 空振り防止 ── 1 件も見つからない形で「全部見た」と言わない
    expect(found.length, 'user の文書を読む probe を 1 つも見つけられていない').toBeGreaterThan(0);
    expect(found).toEqual(DOC_PROBES);
  });

  it('🔴 撮影は env の門の下にある(引数を与えなければ撮れない)', () => {
    let shots = 0;
    for (const rel of DOC_PROBES) {
      const lines = codeLines(rel);
      // その file の中で **env から作った名前**(門になりうるもの)
      const gates = new Set(
        lines
          .flatMap((l) => [...l.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*[^;]*process\.env\./g)])
          .map((m) => m[1]!),
      );
      const shotLines = lines.filter((l) => l.includes('page.screenshot'));
      for (const l of shotLines) {
        shots += 1;
        const gated = l.includes('process.env.') || [...gates].some((g) => l.includes(g));
        expect(gated, `${rel}: 門の無い撮影がある ── ${l.trim().slice(0, 80)}`).toBe(true);
      }
    }
    // 空振り防止 ── 撮影の行が 1 つも無いなら、この検査は何も守っていない
    expect(shots, '撮影の行が 1 つも無い ── 検査が空振りしている').toBeGreaterThan(0);
  });

  it('🔴 使い終わった profile を消している(痕跡を残さない)', () => {
    for (const rel of DOC_PROBES) {
      const code = codeLines(rel).join('\n');
      expect(code, `${rel}: persistent profile を作っているのに消していない`).toMatch(
        /rm\(\s*(PROFILE|profile)\s*,/,
      );
    }
  });
});

/**
 * 🔴 **計器が「全文 textarea」を掴むなら、腕を宣言してから掴む**(#223)。
 *
 * #172(2026-08-14)で**既定の編集面がライブ 1 面**になり、`editor-body` は設定
 * `split` のときしか出ない。⚠ bench 4 本はそれを知らずに掴み続け、**既定では
 * timeout / `null` で死ぬ**状態が 3 日間気づかれなかった(CI で走らないので、
 * こちらの計器は 1 つも鳴らない)。
 *
 * 🔑 だから「`editor-body` を掴む file は、**腕の切替**(`pkc3.editor-mode` /
 * `editor-arm.mjs`)も持っている」ことを機械で守る。⚠ 掴むこと自体は禁じない ──
 * split を測る計器は正しく掴む(禁じると `--arm=split` が書けなくなる)。
 */
describe('計器の編集面(#223)', () => {
  const FIELD = 'data-pkc-field="editor-body"';
  /** 腕を宣言していると認める印(どれか 1 つで足りる)。 */
  const ARM_MARKS = ['pkc3.editor-mode', 'editor-arm.mjs', 'useSplitEditor'];

  it('🔴 全文 textarea を掴む計器は、腕の切替も持っている', () => {
    const files = [
      ...readdirSync('tests/bench').map((f) => join('tests/bench', f)),
      ...readdirSync('tests/probe').map((f) => join('tests/probe', f)),
    ].filter((f) => /\.(mjs|ts)$/.test(f));
    // 空振り防止 ── 走査できていない形で「全部見た」と言わない
    expect(files.length, '計器を 1 つも見つけられていない').toBeGreaterThan(5);
    const grabbers = files.filter((f) => readFileSync(f, 'utf-8').includes(FIELD));
    // 空振り防止 ── 掴む file が 0 件なら、この検査は何も守っていない
    expect(grabbers.length, `${FIELD} を掴む計器が 1 つも無い`).toBeGreaterThan(0);
    const offenders = grabbers.filter((f) => {
      const text = readFileSync(f, 'utf-8');
      return !ARM_MARKS.some((m) => text.includes(m));
    });
    expect(offenders, '腕を宣言せずに全文 textarea を掴んでいる(既定 live では無い)').toEqual(
      [],
    );
  });
});

/**
 * 🔴 **画面に出す文字列に markdown の記法を書かない**(2026-08-18 に実際に踏んだ)。
 *
 * 設定の説明文を `textContent` に代入しているのに `**読む**` と書いたので、
 * **アスタリスクがそのまま画面に出ていた**。⚠ PKC2 が同じ失敗をしており、
 * `src/features/notice/notice-log.ts` の冒頭が「`textContent` で描くのに本文が
 * `**強調**` で書かれ、アスタリスクが見えていた」と**戒めている当のもの**である
 * (お知らせ側には既に検査が在り、設定側に無かった)。
 *
 * ⚠ **範囲を絞る** ── src 全体で `**` を禁じると、コメントの強調が全部落ちる。
 * 見るのは「**`textContent` に代入している文字列リテラル**」だけ。
 */
describe('画面の文字列に記法を書かない(2026-08-18)', () => {
  const UI_FILES = readdirSync('src/adapter/ui/render')
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join('src/adapter/ui/render', f));

  it('🔴 textContent に代入する文字列に markdown の強調が無い', () => {
    // 空振り防止 ── 走査対象が 0 件 / 代入が 1 件も見つからない形で緑にしない
    expect(UI_FILES.length, '面の file を 1 つも見ていない').toBeGreaterThan(10);
    const offenders: string[] = [];
    let assignments = 0;
    for (const file of UI_FILES) {
      const text = readFileSync(file, 'utf8');
      // `x.textContent = …;` の右辺(複数行の連結も拾う)
      for (const m of text.matchAll(/\.textContent\s*=\s*([\s\S]*?);\n/g)) {
        assignments += 1;
        const rhs = m[1] ?? '';
        // 文字列リテラルの中だけを見る(識別子や式は対象外)
        for (const lit of rhs.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'/g)) {
          const body = lit[1] ?? '';
          if (/\*\*[^*]+\*\*/.test(body) || /`[^`]+`/.test(body)) {
            offenders.push(`${file}: ${body.slice(0, 40)}`);
          }
        }
      }
    }
    expect(assignments, 'textContent への代入を 1 件も拾えていない(走査が壊れている)').toBeGreaterThan(
      20,
    );
    expect(offenders, '画面に出る文字列に記法が書かれている(そのまま記号が見える)').toEqual([]);
  });
});

/**
 * 🔴 **本文を書く action は、忙しい間の門(`BODY_WRITE_ACTIONS`)に必ず載る**
 * (2026-08-19 のレビュー W-4)。
 *
 * ⚠ `toggle-task`(#287)と `calendar-set-date`(#276)は、`toggle-todo` と
 *   **同じ `REQUEST_BODY_REWRITE` を撃つ**のに門から漏れていた ── PKC3 の
 *   `AppPhase` に `'exporting'` は無く、取り込み・書き出し中も `phase` は
 *   `'ready'` のままなので、reducer の門は効かない。止められるのは
 *   `services.busy()` だけであり、その入口がこの配列である。
 * 🔑 **散文では守れない**(2 回とも足し忘れた)ので、
 *   「reducer が本文の書込へ変える action 型」→「それを撃つ binder の action 名」を
 *   **機械で数え上げて**突き合わせる。
 */
describe('本文を書く導線は、忙しい間の門に載っている', () => {
  const STATE = readFileSync('src/adapter/state/app-state.ts', 'utf-8');
  const BINDER = readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8');

  /** reducer の `case 'X':` を境に切って、本文の書込を出す型を拾う。 */
  const writingActionTypes = (): Set<string> => {
    const out = new Set<string>();
    const parts = STATE.split(/\n {4}case '/);
    for (const part of parts.slice(1)) {
      const name = /^([A-Z_]+)'/.exec(part)?.[1];
      if (name === undefined) continue;
      // ⚠ 次の case までを見る(case を跨いで拾わない)
      const body = part.split(/\n {4}case '/)[0]!;
      if (/type: 'REQUEST_BODY_REWRITE'|type: 'PERSIST_ENTRY'/.test(body)) out.add(name);
    }
    return out;
  };

  /**
   * binder の ACTIONS 表を、handler ごとに切る。
   * ⚠ **表の終わりで切る**(2026-08-19 に自分で踏んだ)── file 末尾まで取ると、
   *   最後の handler の本文が**表の外のコード**(別の対応表など)を飲み込み、
   *   無関係な `type: '...'` に満たされて**偽の漏れ**が出る(§1「範囲が広すぎる」)。
   */
  const handlerBodies = (): Map<string, string> => {
    const from = BINDER.indexOf('const ACTIONS: Record<string, ActionHandler> = {');
    // 表は行頭の `};` で閉じる ── そこまでを表と見なす
    const rel = BINDER.slice(from).search(/\n\};\n/);
    expect(rel, 'ACTIONS 表の終わりを読めていない').toBeGreaterThan(0);
    const table = BINDER.slice(from, from + rel);
    const out = new Map<string, string>();
    const marks = [...table.matchAll(/^ {2}'([a-z0-9-]+)':/gm)];
    for (let i = 0; i < marks.length; i++) {
      const start = marks[i]!.index!;
      const end = i + 1 < marks.length ? marks[i + 1]!.index! : table.length;
      out.set(marks[i]![1]!, table.slice(start, end));
    }
    return out;
  };

  /**
   * 🔴 **表の外の helper も 1 段だけ追う**(2026-08-24、変異試験 N5 が教えた)。
   *
   * ⚠ 直す前は handler の**本文だけ**を見ていたので、
   *   `'dual-mkdir': (d, t) => dualCreate(d, t, 'folder'),` のように
   *   **dispatch を helper へ出した瞬間、門の検査から消えていた**。
   *   ⚠ しかもそれは「規則を 1 か所へ寄せる」(§7)をやると必ず起きる形なので、
   *   **良い直しをするほど検査が緩む**という最悪の向きだった。
   * 🔑 helper の本文を取り、handler が**その名前を呼んでいれば**中身を足して見る。
   * ⚠ **1 段だけ**(helper が別の helper を呼ぶ形は追わない)── 追い始めると
   *   file ぜんぶを飲み込んで、§1 の「範囲が広すぎて無関係な散文に満たされる」へ倒れる。
   *   ⚠ 2 段目が要るようになったら、**そのとき**広げる(いま広げると空振りを買う)。
   */
  const helperBodies = (): Map<string, string> => {
    const out = new Map<string, string>();
    // ⚠ **行頭**の宣言だけ(表の中の要素を拾わない)
    for (const m of BINDER.matchAll(/^(?:const|function) ([A-Za-z_][\w]*)\b/gm)) {
      const start = m.index!;
      // 宣言は行頭の `};` か `}` で閉じる ── そこまでを本文と見なす
      const rel = BINDER.slice(start).search(/\n\};?\n/);
      if (rel > 0) out.set(m[1]!, BINDER.slice(start, start + rel));
    }
    return out;
  };

  it('⚠ 数え上げが空振りしていない(表を読めている)', () => {
    const types = writingActionTypes();
    expect(types.size, 'reducer から本文の書込を出す型を 1 つも読めていない').toBeGreaterThan(2);
    expect(types, 'よく知られた書込の型が拾えていない').toContain('TOGGLE_TASK');
    expect(handlerBodies().size, 'binder の表を読めていない').toBeGreaterThan(20);
  });

  it('🔴 本文を書く action が門から漏れていない', () => {
    const types = writingActionTypes();
    const gate = new Set(
      [...(/const BODY_WRITE_ACTIONS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)/
        .exec(BINDER)?.[1] ?? '').matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]!),
    );
    expect(gate.size, '門の一覧を読めていない(空振り)').toBeGreaterThan(5);
    const helpers = helperBodies();
    // ⚠ 空振り防止 ── helper を 1 つも読めていないなら、下の展開は何もしていない
    expect(helpers.size, 'binder の helper を読めていない(空振り)').toBeGreaterThan(3);
    const missing: string[] = [];
    for (const [action, body] of handlerBodies()) {
      // 🔑 handler が呼んでいる helper の本文を**1 段だけ**足して見る(上の docstring)
      const called = [...body.matchAll(/\b([A-Za-z_][\w]*)\s*\(/g)].map((m) => m[1]!);
      const seen = new Set<string>();
      let scan = body;
      for (const name of called) {
        const h = helpers.get(name);
        if (h !== undefined && !seen.has(name)) {
          seen.add(name);
          scan += h;
        }
      }
      const dispatched = [...scan.matchAll(/type: '([A-Z_]+)'/g)].map((m) => m[1]!);
      if (dispatched.some((t) => types.has(t)) && !gate.has(action)) missing.push(action);
    }
    expect(missing, '本文を書くのに BODY_WRITE_ACTIONS に無い action がある').toEqual([]);
  });
});

/**
 * 🔴 **新しい本文が state に入る所は、全部 `refreshTaskCards` を通る**
 * (2026-08-20。#277 段②-b の宣言が**数を間違えていた**ので、機械で数える形へ変えた)。
 *
 * ## なぜ機械で数えるか
 *
 * `refreshTaskCards` の docstring には「`buildPersist` と `BODY_REWRITTEN` の
 * **2 か所だけ**を通す(数えた数だけ通す ── §7)」と書いてあったが、
 * **`ENTRY_APPENDED` が 3 か所目**として漏れていた。
 * ⚠ 宣言が在るぶん、次に読む人は**数え直さない** ── 誤った安心が配られる。
 *
 * 🔑 板の札は**原文の行番号**を指すので、本文が変わったのに組み直さないと
 *   **押したとき別の行が黙って完了になる**(#277 段②-b で実際に踏んだ形)。
 *
 * ⚠ この検査は**漏れを名指しする**だけで、中身の正しさは見ない
 *   (`refreshTaskCards` を呼んでいれば通る)── 弱いと自覚して使う。
 *   行番号の追従そのものは `tests/adapter/state.test.ts` の変異試験が守る。
 */
describe('新しい本文が state に入る所は、札の組み直しを通る', () => {
  /**
   * 🔴 **コメントを落としてから見る**(2026-08-20、着地前の変異試験が突いた)。
   *
   * ⚠ ここは「**在る**」ことを主張する検査なので、注釈が検査を満たす ──
   *   1 稿目は原文のまま見ていたので、実装から `refreshTaskCards(...)` の**呼び出しを
   *   消しても**、同じ case に書いた解説コメントの中の `refreshTaskCards` の 5 文字に
   *   満たされて**緑のまま**だった(変異 R1 が生き延びて判明)。
   * ⚠ この罠は `tests/docs-parity.test.ts` の `codeOnly` が名指しで戒めているのに、
   *   **同じセッションでそれを引用しておきながら踏んだ**。
   */
  const STATE = readFileSync('src/adapter/state/app-state.ts', 'utf-8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  /**
   * reducer の `case 'X':` を境に切り、**`openBody` に新しい本文を入れる** case を拾う。
   * ⚠ 「`openBody` の語が在る」では拾いすぎる(読むだけの case も当たる)ので、
   *   **`body:` を持つ object を組んでいる**ことを条件にする。
   */
  const bodyIntoStateCases = (): Map<string, string> => {
    const out = new Map<string, string>();
    for (const part of STATE.split(/\n {4}case '/).slice(1)) {
      const name = /^([A-Z_]+)'/.exec(part)?.[1];
      if (name === undefined) continue;
      const body = part.split(/\n {4}case '/)[0]!;
      /**
       * 🔴 **距離で拾わない**(2026-08-20 に自分で踏んだ)。1 稿目は
       *   `openBody …{0,400}… body: action.body` と**文字数の窓**で書いていたので、
       *   実装に**コメントを 1 つ足しただけで拾う集合が変わった**
       *   (窓の外へ押し出された case が静かに消える)。
       * 🔑 距離を使わず「その case が `openBody` を組み立てていて、かつ
       *   `body: action.<何か>` を書いている」で見る。
       */
      if (/\bopenBody\b/.test(body) && /\bbody:\s*action\.\w+/.test(body))
        out.set(name, body);
    }
    return out;
  };

  /**
   * 🔴 **通さなくてよい case は、理由つきで名指しする**(黙って除外しない)。
   *
   * ⚠ 一覧に足すのは「**板が見ていない本文**」だけである。増やすときは、
   *   その本文が板に届く筋が無いことを**書いてから**足すこと。
   */
  const EXEMPT: Readonly<Record<string, string>> = {
    /**
     * 打鍵ごとの draft。⚠ 板は**保存された本文**を映すので、draft を追う必要が無い
     * ── そして編集中は `SET_VIEW_MODE` が板を開かせない(reducer が捨てる)ので、
     * draft が板に届く筋がそもそも存在しない。⚠ 追ったら 1 打鍵ごとに札を組み直す。
     */
    UPDATE_OPEN_BODY: '打鍵ごとの draft(編集中は板を開けないので届かない)',
  };

  it('⚠ 前提: そういう case が実在する(空振り防止)', () => {
    const found = bodyIntoStateCases();
    expect(found.size, '1 件も拾えていない ── 拾い方が壊れている').toBeGreaterThan(0);
    /**
     * ⚠ **既知の顔ぶれを等値で pin する** ── 「件数が N 以上」だと、足した人が
     *   通し忘れても既存の件数で満たされる(§1 の空振り)。
     * 🔴 この一覧は 2026-08-20 に **4 件増えた** ── 実装の docstring は
     *   「2 か所だけ」と宣言していたが、実際は 6 か所(うち 5 か所が要追従)だった。
     */
    expect([...found.keys()].sort()).toEqual([
      'BODY_LOADED',
      'BODY_REWRITTEN',
      'ENTRY_APPENDED',
      'ENTRY_BODY_REFRESHED',
      'ENTRY_RESTORED',
      'UPDATE_OPEN_BODY',
    ]);
  });

  /**
   * 🔴 **除外の一覧そのものを等値で pin する**(2026-08-20、変異 R8 が突いた)。
   *
   * ⚠ 除外は**自分で書ける逃げ道**である ── 検査が落ちたときに名前を 1 つ足せば
   *   黙る。実際、`ENTRY_RESTORED` / `BODY_LOADED` を除外へ足す変異は**生き延びた**。
   * 🔑 等値で pin してあれば、除外を増やすには**ここも書き換える**しかない ──
   *   そのとき「本当に板へ届かないのか」を書く場所が目の前に出る。
   */
  it('🔴 除外してよいのは、板へ届かない本文だけ(逃げ道を増やせない)', () => {
    expect(Object.keys(EXEMPT).sort()).toEqual(['UPDATE_OPEN_BODY']);
  });

  it('🔴 拾った case が全部 refreshTaskCards を通っている', () => {
    const missing = [...bodyIntoStateCases()]
      .filter(([name]) => EXEMPT[name] === undefined)
      .filter(([, body]) => !body.includes('refreshTaskCards'))
      .map(([name]) => name);
    expect(
      missing,
      `新しい本文を state へ入れているのに札を組み直していない case がある(押すと別の行が完了になる): ${missing.join(' / ')}`,
    ).toEqual([]);
  });

  /**
   * ⚠ `COMMIT_EDIT` / `RETRY_PERSIST` は `buildPersist` 経由なので上の拾い方には
   *   出てこない。**そちらも通っていること**を別に見る(経路ごとに pin ── §7)。
   */
  it('🔴 buildPersist も札を組み直す', () => {
    const from = STATE.indexOf('function buildPersist(');
    expect(from, 'buildPersist を読めていない').toBeGreaterThan(0);
    const fn = STATE.slice(from, STATE.indexOf('\n}\n', from));
    expect(fn, 'buildPersist が札を組み直していない').toContain('refreshTaskCards');
  });

  /**
   * 🔴 **同じ全数走査を、スマートフォルダの当たりにも当てる**
   * (user 要望 2026-08-26「文書側でタグつけしたら勝手にフォルダに落ちる」)。
   *
   * ⚠ 札(`refreshTaskCards`)とまったく同じ構造の穴である ── 新しい本文が
   *   state に入る口は 6 つ在り、**1 つでも通し忘れると、その経路でタグを付けた
   *   ときだけ入れ物が古いまま**になる(user から見ると「付けたのに出てこない」)。
   * 🔑 だから**同じ census を 2 本立てる** ── 片方だけだと、次に口を足した人が
   *   札は直して当たりを忘れる(逆も同じ)。
   */
  it('🔴 拾った case が全部 refreshSmartHits を通っている', () => {
    const missing = [...bodyIntoStateCases()]
      .filter(([name]) => EXEMPT[name] === undefined)
      .filter(([, body]) => !body.includes('refreshSmartHits'))
      .map(([name]) => name);
    expect(
      missing,
      `新しい本文を state へ入れているのに、開いているスマートフォルダを直していない case がある(タグを付けても出てこない): ${missing.join(' / ')}`,
    ).toEqual([]);
  });

  it('🔴 buildPersist も、開いているスマートフォルダを直す', () => {
    const from = STATE.indexOf('function buildPersist(');
    expect(from, 'buildPersist を読めていない').toBeGreaterThan(0);
    const fn = STATE.slice(from, STATE.indexOf('\n}\n', from));
    expect(fn, 'buildPersist が入れ物の当たりを直していない').toContain('refreshSmartHits');
  });
});

/**
 * 🔴 **native のダイアログは、もう使わない**(#299 段④、user 裁定 2026-08-21)。
 *
 * > 「**ブラウザの方のアラートはマウスの動線が多くてウザいから、自前の方が嬉しい**」
 *
 * ⚠ **戻ってこないことの見張り**である。`window.confirm` / `window.alert` は
 *   1 行足すだけで戻せるうえ、戻しても**ほとんどの test は緑のまま**通る
 *   (happy-dom に両方とも無いので、確認の枝が素通りする)── だから
 *   **機械で塞ぐ**しかない。
 *
 * 🔑 捨てた理由を 3 つとも思い出せるように書いておく:
 * ① native のモーダルは**レンダラを止める**ので、CDP から見ると
 *    「画面が固まった」と区別が付かない(2026-08-21 に**存在しない P0** を 1 件
 *    追わせた)② Chromium の「このページにこれ以上ダイアログを表示させない」は
 *    **解除できない**(確認つき操作が全部 dead click になる)
 * ③ 確認の枝が **unit からも smoke からも一度も実行されなかった**
 */
describe('🔴 native のダイアログを使わない(#299)', () => {
  /**
   * ⚠ **コメントを落としてから見る。** この file の中だけでも、上の docstring に
   *   `window.confirm` と書いてある ── 落とさないと**自分の解説文に満たされて**
   *   必ず落ちる(CLAUDE.md §1 で 5 回踏んだ形)。
   * ⚠ 逆に「**在る**」ことの主張ではないので、拾い漏らすほうが危険 ──
   *   だから**呼び出しの形**(`(`)まで含めて狭く当てる。
   */

  const tsFiles = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) tsFiles(full, out);
      else if (name.endsWith('.ts')) out.push(full);
    }
    return out;
  };

  /**
   * 🔴 **門は 1 本の定数にする**(#299 段⑤。着地前レビュー R9)。
   *
   * ⚠ 直す前は、門の側と「空振りしていないか」を見る側が**別の正規表現リテラル**を
   *   持っていた ── 門を壊す変異(`\\s*\\)` を足して引数付きを拾えなくする等)を当てると
   *   **2 本とも緑**になる(CLAUDE.md §7「期待値側と実装側が別の式を持っている」)。
   * ⚠ そして `window.` しか見ていなかったので、**名前を変えるだけの戻し**を通していた ──
   *   TS では `confirm(msg)` / `globalThis.confirm(msg)` / `self.confirm(msg)` がすべて
   *   有効で、lint も黙る(型情報なしの eslint では `no-restricted-globals` が無い)。
   * ⚠ `prompt` も塞ぐ ── いま使っていないが、次に足すなら自前の器に足すべきである。
   */
  const NATIVE_DIALOG =
    /(?:window|globalThis|self)\.(?:confirm|alert|prompt)\s*\(|(?<![.\w$])(?:confirm|alert|prompt)\s*\(/g;

  it('🔴 src に native のダイアログの呼び出しが 1 つも無い', () => {
    const files = tsFiles('src');
    // ⚠ 空振り防止 ── そもそも file を読めていないなら、この検査は何も言っていない
    expect(files.length, 'src の TS を 1 つも読めていない').toBeGreaterThan(50);
    const hits: string[] = [];
    for (const f of files) {
      const code = stripComments(readFileSync(f, 'utf-8'));
      for (const m of code.matchAll(NATIVE_DIALOG)) hits.push(`${f}: ${m[0]}`);
    }
    expect(
      hits,
      `native のダイアログが戻っている(自前の app-dialog.ts を使うこと): ${hits.join(' / ')}`,
    ).toEqual([]);
  });

  /**
   * ⚠ **この検査自身が空振りしていないか**を見る ── 上の正規表現が
   *   「そもそも何にも当たらない書き方」になっていたら、戻されても気づけない。
   * 🔑 **門と同じ定数を使う**(別のリテラルを書いた瞬間、感度を測る意味が消える)。
   * 🔑 **当たるはずの形を全部並べる** ── 綴りを変えただけの戻しを 1 つずつ潰す。
   */
  it('検査そのものが空振りしていない(当たる形なら当たる)', () => {
    const shouldHit = [
      'const ok = window.confirm("x");',
      'const ok = globalThis.confirm("x");',
      'const ok = self.alert("x");',
      'const ok = confirm("x");',
      'const v = prompt("x");',
      'if (!confirm(message)) return;',
    ];
    for (const line of shouldHit)
      expect([...stripComments(line).matchAll(NATIVE_DIALOG)].length, `拾えない: ${line}`).toBe(1);

    // ⚠ 拾ってはいけない形(自前の器・受け渡しの名前・部分一致)
    const shouldMiss = [
      'const a = confirmInApp(root, "x");',
      'await alertInApp(root, "x");',
      'const ok = await deps.ask(message);',
      'const ok = await this.confirm(message);',
      'const deps = { ask: (m: string) => ask(m) };',
    ];
    for (const line of shouldMiss)
      expect([...stripComments(line).matchAll(NATIVE_DIALOG)].length, `誤検知: ${line}`).toBe(0);

    expect(
      stripComments('// window.alert("y") はコメント\n'),
      'コメントを落とせていない',
    ).not.toContain('window.alert');
  });

  /** ⚠ 自前の器が**実在する**こと(消してから検査だけ残さない)。 */
  it('自前の確認ダイアログが在る', () => {
    const dialog = readFileSync('src/adapter/ui/render/app-dialog.ts', 'utf-8');
    expect(dialog, '器が showModal を使っていない').toContain('showModal()');
    expect(dialog, '器が confirm を出す口を持っていない').toContain('export function confirmInApp');
    expect(dialog, '器が知らせる口を持っていない').toContain('export function alertInApp');
  });
});

/**
 * 🔴 **子プロセスの stderr を、親の画面へ漏らさない**(#558)。
 *
 * ⚠ `execFileSync` / `execSync` の既定は「**stderr は親へ素通り**」である
 *   (Node の doc: *stderr by default will be output to the parent process' stderr
 *   unless stdio is specified*)。⚠ **わざと異常終了させる test** はこの既定のせいで、
 *   緑のまま毎回 stderr へ ERROR を吐く。
 *
 * 🔴 **実害が出た**(2026-08-29):全スイートに常在した 2 行を
 *   「上流の錨が本当に外れた」証拠と読み、**存在しない不具合を起票して撤回した**。
 *   CLAUDE.md「**全スイートの stderr は 0 行を保つ**。1 行でも常在すると、
 *   本物のエラーがそこに紛れる」がこの形で効いた。
 *
 * 🔑 **もう 1 つ得がある** ── 既定のままだと `catch` の `err.stderr` は **null** なので、
 *   `out: stdout + stderr` と書いた helper が **stderr を 1 文字も返していなかった**
 *   (5 か所ともそうだった)。明示すると**検査の材料が戻る**。
 *
 * ⚠ **コメントを落とさない。** これは「**bare な呼び出しが無い**」という
 *   *無い* ことの主張なので、広く拾うほうが安全側である(codeOnly の docstring)。
 *   ⚠ そのぶん**行番号が原文どおり**になるので、落ちたとき指せる。
 */
describe('🔴 test が起こす子プロセスは stdio を明示する(#558)', () => {
  const CALL = /\b(execFileSync|execSync|spawnSync)\s*\(/g;

  /** 呼び出しの `(` から対応する `)` までを返す(素朴な括弧数え)。 */
  function callText(src: string, openParen: number): string {
    let depth = 0;
    for (let i = openParen; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') {
        depth -= 1;
        if (depth === 0) return src.slice(openParen, i + 1);
      }
    }
    return src.slice(openParen);
  }

  function sitesIn(src: string, file: string): { where: string; call: string }[] {
    return [...src.matchAll(CALL)].map((m) => ({
      where: `${file}:${src.slice(0, m.index).split('\n').length}`,
      call: callText(src, m.index + m[0].length - 1),
    }));
  }

  const sites = textFiles('tests')
    .filter((f) => f.endsWith('.ts'))
    .flatMap((f) => sitesIn(readFileSync(f, 'utf-8'), f));

  it('⚠ 前提: 走査が呼び出しを実際に拾っている(空振り防止)', () => {
    expect(sites.length, '子プロセスの呼び出しを 1 件も拾えていない').toBeGreaterThan(10);
  });

  it('🔴 どの呼び出しも stdio を書いている', () => {
    const bare = sites.filter((s) => !s.call.includes('stdio')).map((s) => s.where);
    expect(bare, `stdio を書いていない(子の stderr が画面へ漏れる): ${bare.join(' / ')}`).toEqual(
      [],
    );
  });

  /**
   * ⚠ 検査そのものが効くこと(括弧数えが壊れたら、この形を見逃す)。
   * 🔴 **見本の名前は組み立てる** ── 字面に置くと、この file 自身が
   *   「stdio の無い呼び出し」として自分の検査に引っかかる(実際 1 度引っかかった)。
   */
  it('⚠ 走査は stdio の有無を見分けられる', () => {
    const name = `exec${'File'}Sync`;
    const bare = `${name}('x', [], { encoding: 'utf-8' });`;
    expect(sitesIn(bare, 'f').length, '見本を拾えていない').toBe(1);
    expect(sitesIn(bare, 'f')[0]!.call.includes('stdio'), '無いのに在ると読んだ').toBe(false);
    const ok = `${name}('x', [], { encoding: 'utf-8', stdio: 'pipe' });`;
    expect(sitesIn(ok, 'f')[0]!.call.includes('stdio'), '在るのに無いと読んだ').toBe(true);
    // ⚠ 行番号は**原文の行**(コメントを落とさないので、ずれない)
    expect(sitesIn(`// a\n// b\n${bare}`, 'f')[0]!.where, '行番号がずれている').toBe('f:3');
  });

});

/**
 * 🔴 **smoke の spec が黙って消えないようにする**(2026-08-29 に実際に消した)。
 *
 * ## なぜ要るか
 *
 * ⚠ CLAUDE.md §9 は「**test file を切り落としても suite は緑になる**」を戒め、
 *   気づけたのは **test の件数**だけだった、と書いている。
 * 🔴 **ところがその件数は `npm test`(unit)のもので、smoke を 1 件も数えていない。**
 *   実際 2026-08-29 に、spec を 1 つ外すつもりで
 *   **その下に在った `#279` の test 66 行ごと**切り落としたが、
 *   `npm test` は **6966 件のまま緑**だった(気づいたのは lint の
 *   「import が使われていない」だけ ── 使っていた行を消したからである)。
 *
 * ## 🔑 数を実数で pin する
 *
 * ⚠ spec を足したらこの数を直す ── 直さないと落ちる = **忘れられない**
 *   (`KNOWN_DEAD` / `EXPECTED_ACTIONS` / お知らせの `KNOWN` と同じ作法)。
 * ⚠ **file 数も見る** ── 1 file を丸ごと消しても、他が増えていれば総数は合いうる。
 */
/**
 * 🔴 **状態の行の「器」に字を直接書かない**(#671、2026-09-04)。
 *
 * ⚠ この器は**字の span と、狭すぎる端末への断り書き(押す口つき)を子に持つ** ──
 *   `status.textContent = …` と書くと、**その子が丸ごと消える**。消えても
 *   例外は出ず、以後の知らせは**画面に出ないまま**になる(いちばん気づけない形)。
 * 🔑 書いてよいのは `statusText` の側だけである。
 */
describe('🔴 状態の行は器ではなく字の所に書く(#671)', () => {
  it('🔴 `status` の器へ textContent を書いている所が無い', () => {
    /**
     * ⚠ **`tests` も見る**(着地前レビュー B-3、2026-09-04)── 直す前は `src` だけを
     *   走査していたので、`tests/smoke/layout.smoke.spec.ts` に**同じ書き方が
     *   残っていた**(器を空にして子ごと消す)。CLAUDE.md「A を直した瞬間に
     *   B はどうかを grep する」。
     */
    const files = [...textFiles('src'), ...textFiles('tests')].filter((f) => f.endsWith('.ts'));
    // 空振り防止 ── 走査が壊れて 0 件になったら気づけない
    expect(files.length, 'src / tests の .ts を 1 件も引けない').toBeGreaterThan(50);
    /**
     * 🔴 **窓で見る**(1 稿目は範囲が広すぎた ── CLAUDE.md §1)。
     *
     * ⚠ 1 稿目は「器の綴り … 120 字以内 … `.textContent =`」という 1 本の正規表現で、
     *   `main.ts` の `regions.status.hidden = …` と、その **4 行下**の
     *   `regions.statusText.textContent = text`(**正しい書き方**)を
     *   1 つの一致として拾い、**直した当の file を不合格にした**。
     * 🔑 だから**行で見て、直前 3 行だけを窓にする**。⚠ そして
     *   **字の所を指す行は窓から外す**(`status-text` / `statusText` が正しい宛先)。
     */
    const HOLDER = /regions\.status\b|REGION\(['"]status['"]\)|\[data-pkc-region=["']status["']\]/;
    const TEXT_OK = /status-text|statusText/;
    const WRITE = /\.(?:textContent|innerHTML)\s*=/;
    const bad = files.filter((f) => {
      const lines = readFileSync(f, 'utf-8').split('\n');
      return lines.some((line, i) => {
        if (!WRITE.test(line)) return false;
        const win = lines.slice(Math.max(0, i - 3), i + 1);
        return win.some((l) => HOLDER.test(l)) && !win.some((l) => TEXT_OK.test(l));
      });
    });
    expect(bad, '器へ直接書いている(子の span と断り書きが消える)').toEqual([]);
  });
});

describe('🔴 smoke の spec は黙って消えない(2026-08-29)', () => {
  it('🔴 spec の file 数と test の件数が変わっていない', () => {
    const files = readdirSync('tests/smoke')
      .filter((f) => f.endsWith('.spec.ts'))
      .sort();
    const counts = files.map(
      (f) =>
        (readFileSync(`tests/smoke/${f}`, 'utf-8').match(/^\s*test(?:\.skip)?\(/gm) ?? []).length,
    );
    // 空振り防止 ── 数え方が壊れて 0 件になったら気づけない
    expect(counts.filter((n) => n === 0), 'test を 1 件も引けない spec がある').toEqual([]);
    // ⚠ 2026-08-31: `manual-window.smoke.spec.ts`(#645)で +1 file / +2 件
    // ⚠ 2026-09-02: 同 spec に F5 / 配色 / 印刷 / 当て直しの 4 件 + `portable-html` に
    //    about:blank の経路 1 件(#645 段②)で +5 件
    // ⚠ 2026-09-02: `split-frames` に「開き直しても留まったまま」1 件(#505 段② の hotfix)で +1 件
    // ⚠ 2026-09-02: `mod-click` に「畳んだ追記欄を開いてカーソル」1 件(#596 A/③)で +1 件
    // ⚠ 2026-09-02: `context-menu` に「メニューの下の説明欄」1 件(#587 C-3)で +1 件
    // ⚠ 2026-09-02: `context-menu` に「画面の端で開いても収まる」1 件(#587 C-3 の着地後
    //    レビュー ── clamp の分岐を一度も通していなかった)で +1 件
    // ⚠ 2026-09-02: `split-frames` に「幅で畳まれても帯の × で降ろせる」1 件
    //    (#584 / #633 段① ── unit では原理的に届かない)で +1 件
    // ⚠ 2026-09-02: `split-frames` に「幅は足りているのに畳んだと言わない」1 件
    //    (#633 段① ── 数え方の差は実ブラウザでしか出ない)で +1 件
    // ⚠ 2026-09-02: `phone` を新設(#632 段① ── スマホ用画面。重なった 3 面の
    //    見え方・押せるか・図の焼き直しは、実ブラウザでしか測れない)で file +1 / test +7
    // ⚠ 2026-09-02: 同 spec に「隠れた面も大きさを持ち続ける」1 件(変異試験が
    //    `visibility` → `display:none` を SURVIVED にしたので足した)で +1 件
    // ⚠ 2026-09-02: 同 spec に「お知らせは画面いっぱいに出て、今後は出さないで二度と
    //    出ない」1 件(user 裁定の**唯一の逃げ道**を端から端まで見る ── unit は
    //    `muteAnnounce` が呼ばれたことしか見ていなかった)で +1 件
    // ⚠ 2026-09-02: 同 spec に「← 一覧 で戻っても『ノートへ →』で帰れる」1 件
    //    (user 裁定。行が**押せる** = 一覧の面が最前面に居ることは実ブラウザでしか見えない)で +1 件
    // ⚠ 2026-09-03: `touch` を新設(#632 段② ── 触る端末の手当て。
    //    `@media (hover: none)` / `(pointer: coarse)` は happy-dom が評価しないので、
    //    **本当に当たっているか**は実ブラウザでしか分からない)で file +1 / test +7
    // ⚠ 2026-09-03: `timer` に「タブレットの縦(768px)でも 3 本ぶん押せる」1 件
    //    (#632 段② の着地前レビュー ── 3 本目が右端 868px / 窓 768 で押せなかった)で +1 件
    // ⚠ 2026-09-03: `phone` に「340px の断り書き」「360px ちょうどの対照群」
    //    「2 ペインは上下に積む」3 件、`print` に「A5(559px)の紙」1 件
    //    (#632 段③ ── どれも**解けた寸法**なので happy-dom では測れない)で +4 件
    // ⚠ 2026-09-03: `read-columns` に「スマホでは畳んでも理由を言わない」1 件
    //    (#632 段③ の対照群 ── 700px の腕がスマホ用画面に入ったので書き換えた)で +1 件
    // ⚠ 2026-09-03: `phone` に「横に持ったスマホでは積まない」1 件(#632 段③ の
    //    着地前レビュー ── 667×375 で積むと 6 行のうち 1 行しか出ない)で +1 件
    // ⚠ 2026-09-03: `phone` に「集中モードの鍵で見えない畳みが残らない」1 件
    //    (#632 段④ ── 害の本体は localStorage に残ることなので実ブラウザでしか見えない)で +1 件
    // ⚠ 2026-09-04(#671): `phone` の 2 ペインを書き直した ── 積む / 積まないの
    //    2 件を捨て、**向きで回す 1 本**(縦・横で同じ主張を確かめる)+
    //    **パソコンの対照群**(2 枚とも出たまま・行き先のボタンを出さない)にした
    // ⚠ 2026-09-04(#671): `phone` に「押さずに広げたら畳み、狭め直せばまた出る」
    //    1 件(OK で消す側の**対照群** ── これが無いと「一度出たら二度と出ない」
    //    実装が素通りする)。差し引き **+1 件**。
    // 🔴 ⚠ **数えているのは原文の `test(` であって、走る件数ではない** ──
    //    `for (const … ) { test(…) }` は**何本走っても 1 と数える**
    //    (`deep-link.smoke.spec.ts` が前からそう書いている)。
    //    🔑 この計器の主張は「**spec が黙って消えない**」であって
    //    「走った件数」ではない ── 消せば必ず減るので、その主張は成り立つ。
    // ⚠ 2026-09-04(#685 段②): `note-window.smoke.spec.ts` を足して **+1 file / +1 件**
    // ⚠ 2026-09-04(#685 動線レビュー 欠陥 1 / 3): 同じ file に **+2 件**
    //    ①お知らせを閉じずに押しても付箋にノートが出る ②付箋の中から押しても 2 枚目は出ない
    // ⚠ 2026-09-04(#685 着地前レビュー 🔴1): 同じ file に **+1 件**
    //    ③写した URL のタブでも付箋は開ける ④立ち上がる前の 2 度押しでも 1 枚(**+2 件**)
    //    ── 段①(リンクからノートを開く)と段②(別の窓で開く)は**別々に緑でも
    //    繋がっていなければ意味が無い**ので、繋がりを見る腕を 1 本置いた
    // ⚠ 2026-09-04(#690 ①): `center-scroll` に「別のノートを見てから戻ると、
    //    読んでいた場所から出る」**+1 件**(実レイアウトの丸めを挟んで戻ることは
    //    happy-dom では見えない)
    // ⚠ 2026-09-04(#690 ② A′ / I4): `note-window` に **+2 件**
    //    ①追記欄を畳んでいても付箋は追記欄つきで開き、畳んでも本体の記録は動かない
    //    ②付箋を開いた直後、カーソルは追記欄に在る ── どちらも `main.ts` の配線
    //    (`enterNoteWindow`)が呼ばれることを見るので、unit では届かない
    // ⚠ 2026-09-04(#648 段③): `portable-html.smoke.spec.ts` に **+1 件**
    //    (持ち歩ける 1 枚で選んだ配色が blob: の窓の地の色になる ── `file://` 由来の
    //    blob が localStorage に触れなくても、焼いた属性で届くことは実機でしか見えない)
    // ⚠ 2026-09-04(#687 D-1): `phone` に「行を 600ms 押し続けると印が 2 行」1 件
    //    (実ブラウザが指の押下を pointerType: 'touch' で届け、離した後の click を
    //    捨てるかは unit では見えない)で **+1 件**
    // ⚠ 2026-09-04(#693 案 A): 同じ file に **+1 件** ── 付箋で目次を押しても題名と
    //    住所が残る(本物のブラウザが断片を入れ替えて hashchange を撃つ所は unit で届かない)
    expect(files.length, 'smoke の spec file が増減した(足したらこの数を直す)').toBe(80);
    expect(
      counts.reduce((a, b) => a + b, 0),
      'smoke の test が増減した(足したらこの数を直す)',
    ).toBe(420);
  });
});

describe('\u{1f534} 生成物を追跡しない(2026-08-29)', () => {
  /**
   * \u{1f534} **`5cafa46` で `__pycache__/*.pyc` が 13 file 混入していた。**
   *
   * ⚠ `.gitignore` にも無かったので、**patch script を 1 度動かすだけで作業ツリーが
   * 汚れる**状態だった ── `git status` に常に出るので、
   * **本物の変更が雑音に埋もれる**(CLAUDE.md §9「自分と他人のツリーを壊さない」)。
   *
   * \u{1f511} **等値で 0 件を pin する**(「増えていない」ではなく「1 件も無い」)──
   * 件数で見ると、同じ数だけ別の生成物が入っても緑になる。
   */
  it('\u{1f534} Python の中間生成物(__pycache__ / *.pyc)が 1 件も追跡されていない', () => {
    const tracked = execFileSync('git', ['ls-files'], {
      encoding: 'utf-8',
      // ⚠ 子プロセスの stdio は明示する(#558)
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\n')
      .filter(Boolean);
    // 空振り防止 ── `git ls-files` が空を返したら、この検査は何も見ていない
    expect(tracked.length, 'git ls-files が空(この検査は何も見ていない)').toBeGreaterThan(100);
    const junk = tracked.filter((p) => p.includes('__pycache__/') || p.endsWith('.pyc'));
    expect(
      junk,
      '中間生成物が commit されている ── .gitignore に入れて git rm -r --cached すること',
    ).toEqual([]);
  });
});
