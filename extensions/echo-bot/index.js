'use strict';

/**
 * echo-bot — 聊天回声示例扩展。
 *
 * 订阅 `chat.message.created`，把用户 / webhook 消息回显（echo）到原频道。
 * 入站消息形状 = ChatMessagePayload（src/kernel/channels/types.ts）：
 * { id, channelId, channelSlug, senderType: 'user'|'ext'|'webhook', senderId, content, ... }
 *
 * 防回声循环：扩展经 h.chat.send 发出的消息 senderType 恒为 'ext'
 * （见 kernel-handlers.ts 的 chatSend），因此 senderType === 'ext' 的消息一律跳过，
 * 否则 订阅 → 发送 → 再触发订阅 将无限循环。
 */

defineExtension(async (h) => {
  h.on('chat.message.created', async (msg) => {
    // 空载荷与扩展自身消息（含本扩展）不回显，切断回声循环
    if (!msg || msg.senderType === 'ext') return;

    // 提取文本：text 块直接取正文；其他 content（card / file 等）回退 JSON 摘要
    const raw = msg.content?.text ?? JSON.stringify(msg.content ?? null);
    const text = `echo: ${raw}`.slice(0, 500);

    await h.chat.send({ slug: msg.channelSlug, content: { type: 'text', text } });
  });
});
