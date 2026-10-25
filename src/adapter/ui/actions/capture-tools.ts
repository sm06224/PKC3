/**
 * 🔴 **録ったものを仕上げる道具の実体**(`capture-process.ts` の `ToolRunner` を作る)。
 *
 * 道具ごとの「どのワーカーに何を頼み、結果をどう言うか」だけを持つ。段取り(2 本同時に走らせない・
 * 置き場・追記の預かり)は `capture-process.ts`。重い所はワーカー(`WorkerLease` 経由)で、ここは `Blob` を参照で渡す。
 *
 * ⚠ 判定を `main.ts` へ出さない(CLAUDE.md §2)── `main.ts` は口を渡すだけ。
 */
import type { VideoFoldResult } from '@adapter/platform/video/video-codec';
import { elapsedText } from '@features/elapsed-text';
import type { ProcessTool } from '@features/capture/capture-process';
import type { ToolRunner } from './capture-process';

export interface CaptureToolDeps {
  readonly foldStill: (blob: Blob) => Promise<VideoFoldResult>;
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
  return { 'fold-still': foldStill };
}
