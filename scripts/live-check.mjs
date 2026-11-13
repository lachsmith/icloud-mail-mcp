// Read-only check against the live mailbox. Prints structure and counts, not message content.
// Usage: ICLOUD_USER=you@icloud.com node scripts/live-check.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: [new URL("../dist/stdio.js", import.meta.url).pathname],
  env: { ...process.env },
  stderr: "ignore",
});
const client = new Client({ name: "live-check", version: "0" });
await client.connect(transport);

async function call(name, args = {}) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  const ms = Date.now() - started;
  if (result.isError) {
    console.log(`FAIL ${name} (${ms}ms): ${text}`);
    return null;
  }
  console.log(`ok   ${name} (${ms}ms)`);
  return JSON.parse(text);
}

const boxes = await call("list_mailboxes");
if (boxes) {
  for (const b of boxes.mailboxes) {
    console.log(`       ${b.path.padEnd(28)} ${String(b.specialUse ?? "-").padEnd(10)} total=${b.messages} unread=${b.unseen}`);
  }
}

const recent = await call("search_messages", { limit: 5 });
if (recent) {
  console.log(`       total=${recent.total_matches} returned=${recent.messages.length}`);
  for (const m of recent.messages) {
    console.log(
      `       uid=${m.uid} date=${m.date} from=${m.from.length} subjectLen=${m.subject.length} ` +
        `unread=${m.unread} attach=${m.has_attachments} snippetLen=${m.snippet.length} withheld=${m.snippet.startsWith("[Body withheld")}`,
    );
  }
}

const unread = await call("search_messages", { unread: true, limit: 1 });
if (unread) console.log(`       unread total=${unread.total_matches}`);

const since = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
const week = await call("search_messages", { since, limit: 1 });
if (week) console.log(`       since ${since}: total=${week.total_matches}`);

const first = recent?.messages[0];
if (first) {
  const msg = await call("get_message", { uid: first.uid });
  if (msg) {
    const m = msg.message;
    console.log(`       bodyLen=${m.body.length} truncated=${m.body_truncated} attachments=${m.attachments.length} messageId=${!!m.message_id}`);
  }
  const thread = await call("get_thread", { uid: first.uid });
  if (thread) console.log(`       thread messages=${thread.count} mailboxes=${[...new Set(thread.messages.map((m) => m.mailbox))].join(",")}`);
}

// Thread lookup on one of your own replies, which should find the message it answered.
const sentPath = boxes?.mailboxes.find((b) => b.specialUse === "\\Sent")?.path;
if (sentPath) {
  const replies = await call("search_messages", { mailbox: sentPath, subject: "Re:", limit: 1 });
  const reply = replies?.messages[0];
  if (reply) {
    const thread = await call("get_thread", { mailbox: sentPath, uid: reply.uid });
    if (thread) console.log(`       reply thread messages=${thread.count} mailboxes=${[...new Set(thread.messages.map((m) => m.mailbox))].join(",")}`);
  }
}

await client.close();
