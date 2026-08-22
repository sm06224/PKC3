/**
 * PKC3 計器: **アプリの継続使用**(P8 の UI 一式が入った状態の定常)。
 *
 * > user 指示 2026-08-03(不可侵)「**その後の動作がメモリくったり、もっさりだと
 * > 嫌なだけです**」/「測って報告すべきは配る量ではなく、**継続使用の常駐メモリ**と
 * > **操作の応答**である」
 *
 * 🔴 既存の `run-edit-session.mjs` は **storage core だけ**を測る(StoreClient を
 * 直に叩く)。P8 で入った描画・プレビュー・図のラスタ・ワーカー・ObjectURL は
 * **1 度も定常を測っていない** ── ここがその計器。
 *
 * ## 計測規律(PKC2 から継承)
 * - **persistent profile 必須**(ephemeral は storage がメモリバックで実 I/O を踏まない)
 * - **固定ポート**(origin が変わると毎回「初回起動」になる)
 * - **boot 窓で語らない** ── 最初の数ラウンドは暖機として捨て、そこから先の**傾き**を見る
 * - **ゼロ件次元を明記する** ── 下の FIXTURE がどの次元を持つかを出力に書く
 * - 差し引きは**向きのみ**信頼する(倍率は書かない)
 *
 * ## 何を出すか
 * - `attachPhase` … **添付を貼る操作**の詰まり(user が実機で気にした所)
 * - `pssMb` … 🔴 **ブラウザのプロセス木の常駐**(#114)。⚠ `heapMb` は**メインの
 *   realm だけ**なので、sqlite の wasm(storage worker)・ラスタ・OPFS proxy は
 *   そこに 1 バイトも出ない ── 「常駐メモリ」を語れるのはこちらである
 * - `heapMb` / `liveObjectUrls` / `domNodes` … 定常の**傾き**(前半 / 後半の中央値)
 * - `steadyPhase` … 定常の詰まり。⚠ `longtask` は **50ms 未満を落とす**ので、
 *   **心拍(4ms)の最大空き** `maxGapMs` を併せて見る
 *
 * 使い方(dist を preview で配ってから):
 *   npm run build && npx vite preview --port 45741 &
 *   node tests/bench/run-app-session.mjs --rounds=40 --attachments=6 --attachMb=2
 */
import { chromium } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { armFrom, seedEditorArm, fillBody } from './editor-arm.mjs';
import { listRowsSelector } from '../probe/browse-face.mjs';

/**
 * 🔴 **常駐はプロセス木で測る**(#114)。
 *
 * ⚠ `performance.memory.usedJSHeapSize` は**メインの realm の JS heap だけ**である。
 * PKC3 でいちばん大きい確保元 ── **sqlite の wasm リニアメモリ**は storage worker
 * の中に在るので、この計器は 2026-08-17 まで「継続使用の常駐メモリ」を謳いながら
 * **その本体を 1 バイトも見ていなかった**(worker / ラスタ / OPFS proxy も同様)。
 *
 * 🔑 見るのは **Pss**(共有ページを持ち主の数で割った量)。⚠ `VmRSS` は同じ共有
 * ページを**プロセスごとに数える**ので、プロセス数が変わる比較(まさに #114)では
 * **数が増えただけで常駐が増えたように見える**。両方出して、Pss を主にする。
 */
function readPpid(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm は空白も括弧も含みうるので **最後の `)` から**読む
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return null;
  }
}

/** そのプロセスの常駐(Pss / Rss)を KB で返す。 */
function memKb(pid) {
  try {
    const roll = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const pss = /^Pss:\s+(\d+) kB$/m.exec(roll);
    const rss = /^Rss:\s+(\d+) kB$/m.exec(roll);
    if (pss && rss) return { pss: Number(pss[1]), rss: Number(rss[1]) };
  } catch {
    /* smaps_rollup が無い環境は status へ落ちる */
  }
  try {
    const st = readFileSync(`/proc/${pid}/status`, 'utf8');
    const rss = /^VmRSS:\s+(\d+) kB$/m.exec(st);
    return rss ? { pss: 0, rss: Number(rss[1]) } : null;
  } catch {
    return null;
  }
}

/**
 * profile を握っているブラウザ本体の pid を引く。
 * ⚠ 子(renderer / gpu)は `--type=` を持つので外す ── 本体だけを根にする。
 */
function findBrowserPid(profileDir) {
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let cmd;
    try {
      cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (!cmd.includes(`--user-data-dir=${profileDir}`)) continue;
    if (cmd.includes('--type=')) continue;
    return Number(name);
  }
  return null;
}

/** ブラウザのプロセス木を全部足す(worker は renderer の中に居るので木で採る)。 */
function treeMemoryMb(rootPid) {
  const kids = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const ppid = readPpid(Number(name));
    if (ppid === null) continue;
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(Number(name));
  }
  let pss = 0;
  let rss = 0;
  let procs = 0;
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    const m = memKb(pid);
    if (m) {
      pss += m.pss;
      rss += m.rss;
      procs += 1;
    }
    for (const k of kids.get(pid) ?? []) queue.push(k);
  }
  return { pssMb: +(pss / 1024).toFixed(1), rssMb: +(rss / 1024).toFixed(1), procs };
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const PORT = Number(args.port ?? 45741);
const ROUNDS = Number(args.rounds ?? 40);
/** 暖機(boot と初回の遅延生成を定常に混ぜない)。 */
const WARMUP = Number(args.warmup ?? 8);
/**
 * 🔴 **どの編集面の定常を測るか**(#223)。既定は **live**(#172 で user が使う面に
 * なった)。⚠ `--arm=split` は 2026-08-14 以前の数字と並べたいときだけ使う ──
 * 打鍵が state へ届く経路そのものが違うので、**2 つの数字は連続していない**。
 */
const ARM = armFrom(process.argv);
const PROFILE = '/tmp/pkc3-app-session-profile';

/**
 * fixture の次元。⚠ **ゼロの次元は「測っていない次元」**なので明記する。
 * 図と添付を**必ず入れる**のは、そこが P8 で増えた確保元だから
 * (ラスタの PNG / ObjectURL / worker)。
 */
const ATTACH_MB = Number(args.attachMb ?? 2);
const ATTACHMENTS = Number(args.attachments ?? 6);

const FIXTURE = {
  notes: 12,
  withDiagram: 4,
  withTable: 4,
  /**
   * 🔴 **添付を抱えたセッションも測る**(段㉖)。前の版はここが 0 件で、
   * 「添付の定常は測っていない」と自分で書いていた ── ゼロ件の次元は
   * 測っていない次元なので、埋めた。
   *
   * ⚠ **bytes をゼロ埋めにしない** ── 内容アドレスで 1 件に畳まれ、
   *   「N 件ぶん抱えた」が嘘になる(実際に踏んだ)。
   * ⚠ **mime を `application/octet-stream` にしない** ── preview の分岐が
   *   `img/video/audio/pdf` 以外を「preview 無し」に落とすので、
   *   `lendObjectUrl` が**一度も呼ばれない**。ObjectURL の寿命を測る計器なのに、
   *   その経路をゼロ件にしていては測っていないのと同じ。画像にする。
   */
  attachments: ATTACHMENTS,
  attachmentMb: ATTACH_MB,
  attachmentMime: 'image/png',
  revisions: '編集のたびに増える(round 数ぶん)',
};

const DIAGRAM = '```mermaid\ngraph TD\n  A["始め"]-->B["途中"]\n  B-->C["終わり"]\n```\n';
const TABLE = '```csv\n品目,数\nりんご,120\nみかん,80\n```\n';

function body(i, rev) {
  const para =
    `パラグラフ ${i}-${rev}: PKC-Markdown の本文。**強調** と \`code\` を含む行を` +
    '繰り返して 1KB 級にする。\n';
  const extra = i % 3 === 0 ? DIAGRAM : i % 3 === 1 ? TABLE : '';
  return `# ノート ${i}(rev ${rev})\n\n${extra}\n${para.repeat(8)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    args: ['--js-flags=--expose-gc'],
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH
      ? { executablePath: '/opt/pw-browsers/chromium' }
      : {}),
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // 🔴 **どの worker script を取りに行ったか**を数える(#114 の構造の側)。
  // ⚠ 「常駐が減った」を主張するときは、**減った物の名前**が言えないといけない。
  //    ここが空のまま「差が出た」と言うのは、別の理由で動いた数字を読むのと同じ。
  const workerScripts = new Map();
  ctx.on('request', (req) => {
    const u = req.url();
    if (!/\/assets\/[^/?]*(worker|proxy)[^/?]*\.js/i.test(u)) return;
    const short = u.replace(/^https?:\/\/[^/]+/, '').replace(/-[0-9a-zA-Z_]{8}\.js/, '-*.js');
    workerScripts.set(short, (workerScripts.get(short) ?? 0) + 1);
  });

  // 🔴 常駐を採る根(ブラウザ本体の pid)。⚠ **見つからないまま 0 を出さない** ──
  //    「常駐 0MB」は「測れていない」の顔をしていない(いちばん危ない空振り)。
  const browserPid = findBrowserPid(PROFILE);
  if (browserPid === null) throw new Error(`profile ${PROFILE} を握るブラウザが /proc に居ない`);

  await seedEditorArm(page, ARM);   // ⚠ 最初の goto より前(#223)
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('[data-pkc-slot="root"][data-pkc-boot="ready"]', { timeout: 60000 });

  // 計器を仕込む(long task / ObjectURL の残高 / **心拍**)
  await page.addInitScript(() => {});
  await page.evaluate(() => {
    const w = window;
    w.__m = { long: 0, longMs: 0, made: 0, freed: 0, gapMs: 0 };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        w.__m.long += 1;
        w.__m.longMs += e.duration;
      }
    }).observe({ entryTypes: ['longtask'] });
    // 🔴 **心拍**(4ms)。`longtask` は **50ms 未満を落とす**ので、
    //    「6〜9ms ずつ細かく詰まる」型の詰まりを観測できない(実際に踏んだ)。
    //    ⚠ 見るのは平均ではなく**最大の空き**(= 一番長く返ってこなかった時間)。
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      if (now - last > w.__m.gapMs) w.__m.gapMs = now - last;
      last = now;
    }, 4);
    const mk = URL.createObjectURL.bind(URL);
    const fr = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (b) => {
      w.__m.made += 1;
      return mk(b);
    };
    URL.revokeObjectURL = (u) => {
      w.__m.freed += 1;
      fr(u);
    };
  });

  /** 区間の計測を始める(long task と心拍の最大空きを 0 に戻す)。 */
  const markStart = () =>
    page.evaluate(() => {
      const w = window;
      w.__m.gapMs = 0;
      return { long: w.__m.long, longMs: w.__m.longMs };
    });
  /**
   * 区間の結果(その区間で増えたぶん)。
   * ⚠ **先に 1 手番譲る** ── `PerformanceObserver` の callback は非同期に届くので、
   *   詰まった直後に読むと**その詰まりがまだ入っていない**(検品で実際に踏んだ:
   *   304ms の空きは見えているのに long task は 0 件だった)。
   */
  const markEnd = (base) =>
    page.evaluate(async (b) => {
      const w = window;
      await new Promise((r) => setTimeout(r, 50));
      return {
        longTasks: w.__m.long - b.long,
        longTaskMs: Math.round(w.__m.longMs - b.longMs),
        maxGapMs: Math.round(w.__m.gapMs),
      };
    }, base);

  // 🔴 **計器そのものを検品する**(空振り防止)。心拍が止まっていても
  //    `maxGapMs` は小さい値のまま出るので、「詰まっていない」と**嘘の結論**が出る。
  //    ⚠ 既知の詰まりを 1 度作って、**見えることを確かめてから**測る。
  const probe = await markStart();
  await page.evaluate(
    () =>
      // ⚠ **ページ自身が持つ手番の中で**詰まらせる。`page.evaluate` の本体を
      //   直に回しても `longtask` は 1 件も出ない ── debugger 由来の評価は
      //   frame の task として帰属されないため(検品で実際に踏んだ)。
      //   ここを直に書くと「long task が 0 件」を計器の欠陥ではなく
      //   アプリの美点だと**読み違える**。
      new Promise((resolve) => {
        setTimeout(() => {
          const end = performance.now() + 300;
          while (performance.now() < end);
          resolve();
        }, 0);
      }),
  );
  const probed = await markEnd(probe);
  if (probed.maxGapMs < 200 || probed.longTasks < 1) {
    throw new Error(`計器が既知の 300ms の詰まりを観測できていない: ${JSON.stringify(probed)}`);
  }

  // ⚠ 面は**名指ししない**(既定の一覧タブは入れ替わる ── `browse-face.mjs`)
  const attachRows = await listRowsSelector(page, 'attachment');

  // ── 添付を貼る ──
  // 🔴 ここは**計測する**。user が実機で気にしたのがこの操作
  //    (「添付とかでメインスレッドブロックするのは気になるね」)。
  // ⚠ **1 件ずつ違う bytes** ── 同じ bytes は content addressing で 1 件に
  //    畳まれ、「N 件抱えた」が嘘になる(実際に踏んだ)。
  // ⚠ 画像にするのは preview(= `lendObjectUrl`)を通すため。ノイズ画像は
  //    deflate が効かないので、生成 bytes が指定 MB におおよそ一致する。
  // ⚠ **bytes を作るのは計測の外**(対照群は「測りたい操作以外を全部同じにしたもの」)。
  //   ここを一緒に測ると、canvas のノイズ生成という**アプリと無関係な負荷**が
  //   「添付が詰まる」の数字に混ざる。作り置いてから、貼る操作だけを測る。
  const attachBytes = [];
  for (let a = 0; a < ATTACHMENTS; a++) {
    attachBytes.push(
      await page.evaluate(
        async ({ mb, seed }) => {
          const px = Math.ceil(Math.sqrt((mb * 1024 * 1024) / 3));
          const c = document.createElement('canvas');
          c.width = px;
          c.height = px;
          const ctx = c.getContext('2d');
          const img = ctx.createImageData(px, px);
          // 決定的だが件ごとに違う(乱数を使わない ── 再現性のため)
          let s = (seed * 2654435761 + 12345) >>> 0;
          for (let i = 0; i < img.data.length; i += 4) {
            s = (s * 1664525 + 1013904223) >>> 0;
            img.data[i] = s & 0xff;
            img.data[i + 1] = (s >>> 8) & 0xff;
            img.data[i + 2] = (s >>> 16) & 0xff;
            img.data[i + 3] = 255;
          }
          ctx.putImageData(img, 0, 0);
          const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
          (window.__fx ??= []).push(blob);
          return blob.size;
        },
        { mb: ATTACH_MB, seed: a },
      ),
    );
  }

  const attachMark = await markStart();
  for (let a = 0; a < ATTACHMENTS; a++) {
    await page.evaluate((seed) => {
      const input = document.querySelector('[data-pkc-field="attach-input"]');
      const dt = new DataTransfer();
      dt.items.add(new File([window.__fx[seed]], `att-${seed}.png`, { type: 'image/png' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, a);
    await page.waitForFunction(
      ({ sel, n }) => document.querySelectorAll(sel).length >= n,
      { sel: attachRows, n: a + 1 },
      { timeout: 60000 },
    );
  }
  const attachPhase = await markEnd(attachMark);
  // 作り置いた bytes は用済み ── 抱えたまま定常を測ると常駐が水増しされる
  await page.evaluate(() => {
    window.__fx = [];
  });

  // ── ノートを用意する(計測の外)
  for (let i = 0; i < FIXTURE.notes; i++) {
    await page.click('[data-pkc-action="create-entry"]');
    await page.fill('[data-pkc-field="editor-title"]', `ノート ${i}`);
    await fillBody(page, ARM, body(i, 0));
    await page.click('[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    await page.waitForSelector('[data-pkc-action="start-edit"]');
  }

  const sample = async () => {
    const m = await page.evaluate(() => {
      const w = window;
      const mem = performance.memory;
      return {
        heapMb: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
        live: w.__m.made - w.__m.freed,
        nodes: document.getElementsByTagName('*').length,
      };
    });
    // ⚠ heap は**メインの realm だけ**。worker(sqlite の wasm を含む)は木で採る
    return { ...m, ...treeMemoryMb(browserPid) };
  };

  const rows = [];
  const seen = { diagram: 0, table: 0, attachments: 0, attachmentPreviews: 0 };
  const noteRows = await listRowsSelector(page, 'text');
  // ⚠ **暖機を定常に混ぜない**。ここを loop の外で 1 度だけ立てると、初回の
  //   ラスタ生成(暖機で捨てているはずの窓)が定常の詰まりに混ざる ── 実際に踏んだ:
  //   混ざった版は最大の空きを 53ms と報告したが、暖機を外すと 28ms だった。
  //   ⚠ ヒープ / DOM の中央値は `r >= WARMUP` で正しく捨てていたので、
  //   **同じ計器の中で片方だけ規律が抜けていた**。
  let steadyMark = await markStart();
  for (let r = 0; r < ROUNDS; r++) {
    if (r === WARMUP) steadyMark = await markStart();
    const i = r % FIXTURE.notes;
    // 1 ラウンド = **添付を開く** → ノートを開く → 編集 → 打つ → 確定。
    // 🔴 添付を開く手を入れているのは、そこが `lendObjectUrl` の唯一の入口だから
    //    ── 一覧に並べるだけでは ObjectURL の寿命を 1 度も踏まない
    //    (= 「残高 0 のまま横ばい」が**自明に通ってしまう**)。
    if (ATTACHMENTS > 0) {
      await page.locator(attachRows).nth(r % ATTACHMENTS).click();
      await page.waitForSelector('[data-pkc-field="attachment-media"]', { timeout: 30000 });
      if (r >= WARMUP && r < WARMUP + ATTACHMENTS) {
        seen.attachmentPreviews += await page
          .locator('[data-pkc-field="attachment-media"]')
          .count();
      }
    }
    await page.locator(noteRows).nth(i).click();
    await page.waitForSelector('[data-pkc-action="start-edit"]');
    await page.click('[data-pkc-action="start-edit"]');
    await fillBody(page, ARM, body(i, r + 1));
    await sleep(600); // プレビューの静穏(500ms)を越えて 1 回描かせる
    await page.click('[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    await page.waitForSelector('[data-pkc-action="start-edit"]');
    if (r >= WARMUP) rows.push({ round: r, ...(await sample()) });
    if (r >= WARMUP && r < WARMUP + FIXTURE.notes) {
      // 🔴 **fixture がその次元を持っているか**を測定の中で確かめる
      //    (ゼロ件の次元は「測っていない次元」── CLAUDE.md)
      seen.diagram += await page
        .locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]')
        .count();
      seen.table += await page.locator('[data-pkc-field="detail-body"] table').count();
    }
  }
  const steadyPhase = await markEnd(steadyMark);

  // 定常の傾きを見る(前半 / 後半の中央値)
  const med = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  // ⚠ 数えるのは**添付の行だけ** ── 一覧全体の件数はノートだけで満たせるので、
  //   「添付を抱えている」の証拠にならない(代替物で満たせる条件を置かない)
  seen.attachments = await page.locator(attachRows).count();
  const half = Math.floor(rows.length / 2);
  const early = rows.slice(0, half);
  const late = rows.slice(half);
  const out = {
    fixture: FIXTURE,
    // ⚠ **実際に出た数**(0 なら、その次元は測れていない)
    observed: { ...seen, attachmentBytes: attachBytes },
    rounds: ROUNDS,
    arm: ARM,
    warmup: WARMUP,
    // ⚠ 計器の検品(既知の 300ms を見えたか)── ここが小さければ下の 0 は嘘
    instrumentProbe: probed,
    // 🔴 **添付を貼る操作そのもの**(user が実機で詰まりを感じた所)
    attachPhase,
    heapMb: { early: med(early.map((x) => x.heapMb)), late: med(late.map((x) => x.heapMb)) },
    // 🔴 **プロセス木の常駐**(#114)。⚠ `heapMb` はメインの realm だけなので、
    //    sqlite の wasm・worker・ラスタはこちらにしか出ない。主に見るのは `pssMb`。
    pssMb: { early: med(early.map((x) => x.pssMb)), late: med(late.map((x) => x.pssMb)) },
    rssMb: { early: med(early.map((x) => x.rssMb)), late: med(late.map((x) => x.rssMb)) },
    procs: { early: med(early.map((x) => x.procs)), late: med(late.map((x) => x.procs)) },
    // ⚠ 名前で言えるようにする(何本の worker script を取りに行ったか)
    workerScripts: Object.fromEntries([...workerScripts.entries()].sort()),
    liveObjectUrls: { early: med(early.map((x) => x.live)), late: med(late.map((x) => x.live)) },
    domNodes: { early: med(early.map((x) => x.nodes)), late: med(late.map((x) => x.nodes)) },
    steadyPhase,
    pageErrors: errors,
  };
  console.log(JSON.stringify(out, null, 2));
  await ctx.close();
}

await main();
