import { useState } from 'react';
import { CornerDownLeftIcon, Loader2Icon, SendHorizontalIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

import type { SendOutcome } from './useChatMessages';

/**
 * Composer — 消息输入区。
 *
 * - Enter 发送、Shift+Enter 换行（IME 组合输入中的 Enter 不触发发送）；
 * - 正文即 content：POST /api/v1/channels/{id}/messages body {type:'text',text}；
 * - onSend 返回 'sent' 时清空输入；'blocked'（被频道规则拦截，原因已 toast）与
 *   'error'（网络失败）保留输入便于修改重发；
 * - 长度与内核契约一致（text 上限 20000 字符）。
 */

interface ComposerProps {
  channelName: string | null;
  sending: boolean;
  onSend(text: string): Promise<SendOutcome>;
}

const MAX_TEXT_LENGTH = 20_000;

export function Composer({ channelName, sending, onSend }: ComposerProps): React.ReactNode {
  const [value, setValue] = useState('');

  const submit = async (): Promise<void> => {
    const text = value.trim();
    if (text === '' || sending) return;
    const outcome = await onSend(text);
    if (outcome === 'sent') setValue('');
  };

  return (
    <div className="shrink-0 border-t p-3">
      <div className="flex items-end gap-2">
        <Textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={channelName !== null ? `发消息到 #${channelName}` : '先选择一个频道'}
          maxLength={MAX_TEXT_LENGTH}
          rows={1}
          disabled={channelName === null}
          aria-label="消息输入框"
          className="max-h-40 min-h-9 resize-none py-2"
        />
        <Button
          size="icon"
          aria-label="发送消息"
          disabled={value.trim() === '' || sending || channelName === null}
          onClick={() => {
            void submit();
          }}
        >
          {sending ? <Loader2Icon className="animate-spin" aria-hidden /> : <SendHorizontalIcon aria-hidden />}
        </Button>
      </div>
      <p className="text-muted-foreground mt-1.5 flex items-center gap-1 text-[11px]">
        <CornerDownLeftIcon className="size-3" aria-hidden />
        Enter 发送，Shift+Enter 换行
      </p>
    </div>
  );
}
