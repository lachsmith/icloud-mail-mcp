import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const KEYCHAIN_SERVICE = "icloud-mail-mcp";

export interface Config {
  /** Primary iCloud address used to log in (not an alias). */
  user: string;
  /** Address drafts are written from. Defaults to `user`. */
  from: string;
  /** Display name on drafts, if set. */
  fromName: string | undefined;
  host: string;
  port: number;
  /** Withhold bodies of sign-in codes, password resets and security alerts. */
  sensitiveFilter: boolean;
  /** Where get_attachment saves files when asked to. */
  attachmentDir: string;
  /** Upper bound on body text returned per message. */
  maxBodyChars: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const user = env.ICLOUD_USER?.trim();
  if (!user) {
    throw new Error(
      "ICLOUD_USER is not set. Set it to the primary address of the iCloud account (for example name@icloud.com).",
    );
  }
  return {
    user,
    from: env.ICLOUD_FROM?.trim() || user,
    fromName: env.ICLOUD_FROM_NAME?.trim() || undefined,
    host: env.ICLOUD_IMAP_HOST?.trim() || "imap.mail.me.com",
    port: Number(env.ICLOUD_IMAP_PORT) || 993,
    sensitiveFilter: (env.ICLOUD_SENSITIVE_FILTER ?? "on").toLowerCase() !== "off",
    attachmentDir: env.ICLOUD_ATTACHMENT_DIR?.trim() || join(homedir(), "Downloads", "icloud-mail-attachments"),
    maxBodyChars: Number(env.ICLOUD_MAX_BODY_CHARS) || 20_000,
  };
}

/**
 * Reads the app-specific password from the macOS login Keychain. It is never
 * read from the environment or from a file, so it cannot end up in a config
 * file or in shell history.
 */
export async function readPassword(user: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      user,
      "-w",
    ]);
    const password = stdout.trim();
    if (!password) throw new Error("empty password");
    return password;
  } catch {
    throw new Error(
      `No app-specific password found in the Keychain for ${user}. ` +
        `Add one with: security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${user} -w`,
    );
  }
}
