import { MESSAGE_ROLE, type ChatMessage, type ToolCallView, type ToolVocabulary } from "@shared/bridge-types";
import { Markdown } from "@renderer/shared/markdown/Markdown";
import { ToolActionRow } from "./ActionRows";
import "./MessageBubble.css";

export interface MessageBubbleProps {
  readonly message: ChatMessage;
  /** The chat's tool executions (ChatState.toolCalls): each of the turn's
   * `tool` parts resolves its ONE action row here, by toolCallId. */
  readonly toolCalls?: readonly ToolCallView[];
  /** The child's published vocabulary, for those rows' glyphs. */
  readonly vocabulary?: ToolVocabulary;
}

// Presentational only. The "no tool output, no thinking shown" filtering
// happens in T2's reducer before a message ever reaches this component.
// Assistant replies render through <Markdown> (sanitized HTML — see
// renderMarkdown.ts) since a model naturally replies in Markdown
// (`**bold**`, `` `code` ``, `- lists`); user messages stay literal plain
// text so nothing the human typed is ever reinterpreted as markup.
export function MessageBubble({ message, toolCalls, vocabulary }: MessageBubbleProps) {
  const isUser = message.role === MESSAGE_ROLE.USER;

  // chat-action-rows T3 (S1/S2): an assistant turn renders its ORDERED
  // parts — each text part through <Markdown>, each tool part as ONE action
  // row at that position — so a text → tool → text turn reads text → row →
  // text. A turn without parts (and every user message) renders exactly as
  // today: text, then nothing.
  const parts = isUser ? undefined : message.parts;
  const callById = parts ? new Map((toolCalls ?? []).map((call) => [call.id, call])) : undefined;

  const body = isUser ? (
    <p className="gc-message__text">{message.text}</p>
  ) : parts && parts.length > 0 ? (
    parts.map((part, index) =>
      part.kind === "text" ? (
        <Markdown key={`text-${index}`} text={part.text} />
      ) : (
        // The row's view data is gone (ChatState retains a bounded tail of
        // toolCalls); nothing renders rather than a row without a payload.
        callById?.get(part.toolCallId) ? (
          <ToolActionRow
            key={`tool-${part.toolCallId}`}
            call={callById.get(part.toolCallId) as ToolCallView}
            vocabulary={vocabulary}
          />
        ) : null
      ),
    )
  ) : (
    <Markdown text={message.text} />
  );

  // The speaker reads from the shape, never from a label (Workspace
  // artboard): the user turn is the tinted box, the assistant turn the plain
  // block — no avatar, no name header, no badge.
  return (
    <article className={`gc-message gc-message--${isUser ? "user" : "assistant"}`}>
      <div className="gc-message__body">{body}</div>
    </article>
  );
}
