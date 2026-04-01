# MCP Apps Best Practices: Patterns and Pitfalls

**MCP Dev Summit North America 2026** · Thursday April 2, 2:35–3:00pm EDT · Juliard Complex
**Speakers:** Olivier Chafik & Anton Pidkuiko, Anthropic

> MCP Apps open a new world of possibilities for interactions in AI chats. While [SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) defines how they work, this talk is about how to build them well.

This directory contains the source material for the talk. The patterns referenced here are documented in full at [docs/patterns.md](../../patterns.md).

## Contents

- [`transcript.md`](./transcript.md) — Slide-by-slide walkthrough with speaker notes
- Slides: [Google Slides](https://docs.google.com/presentation/d/1xjtUusG1gl-c0lNZFZr4BfM_3InaxzpL0v1gMxRAeBk/) · [PDF export TODO]
- Recording: TBD (post-conference)

## Demos referenced

| Demo                 | Example server                                                       | What it shows                                         |
| -------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- |
| Excalidraw streaming | —                                                                    | `ontoolinputpartial` progressive rendering            |
| PDF interaction      | [`examples/pdf-server`](../../../examples/pdf-server/)               | Chunked loading, app-only tools, `updateModelContext` |
| Shadertoy            | [`examples/shadertoy-server`](../../../examples/shadertoy-server/)   | `IntersectionObserver` pause, fullscreen              |
| Map server           | [`examples/map-server`](../../../examples/map-server/)               | State persistence via `widgetUUID`                    |
| Transcript follow-up | [`examples/transcript-server`](../../../examples/transcript-server/) | Large context → `sendMessage` pattern                 |
