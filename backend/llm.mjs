// ─────────────────────────────────────────────────────────────
// 邮件 AI 的提示词构造
//
// 这里只管「问什么」，不管「谁来答」。
// 调用模型走 lib/model-host.mjs —— 那是宿主契约 ctx.models（能力位 app/models.infer）：
// 凭据、endpoint、API 协议（openai-completions / anthropic-messages）、流式解码、
// 超时与取消，全部留在宿主侧，本层拿不到也不需要拿到 key。
//
// v0.6.13 起这个文件里没有任何网络代码。原先的 chatCompletion / buildRequest /
// hostConfig / setHostLlmConfig / llmConfigured / HANAKO_LLM_* 环境变量，
// 是被 app/models.infer 整块取代的旧路径，已删除。
// ─────────────────────────────────────────────────────────────

/** 总结：3-5 条要点，保留关键信息与待办。 */
export function summarizePrompt(text, targetLang = "中文") {
  return {
    system:
      "你是一个邮件助手。请将以下邮件内容总结为简洁的要点，" +
      `使用${targetLang}输出，3-5 条，保留关键信息和待办事项；若邮件很短则直接给出核心内容。` +
      "只输出总结本身，不要多余解释。",
    user: text,
    temperature: 0.2,
    maxTokens: 800,
  };
}

/** 翻译：保留原始段落结构，只输出译文。 */
export function translatePrompt(text, targetLang = "中文") {
  return {
    system:
      "你是一个翻译助手。请将以下邮件正文翻译为" +
      `${targetLang}，保留原始段落结构与格式，仅输出译文，不要添加任何解释或前言。`,
    user: text,
    temperature: 0.1,
    maxTokens: 2000,
  };
}

/** 连接自检：让模型回一个固定短词，验证「选中的这个模型真的能跑通」。 */
export function pingPrompt() {
  return {
    system: "",
    user: "Reply with exactly: OK",
    temperature: 0,
    maxTokens: 8,
  };
}
