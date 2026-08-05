#!/usr/bin/env node

import { spawn as nodeSpawn } from "node:child_process";
import crypto from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://keepflash.com";
const MCP_PROTOCOL_VERSION = "2025-03-26";

class KeepFlashCliError extends Error {
  constructor(code, options = {}) {
    super(code, options);
    this.name = "KeepFlashCliError";
    this.code = code;
    if (options.status) this.status = options.status;
    if (options.details) this.details = options.details;
  }
}

export function getCredentialPath({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  configHome,
} = {}) {
  if (configHome) {
    return platform === "win32"
      ? path.win32.join(configHome, "credentials.json")
      : path.join(configHome, "credentials.json");
  }

  if (platform === "win32") {
    const appData =
      env.APPDATA || path.win32.join(homeDir, "AppData", "Roaming");
    return path.win32.join(appData, "KeepFlash", "credentials.json");
  }

  if (platform === "darwin") {
    return path.join(
      homeDir,
      "Library",
      "Application Support",
      "KeepFlash",
      "credentials.json",
    );
  }

  return path.join(
    env.XDG_CONFIG_HOME || path.join(homeDir, ".config"),
    "keepflash",
    "credentials.json",
  );
}

export async function readCredential(options = {}) {
  const credentialPath = getCredentialPath(options);

  try {
    const value = JSON.parse(await readFile(credentialPath, "utf8"));
    if (!value || typeof value.token !== "string" || !value.token.trim()) {
      return null;
    }

    return {
      token: value.token.trim(),
      baseUrl: normalizeBaseUrl(value.baseUrl),
      createdAt:
        typeof value.createdAt === "string" ? value.createdAt : undefined,
    };
  } catch (error) {
    if (
      error?.code === "ENOENT" ||
      error instanceof SyntaxError
    ) {
      return null;
    }
    throw error;
  }
}

export async function writeCredential({
  credential,
  ...options
}) {
  if (!credential?.token?.trim()) {
    throw new KeepFlashCliError("INVALID_CREDENTIAL");
  }

  const credentialPath = getCredentialPath(options);
  const directory = path.dirname(credentialPath);
  const body = `${JSON.stringify(
    {
      token: credential.token.trim(),
      baseUrl: normalizeBaseUrl(credential.baseUrl),
      createdAt: credential.createdAt || new Date().toISOString(),
    },
    null,
    2,
  )}\n`;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (options.platform !== "win32" && process.platform !== "win32") {
    await chmod(directory, 0o700);
  }
  await writeFile(credentialPath, body, { encoding: "utf8", mode: 0o600 });
  if (options.platform !== "win32" && process.platform !== "win32") {
    await chmod(credentialPath, 0o600);
  }

  return credentialPath;
}

export async function deleteCredential(options = {}) {
  await rm(getCredentialPath(options), { force: true });
}

export async function resolveCredential(options = {}) {
  const env = options.env ?? process.env;
  const envToken = env.KEEPFLASH_ACCESS_TOKEN?.trim();

  if (envToken) {
    return {
      token: envToken,
      source: "environment",
      baseUrl: normalizeBaseUrl(
        env.KEEPFLASH_BASE_URL || options.baseUrl,
      ),
    };
  }

  const fileCredential = await readCredential(options);
  if (!fileCredential) return null;

  return {
    ...fileCredential,
    source: "file",
    baseUrl: normalizeBaseUrl(
      options.baseUrl || fileCredential.baseUrl || env.KEEPFLASH_BASE_URL,
    ),
  };
}

export function openBrowserUrl(
  url,
  {
    platform = process.platform,
    spawn = nodeSpawn,
  } = {},
) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new KeepFlashCliError("INVALID_AUTHORIZATION_URL");
  }

  let command;
  let args;

  if (platform === "darwin") {
    command = "open";
    args = [parsed.toString()];
  } else if (platform === "win32") {
    command = "cmd.exe";
    args = ["/d", "/s", "/c", "start", "", parsed.toString()];
  } else {
    command = "xdg-open";
    args = [parsed.toString()];
  }

  const child = spawn(command, args, {
    detached: true,
    shell: false,
    stdio: "ignore",
  });
  child.unref();
  return true;
}

export async function login(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const write = options.write ?? ((value) => process.stdout.write(`${value}\n`));
  const openBrowser =
    options.openBrowser ??
    ((url) =>
      openBrowserUrl(url, {
        platform: options.platform,
        spawn: options.spawn,
      }));
  const baseUrl = normalizeBaseUrl(
    options.baseUrl || env.KEEPFLASH_BASE_URL,
  );

  const started = await fetchImpl(
    `${baseUrl}/api/agent-access/device/code`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_name: options.clientName || "KeepFlash Skill",
      }),
    },
  );
  const authorization = await readJsonResponse(started);

  if (
    !started.ok ||
    typeof authorization.device_code !== "string" ||
    typeof authorization.user_code !== "string"
  ) {
    throw new KeepFlashCliError("DEVICE_AUTH_START_FAILED", {
      status: started.status,
    });
  }

  const verificationUrl =
    authorization.verification_uri_complete ||
    authorization.verification_uri;
  if (typeof verificationUrl !== "string") {
    throw new KeepFlashCliError("DEVICE_AUTH_START_FAILED");
  }

  write(`Open this URL to authorize KeepFlash: ${verificationUrl}`);
  write(`Authorization code: ${authorization.user_code}`);

  try {
    await openBrowser(verificationUrl);
  } catch {
    write("The browser did not open automatically. Use the URL above.");
  }

  const expiresIn = positiveNumber(authorization.expires_in, 600);
  const deadline = now() + expiresIn * 1_000;
  let intervalSeconds = nonNegativeNumber(authorization.interval, 5);

  while (now() < deadline) {
    await sleep(intervalSeconds * 1_000);

    const polled = await fetchImpl(
      `${baseUrl}/api/agent-access/device/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          device_code: authorization.device_code,
        }),
      },
    );
    const payload = await readJsonResponse(polled);

    if (
      polled.ok &&
      typeof payload.access_token === "string" &&
      payload.access_token
    ) {
      const credential = {
        token: payload.access_token,
        baseUrl,
        createdAt: new Date().toISOString(),
      };
      await writeCredential({ credential, ...credentialOptions(options) });
      write("KeepFlash connected. Returning to the original request.");
      return { ...credential, source: "file" };
    }

    if (payload.error === "authorization_pending") {
      continue;
    }
    if (payload.error === "slow_down") {
      intervalSeconds += 5;
      continue;
    }
    if (payload.error === "access_denied") {
      throw new KeepFlashCliError("ACCESS_DENIED");
    }
    if (payload.error === "expired_token") {
      throw new KeepFlashCliError("EXPIRED_TOKEN");
    }
    if (payload.error === "invalid_grant") {
      throw new KeepFlashCliError("INVALID_GRANT");
    }

    throw new KeepFlashCliError("DEVICE_AUTH_POLL_FAILED", {
      status: polled.status,
    });
  }

  throw new KeepFlashCliError("EXPIRED_TOKEN");
}

export async function logout(options = {}) {
  const write = options.write ?? ((value) => process.stdout.write(`${value}\n`));
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const credential = await resolveCredential(options);

  if (!credential) {
    write("KeepFlash is already logged out.");
    return { loggedOut: true, source: null };
  }

  try {
    const response = await fetchImpl(
      `${credential.baseUrl}/api/agent-access/current`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${credential.token}`,
          Accept: "application/json",
        },
      },
    );

    if (response.status !== 204) {
      throw new KeepFlashCliError("REMOTE_LOGOUT_FAILED", {
        status: response.status,
      });
    }
  } catch (error) {
    throw new KeepFlashCliError("LOGOUT_INCOMPLETE", { cause: error });
  }

  if (credential.source === "file") {
    await deleteCredential(credentialOptions(options));
    write("KeepFlash access was revoked and the local credential was removed.");
  } else {
    write(
      "KeepFlash access was revoked. Remove KEEPFLASH_ACCESS_TOKEN from the parent environment.",
    );
  }

  return { loggedOut: true, source: credential.source };
}

export async function callMcpTool(
  toolName,
  argumentsValue,
  {
    token,
    baseUrl = DEFAULT_BASE_URL,
    fetch: fetchImpl = globalThis.fetch,
  },
) {
  const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: argumentsValue,
      },
    }),
  });

  if (!response.ok) {
    throw new KeepFlashCliError(
      response.status === 401 ? "UNAUTHORIZED" : "MCP_HTTP_ERROR",
      { status: response.status },
    );
  }

  return parseMcpResponse(response);
}

export async function parseMcpResponse(response) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  let envelope;

  if (contentType.includes("text/event-stream")) {
    const messages = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]")
      .map((line) => JSON.parse(line));
    envelope =
      messages.findLast((message) => message?.result || message?.error) ??
      messages.at(-1);
  } else {
    envelope = JSON.parse(text);
  }

  if (!envelope || typeof envelope !== "object") {
    throw new KeepFlashCliError("INVALID_MCP_RESPONSE");
  }
  if (envelope.error) {
    throw new KeepFlashCliError("MCP_PROTOCOL_ERROR", {
      details: sanitizeMcpErrorDetails(envelope.error.message),
    });
  }

  const result = envelope.result;
  if (!result || typeof result !== "object") {
    throw new KeepFlashCliError("INVALID_MCP_RESPONSE");
  }
  if (result.isError === true) {
    const text = result.content?.find(
      (item) => item?.type === "text" && typeof item.text === "string",
    )?.text;
    throw new KeepFlashCliError("MCP_TOOL_ERROR", {
      details: sanitizeMcpErrorDetails(text),
    });
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }

  const textContent = result.content?.find(
    (item) => item?.type === "text" && typeof item.text === "string",
  )?.text;
  if (textContent === undefined) {
    return result.content ?? result;
  }

  try {
    return JSON.parse(textContent);
  } catch {
    return textContent;
  }
}

export async function callToolWithAuthorizationRetry(
  toolName,
  argumentsValue,
  dependencies = {},
) {
  const getCredential =
    dependencies.resolveCredential ??
    (() => resolveCredential(dependencies));
  const performLogin =
    dependencies.login ??
    (() => login(dependencies));
  const performToolCall =
    dependencies.callTool ??
    ((name, args, credential) =>
      callMcpTool(name, args, {
        token: credential.token,
        baseUrl: credential.baseUrl,
        fetch: dependencies.fetch,
      }));

  let credential = await getCredential();
  if (!credential) {
    credential = await performLogin();
  }

  try {
    return await performToolCall(toolName, argumentsValue, credential);
  } catch (error) {
    if (error?.status !== 401) throw error;
    if (credential.source === "environment") {
      throw new KeepFlashCliError("INVALID_ENV_TOKEN", { cause: error });
    }
  }

  const refreshedCredential = await performLogin();
  return performToolCall(toolName, argumentsValue, refreshedCredential);
}

export async function uploadImageFile(input, dependencies = {}) {
  const filePath = path.resolve(requiredInputText(input?.filePath, "filePath"));
  const purpose = normalizeUploadPurpose(input?.purpose);
  const idempotencyKey = requiredInputText(
    input?.idempotencyKey,
    "idempotencyKey",
  );
  let bytes;

  try {
    bytes = await readFile(filePath);
  } catch (error) {
    throw new KeepFlashCliError("INVALID_ARGUMENTS", {
      details: `Unable to read image file: ${error?.code ?? "unknown error"}.`,
    });
  }

  const maximumBytes = 5 * 1024 * 1024;
  if (bytes.length === 0 || bytes.length > maximumBytes) {
    throw new KeepFlashCliError("INVALID_ARGUMENTS", {
      details: "Image files must be between 1 byte and 5 MB.",
    });
  }

  const mimeType = detectImageMimeType(bytes);
  if (!mimeType) {
    throw new KeepFlashCliError("INVALID_ARGUMENTS", {
      details: "Image must be JPEG, PNG, WebP, GIF, or AVIF.",
    });
  }

  const fileName = path.basename(filePath);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const prepared = await callToolWithAuthorizationRetry(
    "keepflash_prepare_image_upload",
    {
      purpose,
      fileName,
      mimeType,
      sizeBytes: bytes.length,
      sha256,
      idempotencyKey,
    },
    dependencies,
  );

  if (
    typeof prepared?.uploadId !== "string" ||
    typeof prepared?.uploadUrl !== "string"
  ) {
    throw new KeepFlashCliError("INVALID_MCP_RESPONSE");
  }

  let uploadUrl;
  try {
    uploadUrl = new URL(prepared.uploadUrl);
  } catch {
    throw new KeepFlashCliError("INVALID_MCP_RESPONSE");
  }
  if (!["http:", "https:"].includes(uploadUrl.protocol)) {
    throw new KeepFlashCliError("INVALID_MCP_RESPONSE");
  }

  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const uploaded = await fetchImpl(uploadUrl, {
    method: "PUT",
    headers: normalizeUploadHeaders(prepared.requiredHeaders, mimeType),
    body: bytes,
  });
  if (!uploaded.ok) {
    throw new KeepFlashCliError("IMAGE_UPLOAD_FAILED", {
      status: uploaded.status,
    });
  }

  return {
    status: "uploaded",
    uploadId: prepared.uploadId,
    fileName,
    mimeType,
    sizeBytes: bytes.length,
    sha256,
  };
}

export function buildToolCall(argv) {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  if (command === "context") {
    return {
      toolName: "keepflash_get_context",
      arguments: compactObject({
        query: requiredTextFlag(flags, "query"),
        maxTokens: integerFlag(flags, "max-tokens"),
        spaceIds: arrayFlag(flags, "space"),
        noteTypes: arrayFlag(flags, "type"),
      }),
    };
  }

  if (command === "search") {
    return {
      toolName: "keepflash_search_notes",
      arguments: compactObject({
        query: requiredTextFlag(flags, "query"),
        mode: stringFlag(flags, "mode"),
        limit: integerFlag(flags, "limit", { max: 50 }),
        cursor: stringFlag(flags, "cursor"),
        spaceIds: arrayFlag(flags, "space"),
        noteTypes: arrayFlag(flags, "type"),
      }),
    };
  }

  if (command === "list") {
    return {
      toolName: "keepflash_list_notes",
      arguments: compactObject({
        limit: integerFlag(flags, "limit", { max: 50 }),
        cursor: stringFlag(flags, "cursor"),
        spaceIds: arrayFlag(flags, "space"),
        noteTypes: arrayFlag(flags, "type"),
      }),
    };
  }

  if (command === "read") {
    return {
      toolName: "keepflash_read_note",
      arguments: compactObject({
        noteId: requiredFlag(flags, "id"),
        maxTokens: integerFlag(flags, "max-tokens"),
        includeBlocks: true,
        includeMetadata: true,
        includeImageAssets: booleanFlag(flags, "images"),
      }),
    };
  }

  if (command === "create") {
    const body = stringFlag(flags, "body");
    const blocksJson = stringFlag(flags, "blocks-json");
    const markdown = stringFlag(flags, "markdown");
    const markdownFile = stringFlag(flags, "markdown-file");
    const contentInputCount = [body, blocksJson, markdown, markdownFile].filter(
      (value) => value !== undefined,
    ).length;
    if (contentInputCount > 1) {
      throw new KeepFlashCliError("INVALID_ARGUMENTS", {
        details:
          "Use only one of --body, --markdown, --markdown-file, or --blocks-json.",
      });
    }

    const markdownContent =
      markdownFile !== undefined
        ? readMarkdownInputFile(markdownFile)
        : validateMarkdownInput(markdown);
    const blocks =
      blocksJson !== undefined
        ? jsonArrayFlag(flags, "blocks-json")
        : body !== undefined
          ? bodyToParagraphBlocks(body)
          : markdownContent === undefined
            ? []
            : undefined;

    return {
      toolName: "keepflash_create_note",
      arguments: compactObject({
        title: stringFlag(flags, "title"),
        spaceId: stringFlag(flags, "space"),
        markdown: markdownContent,
        blocks,
        attachments: attachmentFlags(flags),
        idempotencyKey: requiredFlag(flags, "idempotency-key"),
      }),
    };
  }

  if (command === "create-image-note") {
    return {
      toolName: "keepflash_create_image_note",
      arguments: compactObject({
        uploadId: requiredFlag(flags, "upload-id"),
        title: stringFlag(flags, "title"),
        descriptionMarkdown: stringFlag(flags, "description-markdown"),
        spaceId: stringFlag(flags, "space"),
        sourceUrl: stringFlag(flags, "source-url"),
        idempotencyKey: requiredFlag(flags, "idempotency-key"),
      }),
    };
  }

  if (command === "update") {
    return {
      toolName: "keepflash_update_note",
      arguments: compactObject({
        noteId: requiredFlag(flags, "id"),
        baseRevision: requiredIntegerFlag(flags, "base-revision"),
        title: stringFlag(flags, "title"),
        operations: jsonArrayFlag(flags, "operations-json", { nonEmpty: true }),
        idempotencyKey: requiredFlag(flags, "idempotency-key"),
      }),
    };
  }

  if (command === "spaces") {
    assertNoFlags(flags);
    return {
      toolName: "keepflash_list_spaces",
      arguments: {},
    };
  }

  if (command === "asset-url") {
    return {
      toolName: "keepflash_get_asset_access_url",
      arguments: {
        assetId: requiredFlag(flags, "id"),
      },
    };
  }

  throw new KeepFlashCliError("UNKNOWN_COMMAND");
}

export async function main(argv, dependencies = {}) {
  const write =
    dependencies.write ??
    ((value) => process.stdout.write(`${value}\n`));
  const [command, subcommand] = argv;

  if (!command || command === "help" || command === "--help") {
    write(usage());
    return;
  }

  if (command === "auth" && subcommand === "login") {
    await login({ ...dependencies, write });
    return;
  }
  if (command === "auth" && subcommand === "logout") {
    await logout({ ...dependencies, write });
    return;
  }
  if (command === "status") {
    const credential = await resolveCredential(dependencies);
    write(
      JSON.stringify(
        credential
          ? {
              connected: true,
              source: credential.source,
              baseUrl: credential.baseUrl,
            }
          : { connected: false },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "upload-image") {
    const flags = parseFlags(argv.slice(1));
    const result = await uploadImageFile(
      {
        filePath: requiredFlag(flags, "file"),
        purpose: requiredFlag(flags, "purpose"),
        idempotencyKey: requiredFlag(flags, "idempotency-key"),
      },
      dependencies,
    );
    write(JSON.stringify(result, null, 2));
    return;
  }

  const tool = buildToolCall(argv);
  const result = await callToolWithAuthorizationRetry(
    tool.toolName,
    tool.arguments,
    dependencies,
  );
  write(JSON.stringify(result, null, 2));
}

export function formatCliError(error) {
  const messages = {
    ACCESS_DENIED: "KeepFlash authorization was denied.",
    EXPIRED_TOKEN: "KeepFlash authorization expired. Run the request again.",
    INVALID_GRANT: "This KeepFlash authorization request is no longer valid.",
    INVALID_ENV_TOKEN:
      "KEEPFLASH_ACCESS_TOKEN is invalid. Remove or replace it; browser authorization is disabled while it is set.",
    LOGOUT_INCOMPLETE:
      "LOGOUT_INCOMPLETE: remote revocation failed, so the local credential was kept.",
    UNKNOWN_COMMAND: "Unknown KeepFlash command. Run with --help.",
  };
  if (
    (error?.code === "MCP_TOOL_ERROR" ||
      error?.code === "MCP_PROTOCOL_ERROR") &&
    error.details
  ) {
    return `KeepFlash command failed: ${error.details}`;
  }
  if (error?.code === "INVALID_ARGUMENTS" && error.details) {
    return `Invalid KeepFlash command arguments: ${error.details}`;
  }
  return messages[error?.code] || "KeepFlash command failed.";
}

function credentialOptions(options) {
  return {
    env: options.env,
    platform: options.platform,
    homeDir: options.homeDir,
    configHome: options.configHome,
  };
}

function normalizeBaseUrl(value) {
  const raw =
    typeof value === "string" && value.trim()
      ? value.trim()
      : DEFAULT_BASE_URL;
  const parsed = new URL(raw);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new KeepFlashCliError("INVALID_BASE_URL");
  }
  return parsed.toString().replace(/\/+$/, "");
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function positiveNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function nonNegativeNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function requiredInputText(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new KeepFlashCliError("INVALID_ARGUMENTS", {
      details: `${name} is required.`,
    });
  }
  return value.trim();
}

function normalizeUploadPurpose(value) {
  const normalized = requiredInputText(value, "purpose").replaceAll("-", "_");
  if (!["image_note", "note_block"].includes(normalized)) {
    throw new KeepFlashCliError("INVALID_ARGUMENTS", {
      details: "--purpose must be image-note or note-block.",
    });
  }
  return normalized;
}

function detectImageMimeType(bytes) {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  const header = bytes.subarray(0, 12).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(4, 8).toString("ascii") === "ftyp" &&
    ["avif", "avis"].includes(bytes.subarray(8, 12).toString("ascii"))
  ) {
    return "image/avif";
  }
  return undefined;
}

function normalizeUploadHeaders(value, mimeType) {
  if (value === undefined) return { "Content-Type": mimeType };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new KeepFlashCliError("INVALID_MCP_RESPONSE");
  }
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new KeepFlashCliError("INVALID_MCP_RESPONSE");
  }
  return Object.fromEntries(entries);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseFlags(args) {
  const flags = new Map();

  for (let index = 0; index < args.length; index += 1) {
    const part = args[index];
    if (!part?.startsWith("--")) {
      throw new KeepFlashCliError("INVALID_ARGUMENTS");
    }

    const name = part.slice(2);
    if (name === "images") {
      flags.set(name, true);
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new KeepFlashCliError("INVALID_ARGUMENTS");
    }
    index += 1;
    const current = flags.get(name);
    flags.set(name, current === undefined ? value : [].concat(current, value));
  }

  return flags;
}

function stringFlag(flags, name) {
  const value = flags.get(name);
  if (Array.isArray(value)) {
    throw new KeepFlashCliError("INVALID_ARGUMENTS");
  }
  return typeof value === "string" ? value : undefined;
}

function requiredFlag(flags, name) {
  const value = stringFlag(flags, name);
  if (!value) throw new KeepFlashCliError("MISSING_REQUIRED_ARGUMENT");
  return value;
}

function requiredTextFlag(flags, name) {
  const value = requiredFlag(flags, name).trim();
  if (!value) {
    throw new KeepFlashCliError("INVALID_ARGUMENTS", {
      details: `--${name} must contain non-whitespace text.`,
    });
  }
  return value;
}

function integerFlag(flags, name, { max = Number.POSITIVE_INFINITY } = {}) {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > max) {
    throw new KeepFlashCliError("INVALID_ARGUMENTS", {
      details: Number.isFinite(max)
        ? `--${name} must be an integer between 1 and ${max}.`
        : `--${name} must be a positive integer.`,
    });
  }
  return number;
}

function requiredIntegerFlag(flags, name) {
  const value = integerFlag(flags, name);
  if (value === undefined) {
    throw new KeepFlashCliError("MISSING_REQUIRED_ARGUMENT");
  }
  return value;
}

function jsonArrayFlag(flags, name, { nonEmpty = false } = {}) {
  const value = requiredFlag(flags, name);
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new KeepFlashCliError("INVALID_ARGUMENTS");
  }
  if (!Array.isArray(parsed) || (nonEmpty && parsed.length === 0)) {
    throw new KeepFlashCliError("INVALID_ARGUMENTS");
  }
  return parsed;
}

function bodyToParagraphBlocks(body) {
  if (body === undefined) return [];

  return body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text, styles: {} }],
    }));
}

function validateMarkdownInput(markdown) {
  if (markdown === undefined) return undefined;
  if (!markdown.trim()) {
    throw new KeepFlashCliError("INVALID_ARGUMENTS", {
      details: "Markdown must contain non-whitespace text.",
    });
  }
  if (markdown.length > 200_000) {
    throw new KeepFlashCliError("INVALID_ARGUMENTS", {
      details: "Markdown must be 200,000 characters or fewer.",
    });
  }
  return markdown;
}

function readMarkdownInputFile(filePath) {
  try {
    return validateMarkdownInput(
      readFileSync(path.resolve(filePath), { encoding: "utf8" }),
    );
  } catch (error) {
    if (error instanceof KeepFlashCliError) throw error;
    throw new KeepFlashCliError("INVALID_ARGUMENTS", {
      details: `Unable to read --markdown-file: ${error?.code ?? "unknown error"}.`,
    });
  }
}

function arrayFlag(flags, name) {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

function attachmentFlags(flags) {
  const values = arrayFlag(flags, "attachment");
  if (!values) return undefined;

  const seen = new Set();
  return values.map((value) => {
    const separator = typeof value === "string" ? value.indexOf("=") : -1;
    const ref = separator > 0 ? value.slice(0, separator).trim() : "";
    const uploadId = separator > 0 ? value.slice(separator + 1).trim() : "";
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(ref) || !uploadId || seen.has(ref)) {
      throw new KeepFlashCliError("INVALID_ARGUMENTS", {
        details: "Each --attachment must be a unique ref=uploadId pair.",
      });
    }
    seen.add(ref);
    return { ref, uploadId };
  });
}

function booleanFlag(flags, name) {
  return flags.get(name) === true ? true : undefined;
}

function assertNoFlags(flags) {
  if (flags.size > 0) throw new KeepFlashCliError("INVALID_ARGUMENTS");
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

function sanitizeMcpErrorDetails(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/kf_mcp_live_[A-Za-z0-9_-]+/g, "[redacted-token]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim();
  if (!normalized) return undefined;
  return normalized.slice(0, 2_000);
}

function usage() {
  return [
    "KeepFlash Skill CLI",
    "",
    "  auth login",
    "  auth logout",
    "  status",
    "  context --query <text>",
    "  search --query <text>",
    "  list [--limit <1-50>] [--cursor <cursor>] [--space <id>] [--type <type>]",
    "  read --id <noteId> [--images]",
    "  spaces",
    "  upload-image --file <path> --purpose <image-note|note-block> --idempotency-key <key>",
    "  create --title <text> [--space <id>] [--body <text> | --markdown <text> | --markdown-file <path> | --blocks-json <json>] --idempotency-key <key>",
    "  create-image-note --upload-id <uploadId> [--title <text>] [--description-markdown <text>] [--space <id>] --idempotency-key <key>",
    "  update --id <noteId> --base-revision <number> --operations-json <json> --idempotency-key <key>",
    "  asset-url --id <assetId>",
  ].join("\n");
}

const executedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";

if (executedPath && import.meta.url === executedPath) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
