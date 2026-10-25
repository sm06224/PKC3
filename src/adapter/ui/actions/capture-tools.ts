/**
 * 🔴 **録ったものを仕上げる道具の実体**(`capture-process.ts` の `ToolRunner` を作る)。
 *
 * 道具ごとの「どのワーカーに何を頼み、結果をどう言うか」だけを持つ。段取り(2 本同時に走らせない・
 * 置き場・追記の預かり)は `capture-process.ts`。重い所はワーカー(`WorkerLease` 経由)で、ここは `Blob` を参照で渡す。
 *
 * ⚠ 判定を `main.ts` へ出さない(CLAUDE.md §2)── `main.ts` は口を渡すだけ。
 */
import type { VideoFoldResult, VideoScenesResult } from '@adapter/platform/video/video-codec';
import { elapsedText } from '@features/elapsed-text';
import { canProcess, type ProcessTool } from '@features/capture/capture-process';
import { canTrimCapture } from '@features/capture/capture-trim-gate';
import { chaptersHeading, chaptersText, silenceChapterStarts } from '@features/capture/chapters';
import { ASR_SAMPLE_RATE } from '@features/asr/asr-parts';
import type { ToolRunner } from './capture-process';

export interface CaptureToolDeps {
  readonly foldStill: (blob: Blob) => Promise<VideoFoldResult>;
  /** 場面が変わる所(動画。ワーカー)。 */
  readonly scenes: (blob: Blob) => Promise<VideoScenesResult>;
  /** 16kHz mono の PCM へ(`asr-decode.ts`)。⚠ 読めなければ例外。 */
  readonly decode16k: (blob: Blob) => Promise<Float32Array>;
  readonly now: () => Date;
}

/** 動画の断り文(`webm-vp8.ts` の `VIDEO_TRIM_REFUSAL_TEXT` と同じ語り口)。 */
const FOLD_REFUSAL: Readonly<Record<string, string>> = {
  'nothing-to-fold': 'まとめられる静止区間がありませんでした(画面がずっと動いているか、短い区間しかありません)。新しい動画は作っていません。',
  'not-webm': 'この形の動画からはまだまとめられません。',
  'not-vp8': 'この動画は対応していない映像の形式です。',
  lacing: 'この動画は対応していない詰め方です。',
  timescale: 'この動画は対応していない時間の刻み方です。',
  'no-video': 'この動画には映像が入っていません。',
  'empty-range': 'この動画にはまとめられる中身がありません。',
  broken: 'この動画は途中までしか読めませんでした。',
};

export function createCaptureTools(deps: CaptureToolDeps): Partial<Record<ProcessTool, ToolRunner>> {
  const foldStill: ToolRunner = async ({ blob }) => {
    const out = await deps.foldStill(blob);
    if (!out.ok) return { kind: 'refused', text: FOLD_REFUSAL[out.reason] ?? 'まとめられませんでした。' };
    return {
      kind: 'attach',
      items: [{ tag: '静止区間をまとめた', blob: out.blob, mime: 'video/webm' }],
      summary: `静止している ${String(out.runs)} 区間(合計 ${elapsedText(out.foldedMs)}、映像 ${String(out.droppedFrames)} 枚)をまとめました`,
    };
  };

  /**
   * チャプター。動画は場面の変わり目(映像のフレームの大きさ。ワーカー)、場面が見つからない動画と音は無音の区切れ。
   * ⚠ 区切りは本文の末尾に足すだけ(いまある説明は 1 文字も変えない)。
   */
  const chapters: ToolRunner = async ({ item, blob }) => {
    let starts: number[] = [0];
    if (item.kind === 'video' && canTrimCapture(item)) {
      const r = await deps.scenes(blob);
      if (!r.ok) return { kind: 'refused', text: FOLD_REFUSAL[r.reason] ?? 'この動画は読めませんでした。' };
      starts = [...r.startsMs];
    }
    if (starts.length < 2 && canProcess(item, 'denoise')) {
      let pcm: Float32Array;
      try {
        pcm = await deps.decode16k(blob);
      } catch {
        return { kind: 'refused', text: 'この音を読み取れませんでした(このブラウザが対応していない形かもしれません)。' };
      }
      starts = silenceChapterStarts(pcm, ASR_SAMPLE_RATE);
    }
    if (starts.length < 2) {
      return {
        kind: 'refused',
        text: 'チャプターに分けられる所が見つかりませんでした(場面の変わり目も、2 秒以上の静けさもありません)。ノートは変えていません。',
      };
    }
    return {
      kind: 'note',
      heading: chaptersHeading(deps.now()),
      text: chaptersText(starts),
      summary: `${String(starts.length)} 件のチャプターを足しました`,
    };
  };
  return { 'fold-still': foldStill, chapters };
}
