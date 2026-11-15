import { MESSAGE_ROLE, type ChatMessage } from "@shared/bridge-types";
import { Markdown } from "@renderer/shared/markdown/Markdown";
import "./MessageBubble.css";

export interface MessageBubbleProps {
  readonly message: ChatMessage;
}

// Presentational only. The "no tool output, no thinking shown" filtering
// happens in T2's reducer before a message ever reaches this component.
// Assistant replies render through <Markdown> (sanitized HTML — see
// renderMarkdown.ts) since a model naturally replies in Markdown
// (`**bold**`, `` `code` ``, `- lists`); user messages stay literal plain
// text so nothing the human typed is ever reinterpreted as markup.
export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === MESSAGE_ROLE.USER;

  return (
    <article className={`gc-message gc-message--${isUser ? "user" : "assistant"}`}>
      <div className="gc-message__avatar" aria-hidden="true">
        {isUser ? "YOU" : <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" /></svg>}
      </div>
      <div className="gc-message__body">
        <header className="gc-message__speaker"><strong>{isUser ? "You" : "el Gentleman"}</strong>{!isUser && <span className="gc-message__badge">GENTLE</span>}</header>
        {isUser ? <p className="gc-message__text">{message.text}</p> : <Markdown text={message.text} />}
      </div>
    </article>
  );
}
