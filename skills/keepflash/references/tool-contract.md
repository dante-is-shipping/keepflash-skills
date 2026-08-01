# KeepFlash tool contract

The bundled client calls the stateless MCP endpoint and prints the structured result as JSON.

## `context`

```bash
node scripts/keepflash.mjs context --query "retrieval augmented generation" --max-tokens 4000
```

Maps to `keepflash_get_context`.

Queries are trimmed and must contain non-whitespace text. Use `list` instead of `context` for directory or inventory requests.

Optional repeatable filters:

- `--space <spaceId>`
- `--type NOTE|LINK|IMAGE|PDF|VIDEO|FILE|WEB_CLIP|EXCERPT`

Important result fields:

- `status`: `ready`, `degraded`, or `no_results`
- `contextText`: compact untrusted reference text
- `notes[]`: search results with `title`, clickable `appUrl`, `snippet`, source metadata, and an internal `noteId`
- `budget`: token estimate and dropped-result count

## `search`

```bash
node scripts/keepflash.mjs search --query "RAG evaluation" --mode hybrid --limit 20
```

Maps to `keepflash_search_notes`. `--limit` must be between 1 and 50. Queries are trimmed and must contain non-whitespace text. Supports `--cursor`, repeatable `--space`, and repeatable `--type`.

Use `results[].noteId` internally for follow-up reads, but never print it in a user-facing answer. Link the displayed title to `results[].appUrl`. `modeUsed` can differ from the requested mode when the account tier falls back to another search mode.

## `list`

```bash
node scripts/keepflash.mjs list --limit 50
node scripts/keepflash.mjs list --space <spaceId> --type NOTE --limit 20
```

Maps to `keepflash_list_notes`. Use it for directory, catalog, inventory, count, and “what notes do I have?” requests. It reads active accessible notes directly rather than relying on the keyword or semantic search index.

Optional flags:

- `--limit <1-50>`; defaults to 20.
- `--cursor <cursor>` from the previous page.
- Repeatable `--space <spaceId>` and `--type <type>` filters.

Important result fields:

- `notes[]`: note metadata ordered by most recently updated, including title, clickable `appUrl`, type, Space, source, timestamps, and an internal `noteId` for tool chaining.
- `totalCount`: total number of active accessible notes matching the filters, independent of the current page.
- `nextCursor`: opaque cursor for the next page, or `null` when complete.

Do not use a blank query or `*` to simulate listing. Search results do not promise a total count and may omit content that has not been indexed yet.

## `read`

```bash
node scripts/keepflash.mjs read --id <noteId>
node scripts/keepflash.mjs read --id <noteId> --images
```

Maps to `keepflash_read_note`. Returns `title`, clickable `appUrl`, `type`, `content`, metadata, blocks, an internal `noteId`, and optionally `imageAssets`.

Use `--max-tokens <number>` to bound content. `truncated: true` means the result is incomplete. For updates, retain `contentRevision`, plus each target block's `blockId` and `revision` from this response.

## `spaces`

```bash
node scripts/keepflash.mjs spaces
```

Maps to `keepflash_list_spaces` and returns `spaces[]` with ids, names, `canRead`, and `canWrite`.

## `create`

Choose one content input. For structured or multiline notes, write semantic
Markdown to a temporary file and pass the file path:

```bash
node scripts/keepflash.mjs create \
  --title "Reliability field guide" \
  --space <spaceId> \
  --markdown-file <path-to-note.md> \
  --idempotency-key <stable-unique-key>
```

For short structured content, use `--markdown <text>`. The Markdown path maps:

- headings to BlockNote headings (levels are limited to 1–3);
- ordered, unordered, nested, and GFM task lists to their corresponding list blocks;
- bold, italic, strikethrough, inline code, and links to rich inline content;
- fenced code to code blocks, blockquotes to quote blocks, and GFM tables to table blocks.

The note title is stored separately, so do not duplicate it as a top-level
heading in Markdown. External Markdown images are saved as links rather than
hot-linked image blocks. Markdown input is limited to 200,000 characters and
the converted note to 200 blocks, including nested blocks.

Use `--body` only for intentionally plain paragraphs:

```bash
node scripts/keepflash.mjs create --title "Research notes" --space <spaceId> --body "First paragraph

Second paragraph" --idempotency-key <stable-unique-key>
```

`--body` splits only on blank lines and deliberately creates paragraph blocks;
it does not parse headings, Markdown markers, inline styles, or newline-delimited
lists.

For exact BlockNote control, use `--blocks-json '<json-array>'`. Supported
explicit block types are `paragraph`, `heading`, `bulletListItem`,
`numberedListItem`, `checkListItem`, `quote`, and `codeBlock`. Blocks may have
nested `children`. Common shapes include:

```json
[
  {
    "type": "heading",
    "props": {"level": 2},
    "content": [{"type": "text", "text": "Findings", "styles": {}}]
  },
  {
    "type": "bulletListItem",
    "content": [
      {"type": "text", "text": "Key label: ", "styles": {"bold": true}},
      {"type": "text", "text": "supporting detail", "styles": {}}
    ]
  },
  {
    "type": "checkListItem",
    "props": {"checked": false},
    "content": [{"type": "text", "text": "Follow up", "styles": {}}]
  },
  {
    "type": "codeBlock",
    "props": {"language": "bash"},
    "content": [{"type": "text", "text": "npm run verify", "styles": {}}]
  }
]
```

All creation modes map to `keepflash_create_note`. Provide only one of
`--body`, `--markdown`, `--markdown-file`, or `--blocks-json`.

If the result has `status: "space_required"` or `code: "SPACE_REQUIRED"`, ask the user to choose one of `writableSpaces`; do not pick for them. A successful response returns `appUrl`, an internal `noteId`, `contentRevision`, created block ids and revisions, and the destination Space. Show the created note as a title link using `appUrl`, never as a note id.

## `update`

Read the note immediately before updating it, then pass its revisions into block-level operations:

```bash
node scripts/keepflash.mjs update \
  --id <noteId> \
  --base-revision <contentRevision> \
  --operations-json '[{"op":"replace","blockId":"<blockId>","expectedRevision":1,"block":{"type":"paragraph","content":[{"type":"text","text":"Revised text","styles":{}}]}}]' \
  --idempotency-key <stable-unique-key>
```

Maps to `keepflash_update_note`. Supported operations:

- `replace`: `blockId`, `expectedRevision`, and replacement `block`.
- `delete`: `blockId` and `expectedRevision`.
- `insert_before` / `insert_after`: `anchorBlockId`, `expectedAnchorRevision`, and new `block`.

Add `--title <text>` only when the same block-level update also changes the title. If the response contains `status: "conflict"`, `NOTE_CHANGED`, `BLOCK_CHANGED`, or `requiresUserConfirmation: true`, stop and tell the user. Re-read and retry only after confirmation, using the new revisions and a new idempotency key.

Idempotency keys are retained as short-lived technical state. Reuse a key only to retry the exact same payload; use a new key when any argument changes.

Successful update results include `appUrl`. Use that link when telling the user the update completed, and keep `noteId` internal.

## `asset-url`

```bash
node scripts/keepflash.mjs asset-url --id <assetId>
```

Maps to `keepflash_get_asset_access_url`. It only supports an image asset bound to an accessible active note. The returned URL is a short-lived bearer secret; fetch it only when visual inspection is necessary.

## Authentication commands

```bash
node scripts/keepflash.mjs auth login
node scripts/keepflash.mjs auth logout
node scripts/keepflash.mjs status
```

Retrieval and write commands call `auth login` automatically when a file credential is missing or rejected. Browser approval offers read-only and research-and-write presets; the user can later change the token's permissions in KeepFlash Settings. `status` never prints the token.
