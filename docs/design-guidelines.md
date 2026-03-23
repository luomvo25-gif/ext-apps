---
title: Design Guidelines
group: Getting Started
description: UX guidance for MCP Apps — what the host already provides, how to size your content, and how to stay visually consistent with the surrounding chat.
---

# Design Guidelines

MCP Apps live inside a conversation. They should feel like a natural part of the chat, not a separate application wedged into it.

## The host provides the chrome

Hosts typically render a frame around your App that includes:

- A **title bar** showing your App's name (from the tool or server metadata)
- **Display-mode controls** (expand to fullscreen, collapse, close)
- **Attribution** (which connector/server the App came from)

**Don't duplicate these.** Your App doesn't need its own close button, title header, or "powered by" footer. Start your layout with the actual content.

If you need a title _inside_ your content (e.g., "Q3 Revenue by Region" above a chart), that's fine — just don't put your App's brand name there.

## Keep it focused

An MCP App answers one question or supports one task. Resist the urge to build a full dashboard with tabs, sidebars, and settings panels.

Good heuristics:

- **Inline mode should fit in roughly one screen of scroll.** If your content is much taller than the chat viewport, consider whether it belongs in fullscreen mode — or whether you're showing too much.
- **One primary action at most.** A "Confirm" button is fine. A toolbar with eight icons is probably too much for inline mode.
- **Let the conversation drive navigation.** Instead of building a search box inside your App, let the user ask a follow-up question and re-invoke the tool with new arguments.

## Don't replicate the host's UI

Your App must not look like the surrounding chat client. Specifically, avoid:

- Rendering fake chat bubbles or message threads
- Mimicking the host's input box or send button
- Showing fake system notifications or permission dialogs

These patterns confuse users about what's real host UI versus App content, and most hosts prohibit them in their submission guidelines.

## Use host styling where possible

Hosts provide CSS custom properties for colors, fonts, spacing, and border radius (see [Adapting to host context](./patterns.md#adapting-to-host-context-theme-styling-fonts-and-safe-areas)). Using them makes your App feel native across light mode, dark mode, and different host themes.

You can bring your own brand colors for content (chart series, status badges), but let the host's variables drive backgrounds, text, and borders. Always provide fallback values so your App still renders reasonably on hosts that don't supply every variable.

## Inline vs fullscreen layout

Design for **inline first** — that's where your App appears by default. Inline mode is narrow (often the width of a chat message) and height-constrained.

Treat **fullscreen** as a progressive enhancement for Apps that benefit from more space (editors, maps, large datasets). Check `hostContext.availableDisplayModes` before showing a fullscreen toggle — not every host supports it.

When switching modes, remember to adjust your layout: remove border radius at the edges, expand to fill the viewport, and re-read `containerDimensions` from the updated host context.

## Handle the empty and loading states

Your App mounts before the tool result arrives. Between `ui/initialize` and `ontoolresult`, show something — a skeleton, a spinner, or at minimum a neutral background. A blank white rectangle looks broken.

Similarly, if your tool result can be empty (no search results, no items in cart), design a clear empty state rather than rendering nothing.
