// Saves one test draft addressed to yourself and confirms it landed in Drafts.
// Usage: ICLOUD_USER=you@icloud.com node scripts/draft-check.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: [new URL("../dist/stdio.js", import.meta.url).pathname],
  env: { ...process.env },
  stderr: "ignore",
});
const client = new Client({ name: "draft-check", version: "0" });
await client.connect(transport);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};

const saved = await call("create_draft", {
  to: [process.env.ICLOUD_USER],
  subject: "Test draft from icloud-mail-mcp",
  body: "This draft was saved by the MCP server to check drafting works. Safe to delete.",
});
console.log(`saved_to=${saved.saved_to} uid=${saved.uid} sent=${saved.sent}`);
const found = await call("search_messages", { mailbox: saved.saved_to, subject: "Test draft from icloud-mail-mcp" });
console.log(`found in ${saved.saved_to}: ${found.total_matches}`);
const msg = await call("get_message", { mailbox: saved.saved_to, uid: found.messages[0].uid });
console.log(`to=${msg.message.to.length} bodyOk=${msg.message.body.includes("Safe to delete.")}`);
await client.close();
