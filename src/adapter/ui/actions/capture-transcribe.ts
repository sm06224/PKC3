/**
 * 🔴 **録った音を文字にする段取り**(#772 段②。裁定 2026-10-01 ①②③ = 端末の中だけ /
 * 「音/動画」の行に 1 つ / そのノートの本文の末尾に追記)。
 *
 * ## 🔑 ここが持っている判断(重い所は部品側 ── ここは段取りだけ)
 *
 * - 🔴 **部品が無ければ、取り込みへ案内する**(押したのに無言、を作らない)。⚠ 案内の字は
 *   **画面に実在する名前から引く**(入口 = `viewModeLabel('settings')`、節 = `ASR_SECTION_LABEL`)。
 * - 🔴 **本文を上書きしない** ── 足すのは `APPEND_TO_ENTRY` の 1 本だけ(新しい書込経路を作らない)。
 *   見出し(日時)つきで**末尾に足す**ので、既にある説明は 1 文字も動かない。
 * - 🔴 **編集中は預かる**(`createWritableQueue`)── 文字にするのは数十秒かかるので、
 *   その間に user が編集に入ることは普通に起きる。「書けないから捨てる」にしない。
 *   ⚠ **書き先は録音のノート**を渡す(別のノートの編集中は待たせない ── #1081)。
 * - 🔴 **黙って終わらない** ── 失敗・無音・読めない音、どれも理由を出す。
 * - **2 本同時に走らせない**(重い。1.65〜3.6GB を 2 つ重ねない)。
 * - 🔑 **走っている間は押した行に出す**(`captureTranscribeLid`)── 長い録音は数分かかるので、
 *   ボタンが何も言わないと「効かなかった」と読まれて、もう一度押される。
 *
 * ⚠ **判定を `main.ts` へ出さない**(CLAUDE.md §2:あちらはどの test からも実行されない)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { viewModeLabel } from '@adapter/state/app-state';
import type { AsrJob, AsrJobResult } from '@adapter/platform/asr/asr-run';
import {
  ASR_LANGUAGE,
  ASR_PARTS,
  type AsrPart,
} from '@features/asr/asr-parts';
import {
  ASR_SECTION_LABEL,
  transcriptHeading,
  transcriptLines,
  transcriptText,
} from '@features/asr/asr-text';
import { looksOutOfMemory } from '@features/storage/image-export-limit';
import { elapsedText } from '@features/elapsed-text';
import { createWritableQueue } from './writable-queue';

/**
 * 🔴 **部品が無いとき、user に押させる場所を言う**。
 * ⚠ **字は画面から引く**(手で「システム」と書かない ── 入口の名前を変えた日に食い違う)。
 */
export function asrMissingText(): string {
  return `音声認識の一式がまだ取り込まれていません。${viewModeLabel('settings')} → ${ASR_SECTION_LABEL} で取り込んでください。`;
}

/** 端末に入っていて、実際に使える 1 つ(重みと実行の部品が揃っている)。 */
export interface AsrReady {
  readonly part: AsrPart;
  readonly files: ReadonlyMap<string, Blob>;
}

export interface CaptureTranscribeDeps {
  readonly dispatcher: Dispatcher;
  /** 元の bytes を読む口。⚠ `null` = 中身がもう無い。 */
  readonly readBlob: (assetKey: string) => Promise<Blob | null>;
  /** 16kHz mono の PCM へ(`asr-decode.ts`)。⚠ 読めなければ例外。 */
  readonly decode: (blob: Blob) => Promise<Float32Array>;
  /** 使える部品を 1 つ引く。⚠ 無ければ `null`(= 取り込みを案内する)。 */
  readonly ready: () => Promise<AsrReady | null>;
  /** 字にする(ワーカー)。⚠ 落ちたら例外。 */
  readonly transcribe: (job: AsrJob) => Promise<AsrJobResult>;
  /** 一時の知らせ(エラーの行とは別)。 */
  readonly notify: (text: string) => void;
  readonly now?: () => Date;
}

export interface CaptureTranscriber {
  run(lid: string): Promise<void>;
  readonly busy: boolean;
}

/**
 * 入っている部品のうち、どれで動かすか。
 * 🔑 **当たりやすい方を優先する**(両方入れた user は、より当たる方を選んだ人である)。
 *    ⚠ 並びは `ASR_PARTS` の逆順(= 後ろが重い)── 定数の側で並びを変えたら追随する。
 */
export function preferredPart(installed: ReadonlySet<string>): AsrPart | null {
  for (const p of [...ASR_PARTS].reverse()) if (installed.has(p.id)) return p;
  return null;
}

/**
 * 端末に入っている部品を、**使える形**で引く(`CaptureTranscribeDeps.ready` の実体)。
 *
 * 🔴 **判断をここへ寄せる** ── `main.ts` はどの test からも実行されない(§2)ので、
 * 「どの部品で動かすか」「揃っていなければ `null`」は `main.ts` に書かない。
 * ⚠ 壊れた・欠けた物は `readFilesFor` が理由つきで**投げる**(`null` にしない ── 「入っていない」と
 *   読まれると、取り込みを案内して**また同じ壊れた物を入れさせる**)。
 */
export function asrReadyFrom(store: {
  readInstalled(): Promise<{ parts: Readonly<Partial<Record<string, unknown>>> }>;
  readFilesFor(id: AsrPart['id']): Promise<Map<string, Blob> | null>;
}): () => Promise<AsrReady | null> {
  return async () => {
    const installed = await store.readInstalled().catch(() => ({ parts: {} as Record<string, unknown> }));
    const part = preferredPart(new Set(Object.keys(installed.parts)));
    if (part === null) return null;
    const files = await store.readFilesFor(part.id);
    return files === null ? null : { part, files };
  };
}

export function createCaptureTranscriber(deps: CaptureTranscribeDeps): CaptureTranscriber {
  let running = false;
  const queue = createWritableQueue(deps.dispatcher);
  const now = deps.now ?? ((): Date => new Date());
  const fail = (error: string): void => deps.dispatcher.dispatch({ type: 'OP_FAILED', error });
  const mark = (lid: string | null): void =>
    deps.dispatcher.dispatch({ type: 'SET_CAPTURE_TRANSCRIBE', lid });

  return {
    get busy(): boolean {
      return running;
    },
    async run(lid: string): Promise<void> {
      // ⚠ 2 本目は**断る**(黙って無視しない ── 押したのに何も起きないのと同じになる)
      if (running) {
        fail('いま別の録音を文字にしています。終わるまで待ってください。');
        return;
      }
      const item = (deps.dispatcher.getState().captureItems ?? []).find((i) => i.lid === lid);
      if (item === undefined || item.assetKey === null) {
        fail('この録音が見つかりませんでした。');
        return;
      }
      running = true;
      mark(lid);
      /**
       * 🔴 **進行中の字を出している間だけ true**(#1017 C5)。⚠ 直す前は、音を読めなかった・
       *   メモリが足りなかった等の失敗で「文字にしています…」が画面下に**残った**。
       *   失敗の出口は多いので、個々の枝ではなく **`finally` で 1 度だけ**消す。
       *   進行中のあとに言う字(結果・預かった)は `say` を通す ── 結果の知らせが進行中の欄を空にする
       *   (`status-lifetime.ts`。結果は進行中の終わりでもある)。
       */
      let progressShown = false;
      const say = (text: string): void => {
        progressShown = false;
        deps.notify(text);
      };
      try {
        const ready = await deps.ready();
        if (ready === null) {
          // 🔴 取り込みへ案内する(重い仕事は始めない)
          fail(asrMissingText());
          return;
        }
        const blob = await deps.readBlob(item.assetKey);
        if (blob === null) {
          fail('この録音の中身が見つかりませんでした。');
          return;
        }
        deps.notify(`「${item.name}」を文字にしています…(${ready.part.label}の一式)`);
        progressShown = true;
        const startedAt = Date.now();
        let pcm: Float32Array;
        try {
          pcm = await deps.decode(blob);
        } catch {
          fail('この音を読み取れませんでした(このブラウザが対応していない形かもしれません)。');
          return;
        }
        if (pcm.length === 0) {
          fail('この録音には音が入っていませんでした。');
          return;
        }
        const out = await deps.transcribe({
          files: [...ready.files],
          modelId: ready.part.modelId,
          language: ASR_LANGUAGE,
          pcm,
        });
        // 時刻つきの行があればそれ、無ければ今までの 1 段落(#1232 段 a)
        const text = transcriptLines(out.segments) ?? transcriptText(out.text);
        if (text === null) {
          say(`「${item.name}」からは字になりませんでした(声が小さい・無音かもしれません)。ノートは変えていません`);
          return;
        }
        const took = elapsedText(Date.now() - startedAt);
        /**
         * 🔴 **書き先は録音のノート** ── 渡して、「別のノートの編集中」は待たせない。
         * ⚠ 書けない間は預かる(捨てない)。預かったら**そう言う**。
         */
        const heading = transcriptHeading(now());
        const held = queue.push(() => {
          deps.dispatcher.dispatch({
            type: 'APPEND_TO_ENTRY',
            lid,
            text,
            heading,
            target: null,
          });
          say(`「${item.name}」に文字起こしを足しました(${took})`);
        }, lid);
        if (held) {
          say(`「${item.name}」の文字起こしは、編集を終えるまで足すのを待たせています。終えると、ノートの末尾に足します`);
        }
      } catch (e) {
        if (looksOutOfMemory(e)) {
          fail(
            `この端末のメモリが足りず、文字にできませんでした。ほかのタブを閉じるか、「${ASR_PARTS[0]!.label}」の一式でもう一度お試しください。`,
          );
        } else {
          fail(`文字にできませんでした(${e instanceof Error ? e.message : String(e)})`);
        }
      } finally {
        if (progressShown) deps.notify('');
        // ⚠ **必ず解く** ── 解かないと、1 度失敗しただけで以後ずっと断るようになる
        running = false;
        mark(null);
      }
    },
  };
}
