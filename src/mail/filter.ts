/**
 * Sensitive-mail filter.
 *
 * Mail that carries sign-in codes, password resets or security alerts is the
 * most valuable thing in a mailbox to an attacker, and an agent rarely needs
 * to read it. When the filter is on, such messages return headers only.
 */

const SUBJECT_PATTERNS: Array<[RegExp, string]> = [
  [/\b(verification|security|sign[- ]?in|log[- ]?in|login|access|authentication|confirmation)\s+code\b/i, "sign-in code"],
  [/\bone[- ]time\s+(pass(word|code)|code|pin)\b/i, "one-time code"],
  [/\b(otp|2fa|mfa)\b/i, "one-time code"],
  [/\btwo[- ](factor|step)\b/i, "two-factor message"],
  [/\b(reset|recover|change|forgot)\b.{0,20}\bpass(word|code)\b/i, "password reset"],
  [/\bpass(word|code)\b.{0,20}\b(reset|recovery|changed|change)\b/i, "password reset"],
  [/\bmagic\s+link\b/i, "sign-in link"],
  [/\b(verify|confirm)\s+(your\s+)?(e-?mail|account|identity|device)\b/i, "account verification"],
  [/\bsecurity\s+alert\b/i, "security alert"],
  [/\bnew\s+(sign[- ]?in|log[- ]?in|login|device)\b/i, "security alert"],
  [/\b(unusual|suspicious)\s+(sign[- ]?in|log[- ]?in|activity)\b/i, "security alert"],
  [/\brecovery\s+(key|code|contact)\b/i, "account recovery"],
];

const BODY_PATTERNS: Array<[RegExp, string]> = [
  [/\b(code|pin|passcode)\b[^\n]{0,40}?\b\d{4,8}\b/i, "sign-in code"],
  [/\b\d{4,8}\b[^\n]{0,40}?\bis\s+your\b[^\n]{0,40}?\b(code|pin|passcode)\b/i, "sign-in code"],
  [/\breset\s+(your\s+)?password\b/i, "password reset"],
];

export interface SensitivityInput {
  subject?: string;
  text?: string;
}

/** Returns a short reason when the message looks sensitive, otherwise null. */
export function sensitiveReason(input: SensitivityInput): string | null {
  const subject = input.subject ?? "";
  for (const [pattern, reason] of SUBJECT_PATTERNS) {
    if (pattern.test(subject)) return reason;
  }
  // Only look at the start of the body: codes and reset links lead the message.
  const head = (input.text ?? "").slice(0, 1500);
  for (const [pattern, reason] of BODY_PATTERNS) {
    if (pattern.test(head)) return reason;
  }
  return null;
}

export function withheldNotice(reason: string): string {
  return `[Body withheld by the sensitive-mail filter: looks like a ${reason}. Ask the user to read this message themselves.]`;
}
