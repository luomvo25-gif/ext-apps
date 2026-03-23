---
title: Design Guidelines
group: Getting Started
description: UX guidance for MCP Apps, covering host-provided chrome, content sizing, and visual consistency with the surrounding chat.
---

# Design Guidelines

An MCP App is part of a conversation. It should read as a continuation of the chat, not as a separate application embedded inside it.

## Host chrome

Hosts render a frame around your App that typically includes:

- A title bar showing the App name (from tool or server metadata)
- Display-mode controls (expand, collapse, close)
- Attribution indicating which connector or server provided the App

Do not duplicate these elements. Your App does not need its own close button, header bar, or "powered by" footer. Begin the layout with content.

A title inside the content area (for example, "Q3 Revenue by Region" above a chart) is acceptable. The App's brand name is not.

## Scope

An MCP App answers one question or supports one task. Avoid building a full dashboard with tabs, sidebars, and settings panels.

- Inline mode should fit within roughly one viewport of scroll. Content that is significantly taller than the chat viewport belongs in fullscreen mode, or should be trimmed.
- Limit inline mode to one primary action. A "Confirm" button is appropriate; a toolbar with eight icons is not.
- Let the conversation handle navigation. Rather than adding a search box inside the App, let the user ask a follow-up question that re-invokes the tool with new arguments.

## Host UI imitation

Your App must not resemble the surrounding chat client. Do not render:

- Chat bubbles or message threads
- Anything that resembles the host's text input or send button
- System notifications or permission dialogs

These patterns blur the line between host UI and App content, and most hosts prohibit them in their submission guidelines.

## Host styling

Hosts provide CSS custom properties for colors, fonts, spacing, and border radius (see [Adapting to host context](./patterns.md#adapting-to-host-context-theme-styling-fonts-and-safe-areas)). Using them keeps your App consistent across light mode, dark mode, and different host themes.

Brand colors are appropriate for content elements such as chart series or status badges. Backgrounds, text, and borders should use host variables. Always provide fallback values so the App renders correctly on hosts that omit some variables.

## Display modes

Design for inline mode first. It is the default, and it is narrow (often the width of a chat message) and height-constrained.

Treat fullscreen as a progressive enhancement for Apps that benefit from more space: editors, maps, large datasets. Check `hostContext.availableDisplayModes` before rendering a fullscreen toggle, since not every host supports it.

When the display mode changes, update your layout: remove edge border radius, expand to fill the viewport, and re-read `containerDimensions` from the updated host context.

## Loading and empty states

The App mounts before the tool result arrives. Between `ui/initialize` and `ontoolresult`, render a loading indicator such as a skeleton, spinner, or neutral background. A blank rectangle looks broken.

If the tool result can be empty (no search results, empty cart), design an explicit empty state rather than rendering nothing.
