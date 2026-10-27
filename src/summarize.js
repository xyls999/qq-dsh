const STOP_WORDS = new Set(['这个', '那个', '我们', '你们', '他们', '不是', '还是', '因为', '所以', '然后', '可以', '需要', '一个', '一下', '这里', '那里', '已经', '如果', '就是', '今天', '明天', '大家']);
const DECISION_PATTERN = /确认|决定|定了|通过|采用|定为|确定/;
const TASK_PATTERN = /待办|需要|负责|安排|截止|完成|记得|我来|跟进/;
const QUESTION_PATTERN = /[?？]/;
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });

function formatLocalTimestamp(timestampMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(timestampMs);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function evidenceLine(message) {
  const quote = message.text.replace(/\s+/g, ' ').slice(0, 120)
    .replace(/https?:/gi, (protocol) => `${protocol.slice(0, -1)}\\:`)
    .replace(/[\\`*_{}\[\]()#+.!|<>]/g, '\\$&');
  const reference = message.messageRef ? `消息 ${message.messageRef}` : '本地记录';
  return `- ${formatLocalTimestamp(message.timestampMs)}（本地时间） · ${message.senderKey} · ${reference}：“${quote}”`;
}

function candidateLines(messages, pattern) {
  const candidates = messages.filter((message) => pattern.test(message.text));
  return candidates.length ? candidates.map(evidenceLine).join('\n') : '- 未识别到候选项。';
}

/**
 * Builds a deterministic offline report from records in a specified time range.
 * @param {Array<object>} input Archive records.
 * @param {{fromMs: number, toMs: number}} range Inclusive timestamp range.
 * @returns {{generatedAtMs: number, rangeStartMs: number, rangeEndMs: number, text: string}} Local summary record.
 */
export function summarize(input, range) {
  if (!Number.isSafeInteger(range.fromMs) || !Number.isSafeInteger(range.toMs) || range.fromMs > range.toMs) {
    throw new Error('invalid summary date range');
  }
  const messages = input.filter((message) => Number.isSafeInteger(message.timestampMs)
    && message.timestampMs >= range.fromMs && message.timestampMs <= range.toMs)
    .sort((left, right) => left.timestampMs - right.timestampMs || String(left.messageKey).localeCompare(String(right.messageKey)));
  const counts = new Map();
  for (const message of messages) {
    for (const item of segmenter.segment(message.text)) {
      const word = item.segment.toLocaleLowerCase('zh-CN');
      if (!item.isWordLike || word.length < 2 || STOP_WORDS.has(word) || /^\d+$/.test(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const keywords = [...counts.entries()]
    .sort(([leftWord, leftCount], [rightWord, rightCount]) => rightCount - leftCount || leftWord.localeCompare(rightWord, 'zh-CN'))
    .slice(0, 8)
    .map(([word, count]) => `${word}（${count}）`);
  const text = [
    '# 群聊离线规则归总',
    '',
    `范围：${formatLocalTimestamp(range.fromMs)} 至 ${formatLocalTimestamp(range.toMs)}（本地时间）`,
    `消息数：${messages.length}`,
    '本报告由本地规则生成，不是生成式摘要；关键词仅表示文本出现线索。',
    '',
    '## 关键词线索',
    keywords.length ? `- ${keywords.join('、')}` : '- 无可提取关键词。',
    '',
    '## 决定候选（需人工核对）',
    candidateLines(messages, DECISION_PATTERN),
    '',
    '## 待办候选（需人工核对）',
    candidateLines(messages, TASK_PATTERN),
    '',
    '## 疑问消息（需人工核对）',
    candidateLines(messages, QUESTION_PATTERN),
  ].join('\n');
  return {
    generatedAtMs: Date.now(),
    rangeStartMs: range.fromMs,
    rangeEndMs: range.toMs,
    text,
  };
}
