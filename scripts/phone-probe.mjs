#!/usr/bin/env node
/**
 * 🔴 **狭い窓で、何が押せなくなるかを数える**(#632 段⓪。user 裁定 2026-09-02「A」)。
 *
 * ## なぜ要るか
 *
 * #588 / #586 / #609 は「**狭い窓で押せない / 戻れない**」を別々の issue として
 * 積んできたが、**数で言えないと直したかどうかも言えない**。
 * ⚠ しかも 3 件とも**幅**の話として書かれていたのに、実測すると効いていたのは
 * **縦**だった(お知らせのカードが開いていると本文が 18px まで潰れる)──
 * 設計 doc `mobile-screen-design-2026-09.md` §2 で確定した事実である。
 *
 * 🔑 だから **直す前の表**をここで採る。段①(スマホ用画面の骨組み)を入れた後、
 *   同じ計器で採り直して**並べる**のがこの probe の役目である。
 *
 * ## ⚠ 型は `pane-escape-probe.mjs` から継いでいる(同じ罠を 2 度踏まない)
 *
 * 1. 🔴 **先にノートを 1 件作る** ── 0 件だと追記欄も情報ペインも出ないので、
 *    「押せない」が**製品の主張にならない**。
 * 2. 🔴 **面へスコープする** ── `document` 全体で数えると、お知らせのカードや
 *    編集の帯に満たされて「まだ押せる物が在る」に見える。
 * 3. 🔴 **対照群(1440×900)が崩れた回は、結果を読まない** ── そこで押せない物が
 *    在るなら、それは窓の狭さの話ではなく**計器か待ちの話**である。
 *
 * ## 🔴 「押せる」の判定は elementFromPoint(見えているだけでは足りない)
 *
 * ⚠ `getBoundingClientRect` が面積を持っていても、**別の物が上に重なっていれば
 *   押せない** ── #588 の実体がまさにそれ(編集帯の「保存」が追記欄に覆われる)。
 * 🔑 だから**中心の点を突いて、返ってきた要素が自分(か自分の子)か**を見る。
 *
 * ## 回し方
 *
 *   npm run build && npx vite preview --port 45732 &
 *   PKC3_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *     node scripts/phone-probe.mjs > /tmp/phone-before.json
 *
 * ⚠ **両方のブラウザで回す**(CI は `chromium_headless_shell`、手元は `chromium`)──
 *   採寸と重なりは実装が違いうる(CLAUDE.md §5)。
 */
import { chromium } from '@playwright/test';

const BASE = process.env.PROBE_BASE ?? 'http://127.0.0.1:45732';
const exe = process.env.PKC3_CHROMIUM;

/**
 * 🔴 **窓の一覧**(設計 doc §5 段⓪)。
 *
 * ⚠ **720 と 721 を両方入れる** ── 裁定 ①「幅 720px 以下はスマホ用画面」の
 *   **境目そのもの**を測るため。⚠ 768×1024(iPad 縦)は「境目の外側だが狭い」の代表で、
 *   ここが行き止まりなら境目の数字を見直す材料になる。
 * ⚠ 844×390 は**横向き**(高さが 390px しかない)── 縦の予算がいちばん厳しい形。
 */
const VIEWPORTS = [
  [360, 640],
  [375, 667],
  [390, 844],
  [480, 800],
  [720, 600],
  [721, 800],
  [768, 1024],
  [800, 600],
  [844, 390],
  // 🔑 **対照群** ── ここで押せない物が在るなら、結果は計器の話である
  [1440, 900],
];

/** 面ごとの高さ(px)。⚠ 出ていない面は 0(「無い」と「潰れた」を分けない ── 下で割合を見る)。 */
const PANES = {
  /**
   * ⚠ **左の列そのもの**を測る ── `entry-list` は**既定のタブでは出ない**ので、
   *   そちらだけ見ると**毎回 0** になり「測っていない次元」になる(1 稿目で踏んだ。
   *   CLAUDE.md §2「fixture のゼロ件の次元は測っていない次元」)。
   */
  左の列: '[data-pkc-region="sidebar"]',
  本文: '[data-pkc-region="detail"]',
  情報: '[data-pkc-region="inspector"]',
  追記: '[data-pkc-region="append"]',
  お知らせ: '[data-pkc-region="announce"]',
  /**
   * ⚠ **鍵の名前を「状態」にしない** ── 行の「閲覧 / 編集」と**同じ鍵**になり、
   *   後から広げるほうが**黙って上書き**する(1 稿目で実際に起き、閲覧と編集が
   *   同じ行に見えていた)。§7 の「同じ名前の別物」の型である。
   */
  状態の行: '[data-pkc-region="status"]',
};

/**
 * 🔴 **押せることを確かめる操作**(全数)。
 *
 * ⚠ 綴りで名指しする ── 「押せるボタンの総数」を数えると、お知らせのカードの
 *   ボタンに満たされて**行き止まりが見えなくなる**(#609 で実際に踏んだ型)。
 */
const MUST_PRESS = [
  'commit-edit', // 保存
  'cancel-edit', // やめる
  'start-edit', // 編集
  'toggle-pane', // 面を畳む / 戻す
  'open-palette', // 操作を探す
];

/** ⚠ 面積を持ち、`display`/`visibility` で消えていないものだけを対象にする。 */
const measure = `(panes, actions) => {
  const vh = window.innerHeight;
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (el === null) return 0;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
    return Math.round(r.height);
  };
  const heights = {};
  for (const [name, sel] of Object.entries(panes)) heights[name] = box(sel);

  /**
   * 🔴 **札ではなく、観測した事実を書く**(1 稿目で踏んだ)。
   *
   * ⚠ 「閲覧にしてから測る」段取りは、**狭い窓では押せなくて失敗する**
   *   (それがまさに測りたい現象である)。札だけ信じると
   *   「閲覧と書いてあるのに commit-edit が居る」行ができる。
   * 🔑 だから**画面に居るかどうか**で編集中を判定する ── 段取りが空振りした回も、
   *   表は嘘をつかない(CLAUDE.md §4「観測点は放っておいても変わるものにしない」)。
   */
  const found = {};
  for (const a of actions) {
    let n = 0;
    for (const el of document.querySelectorAll('[data-pkc-action="' + a + '"]')) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden') n += 1;
    }
    if (n > 0) found[a] = n;
  }

  /**
   * 🔴 押せるか = **中心の点を突いて、自分(か自分の子)が返るか**。
   * ⚠ 見えていても、上に重なっていれば押せない(#588 の実体)。
   */
  const blocked = [];
  let checked = 0;
  for (const action of actions) {
    for (const el of document.querySelectorAll('[data-pkc-action="' + action + '"]')) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width <= 0 || r.height <= 0 || cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (el.disabled === true) continue;
      checked += 1;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // ⚠ 画面の外に出ている物は「重なり」ではなく「届かない」── 別の理由として書く
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > vh) {
        blocked.push({ action, why: '画面の外', pane: el.getAttribute('data-pkc-pane') ?? '' });
        continue;
      }
      const hit = document.elementFromPoint(cx, cy);
      if (hit !== el && !el.contains(hit)) {
        blocked.push({
          action,
          why: '覆われている',
          覆っているもの:
            hit === null
              ? '(なし)'
              : (hit.closest('[data-pkc-region]')?.getAttribute('data-pkc-region') ?? hit.tagName),
        });
      }
    }
  }
  return { heights, vh, blocked, checked, found };
}`;

const browser = await chromium.launch(exe === undefined ? {} : { executablePath: exe });
const rows = [];
for (const [width, height] of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-pkc-region="shell"]', { timeout: 20000 });
  await page.waitForTimeout(500);
  /**
   * ⚠ 罠 1 ── ノートが 0 件だと追記欄も情報ペインも出ない。
   * 🔴 **段取りの押しは `force` にする**(1 稿目で詰まった)── 狭い窓では
   *   情報ペインが押し所を覆うので、**計器が測りたい現象そのもの**に段取りが
   *   引っかかる。⚠ 「押せるか」を判定するのは下の `elementFromPoint` 1 か所であって、
   *   ここの押しではない(段取りで測ってしまうと、窓ごとに台が変わる)。
   */
  await page.click('[data-pkc-field="create-pick"]', { force: true });
  await page.click('[data-pkc-region="create-menu"] [data-pkc-archetype="text"]', { force: true });
  await page.click('[data-pkc-field="create-run"]', { force: true });
  await page.waitForTimeout(800);
  // ⚠ 作った直後は編集に入っている ── 表の「閲覧」を作るために一度保存する
  const commit = page.locator('[data-pkc-action="commit-edit"]').first();
  if ((await commit.count()) > 0) await commit.click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);

  const snap = async (カード, 状態) => {
    const m = await page.evaluate(
      `(${measure})(${JSON.stringify(PANES)}, ${JSON.stringify(MUST_PRESS)})`,
    );
    rows.push({
      窓: `${width}x${height}`,
      カード,
      /**
       * ⚠ **頼んだ状態と、画面に出ていた操作の両方を残す**。
       * 🔑 1 稿目は「commit-edit が居れば編集中」と**決めつけて**全行「編集」と書いた
       *   ── 推測をやめて、**見つけた物をそのまま**書く(読み手が自分で判断できる)。
       */
      頼んだ画面: 状態,
      出ていた操作: m.found,
      ...m.heights,
      '本文の割合': `${Math.round((m.heights.本文 / m.vh) * 100)}%`,
      検めた数: m.checked,
      押せない: m.blocked,
    });
  };

  const cardOpen = async () =>
    (await page.locator('[data-pkc-region="announce"] [data-pkc-action="dismiss-announce"]').count()) > 0;

  for (const カード of ['開', '閉']) {
    if (カード === '閉' && (await cardOpen())) {
      await page.click('[data-pkc-region="announce"] [data-pkc-action="dismiss-announce"]', {
        force: true,
      });
      await page.waitForTimeout(400);
    }
    // ⚠ カードが最初から閉じている環境では「開」の行は採れない ── 採れないことを書く
    if (カード === '開' && !(await cardOpen())) {
      rows.push({ 窓: `${width}x${height}`, カード, 画面: '—', 判定不能: 'お知らせのカードが出ていない' });
      continue;
    }
    await snap(カード, '閲覧');
    const edit = page.locator('[data-pkc-action="start-edit"]').first();
    if ((await edit.count()) > 0) {
      await edit.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      await snap(カード, '編集');
      const back = page.locator('[data-pkc-action="cancel-edit"]').first();
      if ((await back.count()) > 0) await back.click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);
    }
  }
  await ctx.close();
}
await browser.close();

/**
 * 🔴 **対照群が崩れた回は、結果を読まない**(CLAUDE.md §4)。
 * ⚠ 空振り防止 ── 対照群の行が 0 なら、下の検査は**何も見ずに通る**。
 */
const control = rows.filter((r) => r.窓 === '1440x900' && r.押せない !== undefined);
if (control.length === 0) {
  console.error('⚠ 判定不能: 対照群(1440x900)の行が 1 つも無い');
  process.exit(2);
}
const brokenGauge = control.filter((r) => r.押せない.length > 0);
if (brokenGauge.length > 0) {
  console.error('⚠ 判定不能: 広い窓でも押せない物がある(窓の狭さの話ではない)');
  console.error(JSON.stringify(brokenGauge, null, 1));
  process.exit(2);
}
const empty = control.filter((r) => r.検めた数 === 0);
if (empty.length > 0) {
  console.error('⚠ 判定不能: 対照群で 1 つも検めていない(綴りが変わったか、描画待ちが足りない)');
  process.exit(2);
}
console.log(JSON.stringify(rows, null, 1));
