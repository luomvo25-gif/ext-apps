# MCP Apps Best Practices: Patterns and Pitfalls

> Slide-by-slide transcript. Speaker notes prefixed with `>` blocks.
> Slides: https://docs.google.com/presentation/d/1xjtUusG1gl-c0lNZFZr4BfM_3InaxzpL0v1gMxRAeBk/

<!-- TODO: re-export slides as txt and merge inline with `gh pr edit` once gdrive auth restored -->

---

## Intro

**[Anton]** Every agent is driven by tools. MCP Apps are what happens when a tool decides it has something to _show_ you, not just tell you.

**[Olivier]** Views are the tip of the agentic iceberg for user interactions — but they're still part of, and connected to, the underground machinery of tools, resources, and model context. This talk is about that connection.

---

## Streaming

**[Anton]**

Demo: **Excalidraw**. Watch the diagram appear stroke by stroke as the model generates it.

What's happening: the model is producing tool arguments, and we're rendering them _while it's still thinking_. The mechanism is `ontoolinputpartial`:

```typescript
app.ontoolinputpartial = (partial) => {
  // partial.arguments is "healed" JSON — always parseable,
  // but the last array item may be truncated. Preview only.
  renderPreview(partial.arguments);
};
```

> Spreadsheet demo as backup if Excalidraw misbehaves on conference wifi.

See [Lowering perceived latency](../../patterns.md#lowering-perceived-latency).

---

## The Readme tool

**[Anton]**

A skill can ship its own README as a tool. The model calls it once to learn how the server works, then uses that knowledge for the rest of the conversation. Self-documenting servers.

> Candidate for cut if we're tight on time — weakest signal/time ratio.

---

## Interaction with the widget — "view-side tools"

**[Olivier]**

Demo: **PDF server**.

User asks "show me this PDF." Tool fires, PDF renders in an iframe. So far so normal. But now the user scrolls to page 12 and asks "what's this diagram?"

The model knows which page they're on. How? The app told it:

```typescript
app.updateModelContext({
  content: [{ type: "text", text: "User is viewing page 12 of 47" }],
});
```

The PDF bytes never went through the model. They went through an **app-only tool** — a tool with `_meta.ui.visibility: ["app"]` that the model doesn't even see in its tool list. The app calls it directly to fetch chunks:

```typescript
const chunk = await app.callServerTool({
  name: "pdf_get_chunk",
  arguments: { offset, length: 64_000 },
});
```

> If "Tools for Apps" protocol update lands before the talk, hint at it here — otherwise stick to the command-queue pattern (caveat: requires stateful server or stdio).

See [Tools that are private to Apps](../../patterns.md#tools-that-are-private-to-apps) and [Reading large amounts of data via chunked tool calls](../../patterns.md#reading-large-amounts-of-data-via-chunked-tool-calls).

---

## Tool results — where do your bytes go?

**[Olivier]**

A tool result has more shelves than people realize. Diagram slide:

| Field               | Goes to           | Use for                                  |
| ------------------- | ----------------- | ---------------------------------------- |
| `content[]`         | Model **and** App | What you'd say out loud                  |
| `structuredContent` | Model **and** App | Typed data the model reasons about       |
| `_meta`             | App **only**      | Side-channel: cursors, widgetUUID, blobs |
| `isError: true`     | Model             | "Something went wrong, here's why"       |

And separately, from the _app_ side:

| Method                 | Goes to              | Use for                         |
| ---------------------- | -------------------- | ------------------------------- |
| `updateModelContext()` | Model                | App state the model should know |
| `sendMessage()`        | Model (as user turn) | Triggering a follow-up          |

> The pitfall: stuffing binary into `structuredContent` bloats model context. Put it in `_meta` or fetch it via app-only tool.

See [Passing contextual information from the App to the model](../../patterns.md#passing-contextual-information-from-the-app-to-the-model) and [Sending large follow-up messages](../../patterns.md#sending-large-follow-up-messages).

---

## Dude, can you even fetch?

**[Olivier]**

Two worlds.

**Non-authenticated data:** business as usual. `fetch()`, WebSockets, all the normal web stuff. You configure CSP via `_meta.ui.csp` to allowlist the origins, and `_meta.ui.domain` gives your iframe a stable origin for CORS.

> Side note: if your app already exists as a web page, you get the MCP App version _for the same price_ — iframe embed plus a thin SDK wrapper. We should document this in the official patterns. <!-- TODO: file issue / add to patterns.md -->

**Authenticated data:** tools. The MCP server already has the user's credentials; the app calls server tools to fetch on its behalf. No cookies in the iframe, no OAuth dance in the sandbox.

See [Polling for live data](../../patterns.md#polling-for-live-data), [Serving binary blobs via resources](../../patterns.md#serving-binary-blobs-via-resources), and [Configuring CSP and CORS](../../patterns.md#configuring-csp-and-cors).

---

## Persisting view state

**[Olivier]**

The server mints a UUID, returns it in the tool result's `_meta`. The app uses it as a `localStorage` key:

```typescript
app.ontoolresult = (result) => {
  const key = `view:${result._meta.widgetUUID}`;
  const saved = localStorage.getItem(key);
  if (saved) restoreState(JSON.parse(saved));
};
```

Reload the conversation, your map camera is where you left it. Works client-side or server-side (the UUID keys server storage too).

> A SEP for first-class persistence is in the works — mention if it's public by talk time.

See [Persisting view state](../../patterns.md#persisting-view-state).

---

## Perceived latency

**[Olivier]**

Callback to streaming: `ontoolinputpartial` lets you show _something_ before the model finishes thinking.

Another trick: tool returns a task ID immediately, app polls for completion. The model moves on; the spinner is the app's problem.

See [Lowering perceived latency](../../patterns.md#lowering-perceived-latency).

---

## Making it look good everywhere

**[Anton]**

One slide, three things:

1. **Theme:** the host sets `[data-theme="dark"]` and CSS vars like `--color-background-primary`, `--font-sans`. Use them.
2. **Safe areas:** `getHostContext().safeAreaInsets` — pad accordingly, especially on mobile.
3. **Fullscreen:** `requestDisplayMode()`, listen on `onhostcontextchanged`, drop your border-radius.

Hosts that support this today: Claude (web/desktop/mobile), VS Code Copilot, Goose, Postman, MCPJam, Cursor.

See [Adapting to host context](../../patterns.md#adapting-to-host-context-theme-styling-fonts-and-safe-areas) and [Entering / exiting fullscreen](../../patterns.md#entering--exiting-fullscreen).

---

## Pitfall speedrun

**[Both]**

Five things that will waste an afternoon:

1. **Handlers after `connect()`** → you miss the initial `ontoolresult`. Register first, connect second.
2. **CSP silently blocking** → external scripts 404, no error in your code, only in the browser console nobody opens.
3. **`_meta.ui.resourceUri` typo** → tool works, no UI renders, no error. Check the URI matches what you registered.
4. **Partial JSON treated as final** → `ontoolinputpartial` gives you healed JSON; the last array item may be a fragment. Preview-only.
5. **Relative asset paths inside the iframe** → use `vite-plugin-singlefile` or configure CSP for your CDN. Relative paths resolve against `about:srcdoc`.

---

## Reveal

**[Anton]**

Demo: **Imagine**.

> "This thing you've been using? It's an MCP App." Only on Claude.ai today — but it's the same protocol you can build against. This is what's possible when host and app are co-designed.

---

## Links

- Patterns guide: https://apps.extensions.modelcontextprotocol.io/api/documents/patterns.html
- This talk: https://github.com/modelcontextprotocol/ext-apps/tree/main/docs/talks/mcp-dev-summit-2026
- `/create-mcp-app` skill: scaffolds everything above
