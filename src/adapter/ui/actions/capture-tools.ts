/**
 * 🔴 **録ったものを仕上げる道具の実体**(`capture-process.ts` の `ToolRunner` を作る)。
 *
 * 道具ごとの「どのワーカーに何を頼み、結果をどう言うか」だけを持つ。段取り(2 本同時に走らせない・
 * 置き場・追記の預かり)は `capture-process.ts`。重い所はワーカー(`WorkerLease` 経由)で、ここは `Blob` を参照で渡す。
 *
 * ⚠ 判定を `main.ts` へ出さない(CLAUDE.md §2)── `main.ts` は口を渡すだけ。
 */
import type { VideoFoldResult, VideoScenesResult } from '@adapter/platform/video/video-codec';
import type { ContactSheetResult } from '@adapter/platform/video/contact-sheet';
import { transcriptLinesOf, type TimedLine } from '@features/capture/contact-sheet-layout';
import { elapsedText } from '@features/elapsed-text';
import { canProcess, type ProcessTool } from '@features/capture/capture-process';
import { canTrimCapture } from '@features/capture/capture-trim-gate';
import { chaptersHeading, chaptersText, silenceChapterStarts } from '@features/capture/chapters';
import { ASR_SAMPLE_RATE } from '@features/asr/asr-parts';
import { VOICE_MAX_MS, VOICE_RATE } from '@features/audio/voice-lab';
import {
  speakerTranscript,
  speakerTranscriptHeading,
  speakersHeading,
  speakersText,
  speakerName,
} from '@features/capture/speakers';
import type { VoiceJob, VoiceRefusal, VoiceResult } from '@adapter/platform/voice/voice-run';
import type { ToolRunner } from './capture-process';

export interface CaptureToolDeps {
  readonly foldStill: (blob: Blob) => Promise<VideoFoldResult>;
  /** 場面が変わる所(動画。ワーカー)。 */
  readonly scenes: (blob: Blob) => Promise<VideoScenesResult>;
  /** 場面ごとの静止画 + 文字起こしの PNG(動画。ワーカー)。 */
  readonly contactSheet: (blob: Blob, lines: readonly TimedLine[], title: string) => Promise<ContactSheetResult>;
  /** 16kHz mono の PCM へ(`asr-decode.ts`)。⚠ 読めなければ例外。 */
  readonly decode16k: (blob: Blob) => Promise<Float32Array>;
  /** 48kHz mono の PCM へ(声の仕上げ用)。⚠ 読めなければ例外。 */
  readonly decode48k: (blob: Blob) => Promise<Float32Array>;
  /** 声の仕上げ(ワーカー)。⚠ `pcm` は譲る(transfer)。断る理由は値で返る。 */
  readonly voice: (job: VoiceJob) => Promise<VoiceResult>;
  readonly now: () => Date;
}

/** 声の仕上げが断る理由 → 画面の字。 */
const VOICE_REFUSAL: Readonly<Record<VoiceRefusal, string>> = {
  'no-encoder': 'このブラウザは音の書き出し(opus の符号化)に対応していないため、新しい音を作れません。',
  empty: 'この添付には音が入っていませんでした。',
  'encode-failed': '新しい音を書き出せませんでした。',
  silent: 'この添付はほぼ無音で、仕上げる音がありません。',
  'no-voice': '話し声が見つかりませんでした(声らしい音が入っていません)。',
  'no-engine': '声の仕上げのライブラリを読み込めませんでした。',
};

/** 声の仕上げの前処理:48kHz の PCM にして、長すぎる録音は断る。成功すれば PCM、失敗すれば断り文。 */
async function decodeForVoice(
  deps: CaptureToolDeps,
  blob: Blob,
): Promise<{ readonly pcm: Float32Array } | { readonly refused: string }> {
  let pcm: Float32Array;
  try {
    pcm = await deps.decode48k(blob);
  } catch {
    return { refused: 'この音を読み取れませんでした(このブラウザが対応していない形かもしれません)。' };
  }
  if (pcm.length > VOICE_MAX_MS * VOICE_RATE * 1e-3) {
    return { refused: '長すぎる録音は仕上げられません(30 分まで)。先に「この範囲で切り出す」で分けてください。' };
  }
  return { pcm };
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

  /**
   * コンタクトシート。場面ごとの静止画に、そのノートの文字起こし(時刻つきの行)があれば場面ごとに添える。
   * ⚠ 文字起こしが無くても作れる(絵と時刻だけ)。結果は新しい画像の添付(PNG)。
   */
  const contactSheet: ToolRunner = async ({ item, blob, readBody }) => {
    const body = await readBody();
    const lines = body === null ? [] : transcriptLinesOf(body);
    const out = await deps.contactSheet(blob, lines, item.name);
    if (!out.ok) {
      if (out.reason === 'no-codec') {
        return { kind: 'refused', text: 'このブラウザは動画の絵を取り出す仕組みを持っていないため、コンタクトシートを作れません。' };
      }
      if (out.reason === 'decode-failed') {
        return { kind: 'refused', text: 'この動画の絵を取り出せませんでした(このブラウザが対応していない形かもしれません)。' };
      }
      return { kind: 'refused', text: FOLD_REFUSAL[out.reason] ?? 'コンタクトシートを作れませんでした。' };
    }
    return {
      kind: 'attach',
      items: [{ tag: 'コンタクトシート', blob: out.blob, mime: 'image/png', ext: 'png' }],
      summary: `${String(out.scenes)} 場面のコンタクトシートを作りました${out.withText > 0 ? `(文字起こしを ${String(out.withText)} 場面に添えました)` : ''}`,
    };
  };

  /** 音の結果を新しい添付にする(拡張子は webm に替える)。 */
  const audioOutput = (r: Extract<VoiceResult, { kind: 'audio' }>, summary: string) =>
    ({
      kind: 'attach',
      items: r.files.map((f) => ({
        tag: f.tag,
        blob: new Blob([f.bytes], { type: 'audio/webm' }),
        mime: 'audio/webm',
        ext: 'webm',
      })),
      summary,
    }) as const;

  /**
   * 雑音を減らす(B1)。元は残し、結果を新しい音の添付にする。
   * 手法は RNNoise(48kHz・小さな再帰型 NN。モデルは wasm の中)。重い所はワーカー。
   */
  const denoise: ToolRunner = async ({ blob, progress }) => {
    const d = await decodeForVoice(deps, blob);
    if ('refused' in d) return { kind: 'refused', text: d.refused };
    progress('雑音を減らしています(ワーカーで処理)…');
    const r = await deps.voice({ op: 'denoise', pcm: d.pcm });
    if (!r.ok) return { kind: 'refused', text: VOICE_REFUSAL[r.reason] };
    if (r.kind !== 'audio') return { kind: 'refused', text: VOICE_REFUSAL['encode-failed'] };
    return audioOutput(r, '雑音を減らした音を作りました');
  };


  /**
   * 声と伴奏を分ける(#674・#949・#683②)。元は残し、「話し声」と「声以外」の 2 つの新しい音にする。
   * 手法は RNNoise の声の推定(声以外 = 元 − 声)── 話し声と背景の音楽・環境音を分ける用途向け。歌声と楽器の分離ではない。
   */
  const separate: ToolRunner = async ({ blob, progress }) => {
    const d = await decodeForVoice(deps, blob);
    if ('refused' in d) return { kind: 'refused', text: d.refused };
    progress('声とそれ以外を分けています(ワーカーで処理)…');
    const r = await deps.voice({ op: 'separate', pcm: d.pcm });
    if (!r.ok) return { kind: 'refused', text: VOICE_REFUSAL[r.reason] };
    if (r.kind !== 'audio') return { kind: 'refused', text: VOICE_REFUSAL['encode-failed'] };
    return audioOutput(r, '話し声と声以外の 2 つの音を作りました');
  };


  /**
   * 話者を分ける(B4・#949)。声の区間を見つけて特徴でまとめ、「## 話者」の節(話者が替わる時刻 + 名前)を本文の末尾に足す。
   * そのノートに時刻つきの文字起こしがあれば、話者を添えた「## 話者つき文字起こし」の節も足す。
   * ⚠ 手法は素朴な特徴(MFCC 平均 + 基本周波数)のクラスタリング ── 似た声は 1 人になりうる。あとから「話者を直す」で直せる。
   */
  const speakers: ToolRunner = async ({ blob, progress, readBody }) => {
    const d = await decodeForVoice(deps, blob);
    if ('refused' in d) return { kind: 'refused', text: d.refused };
    progress('話者を分けています(ワーカーで処理)…');
    const r = await deps.voice({ op: 'diarize', pcm: d.pcm });
    if (!r.ok) return { kind: 'refused', text: VOICE_REFUSAL[r.reason] };
    if (r.kind !== 'turns') return { kind: 'refused', text: VOICE_REFUSAL['encode-failed'] };
    const at = deps.now();
    const body = await readBody();
    const lines = body === null ? [] : transcriptLinesOf(body);
    const named = r.turns.map((t) => ({ ms: t.startMs, name: speakerName(t.speaker) }));
    const withText = speakerTranscript(named, lines);
    const text = `${speakersText(r.turns)}${withText === null ? '' : `\n\n${speakerTranscriptHeading(at)}\n${withText}`}`;
    return {
      kind: 'note',
      heading: speakersHeading(at),
      text,
      summary: `話者 ${String(r.speakers)} 人・${String(r.turns.length)} 区間の一覧を足しました${withText === null ? '' : '(話者つきの文字起こしも足しました)'}`,
    };
  };

  return { 'fold-still': foldStill, chapters, 'contact-sheet': contactSheet, denoise, separate, speakers };
}
