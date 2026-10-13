/**
 * 分卷识别与包名归一（**纯函数，无 Node 依赖**）
 *
 * 为什么单独抽出来：这套逻辑原先在四处各写了一遍 ——
 *   · `engine.ts`   → volumeKey / isVolumeMember
 *   · `tasks.ts`    → volumeKeyOf（与 engine.volumeKey 逐字相同）
 *   · `dedup.ts`    → volumeBase / normalizeCopyName
 *   · `workflows.ts`→ volumeSignature（与 engine.volumeKey 近似但少一层循环）
 *   · `renderer/store.ts` → normalizeCopyName（**手抄一份**，靠注释提醒同步）
 * 一旦其中一处改了规则、其它处没跟上，就会出现"扫描判重与解压删源口径不一致"
 * 这类极难排查的问题。统一到这里后，主进程与渲染进程共用同一份实现。
 *
 * 放在 `shared/` 而不是 `main/`：渲染进程也要用（store.ts 的去重预览），
 * 而 `main/` 下的模块普遍依赖 `node:fs`，被打进渲染层会直接崩。
 */

/**
 * 去掉扩展名与分卷尾号，得到"同一套分卷"的基名（小写）。
 *
 * 例：`75.part1.rar` → `75`；`a.7z.001` → `a.7z`；`x.r00` → `x`。
 *
 * 注意：**它只剥"分卷尾号"，不剥压缩格式后缀**，因此
 * `movie.7z` 与 `movie.nfo` 会得到同一个 key（都是 `movie`）。
 * 这不是 bug，而是"基名"的定义 —— 所以**任何"据此删除文件"的场景，
 * 都必须再叠加一次 {@link isVolumeMember} 判断**，否则会把同名的
 * `.nfo` / `.sfv` / `.txt` 当成分卷删掉。
 */
export function volumeKey(fileName: string): string {
  let s = fileName.replace(/\.[^.]+$/, '');
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(/\.(part\d+|z\d{2}|r\d{2}|\d{3})$/i, '');
  }
  return s.toLowerCase();
}

/**
 * 是否是分卷成员（`.partN` / `.NNN` / `.zNN` / `.rNN`）。
 *
 * 用途：把"同基名"收窄成"真的是一套分卷"，是删除类操作的**必需护栏**。
 */
export function isVolumeMember(fileName: string): boolean {
  return /\.(part\d+(\.(rar|zip|7z))?|z\d{2}|r\d{2}|\d{3})$/i.test(fileName);
}

/**
 * 规范化包名：得到用于"同一份内容"比对的 key（重复包判定用）。
 *
 * 顺序很重要（这里踩过坑）：
 *   ① **先**剥掉分卷尾号与压缩格式后缀 —— 否则 "已存在 (1).part1.7z" 与
 *      "已存在.part1.7z" 会得到不同的 key，导致重复判不出来；
 *   ② **再**剥掉复制后缀 " (1)" / "（2）" / " - 副本" / " copy"；
 *   ③ 最后统一小写。
 */
export function normalizeCopyName(name: string): string {
  // ① 去分卷号与压缩格式后缀（反复剥，直到稳定）
  let s = name;
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s.replace(/\.(part\d+|z\d{2}|r\d{2}|\d{3})$/i, '');
    s = s.replace(/\.(7z|zip|rar|tar|gz|tgz|bz2|xz|cab)$/i, '');
    if (s === before) break;
  }

  // ② 去复制后缀
  //    注意：只处理"带括号/分隔符的副本标记"。像 RX-4114 这种以数字结尾的
  //    正常包名不能被吃掉尾号（否则 "RX-4114 (1)" 与 "RX-4114" 都被归一成 "rx"，
  //    会让所有同前缀的包互相误判为重复）。
  //
  //    修复 ①（去重误判，P0）：**不再**剥离 `_1` / `-2` 这类单数字后缀。
  //    旧实现把它当成"浏览器另存副本"无条件剥掉，于是 `video_1.rar` 与
  //    `video_2.rar` 归一成同一个 key（`video`）—— 当两者同名同体积时，
  //    `findDuplicates` 会按「归一化名 + 逐分卷大小一致」把它们静默合并成一份，
  //    第 2/3 集直接从待处理清单消失。单数字后缀更可能是**不同的分集/序号**，
  //    不能当成副本标记。真正明确的副本标记只有：` (1)`/`（2）`（带括号的序号）、
  //    ` - 副本`/`复制`/`copy`/`copia` —— 即下面两行。
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(/[\s_-]*[(（]\s*\d+\s*[)）]$/, '');
    s = s.replace(/[\s_-]+(?:副本|复制|copy|copia)$/i, '');
    s = s.replace(/[\s_-]+copy\d*$/i, '');
  }
  // 去掉剥完后残留的分隔符
  s = s.replace(/[\s_-]+$/, '');

  return s.trim().toLowerCase();
}
