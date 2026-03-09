import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createPdfCache,
  createServer,
  validateUrl,
  isAncestorDir,
  allowedLocalFiles,
  allowedLocalDirs,
  pathToFileUrl,
  startFileWatch,
  stopFileWatch,
  cliLocalFiles,
  isWritablePath,
  CACHE_INACTIVITY_TIMEOUT_MS,
  CACHE_MAX_LIFETIME_MS,
  CACHE_MAX_PDF_SIZE_BYTES,
  type PdfCache,
} from "./server";

describe("PDF Cache with Timeouts", () => {
  let pdfCache: PdfCache;

  beforeEach(() => {
    // Each test gets its own session-local cache
    pdfCache = createPdfCache();
  });

  afterEach(() => {
    pdfCache.clearCache();
  });

  describe("cache configuration", () => {
    it("should have 10 second inactivity timeout", () => {
      expect(CACHE_INACTIVITY_TIMEOUT_MS).toBe(10_000);
    });

    it("should have 60 second max lifetime timeout", () => {
      expect(CACHE_MAX_LIFETIME_MS).toBe(60_000);
    });

    it("should have 50MB max PDF size limit", () => {
      expect(CACHE_MAX_PDF_SIZE_BYTES).toBe(50 * 1024 * 1024);
    });
  });

  describe("cache management", () => {
    it("should start with empty cache", () => {
      expect(pdfCache.getCacheSize()).toBe(0);
    });

    it("should clear all entries", () => {
      pdfCache.clearCache();
      expect(pdfCache.getCacheSize()).toBe(0);
    });

    it("should isolate caches between sessions", () => {
      // Create two independent cache instances
      const cache1 = createPdfCache();
      const cache2 = createPdfCache();

      // They should be independent (both start empty)
      expect(cache1.getCacheSize()).toBe(0);
      expect(cache2.getCacheSize()).toBe(0);
    });
  });

  describe("readPdfRange caching behavior", () => {
    const testUrl = "https://arxiv.org/pdf/test-pdf";
    const testData = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF header

    it("should cache full body when server returns HTTP 200", async () => {
      // Mock fetch to return HTTP 200 (full body, no range support)
      const mockFetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(testData, {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      );

      try {
        // First request - should fetch and cache
        const result1 = await pdfCache.readPdfRange(testUrl, 0, 1024);
        expect(result1.data).toEqual(testData);
        expect(result1.totalBytes).toBe(testData.length);
        expect(pdfCache.getCacheSize()).toBe(1);

        // Second request - should serve from cache (no new fetch)
        const result2 = await pdfCache.readPdfRange(testUrl, 0, 1024);
        expect(result2.data).toEqual(testData);
        expect(mockFetch).toHaveBeenCalledTimes(1); // Only one fetch call
      } finally {
        mockFetch.mockRestore();
      }
    });

    it("should not cache when server returns HTTP 206 (range supported)", async () => {
      const chunkData = new Uint8Array([0x25, 0x50]); // First 2 bytes

      const mockFetch = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(chunkData, {
          status: 206,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Range": "bytes 0-1/100",
          },
        }),
      );

      try {
        await pdfCache.readPdfRange(testUrl, 0, 2);
        expect(pdfCache.getCacheSize()).toBe(0); // Not cached when 206
      } finally {
        mockFetch.mockRestore();
      }
    });

    it("should slice cached data for subsequent range requests", async () => {
      const fullData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      const mockFetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(fullData, { status: 200 }),
      );

      try {
        // First request caches full body
        await pdfCache.readPdfRange(testUrl, 0, 1024);
        expect(pdfCache.getCacheSize()).toBe(1);

        // Subsequent request gets slice from cache
        const result = await pdfCache.readPdfRange(testUrl, 2, 3);
        expect(result.data).toEqual(new Uint8Array([3, 4, 5]));
        expect(result.totalBytes).toBe(10);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        mockFetch.mockRestore();
      }
    });

    it("should fall back to GET when server returns 501 for Range request", async () => {
      const fullData = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

      const mockFetch = spyOn(globalThis, "fetch")
        // First call: Range request returns 501
        .mockResolvedValueOnce(
          new Response("Unsupported client Range", { status: 501 }),
        )
        // Second call: plain GET returns full body
        .mockResolvedValueOnce(
          new Response(fullData, {
            status: 200,
            headers: { "Content-Type": "application/pdf" },
          }),
        );

      try {
        const result = await pdfCache.readPdfRange(testUrl, 0, 1024);
        expect(result.data).toEqual(fullData);
        expect(result.totalBytes).toBe(fullData.length);
        expect(pdfCache.getCacheSize()).toBe(1);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        mockFetch.mockRestore();
      }
    });

    it("should reject PDFs larger than max size limit", async () => {
      const hugeUrl = "https://arxiv.org/pdf/huge-pdf";
      // Create data larger than the limit
      const hugeData = new Uint8Array(CACHE_MAX_PDF_SIZE_BYTES + 1);

      const mockFetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(hugeData, {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      );

      try {
        await expect(pdfCache.readPdfRange(hugeUrl, 0, 1024)).rejects.toThrow(
          /PDF too large to cache/,
        );
        expect(pdfCache.getCacheSize()).toBe(0); // Should not be cached
      } finally {
        mockFetch.mockRestore();
      }
    });

    it("should reject when Content-Length header exceeds limit", async () => {
      const headerUrl = "https://arxiv.org/pdf/huge-pdf-header";
      const smallData = new Uint8Array([1, 2, 3, 4]);

      const mockFetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(smallData, {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Length": String(CACHE_MAX_PDF_SIZE_BYTES + 1),
          },
        }),
      );

      try {
        await expect(pdfCache.readPdfRange(headerUrl, 0, 1024)).rejects.toThrow(
          /PDF too large to cache/,
        );
        expect(pdfCache.getCacheSize()).toBe(0);
      } finally {
        mockFetch.mockRestore();
      }
    });
  });

  // Note: Timer-based tests (inactivity/max lifetime) would require
  // using fake timers which can be complex with async code.
  // The timeout behavior is straightforward and can be verified
  // through manual testing or E2E tests.
});

describe("validateUrl with MCP roots (allowedLocalDirs)", () => {
  const savedFiles = new Set(allowedLocalFiles);
  const savedDirs = new Set(allowedLocalDirs);

  beforeEach(() => {
    allowedLocalFiles.clear();
    allowedLocalDirs.clear();
  });

  afterEach(() => {
    allowedLocalFiles.clear();
    allowedLocalDirs.clear();
    for (const f of savedFiles) allowedLocalFiles.add(f);
    for (const d of savedDirs) allowedLocalDirs.add(d);
  });

  it("should allow a file under an allowed directory", () => {
    // Use a real existing directory+file for the existsSync check
    const dir = path.resolve(import.meta.dirname);
    allowedLocalDirs.add(dir);

    const filePath = path.join(dir, "server.ts");
    const result = validateUrl(pathToFileUrl(filePath));
    expect(result.valid).toBe(true);
  });

  it("should reject a file outside allowed directories", () => {
    allowedLocalDirs.add("/some/allowed/dir");

    const result = validateUrl("file:///other/dir/test.pdf");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not in allowed list");
  });

  it("should prevent prefix-based directory traversal", () => {
    // /tmp/safe should NOT allow /tmp/safevil/file.pdf
    allowedLocalDirs.add("/tmp/safe");

    const result = validateUrl("file:///tmp/safevil/file.pdf");
    expect(result.valid).toBe(false);
  });

  it("should still allow exact file matches from allowedLocalFiles", () => {
    const filePath = path.resolve(import.meta.dirname, "server.ts");
    allowedLocalFiles.add(filePath);

    const result = validateUrl(pathToFileUrl(filePath));
    expect(result.valid).toBe(true);
  });

  it("should reject non-existent file even if under allowed dir", () => {
    const dir = path.resolve(import.meta.dirname);
    allowedLocalDirs.add(dir);

    const result = validateUrl(
      pathToFileUrl(path.join(dir, "nonexistent-file.pdf")),
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("File not found");
  });

  it("should allow a file under an allowed dir with trailing slash", () => {
    const dir = path.resolve(import.meta.dirname);
    // Simulate a dir stored with a trailing slash (e.g. from CLI path)
    allowedLocalDirs.add(dir + "/");

    const filePath = path.join(dir, "server.ts");
    const result = validateUrl(pathToFileUrl(filePath));
    expect(result.valid).toBe(true);
  });

  it("should allow a file under a grandparent allowed dir", () => {
    // Allow a directory two levels up from the file
    const grandparent = path.resolve(path.join(import.meta.dirname, ".."));
    allowedLocalDirs.add(grandparent);

    const filePath = path.join(import.meta.dirname, "server.ts");
    const result = validateUrl(pathToFileUrl(filePath));
    expect(result.valid).toBe(true);
  });

  it("should accept computer:// URLs as local files", () => {
    const dir = path.resolve(import.meta.dirname);
    allowedLocalDirs.add(dir);

    const filePath = path.join(dir, "server.ts");
    const encoded = encodeURIComponent(filePath).replace(/%2F/g, "/");
    const result = validateUrl(`computer://${encoded}`);
    expect(result.valid).toBe(true);
  });

  it("should accept bare absolute paths as local files", () => {
    const dir = path.resolve(import.meta.dirname);
    allowedLocalDirs.add(dir);

    const filePath = path.join(dir, "server.ts");
    const result = validateUrl(filePath);
    expect(result.valid).toBe(true);
  });

  it("should decode percent-encoded bare paths (e.g. %20 for spaces)", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf test "));
    const testFile = path.join(tmpDir, "file.txt");

    try {
      fs.writeFileSync(testFile, "hello");
      allowedLocalDirs.add(tmpDir);

      // Encode spaces as %20 in the path (as some clients do)
      const encoded = testFile.replace(/ /g, "%20");
      const result = validateUrl(encoded);
      expect(result.valid).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("should allow file accessed via symlink when real dir is allowed", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-test-"));
    const realDir = path.join(tmpDir, "real");
    const linkDir = path.join(tmpDir, "link");
    const testFile = path.join(realDir, "test.txt");

    try {
      fs.mkdirSync(realDir);
      fs.writeFileSync(testFile, "hello");
      fs.symlinkSync(realDir, linkDir);

      // Allow the REAL directory
      allowedLocalDirs.add(realDir);

      // Access via the SYMLINK path — should still be allowed
      const symlinkPath = path.join(linkDir, "test.txt");
      const result = validateUrl(symlinkPath);
      expect(result.valid).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("should allow file when allowed dir is a symlink to real parent", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-test-"));
    const realDir = path.join(tmpDir, "real");
    const linkDir = path.join(tmpDir, "link");
    const testFile = path.join(realDir, "test.txt");

    try {
      fs.mkdirSync(realDir);
      fs.writeFileSync(testFile, "hello");
      fs.symlinkSync(realDir, linkDir);

      // Allow the SYMLINK directory
      allowedLocalDirs.add(linkDir);

      // Access via the REAL path — should still be allowed
      const result = validateUrl(testFile);
      expect(result.valid).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe("isAncestorDir", () => {
  it("should return true for a direct child", () => {
    expect(isAncestorDir("/Users/test/dir", "/Users/test/dir/file.pdf")).toBe(
      true,
    );
  });

  it("should return true for a nested child", () => {
    expect(isAncestorDir("/Users/test", "/Users/test/sub/dir/file.pdf")).toBe(
      true,
    );
  });

  it("should return false for a file outside the dir", () => {
    expect(isAncestorDir("/Users/test/dir", "/Users/test/other/file.pdf")).toBe(
      false,
    );
  });

  it("should return false for the dir itself", () => {
    expect(isAncestorDir("/Users/test/dir", "/Users/test/dir")).toBe(false);
  });

  it("should prevent .. traversal", () => {
    expect(
      isAncestorDir("/Users/test/dir", "/Users/test/dir/../other/file.pdf"),
    ).toBe(false);
  });

  it("should prevent prefix-based traversal", () => {
    // /tmp/safe should NOT match /tmp/safevil/file.pdf
    expect(isAncestorDir("/tmp/safe", "/tmp/safevil/file.pdf")).toBe(false);
  });

  it("should handle dirs with trailing slash", () => {
    expect(isAncestorDir("/Users/test/dir/", "/Users/test/dir/file.pdf")).toBe(
      true,
    );
  });
});

describe("createServer useClientRoots option", () => {
  it("should not set up roots handlers by default", () => {
    const server = createServer();
    // When useClientRoots is false (default), oninitialized should NOT
    // be overridden by our roots logic.
    expect(server.server.oninitialized).toBeUndefined();
    server.close();
  });

  it("should not set up roots handlers when useClientRoots is false", () => {
    const server = createServer({ useClientRoots: false });
    expect(server.server.oninitialized).toBeUndefined();
    server.close();
  });

  it("should set up roots handlers when useClientRoots is true", () => {
    const server = createServer({ useClientRoots: true });
    // When useClientRoots is true, oninitialized should be set to
    // the roots refresh handler.
    expect(server.server.oninitialized).toBeFunction();
    server.close();
  });
});

describe("isWritablePath", () => {
  let savedFiles: Set<string>;
  let savedDirs: Set<string>;
  let savedCli: Set<string>;

  beforeEach(() => {
    savedFiles = new Set(allowedLocalFiles);
    savedDirs = new Set(allowedLocalDirs);
    savedCli = new Set(cliLocalFiles);
    allowedLocalFiles.clear();
    allowedLocalDirs.clear();
    cliLocalFiles.clear();
  });

  afterEach(() => {
    allowedLocalFiles.clear();
    allowedLocalDirs.clear();
    cliLocalFiles.clear();
    for (const x of savedFiles) allowedLocalFiles.add(x);
    for (const x of savedDirs) allowedLocalDirs.add(x);
    for (const x of savedCli) cliLocalFiles.add(x);
  });

  it("nothing is writable when no roots and no CLI files", () => {
    expect(isWritablePath("/any/path/file.pdf")).toBe(false);
  });

  it("CLI file is writable", () => {
    allowedLocalFiles.add("/tmp/explicit.pdf");
    cliLocalFiles.add("/tmp/explicit.pdf");
    expect(isWritablePath("/tmp/explicit.pdf")).toBe(true);
  });

  it("MCP file root is NOT writable", () => {
    allowedLocalFiles.add("/tmp/uploaded.pdf"); // from refreshRoots, no CLI
    expect(isWritablePath("/tmp/uploaded.pdf")).toBe(false);
  });

  it("file under a directory root at any depth is writable", () => {
    allowedLocalDirs.add("/home/user/docs");
    expect(isWritablePath("/home/user/docs/file.pdf")).toBe(true);
    expect(isWritablePath("/home/user/docs/sub/deep/file.pdf")).toBe(true);
  });

  it("the directory root itself is NOT writable", () => {
    allowedLocalDirs.add("/home/user/docs");
    expect(isWritablePath("/home/user/docs")).toBe(false);
  });

  it("MCP file root stays read-only even when under a directory root", () => {
    // Client sent BOTH the directory and a file inside it as roots.
    // The explicit file-root is the stronger signal: treat as upload.
    allowedLocalDirs.add("/home/user/docs");
    allowedLocalFiles.add("/home/user/docs/uploaded.pdf");
    expect(isWritablePath("/home/user/docs/uploaded.pdf")).toBe(false);
    // Siblings not sent as file roots remain writable
    expect(isWritablePath("/home/user/docs/other.pdf")).toBe(true);
  });

  it("CLI file wins even if also in allowedLocalFiles", () => {
    // CLI file added to both sets (main.ts does this)
    allowedLocalFiles.add("/tmp/cli.pdf");
    cliLocalFiles.add("/tmp/cli.pdf");
    expect(isWritablePath("/tmp/cli.pdf")).toBe(true);
  });

  it("file outside any directory root is not writable", () => {
    allowedLocalDirs.add("/home/user/docs");
    expect(isWritablePath("/home/user/other/file.pdf")).toBe(false);
    expect(isWritablePath("/home/user/docsevil/file.pdf")).toBe(false);
  });
});

describe("file watching", () => {
  let tmpDir: string;
  let tmpFile: string;
  const uuid = "test-watch-uuid";

  // Long-poll timeout is 30s — tests that poll must complete sooner.
  const pollWithTimeout = async (
    client: Client,
    timeoutMs = 5000,
  ): Promise<{ type: string; mtimeMs?: number }[]> => {
    const result = await Promise.race([
      client.callTool({
        name: "poll_pdf_commands",
        arguments: { viewUUID: uuid },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("poll timeout")), timeoutMs),
      ),
    ]);
    return (
      ((result as { structuredContent?: { commands?: unknown[] } })
        .structuredContent?.commands as { type: string; mtimeMs?: number }[]) ??
      []
    );
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-watch-"));
    tmpFile = path.join(tmpDir, "test.pdf");
    fs.writeFileSync(tmpFile, Buffer.from("%PDF-1.4\n%test\n"));
    allowedLocalFiles.add(tmpFile);
    cliLocalFiles.add(tmpFile); // save_pdf test needs write scope
  });

  afterEach(() => {
    stopFileWatch(uuid);
    allowedLocalFiles.delete(tmpFile);
    cliLocalFiles.delete(tmpFile);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enqueues file_changed after external write", async () => {
    const server = createServer({ enableInteract: true });
    const client = new Client({ name: "t", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    startFileWatch(uuid, tmpFile);
    await new Promise((r) => setTimeout(r, 50)); // let watcher settle

    fs.writeFileSync(tmpFile, Buffer.from("%PDF-1.4\n%changed\n"));

    const cmds = await pollWithTimeout(client);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].type).toBe("file_changed");
    expect(cmds[0].mtimeMs).toBeGreaterThan(0);

    await client.close();
    await server.close();
  });

  it("debounces rapid writes into one command", async () => {
    const server = createServer({ enableInteract: true });
    const client = new Client({ name: "t", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    startFileWatch(uuid, tmpFile);
    await new Promise((r) => setTimeout(r, 50));

    fs.writeFileSync(tmpFile, Buffer.from("%PDF-1.4\n%a\n"));
    fs.writeFileSync(tmpFile, Buffer.from("%PDF-1.4\n%b\n"));
    fs.writeFileSync(tmpFile, Buffer.from("%PDF-1.4\n%c\n"));

    const cmds = await pollWithTimeout(client);
    expect(cmds).toHaveLength(1);

    await client.close();
    await server.close();
  });

  it("stopFileWatch prevents further commands", async () => {
    const server = createServer({ enableInteract: true });
    const client = new Client({ name: "t", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    startFileWatch(uuid, tmpFile);
    await new Promise((r) => setTimeout(r, 50));
    stopFileWatch(uuid);

    fs.writeFileSync(tmpFile, Buffer.from("%PDF-1.4\n%x\n"));

    // Debounce window + margin — no event should fire
    await new Promise((r) => setTimeout(r, 300));

    // Poll should block (long-poll) → timeout here means no command was queued
    await expect(pollWithTimeout(client, 500)).rejects.toThrow("poll timeout");

    await client.close();
    await server.close();
  });

  it("save_pdf returns mtimeMs in structuredContent", async () => {
    const server = createServer({ enableInteract: true });
    const client = new Client({ name: "t", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const before = fs.statSync(tmpFile).mtimeMs;
    // Ensure mtime will differ on coarse-granularity filesystems
    await new Promise((r) => setTimeout(r, 10));

    const r = await client.callTool({
      name: "save_pdf",
      arguments: {
        url: tmpFile,
        data: Buffer.from("%PDF-1.4\nnew").toString("base64"),
      },
    });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as { filePath: string; mtimeMs: number };
    expect(sc.filePath).toBe(tmpFile);
    expect(sc.mtimeMs).toBeGreaterThanOrEqual(before);

    await client.close();
    await server.close();
  });

  it("save_pdf refuses file roots from MCP client (not CLI)", async () => {
    // Simulate: file is readable (in allowedLocalFiles via refreshRoots)
    // but NOT in cliLocalFiles — it came from the client, not a CLI arg.
    cliLocalFiles.delete(tmpFile);

    const server = createServer({ enableInteract: true });
    const client = new Client({ name: "t", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const original = fs.readFileSync(tmpFile);
    const r = await client.callTool({
      name: "save_pdf",
      arguments: {
        url: tmpFile,
        data: Buffer.from("%PDF-1.4\nshould-not-write").toString("base64"),
      },
    });
    expect(r.isError).toBe(true);
    const text = (r.content as { text: string }[])[0].text;
    expect(text).toContain("read-only");
    // Verify the file was NOT modified
    expect(fs.readFileSync(tmpFile)).toEqual(original);

    await client.close();
    await server.close();
  });

  it("save_pdf allows files under a directory root", async () => {
    // File is under a mounted directory root — but NOT itself a file root
    // (a file root, even under a mounted dir, is read-only per isWritablePath).
    cliLocalFiles.delete(tmpFile);
    allowedLocalFiles.delete(tmpFile);
    allowedLocalDirs.add(tmpDir);

    const server = createServer({ enableInteract: true });
    const client = new Client({ name: "t", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const r = await client.callTool({
      name: "save_pdf",
      arguments: {
        url: tmpFile,
        data: Buffer.from("%PDF-1.4\nvia-dir-root").toString("base64"),
      },
    });
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(tmpFile, "utf8")).toBe("%PDF-1.4\nvia-dir-root");

    allowedLocalDirs.delete(tmpDir);
    await client.close();
    await server.close();
  });

  // fs.watch on a file that gets replaced via rename: on macOS (kqueue)
  // the watcher reliably fires a "rename" event which our re-attach logic
  // handles. On Linux (inotify), a watcher on the old inode often gets no
  // event at all — inotify watches inodes, and the rename just atomically
  // swaps the directory entry to a NEW inode. Directory-level watching
  // would fix this but isn't what we do. Skip on non-darwin.
  it.skipIf(process.platform !== "darwin")(
    "detects atomic rename (macOS kqueue only)",
    async () => {
      const server = createServer({ enableInteract: true });
      const client = new Client({ name: "t", version: "1" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), client.connect(ct)]);

      startFileWatch(uuid, tmpFile);
      await new Promise((r) => setTimeout(r, 50));

      // Simulate vim/vscode: write to temp, rename over original
      const tmpWrite = tmpFile + ".swp";
      fs.writeFileSync(tmpWrite, Buffer.from("%PDF-1.4\n%atomic\n"));
      fs.renameSync(tmpWrite, tmpFile);

      const cmds = await pollWithTimeout(client);
      expect(cmds).toHaveLength(1);
      expect(cmds[0].type).toBe("file_changed");

      await client.close();
      await server.close();
    },
  );
});
