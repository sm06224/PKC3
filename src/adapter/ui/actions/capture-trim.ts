/**
 * 🔴 **録った音の前後を削る段取り**(#683 段②a。user 裁定 2026-09-14)。
 *
 * > 録った音の前後を削ったら、**元と同じ形(opus)で保存する**。
 * > 切り出した結果は**新しい添付として 1 つ増え**、元のものは残る。
 *
 * 聞きながら「ここから」「ここまで」を押す → 「切り出す」→ **一覧に 1 件増える**。
 *
 * ## 🔑 ここが持っている判断(`webm-opus.ts` は「切るだけ」)
 *
 * - **元を上書きしない**(裁定)── 作るのは新しい添付だけ
 * - 🔴 **さっきまで見ていたノートを退かさない**(#300 / #666 と同じ)── `CREATE_ENTRY` は
 *   **選択を作った添付へ移す**ので、放っておくと「録音を切っただけなのに、読んでいた
 *   ノートが画面から消える」になる。🔑 だから**返す**(`asset-into-note.ts` と同じ作法)
 * - 🔴 **黙って終わらない** ── 切り出せない形・中身が消えている・**編集している最中**・
 *   添付にできない、どれも**理由を出す**(押したのに無言、を作らない)
 * - **2 本同時に走らせない** ── 12 時間の録音を 2 本ほどくと箱が詰まる
 * - 🔑 **走っている間は画面に出す** ── 長い録音は数秒かかるので、押した所が
 *   何も言わないと「効かなかった」と読まれる
 *
 * ⚠ **取り込み口は `attachOne` の 1 本**(`attach` として注入する)── 2 つ目を作らない。
 * ⚠ **判定を `main.ts` へ出さない**(CLAUDE.md §2:あちらはどの test からも実行されない)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { TRIM_REFUSAL_TEXT } from '@features/audio/webm-opus';
import { trimmedCaptureName } from '@features/audio/trim-text';
import { elapsedText } from '@features/elapsed-text';
import type { AudioTrimResult } from '@adapter/platform/audio/audio-codec';
import type { AttachItem, AttachedOne } from './attach';
import { canWriteBody } from './writable-queue';

/**
 * 🔴 **いま本文に書き込めないときの断り文**(#683 段②a、着地前の動線レビュー 欠陥 2)。
 *
 * ⚠ 直す前は「切り出したものを保存できませんでした。」だけだった ── `CREATE_ENTRY` は
 *   **`phase !== 'ready'` を黙って捨てる**ので、**編集している最中**は必ずこれが出る。
 *   ⚠ その字は「録音の処理が壊れた」と読めるので、user は**原因(自分が編集中である
 *   こと)に気づけない**。
 * 🔑 **やり直しが安い**ので預からない(録音そのものとは違う ── 元の録音は残っているので、
 *   編集を終えてもう一度押せば同じものが作れる)。⚠ だから**印は消さない**。
 * ⚠ **「編集中」と言い切らない**(着地前レビュー 2-A)── `canWriteBody` は
 *   `phase` だけでなく**追記の短い錠**でも `false` になる。そこで「編集を終えてから」
 *   とだけ書くと、**何も編集していない user**に嘘を言うことになる。
 */
const BUSY_BODY_TEXT =
  'いま本文に書き込めないので、切り出したものを保存できません。編集を終えるか少し待ってから、もう一度押してください(選んだ範囲は残しています)。';

export interface CaptureTrimDeps {
  readonly dispatcher: Dispatcher;
  /** 元の bytes を読む口。⚠ `null` = 中身がもう無い。 */
  readonly readBlob: (assetKey: string) => Promise<Blob | null>;
  /** 切る口(ワーカー)。⚠ **断る理由は値で返る**(例外にしない)。 */
  readonly trim: (blob: Blob, startMs: number, endMs: number) => Promise<AudioTrimResult>;
  /** bytes を添付にする口。⚠ **`attachOne` を通す**(2 つ目の取込口を作らない)。 */
  readonly attach: (item: AttachItem) => Promise<AttachedOne | null>;
  /** 一時の知らせ(エラーの行とは別)。 */
  readonly notify: (text: string) => void;
}

export interface CaptureTrimmer {
  /** 範囲を切り出して、新しい添付にする。 */
  run(lid: string, startMs: number, endMs: number): Promise<void>;
  /** いま走っているか(描画が「切り出しています…」を出すための観測点)。 */
  readonly busy: boolean;
}

export function createCaptureTrimmer(deps: CaptureTrimDeps): CaptureTrimmer {
  let running = false;
  const fail = (error: string): void => deps.dispatcher.dispatch({ type: 'OP_FAILED', error });
  /**
   * 🔴 **走っていることを画面へ出す**(着地前の動線レビュー 欠陥 3)。
   * ⚠ **state に置く** ── 描画器は同じ document に 2 つ生きうるので、
   *   ここで覚えると片方の面だけ「切り出しています…」になる(§7)。
   */
  const mark = (busy: boolean): void =>
    deps.dispatcher.dispatch({ type: 'SET_CAPTURE_TRIM_BUSY', busy });

  return {
    get busy(): boolean {
      return running;
    },
    async run(lid: string, startMs: number, endMs: number): Promise<void> {
      // ⚠ 2 本目は**断る**(黙って無視しない ── 押したのに何も起きないのと同じになる)
      if (running) {
        fail('いま別の切り出しをしています。終わるまで待ってください。');
        return;
      }
      const items = deps.dispatcher.getState().captureItems ?? [];
      const item = items.find((i) => i.lid === lid);
      if (item === undefined || item.assetKey === null) {
        fail('この録音が見つかりませんでした。');
        return;
      }
      if (!(endMs > startMs)) {
        fail('切り出す範囲を「ここを始まりにする」「ここを終わりにする」で決めてください。');
        return;
      }
      /**
       * 🔴 **本文に書けない間は、重い仕事を始めない**(動線レビュー 欠陥 2)。
       * ⚠ ここで止めないと、**数秒かけて切ってから断る**ことになる。
       * 🔑 判定は `canWriteBody` の 1 か所(呼び側で `phase` を数えない)。
       */
      if (!canWriteBody(deps.dispatcher)) {
        fail(BUSY_BODY_TEXT);
        return;
      }
      running = true;
      mark(true);
      deps.notify('切り出しています…');
      try {
        const blob = await deps.readBlob(item.assetKey);
        if (blob === null) {
          fail('この録音の中身が見つかりませんでした。');
          return;
        }
        const cut = await deps.trim(blob, startMs, endMs);
        if (!cut.ok) {
          fail(TRIM_REFUSAL_TEXT[cut.reason]);
          return;
        }
        const name = trimmedCaptureName(item.name, startMs, endMs);
        /**
         * ⚠ **引数を落とす**(着地前レビュー 2-B)── `;codecs=opus` のまま持ち回ると、
         *   拡張子の逆引きに当たらず**書き出しの名前が `.bin` になる**(#205 と同じ形。
         *   `capture.ts` が録音の取り込みで同じことをしている)。
         */
        const mime = item.mime.split(';')[0]!.trim();
        /**
         * 🔴 **直前に採る**(動線レビュー 欠陥 1)。⚠ 押した時点ではなく**ここ**である ──
         *   切るのに数秒かかるので、その間に user が別のノートを開いていることがある。
         */
        const back = deps.dispatcher.getState().selectedLid;
        /**
         * 🔴 **`attachOne` が先に置いた理由を消さない**(着地前レビュー 1-A)。
         *
         * ⚠ 空き容量が足りない等で落ちると、`attachOne` は**自分で `OP_FAILED` を
         *   撃ってから** `null` を返す。⚠ `OP_FAILED` は `state.error` を**無条件に
         *   上書き**するので、そのまま汎用の断り文を撃つと
         *   **「空き容量が足りません」が user の目に一度も触れずに消える**。
         * 🔑 だから**撃つ前の値を控え**、変わっていたら**そちらを残す**。
         */
        const errorBefore = deps.dispatcher.getState().error;
        const attached = await deps.attach({
          name,
          // 🔑 **元と同じ形**(裁定)── 入れ物も codec も変えないので mime も変えない
          type: mime,
          size: cut.bytes.byteLength,
          blob: new Blob([cut.bytes], { type: mime }),
        });
        if (attached === null) {
          // 🔑 具体的な理由が既に出ていれば、それを残す(汎用の字で塗り潰さない)
          if (deps.dispatcher.getState().error === errorBefore) {
            // ⚠ 切っている間に編集へ入られると、ここで捨てられる ── 原因を言い分ける
            fail(canWriteBody(deps.dispatcher) ? '切り出したものを保存できませんでした。' : BUSY_BODY_TEXT);
          }
          return;
        }
        /**
         * 🔴 **開いていたノートへ返す**(`asset-into-note.ts` と同じ作法)。
         * ⚠ **何も開いていなかったなら、何も開いていない所へ返す** ── `null` を
         *   「撃たない」にすると、中央が**切り出したばかりの添付**に化ける(#684 ㋑ と同じ形)。
         */
        if (back === null) deps.dispatcher.dispatch({ type: 'DESELECT_ENTRY' });
        else if (back !== attached.lid) deps.dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: back });
        // 🔑 印は消す ── 同じ範囲をもう一度押して**同じものを 2 つ**作らせない
        deps.dispatcher.dispatch({ type: 'CLEAR_CAPTURE_TRIM' });
        /**
         * 🔴 **一覧を集め直す**(#683 段②a、着地前の実ブラウザ smoke が拾った)。
         *
         * ⚠ この面の一覧(`captureItems`)は**タブを開いた瞬間に 1 度**集めるだけで、
         *   `CREATE_ENTRY` を見ていない ── だから**切り出したものが一覧に出ない**。
         *   🔴 user から見ると「**押したのに何も起きなかった**」と読める
         *   (実体は在るのに、在るはずの場所に出ない = いちばん気づけない壊れ方)。
         * ⚠ `SYS_BOOTED` の枝は集め直すが、あれが飛ぶのは**別タブが書いたとき**である。
         */
        deps.dispatcher.dispatch({ type: 'REFRESH_CAPTURE_SCAN' });
        deps.notify(`切り出しました:${name}(${elapsedText(cut.durationMs)})`);
      } catch (e: unknown) {
        fail(`切り出せませんでした(${String(e)})`);
      } finally {
        // ⚠ **必ず解く** ── 解かないと、1 度失敗しただけで以後ずっと断るようになる
        running = false;
        mark(false);
      }
    },
  };
}
