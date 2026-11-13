#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, readPassword } from "./config.js";
import { MailClient } from "./mail/imap.js";
import { UNTRUSTED_NOTE } from "./mail/parse.js";
import { registerTools } from "./tools.js";

async function main(): Promise<void> {
  const config = loadConfig();
  // The password is read from the Keychain on first use, not at start-up, so
  // the server still starts and can explain what is missing.
  const mail = new MailClient(config, () => readPassword(config.user));

  const server = new McpServer(
    { name: "icloud-mail", version: "0.1.0" },
    {
      instructions:
        `Tools for the iCloud mailbox ${config.user}. Messages are identified by mailbox path plus uid. ` +
        `This server cannot send or permanently delete mail: replies are saved as drafts for the user to send. ` +
        `${UNTRUSTED_NOTE} Confirm with the user before moving or changing more than a few messages.`,
    },
  );
  registerTools(server, mail, config);

  const shutdown = async () => {
    await mail.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; anything for humans goes to stderr.
  process.stderr.write(`icloud-mail MCP server ready for ${config.user}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
