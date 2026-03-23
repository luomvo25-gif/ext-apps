---
title: Troubleshooting
group: Getting Started
description: Diagnose common issues with MCP Apps — blank iframes, CSP errors, missing tool callbacks, and cross-host rendering differences.
---

# Troubleshooting

## The App renders a blank iframe

This is almost always one of four things. Check them in order:

**1. Open the browser developer console inside the iframe.** Right-click inside the App area → _Inspect_, then switch the console's context dropdown (top-left of the Console tab) from `top` to the sandboxed iframe. Any uncaught JavaScript error will stop your App before it paints.

**2. Check for CSP violations.** Look for `Refused to connect to…` or `Refused to load…` messages. If your App fetches anything over the network — including `localhost` during development — you must declare it in `_meta.ui.csp.connectDomains` or `resourceDomains`. See the [CSP & CORS guide](./csp-cors.md).

**3. Verify the resource URI matches exactly.** The `_meta.ui.resourceUri` on your tool must be character-for-character identical to the URI you registered with `registerAppResource` (or `server.registerResource`). A trailing slash or case mismatch means the host can't find your HTML.

**4. Verify the MIME type.** The resource's `mimeType` must be `text/html;profile=mcp-app` (exported as {@link app!RESOURCE_MIME_TYPE `RESOURCE_MIME_TYPE`}). Plain `text/html` won't be recognized as an App.

## `ontoolinput` / `ontoolresult` never fires

- **Register handlers before calling `connect()`.** If you attach `app.ontoolresult = …` after `connect()` resolves, the notification may have already been delivered and discarded. The React `useApp` hook handles this for you; with vanilla JS, set handlers first.
- **Check the host actually called your tool.** If the model chose a different tool (or none), there's no result to deliver. Verify in the host's tool-call log.
- **Check SDK version compatibility.** Older SDK versions had stricter schemas for host notifications. If your App was built against a significantly older `@modelcontextprotocol/ext-apps` than the host expects, the initialize handshake may silently fail. Keep the SDK version reasonably current.

## The App works in one host but not another

MCP Apps are portable by design, but only if you stick to the SDK. Common portability mistakes:

- **Relying on host-specific globals.** Don't reference `window.openai`, `window.claude`, or any other host-injected object. Use the `App` class from this SDK — it speaks the standard protocol to any compliant host.
- **Hardcoding asset URLs to a specific host's CDN.** Bundle your assets or declare them in `resourceDomains`.
- **Assuming a specific sandbox origin.** The origin that serves your App varies by host. Don't hardcode it in CORS allowlists; use `_meta.ui.domain` to request a stable origin instead (see [CSP & CORS](./csp-cors.md)).

## The App keeps growing taller / has the wrong height

See [Controlling App height](./patterns.md#controlling-app-height). The usual culprit is `height: 100vh` combined with the default `autoResize: true`.

## Network requests fail with CORS errors

CSP and CORS are separate controls:

- **CSP** (`Refused to connect`) — the _browser_ blocked the request because the domain isn't in `connectDomains`. Fix on the MCP server side by adding the domain to `_meta.ui.csp`.
- **CORS** (`No 'Access-Control-Allow-Origin' header`) — the _API server_ rejected the request because it doesn't recognize the sandbox origin. Fix on the API server side by allowlisting the origin, or use `_meta.ui.domain` to get a predictable origin you can allowlist.

See the [CSP & CORS guide](./csp-cors.md) for configuration examples.

## The App's background is opaque when it should be transparent

If you set `color-scheme: light dark` (or just `dark`) on your document, browsers may insert an opaque backdrop behind the iframe when the host's color scheme doesn't match. Remove the `color-scheme` declaration and use the `[data-theme]` attribute pattern from the [host context guide](./patterns.md#adapting-to-host-context-theme-styling-fonts-and-safe-areas) instead.

## Where to get help

- Test against the reference host: `npm start` in this repo serves `examples/basic-host` at `http://localhost:8080`, which logs all protocol traffic to the console.
- Check the [GitHub Discussions](https://github.com/modelcontextprotocol/ext-apps/discussions) for similar issues.
- File a bug with a minimal reproduction in [GitHub Issues](https://github.com/modelcontextprotocol/ext-apps/issues).
