import MailComposer from "nodemailer/lib/mail-composer";
import { formatAddress, type Address, type CleanMessage } from "./parse.js";

export interface DraftInput {
  from: string;
  fromName?: string | undefined;
  to?: string[] | undefined;
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject?: string | undefined;
  body: string;
  /** The message being replied to, if this draft is a reply. */
  original?: CleanMessage | undefined;
  replyAll?: boolean | undefined;
}

export interface DraftHeaders {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  inReplyTo: string | undefined;
  references: string[];
}

export function replySubject(subject: string): string {
  return /^\s*re:/i.test(subject) ? subject.trim() : `Re: ${subject.trim()}`;
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Works out recipients, subject and threading headers for a draft. */
export function draftHeaders(input: DraftInput): DraftHeaders {
  const original = input.original;
  let to = input.to ?? [];
  let cc = input.cc ?? [];

  if (original) {
    if (to.length === 0) {
      const replyTargets = original.replyTo.length > 0 ? original.replyTo : original.from;
      to = replyTargets.map((a) => a.address);
    }
    if (input.replyAll && (input.cc ?? []).length === 0) {
      const others: Address[] = [...original.to, ...original.cc];
      cc = others
        .map((a) => a.address)
        .filter((addr) => !sameAddress(addr, input.from) && !to.some((t) => sameAddress(t, addr)));
      cc = [...new Set(cc.map((c) => c.toLowerCase()))];
    }
  }

  const references = original
    ? [...original.references, ...(original.messageId ? [original.messageId] : [])]
    : [];

  return {
    to,
    cc,
    bcc: input.bcc ?? [],
    subject: input.subject?.trim() || (original ? replySubject(original.subject) : ""),
    inReplyTo: original?.messageId ?? undefined,
    references: [...new Set(references)],
  };
}

/** Body text with the original message quoted underneath, as mail clients do. */
export function replyBody(body: string, original: CleanMessage | undefined): string {
  if (!original) return body;
  const who = original.from[0] ? formatAddress(original.from[0]) : "the sender";
  const when = original.date ? new Date(original.date).toUTCString() : "an earlier date";
  const quoted = original.text
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
  return `${body.trimEnd()}\n\nOn ${when}, ${who} wrote:\n\n${quoted}\n`;
}

/** Builds the raw RFC 822 message to append to the Drafts mailbox. */
export async function buildDraft(input: DraftInput): Promise<{ raw: Buffer; headers: DraftHeaders }> {
  const headers = draftHeaders(input);
  const composer = new MailComposer({
    from: input.fromName ? { name: input.fromName, address: input.from } : input.from,
    to: headers.to,
    cc: headers.cc,
    bcc: headers.bcc,
    subject: headers.subject,
    text: replyBody(input.body, input.original),
    inReplyTo: headers.inReplyTo,
    references: headers.references,
  });
  const node = composer.compile();
  // A draft must keep its Bcc line so the mail client can send to it later.
  node.keepBcc = true;
  const raw = await node.build();
  return { raw, headers };
}
