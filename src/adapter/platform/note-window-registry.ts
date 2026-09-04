/**
 * 🔴 **同じノートの付箋を 2 枚作らない**(#685、user 裁定 2026-09-04)。
 *
 * > 「**開いている窓が前に出る**(2 枚目は作らない)。違うノートなら今までどおり増える」
 *
 * ## なぜ「窓の名前」で済まないのか(2026-09-04 実測)
 *
 * ふつうは `window.open(url, 名前, …)` に**名前**を渡せばブラウザが窓を使い回す
 * (`manual-window.ts` がその形)。⚠ ところが **`noopener` を付けると名前は無視され、
 * 2 度目も新しい窓が開く**:
 *
 * | 開き方 | 2 度目に押すと | 戻り値 |
 * |---|---|---|
 * | 名前あり・`noopener` **なし** | **同じ窓を使い回す** | handle |
 * | 名前あり・`noopener` あり | **窓が増える** | null |
 *
 * 🔑 `noopener` は捨てられない ── あれが「閉じたら常駐が還る」(−32.2 MB / −4.6 MB)の
 * 根拠であり、user 不可侵指示「効くのは定常 / もっさりだと嫌」に直結する。
 * だから**こちらで台帳を持つ**。
 *
 * ## 作り
 *
 * - 付箋の窓は「いま自分はこのノートを出している」を放送する(`here`)
 * - どの窓もそれを聞いて `lid → 窓の id` の表を持つ
 * - 押したときは**その表を同期に読む** ── ⚠ ここで待つと
 *   `window.open` が gesture の外へ落ちてポップアップ遮断に当たる
 * - 出さないと決めたら「前に出て」と頼む(`raise`)
 *
 * ## ⚠ 「前に出る」は保証できない(2026-09-04、判定不能)
 *
 * headless では `document.hasFocus()` が**親子とも `true`** を返す(対照群が崩れる)ので、
 * `window.focus()` が実際に窓を手前へ出すかは**測れなかった**。
 * 分かったのは「例外を投げない」ことだけである。
 * 🔑 だから**画面に出す字で「前に出しました」とは言わない** ── 言えるのは
 * 「別のウィンドウで開いています」までである(実機で user が見て裁定する)。
 */
import type { Broadcaster } from './storage/store-proxy';

/** 放送路。⚠ store の protocol とも面の窓の合図とも**別にする**(混ぜない)。 */
export const NOTE_REGISTRY_CHANNEL = 'pkc3-note-window';

/** 便りの種別。⚠ 名前を付ける ── 将来この路に別の便りが乗っても取り違えない。 */
export const NOTE_HERE = 'note-window-here';
export const NOTE_GONE = 'note-window-gone';
export const NOTE_ROLL_CALL = 'note-window-roll-call';
export const NOTE_RAISE = 'note-window-raise';

interface Wire {
  readonly tag: string;
  readonly id: string;
  readonly lid?: string;
  readonly to?: string;
}

export interface NoteRegistryDeps {
  /** 放送路。⚠ `null` なら台帳は**常に空**(この窓では 2 枚目を止められない)。 */
  readonly channel: Broadcaster | null;
  /** この窓の id。⚠ 自分の放送を数えないために要る。 */
  readonly id: string;
  /** 「前に出て」と頼まれたときに呼ばれる。 */
  readonly onRaise: () => void;
  /** いまの時刻。⚠ test が動かせるように口にする(既定は `Date.now`)。 */
  readonly now?: () => number;
  /** 見込みが自然に外れるまで(既定 `RESERVE_MS`)。 */
  readonly reserveMs?: number;
  /** 点呼の答えを待つ時間(既定 `ANSWER_MS`)。 */
  readonly answerMs?: number;
}

/**
 * 点呼の答えを待つ時間。⚠ **同じ origin の窓が返すだけ**なので短くてよい
 * (放送は 1 タスク先で届く)。⚠ 短すぎると生きている窓を消し、
 * 長すぎると「消えた窓のせいで開けない」時間が延びる。
 */
export const ANSWER_MS = 1_500;

/**
 * 見込みを持ち続ける時間。⚠ **窓が名乗るまで**の猶予である ──
 * `startApp`(storage 初期化 + メタ一覧 + shell)が終わるまでを見込む。
 * ⚠ 長すぎると「閉じたのに開けない」、短すぎると「2 度押しで 2 枚」になる。
 */
export const RESERVE_MS = 10_000;

export interface NoteRegistry {
  /**
   * この窓がいま出している付箋のノートを伝える。`null` = 付箋ではない。
   * ⚠ **変わったときだけ放送する**(選択が動くたびに撒かない)。
   */
  announce(lid: string | null): void;
  /**
   * 🔴 **そのノートは、いまどこで開いているか**(#685 動線レビュー 欠陥 3、2026-09-04)。
   *
   * - `'self'` = **この窓**が出している
   * - `'other'` = 別の窓が出している
   * - `null` = どこにも無い(開いてよい)
   *
   * ⚠ 直す前は「別の窓が居るか」だけを返していたので、**付箋の中から
   *   同じノートに「別の窓で開く」を押すと 2 枚目が開いた** ── お知らせにもマニュアルにも
   *   「同じノートをもう一度押したときは、2 枚目を作りません」と**条件なしで**書いたのに、
   *   押した場所によって約束が成り立ったり成り立たなかったりしていた。
   * ⚠ そのうえ 2 枚並ぶと互いを台帳に載せるので、片方を閉じると本体の台帳から消えて
   *   **3 枚目も開けた**。
   * 🔑 同期に答える(gesture を割らない ── 待つと `window.open` が遮断される)。
   */
  whereIs(lid: string): 'self' | 'other' | null;
  /**
   * 🔴 **これから開く 1 枚を、先に取っておく**(#685 着地前レビュー ⚠7、2026-09-04)。
   *
   * ⚠ 付箋が名乗るのは **`startApp` が終わってから**(storage の初期化・メタ一覧・
   *   shell の組み立ての後)なので、**押した直後の数百 ms は台帳が空**である。
   *   塞がれたと思って 2 度押すと ── まさに「押した瞬間の返事」を足した当の場面 ──
   *   **同じノートの窓が 2 枚開く**。⚠ しかもその 2 枚は互いを台帳に載せるので、
   *   片方を閉じると行が消えて **3 枚目も開ける**。
   * 🔑 だから**開く側が見込みを先に載せる**。⚠ 開けなかったら `release` で外す。
   * ⚠ 万一どちらも呼ばれなかったときのために `ttlMs` で自然に外れる
   *   (`store-proxy.ts` が crash の保険に TTL を置いているのと同じ理屈)。
   */
  reserve(lid: string): void;
  /** 取っておいた 1 枚を外す(開けなかった)。 */
  release(lid: string): void;
  /**
   * その窓に「前に出て」と頼む。⚠ 居なければ何もしない。
   * 🔑 **同時に点呼も打つ**(#685 着地前レビュー、2026-09-04)── 相手が
   * `pagehide` を出さずに消えた(クラッシュ / OS kill / タブ破棄)ときの保険である。
   * 答えが返らなければ、次に聞かれたときに行を捨てて**開けるようにする**。
   */
  raise(lid: string): void;
  /**
   * 🔴 **窓を離れるときに呼ぶ**(台帳から自分を外す)。⚠ **放送路は閉じない**。
   *
   * ⚠ `pagehide` は **bfcache へ入るときにも飛ぶ**(この repo の実測 ──
   *   `window-close.ts`。そこで不可逆な後始末をして**アプリが真っ白になった**事故が
   *   記録されている)。⚠ 閉じてしまうと、戻ってきた窓は名乗れず、
   *   `postMessage` が `InvalidStateError` を投げる。
   * 🔑 `store-proxy.ts` と同じ形にする ── **便りを 1 通出すだけ**にして、
   *   誤発火しても壊れないようにする。
   */
  leave(): void;
  /** 配線を解く(放送路も閉じる)。⚠ `pagehide` では呼ばない ── 上の理由。 */
  close(): void;
}

/**
 * 🔴 **台帳を建てる。** ⚠ 建てた瞬間に**点呼**する ── 後から開いた窓が、
 * 先に居る付箋を知らないと「2 枚目を作らない」が効かない。
 */
export function createNoteRegistry(raw: NoteRegistryDeps): NoteRegistry {
  const deps = { now: () => Date.now(), reserveMs: RESERVE_MS, answerMs: ANSWER_MS, ...raw };
  /** `lid → 窓の id`。⚠ **自分は入れない**(自分の付箋は数えない)。 */
  const byLid = new Map<string, string>();
  let mine: string | null = null;

  /**
   * ⚠ **閉じた路への `postMessage` は `InvalidStateError` を投げる**(実測)。
   * 🔴 ここは state listener(`main.ts` の `announceNote`)から呼ばれるので、
   *   投げると **`dispatch` ごと落ちて `DomainEvent` が丸ごと消える**
   *   (`dispatcher.ts` の listener 呼び出しに try/catch は無い ── 保存の副作用が落ちる)。
   */
  const send = (w: Wire): void => {
    try {
      deps.channel?.postMessage(w);
    } catch {
      /* 閉じた路 ── 名乗る相手が居ない */
    }
  };

  /** これから開く 1 枚(合図が返るまでの見込み)。⚠ 値は外れる時刻。 */
  const pending = new Map<string, number>();
  /**
   * 🔴 **生死を聞いた窓と、聞いた時刻**(#685 着地前レビュー、2026-09-04)。
   *
   * ⚠ 付箋の窓が `pagehide` を出さずに消えると(クラッシュ / OS kill / タブ破棄)、
   *   台帳に行が残り続け、**そのノートは二度と窓で開けなくなる** ── しかも
   *   `raise` は誰にも届かないので**窓も出てこない**(= 断り文が嘘になる)。
   *   逃げ道は本体の読み直しだけだった。
   * 🔑 `raise` のときに点呼も打ち、`answerMs` 待って答えが無ければ行を捨てる。
   *   ⚠ **時計を回さない**(常駐の定期実行を作らない)── 次に聞かれたときに判る。
   * ⚠ 先例:`store-proxy.ts` が crash の保険に TTL を置いているのと同じ理屈。
   */
  const askedAt = new Map<string, number>();
  const alive = (lid: string): boolean => {
    const at = pending.get(lid);
    if (at === undefined) return false;
    if (deps.now() >= at) {
      pending.delete(lid);
      return false;
    }
    return true;
  };

  /** その行の窓は、まだ答える気があるか(上の `askedAt` の理由)。 */
  const answering = (lid: string): boolean => {
    const who = byLid.get(lid);
    if (who === undefined) return false;
    const asked = askedAt.get(who);
    if (asked === undefined || deps.now() < asked + deps.answerMs) return true;
    // ⚠ 聞いたのに答えなかった ── 消えた窓である
    askedAt.delete(who);
    drop(who);
    return false;
  };

  /** ⚠ 1 つの窓が出す付箋は 1 件 ── 前に載っていた行を必ず外す。 */
  const drop = (id: string): void => {
    for (const [lid, who] of [...byLid]) if (who === id) byLid.delete(lid);
  };

  if (deps.channel !== null) {
    deps.channel.onmessage = (ev: MessageEvent): void => {
      const w = ev.data as Wire | null;
      if (w === null || typeof w !== 'object' || typeof w.tag !== 'string') return;
      // ⚠ 自分の放送は数えない(自分の付箋で自分を止めない)
      if (w.id === deps.id) return;
      if (w.tag === NOTE_ROLL_CALL) {
        if (mine !== null) send({ tag: NOTE_HERE, id: deps.id, lid: mine });
        return;
      }
      if (w.tag === NOTE_HERE && typeof w.lid === 'string') {
        // ⚠ 答えたので生きている(聞いた記録を消す)
        askedAt.delete(w.id);
        drop(w.id);
        byLid.set(w.lid, w.id);
        // ⚠ 本物が名乗ったので、見込みは要らない(以後は台帳が持つ)
        pending.delete(w.lid);
        return;
      }
      if (w.tag === NOTE_GONE) {
        drop(w.id);
        return;
      }
      if (w.tag === NOTE_RAISE && w.to === deps.id) deps.onRaise();
    };
    send({ tag: NOTE_ROLL_CALL, id: deps.id });
  }

  return {
    announce: (lid) => {
      if (lid === mine) return;
      mine = lid;
      send(lid === null ? { tag: NOTE_GONE, id: deps.id } : { tag: NOTE_HERE, id: deps.id, lid });
    },
    whereIs: (lid) =>
      mine === lid ? 'self' : answering(lid) || alive(lid) ? 'other' : null,
    reserve: (lid) => pending.set(lid, deps.now() + deps.reserveMs),
    release: (lid) => void pending.delete(lid),
    raise: (lid) => {
      const to = byLid.get(lid);
      if (to === undefined) return;
      send({ tag: NOTE_RAISE, id: deps.id, to });
      // 🔑 生死も聞く(上の docstring)── 答えが返らなければ `alive` が行を捨てる
      askedAt.set(to, deps.now());
      send({ tag: NOTE_ROLL_CALL, id: deps.id });
    },
    leave: () => {
      send({ tag: NOTE_GONE, id: deps.id });
      // ⚠ **自分の名乗りだけ捨てる** ── 戻ってきたら `announce` が撃ち直せるように
      mine = null;
    },
    close: () => {
      send({ tag: NOTE_GONE, id: deps.id });
      // ⚠ 閉じたら**答えも捨てる** ── 残すと、戻ってきた窓が古い台帳で断り続ける
      byLid.clear();
      pending.clear();
      askedAt.clear();
      mine = null;
      deps.channel?.close();
    },
  };
}
