# KeepFlash troubleshooting

## Browser did not open

Use the verification URL and short `KF-XXXX-XXXX` code printed by the client. The request expires after ten minutes.

## Authorization was denied or expired

Run the original KeepFlash request again to create a new authorization. The client does not reuse terminal device codes.

## `INVALID_ENV_TOKEN`

`KEEPFLASH_ACCESS_TOKEN` is set but the server rejected it. Remove or replace that environment value, then retry. The Skill intentionally does not open a browser or overwrite a managed environment credential.

## A saved credential was revoked

Repeat the original retrieval. The client starts browser authorization once and retries that same command after approval.

## `LOGOUT_INCOMPLETE`

Remote revocation could not be confirmed. The local credential remains on disk so the user can retry logout; do not delete it manually unless the user accepts that the server token may remain active.

## MCP errors

The client prints sanitized server error details for MCP tool and protocol errors, including input validation messages. It redacts KeepFlash access-token shaped values and limits the displayed detail length.

- `UNAUTHORIZED`: authorize again, subject to the environment-token rule above.
- `RATE_LIMITED`: wait before retrying.
- `NOT_FOUND`: verify the note or asset id.
- `FORBIDDEN`: the requested resource is outside the token scope.
- `SPACE_REQUIRED`: ask the user to select one of the returned writable Spaces.
- `UPLOAD_EXPIRED`: run `upload-image` again with a new upload idempotency key, then retry the create call with a new create key.
- `UPLOAD_INTEGRITY_MISMATCH`: the stored bytes did not match the declared size, MIME signature, or SHA-256; upload the original local file again rather than reusing that reservation.
- `UPLOAD_NOT_READY`: the upload is missing, has the wrong purpose, or was already consumed; prepare a new upload for the intended note type.
- `NOTE_CHANGED`: the note changed after it was read; stop and ask whether to re-read and reapply the edit.
- `BLOCK_CHANGED`: a targeted block or insertion anchor changed; stop and ask before rebasing.
- `MCP_TOOL_ERROR`: use the displayed server detail to distinguish invalid input, scope, rate limiting, and server failures; report the failure without inventing a result.

For search, use a non-blank query and a limit from 1 to 50. For directory or total-count requests, use `list`; blank queries and `*` are not supported listing mechanisms.

When a write conflict includes `requiresUserConfirmation: true`, never retry automatically. After confirmation, read the note again and use a new idempotency key for the revised request.

Do not print credentials or signed asset URLs while troubleshooting.

If the direct PUT reports `IMAGE_UPLOAD_FAILED`, repeat `upload-image` with the
same idempotency key only when the file and purpose are unchanged. The client
will obtain another short-lived upload URL without exposing it. If the file or
purpose changes, use a new key.
