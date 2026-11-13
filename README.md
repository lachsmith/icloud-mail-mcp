# iCloud Mail MCP server

A local MCP server that lets Claude read, organise and draft mail in an iCloud mailbox. It runs on your Mac over stdio and exposes nothing to the network.

It **cannot send mail** and **cannot permanently delete mail**. Replies are saved to Drafts for you to send.

## Tools

| Tool | What it does |
|---|---|
| `list_mailboxes` | Folders with total and unread counts |
| `search_messages` | Filter by sender, recipient, subject, text, dates, unread, flagged |
| `get_message` | One message: headers, body, attachment list |
| `get_thread` | A whole conversation, oldest first, including your replies |
| `get_attachment` | Text and images inline; other types saved to disk on request |
| `mark_messages` | Read/unread, flag/unflag |
| `move_messages` | Move to a folder, archive, junk or trash |
| `create_draft` | Save a new message or a reply to Drafts |

## Setup

1. **Build**

   ```bash
   npm install && npm run build
   ```

2. **Create an app-specific password.** Sign in at [account.apple.com](https://account.apple.com) as the iCloud account you want Claude to use, then Sign-In and Security → App-Specific Passwords. The account needs two-factor authentication.

3. **Store it in the Keychain.** Replace the address with the account's primary iCloud address. You are prompted for the password, so it never appears in shell history.

   ```bash
   security add-generic-password -s icloud-mail-mcp -a you@icloud.com -w
   ```

4. **Register with Claude Code.** Use the absolute path to this folder.

   ```bash
   claude mcp add icloud-mail --scope user --env ICLOUD_USER=you@icloud.com -- node /path/to/icloud-mail-mcp/dist/stdio.js
   ```

   **Claude Desktop:** add this under `mcpServers` in `~/Library/Application Support/Claude/claude_desktop_config.json`, then restart the app.

   ```json
   "icloud-mail": {
     "command": "node",
     "args": ["/path/to/icloud-mail-mcp/dist/stdio.js"],
     "env": { "ICLOUD_USER": "you@icloud.com" }
   }
   ```

5. **Install the skills** (optional)

   ```bash
   cp -R skills/inbox-triage skills/draft-reply ~/.claude/skills/
   ```

The first time the server reads the password, macOS may ask whether `security` can access the Keychain item. Choose Always Allow.

## Options

Environment variables, all optional except `ICLOUD_USER`.

| Variable | Default | Purpose |
|---|---|---|
| `ICLOUD_USER` | (required) | Primary iCloud address used to log in |
| `ICLOUD_FROM` | same as user | Address drafts are written from (for an alias) |
| `ICLOUD_FROM_NAME` | none | Display name on drafts |
| `ICLOUD_SENSITIVE_FILTER` | `on` | Set to `off` to return bodies of sign-in codes and password resets |
| `ICLOUD_ATTACHMENT_DIR` | `~/Downloads/icloud-mail-attachments` | Where saved attachments go |
| `ICLOUD_MAX_BODY_CHARS` | `20000` | Cap on body text returned per message |

## Safeguards

- **No send, no permanent delete.** The worst a hijacked instruction can do is move mail or save a draft.
- **Untrusted content is labelled.** Every email body is wrapped in `<untrusted_email_content>` so Claude can tell it from instructions.
- **Sensitive-mail filter.** Messages that look like sign-in codes, password resets or security alerts return headers only.
- **Audit log.** Each tool call writes one line to stderr (tool, mailbox, uids), never message content.
- **Password stays in the Keychain.** It is not read from the environment or any file.

Prompt injection cannot be ruled out. Avoid combining this server with tools that can send data elsewhere (web browsing, other connectors) in the same conversation.

## Turning it off

Revoke the app-specific password at [account.apple.com](https://account.apple.com). Access stops immediately. To remove the local copy:

```bash
security delete-generic-password -s icloud-mail-mcp -a you@icloud.com
```

## Development

```bash
npm test
```

```bash
npx @modelcontextprotocol/inspector -e ICLOUD_USER=you@icloud.com node dist/stdio.js
```

`src/tools.ts` is independent of the transport, so a remote (HTTP) entry point can be added beside `src/stdio.ts` later.

## What has been checked against iCloud

`scripts/live-check.mjs` (read-only) and `scripts/draft-check.mjs` (saves one test draft) run the built server against the real mailbox. Listing folders, searching, reading a message, thread lookup across Inbox and Sent, and saving a draft all work.

Not yet exercised live: `mark_messages`, `move_messages` and `get_attachment`.

## Licence

MIT. See [LICENSE](LICENSE).
