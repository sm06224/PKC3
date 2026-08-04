/**
 * 書出し / 取込の注意を**数で畳む**(P8 段㉒)。
 *
 * 🔴 生まれた理由: 同じ規則が md ZIP にだけあり、アーカイブ側に無かった。
 * アーカイブの取込は**衝突した entry 1 件につき 1 行**警告を積むので、
 * 同じバックアップを 2 回取り込むと**全件が該当**する ── 200 件なら 200 行。
 * 注意の面には上限も scroll も無かったため、3 列が数十 px まで押し潰され、
 * 閉じるまで作業できなくなっていた(user 指示「1 画面で完結」の破れ)。
 *
 * 🔑 **上限は 2 か所で持つ**:
 *   ① ここ(件数を畳む)── そもそも 200 行作らない
 *   ② `app.css` の `[data-pkc-region='notices']`(高さの上限)── 画面の側の保険
 * どちらか片方だけでは足りない ── ① だけだと将来別の経路が大量に積んだとき、
 * ② だけだと DOM に 200 行が実在してスクロールの中に埋もれる。
 */

/** 同種の注意を並べる上限。⚠ これを超えたぶんは「ほか N 件」に畳む。 */
export const WARN_CAP = 10;

export interface WarnCollector {
  /**
   * 1 件積む(上限を超えたら数えるだけ)。
   * @param bucket 同種かどうかの判定キー(**user には見せない**内部の名前)
   * @param label 畳んだときに出す日本語(「〜はほか N 件あります」の主語)
   */
  add(bucket: string, label: string, message: string): void;
  /**
   * 畳んだぶんの行を足して確定する。⚠ **呼び忘れると件数が消える** ──
   * 「10 件までは出るが、それ以上あったことは誰も知らない」になる。
   */
  finish(): string[];
}

/**
 * @param warnings 既存の配列に積む(呼び側が他の経路でも push しているため)
 */
export function createWarnCollector(warnings: string[] = []): WarnCollector {
  const counted = new Map<string, { n: number; label: string }>();
  return {
    add(bucket, label, message) {
      const c = counted.get(bucket) ?? { n: 0, label };
      c.n += 1;
      counted.set(bucket, c);
      if (c.n <= WARN_CAP) warnings.push(message);
    },
    finish() {
      for (const c of counted.values()) {
        if (c.n > WARN_CAP) warnings.push(`${c.label}はほか ${c.n - WARN_CAP} 件あります`);
      }
      counted.clear();
      return warnings;
    },
  };
}
