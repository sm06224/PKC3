/**
 * 音源分離モデルの**取り込み・消去・使うときの取り出し**(#674 / #949)。
 *
 * 🔑 `asr-pack-install.ts` と同じ形 ── 取得は `stem-fetch.ts`、保管は `stem-model-store.ts`。この module は
 * **その 2 つをどう繋ぐか**と、**失敗したとき user へ何と言うか**だけを持つ。
 *
 * ## 🔴 取り込んで残す(レビュー裁定)
 * 1 度取り込んだモデルは端末の保管(IndexedDB の Blob)に残り、**次からは取りに行かない**。設定の「音源分離」から
 * **取り込む / 消す**の両方向がある(片道にしない)。録音から押したとき、まだ無ければここで取り込んでから使う(`obtain`)。
 * ⚠ 保存に失敗しても(容量・権限)、取れた Blob でその 1 回は動かす(保存の失敗で分離を止めない。知らせは言う)。
 *
 * ## 🔴 投げない
 * 数十 MB を触る長い操作で、途中の失敗は珍しくない。結果を値で返し、そのまま画面に出せる文にする。
 */
import { requestPersist as requestPersistState } from '@adapter/platform/storage-persist';
import { humanBytes } from '@features/human-bytes';
import { stemModelOf, type StemModel } from '@features/audio/stem-model';
import { fetchStemModel, type StemFetchResult } from './stem-fetch';
import type { StemModelMeta, StemModelStorePort } from './stem-model-store';

export type StemModelInstalled = Readonly<Record<string, StemModelMeta>>;

export type StemInstallResult =
  | { readonly ok: true; readonly installed: StemModelInstalled; readonly message: string }
  | { readonly ok: false; readonly message: string };

export type StemObtainResult =
  | {
      readonly ok: true;
      readonly blob: Blob;
      /** 端末に入っていた物か(true なら取得していない)。 */
      readonly fromStore: boolean;
      /**
       * 🔴 **端末へ保存する**(取得した回だけ意味がある。入っていた物には何もしない)。
       * 呼ぶのは**分離が成功して安全弁を通ったあと**だけ ── 検証前に残すと、別のモデルや壊れた物を「入っている」ことにして、
       * 次からも取りに行かず同じ失敗を繰り返す。返すのは知らせの 1 文(保存できなかった理由も含む)。投げない。
       */
      readonly save: () => Promise<string>;
    }
  | { readonly ok: false; readonly why: string };

export interface StemModelInstallDeps {
  readonly store: StemModelStorePort;
  /** 既定は `fetchStemModel`。test が差し替える。 */
  readonly fetchModel?: (
    model: StemModel,
    opts: { signal?: AbortSignal; onProgress?: (got: number, total: number, host: string) => void },
  ) => Promise<StemFetchResult>;
  /** 保存の永続化を頼む。⚠ test が差し替える。 */
  readonly persist?: () => Promise<boolean>;
  readonly now?: () => number;
}

async function requestPersist(): Promise<boolean> {
  const store = typeof navigator === 'undefined' ? undefined : navigator.storage;
  return (await requestPersistState(store)) === 'persisted';
}

function messageOf(e: unknown, what: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/quota/i.test(raw)) return `${what}に失敗しました: この端末の空き容量が足りません。`;
  return `${what}に失敗しました: ${raw.slice(0, 160)}`;
}

/** 進み具合の 1 行。 */
export function stemProgressText(got: number, total: number, host: string): string {
  return total > 0
    ? `${host} から取得しています… ${String(Math.min(100, Math.floor((got / total) * 100)))}%(${humanBytes(got)} / ${humanBytes(total)})`
    : `${host} から取得しています… ${humanBytes(got)}`;
}

export class StemModelInstaller {
  private readonly deps: StemModelInstallDeps;
  /** ⚠ 二重起動を作らない(66MB を 2 本走らせると帯域も quota も倍食う)。 */
  private running = false;
  private abort: AbortController | null = null;

  constructor(deps: StemModelInstallDeps) {
    this.deps = deps;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 取得を途中で止める。⚠ 走っていなければ何もしない。 */
  cancel(): void {
    this.abort?.abort();
  }

  /** いま入っているモデル。⚠ 読めなければ「入っていない」側へ倒す。 */
  async readInstalled(ids: readonly string[]): Promise<StemModelInstalled> {
    const out: Record<string, StemModelMeta> = {};
    for (const id of ids) {
      const m = await this.deps.store.readMeta(id).catch(() => null);
      if (m !== null) out[id] = m;
    }
    return out;
  }

  /** 端末に入っているか(取得の確認を出すかどうかの判断に使う)。 */
  async isStored(id: string): Promise<boolean> {
    return (await this.deps.store.readMeta(id).catch(() => null)) !== null;
  }

  /**
   * 使うための重みを取り出す。入っていればそれ(取りに行かない)、無ければ取得して返す。
   * 🔴 **ここでは保存しない** ── 保存は返す `save()`(分離が成功して安全弁を通ったあと)。
   * @param onProgress 取得の進み(入っているときは呼ばない)
   */
  async obtain(
    model: StemModel,
    onProgress: (got: number, total: number, host: string) => void = () => {},
  ): Promise<StemObtainResult> {
    try {
      const stored = await this.deps.store.readBlob(model.id).catch(() => null);
      if (stored !== null) return { ok: true, blob: stored, fromStore: true, save: async () => '' };
    } catch {
      /* 読めなければ取り直す */
    }
    if (this.running) return { ok: false, why: 'すでにモデルを取得しています。終わるまでお待ちください。' };
    this.running = true;
    const abort = new AbortController();
    this.abort = abort;
    try {
      const fetched = await (this.deps.fetchModel ?? ((m, o) => fetchStemModel(m, undefined, o)))(model, {
        signal: abort.signal,
        onProgress,
      });
      if (!fetched.ok) return { ok: false, why: fetched.why };
      const save = async (): Promise<string> => {
        try {
          const persisted = await (this.deps.persist ?? requestPersist)();
          await this.deps.store.put(model.id, fetched.blob, {
            bytes: fetched.blob.size,
            url: fetched.url,
            installedAt: (this.deps.now ?? Date.now)(),
          });
          return persisted
            ? 'モデルを端末に取り込みました(次からは取得しません。設定の「音源分離」で消せます)'
            : 'モデルを端末に取り込みました(ブラウザが「消さずに残す」を許していないため、空き容量が減ると消されることがあります)';
        } catch (e) {
          // 保存に失敗しても、分離の結果は出ている
          return `${messageOf(e, 'モデルの保存')}(次回は取得し直します)`;
        }
      };
      return { ok: true, blob: fetched.blob, fromStore: false, save };
    } finally {
      this.running = false;
      this.abort = null;
    }
  }

  /**
   * 🔴 **端末のモデルを捨てる**(保存済みのモデルで分離が bad-model になったとき)── 合わない物を残すと、次も同じ失敗をする。
   * @returns 消したか(元から無ければ false)
   */
  async discard(id: string): Promise<boolean> {
    const had = await this.isStored(id);
    if (!had) return false;
    await this.deps.store.remove(id).catch(() => undefined);
    return !(await this.isStored(id));
  }

  /** 設定から取り込む(`obtain` と同じ道。入っていれば何もしない)。 */
  async install(id: string, onProgress: (text: string) => void = () => {}): Promise<StemInstallResult> {
    const model = stemModelOf(id);
    if (model === undefined) return { ok: false, message: '知らないモデルです。' };
    if (this.running) return { ok: false, message: 'すでに取得中です。終わるまでお待ちください。' };
    const before = await this.readInstalled([id]);
    if (before[id] !== undefined) return { ok: true, installed: before, message: `「${model.label}」のモデルは取り込み済みです` };
    onProgress('取得を始めています');
    const r = await this.obtain(model, (g, t, h) => onProgress(stemProgressText(g, t, h)));
    onProgress('');
    if (!r.ok) return { ok: false, message: r.why };
    // 設定からの取り込みは user の明示操作 ── 分離を通さずにそのまま保存する(合わなければ、使ったときに捨てる)
    const note = await r.save();
    const after = await this.readInstalled([id]);
    if (after[id] === undefined) {
      // 保存が通らなかった(note に理由が入っている)── 入ったとは言わない
      return { ok: false, message: note !== '' ? note : 'モデルを保存できませんでした。' };
    }
    return { ok: true, installed: after, message: note !== '' ? note : `「${model.label}」のモデルを取り込みました` };
  }

  /** 消す。⚠ 消えたことを確かめてから成功と言う。 */
  async remove(id: string): Promise<StemInstallResult> {
    const model = stemModelOf(id);
    if (model === undefined) return { ok: false, message: '知らないモデルです。' };
    if (this.running) return { ok: false, message: 'いま取得している最中です。終わるまでお待ちください。' };
    try {
      await this.deps.store.remove(id);
      const left = await this.readInstalled([id]);
      if (left[id] !== undefined) return { ok: false, message: '消せませんでした(まだ残っています)。' };
      return { ok: true, installed: left, message: `「${model.label}」のモデルを消しました(使うときに、もう一度取得します)` };
    } catch (e) {
      return { ok: false, message: messageOf(e, '削除') };
    }
  }
}
