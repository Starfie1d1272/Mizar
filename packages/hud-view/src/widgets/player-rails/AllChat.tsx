import { useEffect, useState } from 'react';
import type { ProgramPayload } from '@mizar/protocol/program';
import type { HudDesign } from '../../hud-design.js';

export function AllChat({
  messages,
  design,
}: {
  messages: NonNullable<ProgramPayload['allChat']>;
  design: HudDesign;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const deadlines = messages
      .map((message) => Date.parse(message.expiresAt))
      .filter((time) => time > Date.now());
    if (!deadlines.length) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(1, Math.min(...deadlines) - Date.now() + 10),
    );
    return () => window.clearTimeout(timer);
  }, [messages, now]);
  const visible = messages.filter((message) => Date.parse(message.expiresAt) > now);
  if (!visible.length) return null;
  return (
    <aside className="all-chat" data-all-chat={design} aria-label="公共聊天">
      {visible.slice(-3).map((message) => (
        <p className="all-chat__message" key={message.id}>
          <b>{message.sender}</b>
          <span>{message.text}</span>
        </p>
      ))}
    </aside>
  );
}
