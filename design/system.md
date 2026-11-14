# Gentleman Cute — existing desktop system

Synced from repository styles for standalone GUI exploration. This is not a proposed starter system.
The requested Gentleman Programming identity shares the rose, ink, champagne and soft blue vocabulary.
No production styles were changed. New layouts are design proposals, not current application capabilities.

## Colors
Source for every color: `src/renderer/shared/theme/tokens.css`.
- `--bg`: `#060407` — Application background.
- `--panel`: `#100a0f` — Navigation / panels.
- `--raised`: `#180e15` — Elevated surfaces.
- `--line`: `#2a1720` — Decorative separators.
- `--line-strong`: `#563040` — Strong boundaries.
- `--text`: `#f6eff3` — Primary text.
- `--text-2`: `#d2cbd0` — Secondary text.
- `--muted`: `#a78e9b` — Metadata.
- `--accent`: `#f095c8` — Primary action / brand.
- `--accent-active`: `#ffb1dd` — Hover / focus.
- `--blue`: `#a9c7ee` — Information.
- `--green`: `#b4e7c7` — Success.
- `--amber`: `#f2b86d` — Working.
- `--red`: `#ff718f` — Error.
- `--purple`: `#c96aa2` — Decorative accent.
- `--champagne`: `#e0c27a` — Highlight.

## Typography
Source: `src/renderer/shared/theme/tokens.css`.
- Display: "Space Grotesk", "Segoe UI", system-ui, sans-serif.
- Body: "Inter", "Segoe UI", system-ui, sans-serif.
- Mono: "JetBrains Mono", "SFMono-Regular", Consolas, monospace.
- Standalone boards use the system fallbacks only, with no external font downloads.
- Heading: 1rem / 600. Source: `src/renderer/features/chats/ChatsContainer.css`.
- Message: 0.9rem / 1.5. Source: `src/renderer/features/conversation/components/MessageBubble.css`.
- Button: 0.875rem / 600. Source: `src/renderer/shared/ui/atoms/Button.css`.
- Pill: 0.75rem / 600, line-height 1. Source: `src/renderer/shared/ui/atoms/Pill.css`.

## Spacing
- Sidebar: 1rem padding, 0.75rem gap. Source: `src/renderer/features/chats/ChatsContainer.css`.
- Chat row: 0.6rem 0.75rem padding, 0.5rem gap. Source: `src/renderer/features/chats/components/ChatListItem.css`.
- Header: 0.85rem 1rem padding, 0.6rem gap. Source: `src/renderer/features/conversation/components/ConversationHeader.css`.
- Message: 0.6rem 0.85rem padding. Source: `src/renderer/features/conversation/components/MessageBubble.css`.
- Composer: 0.75rem padding, 0.35rem gap. Source: `src/renderer/features/conversation/components/Composer.css`.

## Radius
- 8px: buttons and chat items. Sources: `src/renderer/shared/ui/atoms/Button.css`, `src/renderer/features/chats/components/ChatListItem.css`.
- 10px: text fields. Source: `src/renderer/shared/ui/atoms/TextField.css`.
- 12px: messages and task card. Sources: `src/renderer/features/conversation/components/MessageBubble.css`, `src/renderer/features/conversation/components/TodoCard.css`.
- 999px: pills and tabs. Sources: `src/renderer/shared/ui/atoms/Pill.css`, `src/renderer/features/conversation/components/ConversationHeader.css`.

## Borders and shadows
- 1px borders, raised selected surface with strong border. Source: `src/renderer/features/chats/components/ChatListItem.css`.
- No shadows declared in the inspected components. Artboards use no shadows.

## Component rules
- Chats own their helpers and task lists. Never imply a global helper list.
- Chat / Helpers tab group uses accent for selected state. Source: `src/renderer/features/conversation/components/ConversationHeader.css`.
- Task card moves beside chat at 1100px and above composer below that. Source: `src/renderer/features/conversation/ConversationContainer.css`.
- Text input has an accent focus boundary. Source: `src/renderer/shared/ui/atoms/TextField.css`. Boards additionally provide a visible focus outline.
- Working: amber; waiting: blue; done: green; failed: red. Source: `src/renderer/shared/ui/atoms/Pill.css`. Always pair color with text.
- Helpers Stop is unavailable in the current RPC interface. Do not show an enabled Stop action.
- Mock content is explicitly labeled as local prototype data. No simulated model response is presented as a real run.
- App-wide workspaces, model pickers and ODD phase controls are outside these proposals.
