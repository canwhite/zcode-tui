import { modelMessageContentToText } from "../deps.js";
import {
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";

/**
 * 侧问的「有没有据」廉价证据检查。
 *
 * **它是软信号，不是硬闸门。** 中文提问与英文/代码上下文之间几乎没有字面重合
 *（上下文里是标识符，提问是「刚才那个函数是怎么实现的」），把未命中直接当成拒答会把
 * **合法问题一律打死**——而单向验收（只测「无据必须拒答」）会给这种实现满分。
 * 因此未命中的语义是「低置信」：由 `btw-model-request.ts` 追加一段要求模型显式声明
 * 依据的约束，仍答不出才拒答。
 *
 * 阈值与分词策略是可调项，不是定论；调整前请先记录一次实测的误拒率作为基线。
 */

/** 命中判定阈值。调参前先测误拒率——它同时决定漏拒与误拒两个方向。 */
export const BTW_EVIDENCE_HIT_RATIO = 0.34;

const MIN_LATIN_TOKEN_LENGTH = 3;
const CJK_BIGRAM_LENGTH = 2;

/**
 * 停用词。**没有它们这个信号就几乎恒为 miss**——自然提问里的大半 token 是「怎么 / 是 / 的 /
 * how / does / the」，它们在上下文里同样不出现，把分母撑大、把命中率压到阈值以下，
 * 于是低置信分支变成无条件分支（等于没有信号）。
 */
const LATIN_STOPWORDS = new Set([
  "about", "and", "any", "are", "but", "can", "could", "did", "does", "for", "from", "had",
  "has", "have", "here", "how", "into", "its", "not", "our", "should", "than", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "those", "was", "were", "what",
  "when", "where", "which", "who", "why", "with", "would", "you", "your",
]);
/** 中文功能字：二字组里只要含其中之一就丢（「怎么」「是怎」「做了」「口偏」这类噪声）。 */
const CJK_FUNCTION_CHARS = new Set([
  ..."的了是在么什怎吗呢吧啊我你他她它这那有和与就都也很会能要把被给到从对个一上下里中为而不只还未于其所个吗嘛呀",
]);

export interface BtwEvidenceAssessment {
  /** `hit` = 有字面依据；`miss` = 低置信（**不是**「无据」，不得据此直接拒答）。 */
  level: "hit" | "miss";
  /** 命中的不同 token 数。只记计数，不记 token 本身——埋点不得成为写入通道。 */
  matchedTokenCount: number;
  ratio: number;
  tokenCount: number;
}

export function assessBtwEvidence(
  question: string,
  entries: readonly RuntimeMessageEntry[],
): BtwEvidenceAssessment {
  const tokens = extractEvidenceTokens(question);
  if (tokens.size === 0) {
    // 没有可判定的 token（极短提问、纯符号，或全被停用词吃光）时不制造低置信信号，
    // 交给模型自行判断——低置信分支只应在**确实有词可比**时才出现。
    return { level: "hit", matchedTokenCount: 0, ratio: 1, tokenCount: 0 };
  }

  const haystack = buildContextHaystack(entries);
  let matchedTokenCount = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) matchedTokenCount += 1;
  }

  const ratio = matchedTokenCount / tokens.size;
  return {
    level: ratio >= BTW_EVIDENCE_HIT_RATIO ? "hit" : "miss",
    matchedTokenCount,
    ratio,
    tokenCount: tokens.size,
  };
}

/**
 * 分词：拉丁文取长度 ≥3 的词/标识符；CJK 取相邻二字组（bigram）——中文没有空格，
 * 逐字匹配会过宽、整句匹配会全不命中，bigram 是廉价且够用的折中。
 */
export function extractEvidenceTokens(question: string): Set<string> {
  const tokens = new Set<string>();
  const lowercased = question.toLowerCase();

  for (const match of lowercased.matchAll(/[a-z0-9_][a-z0-9_./-]*/gu)) {
    const token = match[0];
    if (token.length >= MIN_LATIN_TOKEN_LENGTH && !LATIN_STOPWORDS.has(token)) tokens.add(token);
  }

  const cjkRuns = lowercased.match(/[㐀-䶿一-鿿぀-ヿ]+/gu) ?? [];
  for (const run of cjkRuns) {
    const characters = [...run];
    if (characters.length < CJK_BIGRAM_LENGTH) continue;
    for (let index = 0; index + CJK_BIGRAM_LENGTH <= characters.length; index += 1) {
      const bigram = characters.slice(index, index + CJK_BIGRAM_LENGTH);
      if (bigram.some((char) => CJK_FUNCTION_CHARS.has(char))) continue;
      tokens.add(bigram.join(""));
    }
  }

  return tokens;
}

function buildContextHaystack(entries: readonly RuntimeMessageEntry[]): string {
  const parts: string[] = [];
  for (const entry of entries) {
    // attachment 条目（system reminder）也进上下文，证据检查必须与模型实际看到的一致。
    parts.push(
      isRuntimeAttachmentEntry(entry)
        ? entry.content
        : modelMessageContentToText(entry.message.content),
    );
  }
  return parts.join("\n").toLowerCase();
}
