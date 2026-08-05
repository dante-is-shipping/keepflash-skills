import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildToolCall,
  callToolWithAuthorizationRetry,
  formatCliError,
  getCredentialPath,
  login,
  logout,
  openBrowserUrl,
  parseMcpResponse,
  readCredential,
  resolveCredential,
  writeCredential,
} from "../scripts/keepflash.mjs";

function createTestToken(label) {
  return [["kf", "mcp", "live"].join("_"), label, "x".repeat(24)].join(
    "_",
  );
}

const FILE_TEST_TOKEN = createTestToken("fixture");
const LOGIN_TEST_TOKEN = createTestToken("login");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sequenceFetch(responses, calls = []) {
  return async (url, options) => {
    calls.push({ url: String(url), options });
    const response = responses.shift();
    if (!response) throw new Error("UNEXPECTED_FETCH");
    if (response instanceof Error) throw response;
    return response;
  };
}

async function withTempConfig(run) {
  const configHome = await mkdtemp(
    path.join(os.tmpdir(), "keepflash-skill-test-"),
  );
  try {
    await run(configHome);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
}

test("uses platform-specific credential paths", () => {
  assert.equal(
    getCredentialPath({
      platform: "darwin",
      homeDir: "/Users/ada",
      env: {},
    }),
    "/Users/ada/Library/Application Support/KeepFlash/credentials.json",
  );
  assert.equal(
    getCredentialPath({
      platform: "linux",
      homeDir: "/home/ada",
      env: { XDG_CONFIG_HOME: "/config" },
    }),
    "/config/keepflash/credentials.json",
  );
  assert.equal(
    getCredentialPath({
      platform: "win32",
      homeDir: "C:\\Users\\Ada",
      env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" },
    }),
    path.win32.join(
      "C:\\Users\\Ada\\AppData\\Roaming",
      "KeepFlash",
      "credentials.json",
    ),
  );
});

test("writes file credentials with user-only permissions", async () => {
  await withTempConfig(async (configHome) => {
    await writeCredential({
      credential: {
        token: FILE_TEST_TOKEN,
        baseUrl: "https://keepflash.com",
      },
      configHome,
      platform: "linux",
      env: {},
      homeDir: "/unused",
    });

    const credentialPath = getCredentialPath({
      configHome,
      platform: "linux",
      env: {},
      homeDir: "/unused",
    });
    const fileStat = await stat(credentialPath);
    const directoryStat = await stat(path.dirname(credentialPath));

    assert.equal(fileStat.mode & 0o777, 0o600);
    assert.equal(directoryStat.mode & 0o777, 0o700);
    assert.equal((await readCredential({ configHome })).token.startsWith("kf_"), true);
  });
});

test("login polls pending, stores the token, and never prints it", async () => {
  await withTempConfig(async (configHome) => {
    const output = [];
    const fetch = sequenceFetch([
      jsonResponse({
        device_code: "private-device",
        user_code: "KF-ABCD-EFGH",
        verification_uri: "https://keepflash.com/en/agent-access/authorize",
        verification_uri_complete:
          "https://keepflash.com/en/agent-access/authorize?code=KF-ABCD-EFGH",
        expires_in: 600,
        interval: 0,
      }),
      jsonResponse({ error: "authorization_pending" }, 400),
      jsonResponse({
        access_token: LOGIN_TEST_TOKEN,
        token_type: "Bearer",
        scope: "notes:read",
      }),
    ]);
    let openedUrl = "";

    await login({
      fetch,
      openBrowser: async (url) => {
        openedUrl = url;
        return true;
      },
      sleep: async () => {},
      write: (value) => output.push(value),
      configHome,
      baseUrl: "https://keepflash.com",
    });

    const credential = await readCredential({ configHome });
    assert.equal(credential.token, LOGIN_TEST_TOKEN);
    assert.match(openedUrl, /code=KF-ABCD-EFGH/);
    assert.match(output.join("\n"), /KF-ABCD-EFGH/);
    assert.equal(output.join("\n").includes(credential.token), false);
    assert.equal(output.join("\n").includes("private-device"), false);
  });
});

test("login stops when browser authorization is denied or expired", async () => {
  for (const error of ["access_denied", "expired_token"]) {
    await withTempConfig(async (configHome) => {
      const fetch = sequenceFetch([
        jsonResponse({
          device_code: "private-device",
          user_code: "KF-ABCD-EFGH",
          verification_uri_complete:
            "https://keepflash.com/en/agent-access/authorize?code=KF-ABCD-EFGH",
          expires_in: 600,
          interval: 0,
        }),
        jsonResponse({ error }, 400),
      ]);

      await assert.rejects(
        () =>
          login({
            fetch,
            openBrowser: async () => true,
            sleep: async () => {},
            write: () => {},
            configHome,
            baseUrl: "https://keepflash.com",
          }),
        new RegExp(error.toUpperCase()),
      );
      assert.equal(await readCredential({ configHome }), null);
    });
  }
});

test("browser open uses argument arrays without a shell", () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { unref() {} };
  };

  openBrowserUrl("https://keepflash.com/authorize?code=KF-ABCD-EFGH", {
    platform: "darwin",
    spawn,
  });

  assert.equal(calls[0].command, "open");
  assert.deepEqual(calls[0].args, [
    "https://keepflash.com/authorize?code=KF-ABCD-EFGH",
  ]);
  assert.equal(calls[0].options.shell, false);
});

test("parses JSON and SSE MCP results and preserves tool error details", async () => {
  const json = await parseMcpResponse(
    jsonResponse({
      jsonrpc: "2.0",
      id: 1,
      result: { structuredContent: { query: "RAG", notes: [] } },
    }),
  );
  assert.deepEqual(json, { query: "RAG", notes: [] });

  const ssePayload = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify({ spaces: [] }) }],
    },
  };
  const sse = await parseMcpResponse(
    new Response(`event: message\ndata: ${JSON.stringify(ssePayload)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    }),
  );
  assert.deepEqual(sse, { spaces: [] });

  await assert.rejects(
    () =>
      parseMcpResponse(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: `MCP error -32602: limit expected <= 50 (${FILE_TEST_TOKEN})`,
              },
            ],
          },
        }),
      ),
    (error) => {
      assert.equal(error.code, "MCP_TOOL_ERROR");
      const formatted = formatCliError(error);
      assert.match(formatted, /MCP error -32602: limit expected <= 50/);
      assert.doesNotMatch(formatted, /kf_mcp_live_/);
      return true;
    },
  );
});

test("missing credentials authorize once before calling the original tool", async () => {
  let loginCalls = 0;
  const toolCalls = [];

  const result = await callToolWithAuthorizationRetry(
    "keepflash_get_context",
    { query: "RAG" },
    {
      resolveCredential: async () => null,
      login: async () => {
        loginCalls += 1;
        return { token: "new-token", source: "file" };
      },
      callTool: async (toolName, args, credential) => {
        toolCalls.push({ toolName, args, credential });
        return { query: args.query };
      },
    },
  );

  assert.deepEqual(result, { query: "RAG" });
  assert.equal(loginCalls, 1);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].toolName, "keepflash_get_context");
});

test("a file-token 401 authorizes once and retries the original tool", async () => {
  let loginCalls = 0;
  let toolCalls = 0;

  const result = await callToolWithAuthorizationRetry(
    "keepflash_get_context",
    { query: "RAG" },
    {
      resolveCredential: async () => ({
        token: "old-token",
        source: "file",
      }),
      login: async () => {
        loginCalls += 1;
        return { token: "new-token", source: "file" };
      },
      callTool: async (_toolName, args, credential) => {
        toolCalls += 1;
        if (credential.token === "old-token") {
          throw Object.assign(new Error("unauthorized"), { status: 401 });
        }
        return { query: args.query };
      },
    },
  );

  assert.deepEqual(result, { query: "RAG" });
  assert.equal(loginCalls, 1);
  assert.equal(toolCalls, 2);
});

test("an invalid environment token does not open a browser", async () => {
  let loginCalls = 0;

  await assert.rejects(
    () =>
      callToolWithAuthorizationRetry(
        "keepflash_get_context",
        { query: "RAG" },
        {
          resolveCredential: async () => ({
            token: "managed-token",
            source: "environment",
          }),
          login: async () => {
            loginCalls += 1;
            return { token: "new-token", source: "file" };
          },
          callTool: async () => {
            throw Object.assign(new Error("unauthorized"), { status: 401 });
          },
        },
      ),
    /INVALID_ENV_TOKEN/,
  );
  assert.equal(loginCalls, 0);
});

test("logout keeps local credentials on remote failure and deletes after 204", async () => {
  await withTempConfig(async (configHome) => {
    await writeCredential({
      credential: { token: "file-token", baseUrl: "https://keepflash.com" },
      configHome,
    });

    await assert.rejects(
      () =>
        logout({
          fetch: async () => {
            throw new Error("offline");
          },
          write: () => {},
          configHome,
        }),
      /LOGOUT_INCOMPLETE/,
    );
    assert.equal(Boolean(await readCredential({ configHome })), true);

    await logout({
      fetch: async () => new Response(null, { status: 204 }),
      write: () => {},
      configHome,
    });
    assert.equal(await readCredential({ configHome }), null);
  });
});

test("environment-token logout revokes remotely and asks the user to clear it", async () => {
  const output = [];
  const calls = [];

  await logout({
    env: {
      KEEPFLASH_ACCESS_TOKEN: "environment-token",
      KEEPFLASH_BASE_URL: "https://keepflash.com",
    },
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(null, { status: 204 });
    },
    write: (value) => output.push(value),
  });

  assert.equal(calls[0].options.method, "DELETE");
  assert.equal(
    calls[0].options.headers.Authorization,
    "Bearer environment-token",
  );
  assert.match(output.join("\n"), /KEEPFLASH_ACCESS_TOKEN/);
});

test("environment credentials take precedence over file credentials", async () => {
  await withTempConfig(async (configHome) => {
    await writeCredential({
      credential: { token: "file-token", baseUrl: "https://keepflash.com" },
      configHome,
    });

    const credential = await resolveCredential({
      env: { KEEPFLASH_ACCESS_TOKEN: "environment-token" },
      configHome,
    });
    assert.deepEqual(credential, {
      token: "environment-token",
      source: "environment",
      baseUrl: "https://keepflash.com",
    });
  });
});

test("maps retrieval CLI commands to the MCP tool contract", () => {
  assert.deepEqual(
    buildToolCall(["context", "--query", "RAG", "--max-tokens", "1200"]),
    {
      toolName: "keepflash_get_context",
      arguments: { query: "RAG", maxTokens: 1200 },
    },
  );
  assert.deepEqual(buildToolCall(["read", "--id", "note-1", "--images"]), {
    toolName: "keepflash_read_note",
    arguments: {
      noteId: "note-1",
      includeBlocks: true,
      includeMetadata: true,
      includeImageAssets: true,
    },
  });
  assert.deepEqual(buildToolCall(["spaces"]), {
    toolName: "keepflash_list_spaces",
    arguments: {},
  });
  assert.deepEqual(
    buildToolCall([
      "list",
      "--limit",
      "50",
      "--cursor",
      "next-page",
      "--space",
      "space-1",
      "--type",
      "NOTE",
    ]),
    {
      toolName: "keepflash_list_notes",
      arguments: {
        limit: 50,
        cursor: "next-page",
        spaceIds: ["space-1"],
        noteTypes: ["NOTE"],
      },
    },
  );
});

test("rejects blank retrieval queries and search limits outside 1 to 50", () => {
  for (const command of ["context", "search"]) {
    assert.throws(
      () => buildToolCall([command, "--query", "   "]),
      (error) => {
        assert.equal(error?.code, "INVALID_ARGUMENTS");
        assert.match(formatCliError(error), /non-whitespace text/);
        return true;
      },
    );
  }

  assert.throws(
    () => buildToolCall(["search", "--query", "RAG", "--limit", "51"]),
    (error) => {
      assert.equal(error?.code, "INVALID_ARGUMENTS");
      assert.match(formatCliError(error), /between 1 and 50/);
      return true;
    },
  );
  assert.equal(
    buildToolCall(["search", "--query", "RAG", "--limit", "50"])
      .arguments.limit,
    50,
  );
});

test("maps note creation to writable blocks and an idempotency key", () => {
  assert.deepEqual(
    buildToolCall([
      "create",
      "--title",
      "Research notes",
      "--space",
      "space-1",
      "--body",
      "First paragraph\n\nSecond paragraph",
      "--idempotency-key",
      "create-research-notes-1",
    ]),
    {
      toolName: "keepflash_create_note",
      arguments: {
        title: "Research notes",
        spaceId: "space-1",
        blocks: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "First paragraph", styles: {} },
            ],
          },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Second paragraph", styles: {} },
            ],
          },
        ],
        idempotencyKey: "create-research-notes-1",
      },
    },
  );
});

test("maps a prepared image upload to image-note creation", () => {
  assert.deepEqual(
    buildToolCall([
      "create-image-note",
      "--upload-id",
      "upload-1",
      "--title",
      "System diagram",
      "--description-markdown",
      "Generated architecture overview.",
      "--space",
      "space-1",
      "--idempotency-key",
      "create-image-note-1",
    ]),
    {
      toolName: "keepflash_create_image_note",
      arguments: {
        uploadId: "upload-1",
        title: "System diagram",
        descriptionMarkdown: "Generated architecture overview.",
        spaceId: "space-1",
        idempotencyKey: "create-image-note-1",
      },
    },
  );
});

test("maps attachment references into ordinary note creation", () => {
  assert.deepEqual(
    buildToolCall([
      "create",
      "--title",
      "Architecture notes",
      "--markdown",
      "![Diagram](attachment://diagram)",
      "--attachment",
      "diagram=upload-1",
      "--idempotency-key",
      "create-note-with-image-1",
    ]),
    {
      toolName: "keepflash_create_note",
      arguments: {
        title: "Architecture notes",
        markdown: "![Diagram](attachment://diagram)",
        attachments: [{ ref: "diagram", uploadId: "upload-1" }],
        idempotencyKey: "create-note-with-image-1",
      },
    },
  );
});

test("uploads a local image through a secret presigned URL and returns only upload metadata", async () => {
  const imported = await import("../scripts/keepflash.mjs");
  if (typeof imported.uploadImageFile !== "function") {
    assert.fail("KeepFlash Skill should upload local image files");
  }
  const { uploadImageFile } = imported;
  await withTempConfig(async (directory) => {
    const imagePath = path.join(directory, "diagram.png");
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02,
    ]);
    await writeFile(imagePath, bytes);
    const toolCalls = [];
    const fetchCalls = [];
    const credential = {
      token: "kf_mcp_live_secret",
      baseUrl: "https://keepflash.example",
      source: "file",
    };

    const result = await uploadImageFile(
      {
        filePath: imagePath,
        purpose: "note_block",
        idempotencyKey: "upload-diagram-1",
      },
      {
        resolveCredential: async () => credential,
        callTool: async (toolName, args, receivedCredential) => {
          toolCalls.push({ toolName, args, credential: receivedCredential });
          return {
            uploadId: "upload_1",
            uploadUrl: "https://storage.example/upload?secret=1",
            requiredHeaders: { "Content-Type": "image/png" },
          };
        },
        fetch: async (url, options) => {
          fetchCalls.push({ url: String(url), options });
          return new Response(null, { status: 200 });
        },
      },
    );

    assert.equal(toolCalls[0]?.toolName, "keepflash_prepare_image_upload");
    assert.equal(toolCalls[0]?.credential, credential);
    assert.equal(toolCalls[0]?.args.fileName, "diagram.png");
    assert.equal(toolCalls[0]?.args.mimeType, "image/png");
    assert.equal(toolCalls[0]?.args.sizeBytes, bytes.length);
    assert.match(toolCalls[0]?.args.sha256, /^[a-f0-9]{64}$/);
    assert.equal(fetchCalls[0]?.url, "https://storage.example/upload?secret=1");
    assert.equal(fetchCalls[0]?.options.method, "PUT");
    assert.deepEqual(Buffer.from(fetchCalls[0]?.options.body), bytes);
    assert.deepEqual(result, {
      status: "uploaded",
      uploadId: "upload_1",
      fileName: "diagram.png",
      mimeType: "image/png",
      sizeBytes: bytes.length,
      sha256: toolCalls[0]?.args.sha256,
    });
    assert.doesNotMatch(JSON.stringify(result), /secret=1/);
  });
});

test("maps structured note creation to Markdown without flattening it into paragraphs", async () => {
  await withTempConfig(async (directory) => {
    const markdownPath = path.join(directory, "field-guide.md");
    const markdown = [
      "## Findings",
      "",
      "- **Leases:** prevent duplicate ownership.",
      "- **Retries:** require idempotency.",
      "",
      "```bash",
      "npm run worker:health",
      "```",
      "",
      "- [ ] Verify recovery",
    ].join("\n");
    await writeFile(markdownPath, markdown, "utf8");

    assert.deepEqual(
      buildToolCall([
        "create",
        "--title",
        "Field guide",
        "--markdown-file",
        markdownPath,
        "--idempotency-key",
        "create-field-guide-1",
      ]),
      {
        toolName: "keepflash_create_note",
        arguments: {
          title: "Field guide",
          markdown,
          idempotencyKey: "create-field-guide-1",
        },
      },
    );
  });

  assert.deepEqual(
    buildToolCall([
      "create",
      "--title",
      "Short plan",
      "--markdown",
      "## Next\n\n- [ ] Verify",
      "--idempotency-key",
      "create-short-plan-1",
    ]),
    {
      toolName: "keepflash_create_note",
      arguments: {
        title: "Short plan",
        markdown: "## Next\n\n- [ ] Verify",
        idempotencyKey: "create-short-plan-1",
      },
    },
  );
});

test("rejects ambiguous or blank structured creation input", () => {
  assert.throws(
    () =>
      buildToolCall([
        "create",
        "--body",
        "Plain",
        "--markdown",
        "## Structured",
        "--idempotency-key",
        "ambiguous-create-1",
      ]),
    /INVALID_ARGUMENTS/,
  );
  assert.throws(
    () =>
      buildToolCall([
        "create",
        "--markdown",
        "   ",
        "--idempotency-key",
        "blank-markdown-1",
      ]),
    /INVALID_ARGUMENTS/,
  );
});

test("maps block-level note updates with read revisions", () => {
  const operations = [
    {
      op: "replace",
      blockId: "block-1",
      expectedRevision: 3,
      block: {
        type: "paragraph",
        content: [{ type: "text", text: "Revised", styles: {} }],
      },
    },
  ];

  assert.deepEqual(
    buildToolCall([
      "update",
      "--id",
      "note-1",
      "--base-revision",
      "7",
      "--operations-json",
      JSON.stringify(operations),
      "--idempotency-key",
      "update-note-1-revision-7",
    ]),
    {
      toolName: "keepflash_update_note",
      arguments: {
        noteId: "note-1",
        baseRevision: 7,
        operations,
        idempotencyKey: "update-note-1-revision-7",
      },
    },
  );
});

test("Skill instructions define safe activation, citations, and automatic authorization", async () => {
  const skillRoot = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
  );
  const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  const setup = await readFile(
    path.join(skillRoot, "scripts", "setup.mjs"),
    "utf8",
  );
  const evals = JSON.parse(
    await readFile(path.join(skillRoot, "evals", "evals.json"), "utf8"),
  );

  assert.match(skill, /^name: keepflash$/m);
  assert.match(skill, /Do not use for generic web search/i);
  assert.match(skill, /browser authorization automatically/i);
  assert.match(skill, /clickable.*link|\[.*title.*\]\(.*appUrl/i);
  assert.match(skill, /do not.*(?:show|expose).*noteId/i);
  assert.doesNotMatch(skill, /Source: Note title \(note id:/i);
  assert.match(skill, /untrusted/i);
  assert.match(skill, /never.*token/i);
  assert.match(skill, /create/i);
  assert.match(skill, /block-level/i);
  assert.match(skill, /SPACE_REQUIRED/);
  assert.match(skill, /requiresUserConfirmation/);
  assert.match(skill, /list --limit/i);
  assert.match(skill, /directory|catalog|有哪些笔记/i);
  assert.match(skill, /Do not use a blank query/i);
  assert.match(skill, /upload-image/);
  assert.match(skill, /create-image-note/);
  assert.match(skill, /attachment:\/\//);
  assert.match(skill, /upload URL.*secret|signed upload URL.*secret/i);
  assert.match(setup, /auth", "login"/);
  assert.equal(evals.skill_name, "keepflash");
  assert.equal(evals.evals.length >= 12, true);
  assert.ok(
    evals.evals.some((item) => /keepflash_list_notes/.test(item.expected_output)),
  );
});
