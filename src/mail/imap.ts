import { ImapFlow } from "imapflow";
import type { ParsedMail } from "mailparser";
import type { Config } from "../config.js";
import { parseRaw } from "./parse.js";

export interface MailboxInfo {
  path: string;
  name: string;
  specialUse: string | null;
  messages: number | null;
  unseen: number | null;
}

export interface SearchCriteria {
  mailbox: string;
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  /** Matches anywhere in headers or body. */
  text?: string | undefined;
  since?: Date | undefined;
  before?: Date | undefined;
  unread?: boolean | undefined;
  flagged?: boolean | undefined;
  limit: number;
  offset: number;
}

export interface FetchedMessage {
  uid: number;
  flags: string[];
  size: number | null;
  internalDate: string | null;
  parsed: ParsedMail;
  /** True when only the first part of the message was downloaded. */
  partial: boolean;
  /** From the server's body structure, so it is right even for partial downloads. */
  hasAttachments: boolean;
}

export interface SearchPage {
  total: number;
  messages: FetchedMessage[];
}

export type SpecialFolder = "archive" | "trash" | "drafts" | "sent" | "junk";

const SPECIAL_USE: Record<SpecialFolder, string> = {
  archive: "\\Archive",
  trash: "\\Trash",
  drafts: "\\Drafts",
  sent: "\\Sent",
  junk: "\\Junk",
};

/** Names iCloud uses when a folder is not tagged with a special-use flag. */
const FALLBACK_NAMES: Record<SpecialFolder, string[]> = {
  archive: ["Archive"],
  trash: ["Deleted Messages", "Trash"],
  drafts: ["Drafts"],
  sent: ["Sent Messages", "Sent"],
  junk: ["Junk"],
};

const IDLE_CLOSE_MS = 60_000;
/** Bytes downloaded per message when only a preview is needed. */
const PREVIEW_BYTES = 16 * 1024;

/**
 * Thin wrapper over one IMAP connection. Calls are run one at a time, the
 * connection is opened on first use and closed after a minute idle, so the
 * server never holds more than one session against Apple's limits.
 */
export class MailClient {
  private client: ImapFlow | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private mailboxCache: MailboxInfo[] | null = null;

  constructor(
    private readonly config: Config,
    private readonly getPassword: () => Promise<string>,
  ) {}

  private async connect(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: true,
      auth: { user: this.config.user, pass: await this.getPassword() },
      logger: false,
    });
    client.on("error", () => {
      /* surfaced through the failing call; avoid an unhandled 'error' event */
    });
    client.on("close", () => {
      if (this.client === client) this.client = null;
    });
    await client.connect();
    this.client = client;
    return client;
  }

  /** Runs `fn` with a live connection, after any call already in flight. */
  private run<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      try {
        return await fn(await this.connect());
      } finally {
        this.idleTimer = setTimeout(() => void this.close(), IDLE_CLOSE_MS);
        this.idleTimer.unref();
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const client = this.client;
    this.client = null;
    if (client?.usable) await client.logout().catch(() => client.close());
  }

  async listMailboxes(): Promise<MailboxInfo[]> {
    return this.run(async (client) => {
      const list = await client.list({ statusQuery: { messages: true, unseen: true } });
      const boxes = list
        .filter((box) => !box.flags.has("\\Noselect"))
        .map((box) => ({
          path: box.path,
          name: box.name,
          specialUse: box.specialUse ?? null,
          messages: box.status?.messages ?? null,
          unseen: box.status?.unseen ?? null,
        }));
      this.mailboxCache = boxes;
      return boxes;
    });
  }

  /** Resolves "archive", "trash" and so on to this account's real folder path. */
  async resolveSpecial(kind: SpecialFolder): Promise<string> {
    const boxes = this.mailboxCache ?? (await this.listMailboxes());
    const tagged = boxes.find((box) => box.specialUse === SPECIAL_USE[kind]);
    if (tagged) return tagged.path;
    for (const name of FALLBACK_NAMES[kind]) {
      const named = boxes.find((box) => box.path.toLowerCase() === name.toLowerCase());
      if (named) return named.path;
    }
    throw new Error(`This account has no ${kind} folder that could be identified.`);
  }

  async search(criteria: SearchCriteria): Promise<SearchPage> {
    return this.run(async (client) => {
      const lock = await client.getMailboxLock(criteria.mailbox, { readOnly: true });
      try {
        const query: Record<string, unknown> = {};
        if (criteria.from) query.from = criteria.from;
        if (criteria.to) query.to = criteria.to;
        if (criteria.subject) query.subject = criteria.subject;
        if (criteria.text) query.text = criteria.text;
        if (criteria.since) query.since = criteria.since;
        if (criteria.before) query.before = criteria.before;
        if (criteria.unread !== undefined) query.seen = !criteria.unread;
        if (criteria.flagged !== undefined) query.flagged = criteria.flagged;
        if (Object.keys(query).length === 0) query.all = true;

        const found = await client.search(query, { uid: true });
        const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a);
        const page = uids.slice(criteria.offset, criteria.offset + criteria.limit);
        if (page.length === 0) return { total: uids.length, messages: [] };

        const messages: FetchedMessage[] = [];
        for await (const msg of client.fetch(
          page,
          {
            uid: true,
            flags: true,
            size: true,
            internalDate: true,
            bodyStructure: true,
            source: { start: 0, maxLength: PREVIEW_BYTES },
          },
          { uid: true },
        )) {
          if (!msg.source) continue;
          messages.push({
            uid: msg.uid,
            flags: [...(msg.flags ?? [])],
            size: msg.size ?? null,
            internalDate: toIso(msg.internalDate),
            parsed: await parseRaw(msg.source),
            partial: (msg.size ?? 0) > PREVIEW_BYTES,
            hasAttachments: structureHasAttachment(msg.bodyStructure),
          });
        }
        messages.sort((a, b) => b.uid - a.uid);
        return { total: uids.length, messages };
      } finally {
        lock.release();
      }
    });
  }

  async fetchMessage(mailbox: string, uid: number): Promise<FetchedMessage> {
    return this.run(async (client) => {
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        return await fetchFull(client, mailbox, uid);
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Finds the other messages in a conversation by following Message-ID,
   * In-Reply-To and References headers across the given mailboxes. iCloud has
   * no server-side threading, so this is a header search.
   */
  async fetchThread(
    mailboxes: string[],
    ids: string[],
    max: number,
  ): Promise<Array<FetchedMessage & { mailbox: string }>> {
    if (ids.length === 0) return [];
    return this.run(async (client) => {
      const out: Array<FetchedMessage & { mailbox: string }> = [];
      for (const mailbox of mailboxes) {
        const lock = await client.getMailboxLock(mailbox, { readOnly: true });
        try {
          // One OR search per mailbox keeps this to a single round trip each.
          const or = ids.flatMap((id) =>
            ["message-id", "references", "in-reply-to"].map((header) => ({ header: { [header]: id } })),
          );
          const found = await client.search({ or }, { uid: true });
          const uids = new Set<number>(Array.isArray(found) ? found : []);
          for (const uid of [...uids].sort((a, b) => a - b).slice(-max)) {
            out.push({ ...(await fetchFull(client, mailbox, uid)), mailbox });
          }
        } finally {
          lock.release();
        }
      }
      return out;
    });
  }

  async setFlags(
    mailbox: string,
    uids: number[],
    change: { read?: boolean | undefined; flagged?: boolean | undefined },
  ): Promise<void> {
    await this.run(async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const apply = async (flag: string, on: boolean | undefined) => {
          if (on === undefined) return;
          if (on) await client.messageFlagsAdd(uids, [flag], { uid: true });
          else await client.messageFlagsRemove(uids, [flag], { uid: true });
        };
        await apply("\\Seen", change.read);
        await apply("\\Flagged", change.flagged);
      } finally {
        lock.release();
      }
    });
  }

  async move(mailbox: string, uids: number[], destination: string): Promise<number> {
    return this.run(async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const result = await client.messageMove(uids, destination, { uid: true });
        if (!result) throw new Error(`Could not move messages to "${destination}".`);
        return result.uidMap ? result.uidMap.size : uids.length;
      } finally {
        lock.release();
      }
    });
  }

  async appendDraft(raw: Buffer): Promise<{ mailbox: string; uid: number | null }> {
    const drafts = await this.resolveSpecial("drafts");
    return this.run(async (client) => {
      const result = await client.append(drafts, raw, ["\\Draft", "\\Seen"]);
      if (!result) throw new Error("The server refused the draft.");
      return { mailbox: drafts, uid: result.uid ?? null };
    });
  }
}

async function fetchFull(client: ImapFlow, mailbox: string, uid: number): Promise<FetchedMessage> {
  const msg = await client.fetchOne(
    String(uid),
    { uid: true, flags: true, size: true, internalDate: true, bodyStructure: true, source: true },
    { uid: true },
  );
  if (!msg || !msg.source) throw new Error(`No message with uid ${uid} in "${mailbox}".`);
  return {
    uid: msg.uid,
    flags: [...(msg.flags ?? [])],
    size: msg.size ?? null,
    internalDate: toIso(msg.internalDate),
    parsed: await parseRaw(msg.source),
    partial: false,
    hasAttachments: structureHasAttachment(msg.bodyStructure),
  };
}

function toIso(value: Date | string | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

interface StructureNode {
  disposition?: string | undefined;
  childNodes?: StructureNode[] | undefined;
}

function structureHasAttachment(node: StructureNode | undefined): boolean {
  if (!node) return false;
  if (node.disposition?.toLowerCase() === "attachment") return true;
  return (node.childNodes ?? []).some(structureHasAttachment);
}
