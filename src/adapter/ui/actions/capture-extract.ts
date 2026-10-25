/**
 * 🔴 **動画から音だけ / 絵だけを取り出す段取り**(#952 A1。Gemini 裁定済み = 作る。元の添付は残す)。
 *
 * 動画の行の「音だけ取り出す」「絵だけ取り出す」を押す → **一覧に新しい添付が 1 件増える**。
 * 作りは `capture-trim.ts`(録音・動画の切り出し)に揃えた:
 *
 * - **元を上書きしない** ── 作るのは新しい添付だけ。取り込み口は `attachOne` の 1 本(2 つ目を作らない)
 * - 🔴 **元の添付と同じフォルダへ入れる**(`image-draw.ts` と同じ `place`)。⚠ 読んでいるノートも選択も
 *   動かさない(`keepSelection`。#300 / #666 ── 取り出しただけで読んでいたノートが消えない)
 * - 🔴 **黙って終わらない** ── 取り出せない形・中身が消えている・本文に書けない・保存できない、
 *   どれも**理由を出す**。やり直しが安い(元は残っている)ので預からない
 * - **2 本同時に走らせない**(切り出しが走っている間も断る)
 * - 🔑 **走っている間は画面に出す**(長い動画は数秒かかる)
 * - 名前は元の名前 + 「(音だけ)」「(絵だけ)」(`extractedCaptureName`)。聞かない
 *
 * 🔑 **重い所はワーカー**(`AudioClient` / `VideoClient`)。ここは `Blob` を参照で渡すだけで、bytes を開かない。
 * ⚠ **判定を `main.ts` へ出さない**(CLAUDE.md §2:あちらはどの test からも実行されない)。
 */
import { captureBusyText, type CaptureJobGate } from './capture-job-gate';
import { errorText } from '@features/error-text';
import type { Dispatcher } from '@adapter/state/dispatcher';
import { elapsedText } from '@features/elapsed-text';
import { extractedCaptureName } from '@features/audio/trim-text';
import { canExtractFromVideo, type ExtractPart } from '@features/capture/capture-trim-gate';
import type { AudioTrimResult } from '@adapter/platform/audio/audio-codec';
import type { VideoPictureResult } from '@adapter/platform/video/video-codec';
import type { AttachItem, AttachedOne } from './attach';
import { canWriteBody } from './writable-queue';

/** 断る理由(音の取り出しと絵の取り出しの両方)。⚠ user が読む字なので内部の綴りを出さない。 */
const REFUSAL_TEXT: Readonly<Record<string, string>> = {
  'not-webm': 'この形の動画からはまだ取り出せません。',
  'not-opus': 'この動画は取り出しに対応していない音の形式です。',
  'not-vp8': 'この動画は取り出しに対応していない映像の形式です。',
  lacing: 'この動画は取り出しに対応していない詰め方です。',
  timescale: 'この動画は取り出しに対応していない時間の刻み方です。',
  'no-audio': 'この動画には音が入っていません。',
  'no-video': 'この動画には映像が入っていません。',
  'empty-range': 'この動画には取り出せる中身がありません。',
  broken: 'この動画は途中までしか読めませんでした。',
};

/**
 * 🔑 音だけのとき、`not-opus`(opus の音のトラックが見つからない)は「音が入っていない」動画でも「別の形式の音」の
 *   動画でも同じ理由で返る ── どちらか言い切ると片方で嘘になるので、**取り出せる音が無い**とだけ言う。
 */
const refusalText = (reason: string, part: ExtractPart): string =>
  part === 'audio' && reason === 'not-opus'
    ? 'この動画には取り出せる音が入っていません。'
    : (REFUSAL_TEXT[reason] ?? '取り出せませんでした。');

const BUSY_BODY_TEXT =
  'いま本文に書き込めないので、取り出したものを保存できません。編集を終えるか少し待ってから、もう一度押してください。';

export interface CaptureExtractDeps {
  readonly dispatcher: Dispatcher;
  /** 元の bytes を読む口。⚠ `null` = 中身がもう無い。 */
  readonly readBlob: (assetKey: string) => Promise<Blob | null>;
  /** 音だけを取り出す口(ワーカー)。⚠ 断る理由は**値で返る**(例外にしない)。 */
  readonly extractAudio: (blob: Blob) => Promise<AudioTrimResult>;
  /** 絵だけを取り出す口(ワーカー)。出力は `Blob`(元の部品を指す = コピーしない)。 */
  readonly extractPicture: (blob: Blob) => Promise<VideoPictureResult>;
  /** 添付(ノート)の置き場のフォルダ。ルートなら `null`。 */
  readonly parentOf: (lid: string) => string | null;
  /** bytes を添付にする口。⚠ **`attachOne` を通す**(2 つ目の取込口を作らない)。 */
  readonly attach: (
    item: AttachItem,
    place: { readonly parentLid: string | null; readonly keepSelection: boolean },
  ) => Promise<AttachedOne | null>;
  /** 一時の知らせ(エラーの行とは別)。 */
  readonly notify: (text: string) => void;
  /** 🔴 録ったものへの重い仕事を 1 本ずつにする門(両方向に断る)。省略 = 門なし(単体の test)。 */
  readonly gate?: CaptureJobGate;
}

export interface CaptureExtractor {
  /** 動画 `lid` から、音だけ / 絵だけを取り出して、新しい添付にする。 */
  run(lid: string, part: ExtractPart): Promise<void>;
  /** いま走っているか。 */
  readonly busy: boolean;
}

export function createCaptureExtractor(deps: CaptureExtractDeps): CaptureExtractor {
  let running = false;
  const fail = (error: string): void => deps.dispatcher.dispatch({ type: 'OP_FAILED', error });

  return {
    get busy(): boolean {
      return running;
    },
    async run(lid: string, part: ExtractPart): Promise<void> {
      // ⚠ 2 本目は**断る**(黙って無視しない ── 押したのに何も起きないのと同じになる)
      if (running || deps.dispatcher.getState().captureTrimBusy) {
        fail('いま別の取り出しか切り出しをしています。終わるまで待ってください。');
        return;
      }
      const item = (deps.dispatcher.getState().captureItems ?? []).find((i) => i.lid === lid);
      if (item === undefined || item.assetKey === null) {
        fail('この添付が見つかりませんでした。');
        return;
      }
      // 🔑 押せない形には押し所を出さないが、別のタブが古い一覧のまま押すこともある
      if (!canExtractFromVideo(item, part)) {
        fail('この形の動画からはまだ取り出せません。');
        return;
      }
      // 🔴 本文に書けない間は、重い仕事を始めない(数秒かけて取り出してから断らない)
      if (!canWriteBody(deps.dispatcher)) {
        fail(BUSY_BODY_TEXT);
        return;
      }
      // 🔴 切り出し・取り出し・文字起こし・仕上げは 1 本ずつ(どれが走っていても他を断る)
      const leaveGate = deps.gate?.tryEnter('取り出し');
      if (deps.gate !== undefined && leaveGate === null) {
        fail(captureBusyText(deps.gate.current));
        return;
      }
      running = true;
      deps.notify('取り出しています…');
      /** 🔴 完了の字を出したら true。⚠ 失敗の枝が多いので、進行中の字は `finally` で 1 度だけ消す。 */
      let finished = false;
      try {
        const blob = await deps.readBlob(item.assetKey);
        if (blob === null) {
          fail('この動画の中身が見つかりませんでした。');
          return;
        }
        let made: { blob: Blob; size: number; durationMs: number; mime: string };
        if (part === 'audio') {
          const out = await deps.extractAudio(blob);
          if (!out.ok) {
            fail(refusalText(out.reason, part));
            return;
          }
          made = {
            blob: new Blob([out.bytes], { type: 'audio/webm' }),
            size: out.bytes.byteLength,
            durationMs: out.durationMs,
            mime: 'audio/webm',
          };
        } else {
          const out = await deps.extractPicture(blob);
          if (!out.ok) {
            fail(refusalText(out.reason, part));
            return;
          }
          made = { blob: out.blob, size: out.blob.size, durationMs: out.durationMs, mime: 'video/webm' };
        }
        const name = extractedCaptureName(item.name, part);
        // 🔴 置き場は元の添付と同じフォルダ。⚠ 読んでいるノートも選択も動かさない
        const parentLid = deps.parentOf(lid);
        // ⚠ 空き容量が足りない等の理由は `attachOne` が先に出す ── 撃つ前の値を控え、変わっていたら残す
        const errorBefore = deps.dispatcher.getState().error;
        const attached = await deps.attach(
          {
            name,
            type: made.mime,
            size: made.size,
            blob: made.blob.type === made.mime ? made.blob : made.blob.slice(0, made.blob.size, made.mime),
          },
          { parentLid, keepSelection: true },
        );
        if (attached === null) {
          if (deps.dispatcher.getState().error === errorBefore) {
            fail(canWriteBody(deps.dispatcher) ? '取り出したものを保存できませんでした。' : BUSY_BODY_TEXT);
          }
          return;
        }
        /**
         * 🔴 **一覧を集め直す**(`capture-trim.ts` と同じ)。⚠ この一覧は開いた瞬間に 1 度集めるだけで
         *   `CREATE_ENTRY` を見ていない ── 集め直さないと「押したのに何も起きない」と読める。
         */
        deps.dispatcher.dispatch({ type: 'REFRESH_CAPTURE_SCAN' });
        finished = true; // ⚠ 次の「取り出しました」が進行中の欄を空にする(`status-lifetime.ts`)
        deps.notify(`取り出しました:「${name}」(${elapsedText(made.durationMs)})`);
      } catch (e: unknown) {
        fail(`取り出せませんでした(${errorText(e)})`);
      } finally {
        if (!finished) deps.notify('');
        // ⚠ **必ず解く** ── 解かないと、1 度失敗しただけで以後ずっと断るようになる
        running = false;
        leaveGate?.();
      }
    },
  };
}
