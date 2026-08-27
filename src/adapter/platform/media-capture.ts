/**
 * 🔴 **録音・画面収録**(#413)。
 *
 * > user 要望 2026-07-16(PKC2 #922):
 * > 「**録音と画面収録をマルチメディアで埋め込めるようにする / これで、
 * > 会議メモをうまく残せるはず**」
 *
 * ## 🔴 PKC2 はここで壊れていた ── PKC3 はその原因を持っていない
 *
 * PKC2 は blob → **base64** → container 全体の JSON 保存でメモリが多段に増幅し、
 * 100MB 級の収録で**タブごと落ちて全損**していた(user 報告 2026-07-21)。
 *
 * 🔑 ここは **`Blob` の断片を配列に積むだけ**である ── ブラウザの `Blob` は
 *   bytes を **JS heap の外**に置くので、積んでも heap は増えない。
 *   最後に `new Blob(chunks)` で 1 本にして、そのまま IDB へ渡す
 *   (`attachOne` の口を通す ── 2 つ目の取り込み口を作らない)。
 * ⚠ **base64 にしない**(不可侵指示 2026-07-27「ゼロコピー」)。
 *
 * ## ⚠ ここは adapter である
 *
 * `MediaRecorder` / `getUserMedia` はブラウザの口なので `features/` に置けない。
 * 🔑 代わりに**口を注入できる形**にしてある ── そうしないと
 *   「実ブラウザでしか確かめられない」= 壊れても間欠の赤でしか気づけない。
 */

/** どちらを録るか。 */
export type CaptureKind = 'audio' | 'screen';

/**
 * 収録が終わった理由。⚠ **黙って終わらない** ── どれも user に見える。
 *
 * ⚠ `discarded`(捨てた)を**別の値にしてある**のは、受け側が
 *   「取り込む / 取り込まない」を**理由で**分けられるようにするため ──
 *   同じ `stopped` にすると、捨てたのに本文へ参照が入る。
 */
export type CaptureEnd = 'stopped' | 'shared-ended' | 'too-large' | 'discarded';

export interface CaptureHandle {
  readonly kind: CaptureKind;
  /** いま何バイト積んだか(概算 ── 帯に出す)。 */
  bytes(): number;
  /** 何ミリ秒経ったか。 */
  elapsedMs(): number;
  /** 止めて、それまでの分を返す。⚠ **1 バイトも録れていなければ `null`**。 */
  stop(): Promise<Blob | null>;
  /** 捨てる(bytes を手放す)。⚠ 止めた後に呼んでも安全。 */
  discard(): void;
}

/** 差し替えられる口(test はここに fake を入れる)。 */
export interface CaptureDeps {
  readonly getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  readonly getDisplayMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  /** ⚠ `MediaRecorder` そのもの(test は fake を渡す)。 */
  readonly Recorder?: typeof MediaRecorder;
  readonly now?: () => number;
}

export interface CaptureOptions {
  /**
   * 🔴 **これを超えたら自動で止める**(それまでの分は残す)。
   * ⚠ PKC2 は落ちて**全損**した ── 繰り返さないための門である。
   */
  readonly maxBytes: number;
  /** 終わったときに呼ぶ(自動で止まった場合も来る)。 */
  readonly onEnd?: (reason: CaptureEnd) => void;
}

/** 断りの理由を持つ失敗。⚠ **黙って no-op にしない**(#413 の要件)。 */
export class CaptureRefused extends Error {}

function pick(deps: CaptureDeps, kind: CaptureKind): (c: MediaStreamConstraints) => Promise<MediaStream> {
  const md = (globalThis as { navigator?: { mediaDevices?: MediaDevices } }).navigator?.mediaDevices;
  const fn =
    kind === 'audio'
      ? (deps.getUserMedia ?? md?.getUserMedia?.bind(md))
      : (deps.getDisplayMedia ?? md?.getDisplayMedia?.bind(md));
  if (fn === undefined) {
    throw new CaptureRefused(
      kind === 'audio'
        ? 'この環境では録音できません(ブラウザが対応していません)'
        : 'この環境では画面収録できません(ブラウザが対応していません)',
    );
  }
  return fn;
}

/**
 * 収録を始める。⚠ **断るときは理由つきで投げる**(権限拒否 / 非対応)。
 *
 * 🔴 **ブラウザ側の「共有を停止」でも正しく終わる** ── track の `ended` を見る。
 *   ⚠ 見ていないと**帯だけ残って、永久に録っているように見える**
 *   (PKC2 が明記していた要件)。
 */
export async function startCapture(
  kind: CaptureKind,
  deps: CaptureDeps,
  opts: CaptureOptions,
): Promise<CaptureHandle> {
  const now = deps.now ?? (() => Date.now());
  const Recorder = deps.Recorder ?? (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (Recorder === undefined) {
    throw new CaptureRefused('この環境では収録できません(ブラウザが対応していません)');
  }
  const ask = pick(deps, kind);
  let stream: MediaStream;
  try {
    // ⚠ 画面収録でも**音を一緒に**頼む(会議メモは音が要る)
    stream = await ask(kind === 'audio' ? { audio: true } : { video: true, audio: true });
  } catch (e) {
    const name = (e as { name?: string } | null)?.name ?? '';
    throw new CaptureRefused(
      name === 'NotAllowedError'
        ? kind === 'audio'
          ? 'マイクの許可がありません'
          : '画面の共有が許可されませんでした'
        : `収録を始められませんでした(${name || (e as Error).message})`,
    );
  }

  const chunks: Blob[] = [];
  let total = 0;
  const startedAt = now();
  let ended = false;
  /** 捨てた ── 以後の断片も、既に積んだ分も**返さない**。 */
  let abandoned = false;

  const rec = new Recorder(stream);

  /**
   * 🔴 **「止まった」は 1 本の約束で表す**(`onstop` が解決する)。
   *
   * ⚠ **押した時点の `chunks` を返してはいけない** ── 実物の `MediaRecorder` は
   *   `stop()` の**後に**最後の `dataavailable` を配ってから `stop` を撃つので、
   *   その場で組むと**末尾が欠ける**。とくに上限 / 共有停止で先に終わっている回は、
   *   受け側が `stop()` を呼ぶのが**数ミリ秒あと**になるので必ず踏む。
   * ⚠ happy-dom の stub は同期に撃つので、**この欠陥は unit では見えない**
   *   (だから約束の側に寄せて、待ち方を 1 つにしてある)。
   */
  let settle: ((b: Blob | null) => void) | null = null;
  const stopped = new Promise<Blob | null>((resolve) => {
    settle = resolve;
  });
  const emit = (): void => {
    const resolve = settle;
    if (resolve === null) return;
    settle = null;
    resolve(
      abandoned || chunks.length === 0
        ? null
        : new Blob(chunks, { type: rec.mimeType || chunks[0]!.type }),
    );
  };
  rec.onstop = emit;

  /**
   * ⚠ **止めるのは 1 回だけ** ── 「止める」を押した直後に track の `ended` が
   *   来ることがある(ブラウザ側の停止と重なる)。2 回止めると例外になる。
   * ⚠ 止められなかった / 既に止まっていた回は**その場で解決する** ──
   *   `onstop` が来ない相手で待つと、受け側が**永久に待つ**。
   */
  const finish = (reason: CaptureEnd): void => {
    if (ended) return;
    ended = true;
    opts.onEnd?.(reason);
    try {
      if (rec.state === 'inactive') emit();
      else rec.stop();
    } catch {
      emit(); // 既に止まっている ── 落とさない・待たせない
    }
    for (const t of stream.getTracks()) t.stop();
  };

  rec.ondataavailable = (ev: BlobEvent): void => {
    if (abandoned || ev.data.size === 0) return;
    chunks.push(ev.data);
    total += ev.data.size;
    // 🔴 **上限に当たったら自動で止める**(それまでの分は残す)
    if (total >= opts.maxBytes) finish('too-large');
  };
  // 🔴 ブラウザ側の「共有を停止」
  for (const t of stream.getTracks()) t.addEventListener('ended', () => finish('shared-ended'));

  // ⚠ 1 秒ごとに切る ── 切らないと `ondataavailable` が最後に 1 回しか来ず、
  //    上限の見張りも帯の大きさも**動かない**
  rec.start(1000);

  return {
    kind,
    bytes: () => total,
    elapsedMs: () => now() - startedAt,
    stop: () => {
      finish('stopped');
      return stopped;
    },
    discard: () => {
      // ⚠ **先に立てる** ── これより後に届く断片も、既に積んだ分も返さない
      abandoned = true;
      finish('discarded');
      // ⚠ **bytes を手放す**(2026-07-27「ライフサイクル終端での即破棄」)
      chunks.length = 0;
      total = 0;
    },
  };
}
