import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildDraft, draftHeaders, replySubject } from "../src/mail/compose.js";
import { sensitiveReason } from "../src/mail/filter.js";
import { cleanMessage, parseRaw, snippet, stripQuoted, truncate, wrapUntrusted } from "../src/mail/parse.js";

const fixture = async (name: string) =>
  cleanMessage(await parseRaw(await readFile(new URL(`./fixtures/${name}`, import.meta.url))));

describe("parse", () => {
  it("extracts headers, threading ids and attachments", async () => {
    const msg = await fixture("reply.eml");
    expect(msg.from).toEqual([{ name: "Jane Doe", address: "jane@example.com" }]);
    expect(msg.cc[0]?.address).toBe("sam@example.com");
    expect(msg.subject).toBe("Lunch on Friday?");
    expect(msg.messageId).toBe("<reply-2@example.com>");
    expect(msg.references).toEqual(["<root-1@example.com>"]);
    expect(msg.date).toBe("2026-11-12T09:15:00.000Z");
    expect(msg.attachments).toEqual([
      expect.objectContaining({ index: 0, filename: "menu.txt", contentType: "text/plain" }),
    ]);
  });

  it("strips quoted history from a reply", async () => {
    const msg = await fixture("reply.eml");
    expect(msg.text).toContain("Are you free for lunch");
    expect(stripQuoted(msg.text)).toBe("Friday works for me. Noon at the usual place?");
  });

  it("strips Outlook-style and forwarded history", () => {
    expect(stripQuoted("Sounds good.\n\n-----Original Message-----\nFrom: A\nold text")).toBe("Sounds good.");
    expect(stripQuoted("Agreed.\n\nFrom: A <a@x.com>\nSent: Monday\nTo: B\n\nold")).toBe("Agreed.");
  });

  it("keeps the text when the whole message is a quote", () => {
    expect(stripQuoted("> only quoted")).toBe("> only quoted");
  });

  it("derives text from an HTML-only message", async () => {
    const msg = await fixture("html.eml");
    expect(msg.text).toContain("20% off");
    expect(msg.text).not.toContain("<b>");
  });

  it("falls back to HTML when the text part is empty", async () => {
    const msg = await fixture("empty-text-part.eml");
    expect(msg.text).toContain("Noon is perfect, see you there.");
    expect(msg.text).not.toContain("example.com/map");
    expect(stripQuoted(msg.text)).toBe("Noon is perfect, see you there.");
  });

  it("wraps email text so it cannot close the wrapper early", async () => {
    const wrapped = wrapUntrusted((await fixture("html.eml")).text);
    expect(wrapped.startsWith("<untrusted_email_content>\n")).toBe(true);
    expect(wrapped.endsWith("\n</untrusted_email_content>")).toBe(true);
    expect(wrapped.match(/<\/untrusted_email_content>/g)).toHaveLength(1);
  });

  it("truncates and makes snippets", () => {
    expect(truncate("abcdef", 3)).toEqual({ text: "abc", truncated: true });
    expect(truncate("abc", 3)).toEqual({ text: "abc", truncated: false });
    expect(snippet("a\n\n  b   c", 200)).toBe("a b c");
    expect(snippet("x".repeat(300), 10)).toBe(`${"x".repeat(10)}…`);
  });
});

describe("sensitive-mail filter", () => {
  it("flags sign-in codes by subject and by body", async () => {
    expect(sensitiveReason(await fixture("otp.eml"))).toBe("sign-in code");
    expect(sensitiveReason({ subject: "Hello", text: "Your code is 482913." })).toBe("sign-in code");
    expect(sensitiveReason({ subject: "Hi", text: "123456 is your Example verification code" })).toBe("sign-in code");
  });

  it.each([
    "Reset your password",
    "Password reset request",
    "Your one-time passcode",
    "Security alert: new sign-in on Mac",
    "Verify your email address",
    "Your Apple Account two-factor authentication",
  ])("flags %s", (subject) => {
    expect(sensitiveReason({ subject })).not.toBeNull();
  });

  it("leaves ordinary mail alone", async () => {
    expect(sensitiveReason(await fixture("reply.eml"))).toBeNull();
    expect(sensitiveReason(await fixture("html.eml"))).toBeNull();
    expect(sensitiveReason({ subject: "Invoice 20261112", text: "Total due: 1200. Order 482913." })).toBeNull();
    expect(sensitiveReason({ subject: "Zip code change for delivery", text: "See you then" })).toBeNull();
  });
});

describe("drafts", () => {
  it("prefixes Re: once", () => {
    expect(replySubject("Lunch")).toBe("Re: Lunch");
    expect(replySubject("RE: Lunch")).toBe("RE: Lunch");
  });

  it("fills reply recipients and threading headers from the original", async () => {
    const original = await fixture("reply.eml");
    const headers = draftHeaders({ from: "me@icloud.com", body: "See you there.", original });
    expect(headers.to).toEqual(["jane@example.com"]);
    expect(headers.cc).toEqual([]);
    expect(headers.subject).toBe("Re: Lunch on Friday?");
    expect(headers.inReplyTo).toBe("<reply-2@example.com>");
    expect(headers.references).toEqual(["<root-1@example.com>", "<reply-2@example.com>"]);
  });

  it("reply-all copies other recipients but not yourself", async () => {
    const original = await fixture("reply.eml");
    const headers = draftHeaders({ from: "me@icloud.com", body: "ok", original, replyAll: true });
    expect(headers.cc).toEqual(["sam@example.com"]);
  });

  it("builds a parseable message that quotes the original and keeps Bcc", async () => {
    const original = await fixture("reply.eml");
    const { raw } = await buildDraft({
      from: "me@icloud.com",
      fromName: "Me",
      bcc: ["archive@example.com"],
      body: "See you there.",
      original,
    });
    const text = raw.toString("utf8");
    expect(text).toMatch(/^Bcc: archive@example\.com/m);
    const draft = cleanMessage(await parseRaw(raw));
    expect(draft.from[0]).toEqual({ name: "Me", address: "me@icloud.com" });
    expect(draft.to[0]?.address).toBe("jane@example.com");
    expect(draft.inReplyTo).toBe("<reply-2@example.com>");
    expect(draft.references).toEqual(["<root-1@example.com>", "<reply-2@example.com>"]);
    expect(draft.text).toContain("See you there.");
    expect(draft.text).toContain("> Friday works for me.");
    expect(stripQuoted(draft.text)).toBe("See you there.");
  });

  it("builds a new message with explicit recipients", async () => {
    const { headers } = await buildDraft({ from: "me@icloud.com", to: ["a@example.com"], subject: "Hi", body: "Hello" });
    expect(headers).toMatchObject({ to: ["a@example.com"], subject: "Hi", references: [] });
    expect(headers.inReplyTo).toBeUndefined();
  });
});
