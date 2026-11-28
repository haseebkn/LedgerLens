/**
 * Zero-dependency RFC-5322 `.eml` parser and document normalizer for Phase 3.5
 * meeting-note and email ingestion.
 */

export interface ParsedEml {
  from: string;
  to: string;
  subject: string;
  date: string | null;
  sentAtIso: string | null;
  messageId: string | null;
  body: string;
  headers: Record<string, string>;
}

export interface NormalizedIngestDocument {
  kind: "transcript" | "eml";
  title: string;
  date: string;
  sentAtIso: string;
  sender: string | null;
  recipient: string | null;
  body: string;
  /** Combined text passed to the extractor and prompt-injection scanner. */
  extractionText: string;
}

function decodeRfc2047Word(input: string): string {
  return input.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, _charset: string, enc: string, payload: string) => {
    try {
      if (enc.toUpperCase() === "B") {
        return Buffer.from(payload, "base64").toString("utf-8");
      }
      const qp = payload.replace(/_/g, " ");
      return decodeQuotedPrintable(qp);
    } catch {
      return payload;
    }
  });
}

export function decodeQuotedPrintable(input: string): string {
  // Remove soft line breaks ("=\n")
  const unfolded = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < unfolded.length; i++) {
    const ch = unfolded[i]!;
    if (ch === "=" && i + 2 < unfolded.length) {
      const hex = unfolded.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    const buf = Buffer.from(ch, "utf-8");
    for (const b of buf) bytes.push(b);
  }
  return Buffer.from(bytes).toString("utf-8");
}

function decodeBody(body: string, transferEncoding: string | undefined): string {
  const enc = (transferEncoding ?? "").trim().toLowerCase();
  if (enc === "quoted-printable") {
    return decodeQuotedPrintable(body);
  }
  if (enc === "base64") {
    try {
      const compact = body.replace(/\s+/g, "");
      return Buffer.from(compact, "base64").toString("utf-8");
    } catch {
      return body;
    }
  }
  return body;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseHeaders(headerBlock: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = headerBlock.split("\n");
  let currentName: string | null = null;

  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && currentName) {
      headers[currentName] = `${headers[currentName]} ${line.trim()}`.trim();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = decodeRfc2047Word(line.slice(colon + 1).trim());
    headers[name] = value;
    currentName = name;
  }

  return headers;
}

function extractBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function extractTextFromMime(headers: Record<string, string>, rawBody: string, depth = 0): string {
  if (depth > 4) return rawBody.trim();
  const contentType = (headers["content-type"] ?? "text/plain").toLowerCase();

  if (contentType.startsWith("multipart/")) {
    const boundary = extractBoundary(headers["content-type"]);
    if (boundary) {
      const delimiter = `--${boundary}`;
      const rawParts = rawBody.split(delimiter).slice(1);
      let plainCandidate: string | null = null;
      let htmlCandidate: string | null = null;

      for (const part of rawParts) {
        if (part.startsWith("--")) break; // closing boundary
        const trimmed = part.replace(/^\n/, "");
        const splitIdx = trimmed.indexOf("\n\n");
        if (splitIdx === -1) continue;
        const partHeaders = parseHeaders(trimmed.slice(0, splitIdx));
        const partBody = trimmed.slice(splitIdx + 2).replace(/\n$/, "");
        const partCt = (partHeaders["content-type"] ?? "text/plain").toLowerCase();

        if (partCt.startsWith("multipart/")) {
          const nested = extractTextFromMime(partHeaders, partBody, depth + 1);
          if (nested && !plainCandidate) plainCandidate = nested;
        } else if (partCt.startsWith("text/plain")) {
          const decoded = decodeBody(partBody, partHeaders["content-transfer-encoding"]).trim();
          if (decoded && !plainCandidate) plainCandidate = decoded;
        } else if (partCt.startsWith("text/html")) {
          const decoded = stripHtml(decodeBody(partBody, partHeaders["content-transfer-encoding"]));
          if (decoded && !htmlCandidate) htmlCandidate = decoded;
        }
      }

      if (plainCandidate) return plainCandidate;
      if (htmlCandidate) return htmlCandidate;
    }
  }

  const decoded = decodeBody(rawBody, headers["content-transfer-encoding"]);
  if (contentType.startsWith("text/html")) {
    return stripHtml(decoded);
  }
  return decoded.trim();
}

export function extractEmailAddress(headerValue: string): string {
  const angleMatch = /<([^<>\s@]+@[^<>\s@]+)>/i.exec(headerValue);
  if (angleMatch?.[1]) return angleMatch[1].trim();
  const bareMatch = /([^\s,;<>@]+@[^\s,;<>@]+)/i.exec(headerValue);
  if (bareMatch?.[1]) return bareMatch[1].trim();
  return headerValue.trim();
}

function parseDateHeader(rawDate: string | undefined): { date: string | null; sentAtIso: string | null } {
  if (!rawDate) return { date: null, sentAtIso: null };
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return { date: null, sentAtIso: null };
  const iso = parsed.toISOString();
  return { date: iso.slice(0, 10), sentAtIso: iso };
}

/** Parses a raw RFC-5322 `.eml` string into headers, metadata, and decoded text body. */
export function parseEml(raw: string): ParsedEml {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimStart();
  const sepIdx = normalized.indexOf("\n\n");
  const headerBlock = sepIdx === -1 ? normalized : normalized.slice(0, sepIdx);
  const rawBody = sepIdx === -1 ? "" : normalized.slice(sepIdx + 2);

  const headers = parseHeaders(headerBlock);
  const { date, sentAtIso } = parseDateHeader(headers["date"]);
  const body = extractTextFromMime(headers, rawBody);

  return {
    from: headers["from"] ?? "",
    to: headers["to"] ?? "",
    subject: headers["subject"] ?? "",
    date,
    sentAtIso,
    messageId: headers["message-id"] ?? null,
    body,
    headers,
  };
}

function titleFromFilename(filename: string | undefined, fallback: string): string {
  if (!filename) return fallback;
  const base = filename
    .replace(/^.*[\\/]/, "")
    .replace(/\.(eml|txt|md|markdown)$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return base || fallback;
}

function extractDateFromText(text: string): string | null {
  const iso = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(text);
  return iso?.[1] ?? null;
}

function extractTitleFromTranscript(text: string, filename: string | undefined): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  if (first.startsWith("#")) {
    const heading = first.replace(/^#+\s*/, "").trim();
    if (heading.length > 0 && heading.length <= 160) return heading;
  }
  const titlePrefix = /^(?:title|subject|meeting)\s*:\s*(.+)$/i.exec(first);
  if (titlePrefix?.[1]) return titlePrefix[1].trim().slice(0, 160);
  return titleFromFilename(filename, "Uploaded meeting transcript");
}

/** Normalizes either a transcript or `.eml` email into a uniform ingest structure. */
export function normalizeIngestDocument(params: {
  kind: "transcript" | "eml";
  content: string;
  filename?: string;
  now?: Date;
}): NormalizedIngestDocument {
  const now = params.now ?? new Date();
  const today = now.toISOString().slice(0, 10);

  if (params.kind === "eml") {
    const parsed = parseEml(params.content);
    const title = parsed.subject.trim() || titleFromFilename(params.filename, "Uploaded client email");
    const date = parsed.date ?? extractDateFromText(parsed.body) ?? today;
    const sentAtIso = parsed.sentAtIso ?? `${date}T12:00:00.000Z`;
    const sender = parsed.from ? extractEmailAddress(parsed.from) : "unknown@client.example";
    const recipient = parsed.to ? extractEmailAddress(parsed.to) : "advisor@atlanticharbour.example";
    const body = parsed.body.trim() || params.content.trim();
    const extractionText = [
      parsed.from ? `From: ${parsed.from}` : "",
      parsed.to ? `To: ${parsed.to}` : "",
      `Subject: ${title}`,
      `Date: ${date}`,
      "",
      body,
    ]
      .filter((line, idx, arr) => line !== "" || (idx > 0 && arr[idx - 1] !== ""))
      .join("\n");

    return {
      kind: "eml",
      title,
      date,
      sentAtIso,
      sender,
      recipient,
      body,
      extractionText,
    };
  }

  const normalized = params.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const title = extractTitleFromTranscript(normalized, params.filename);
  const date = extractDateFromText(normalized) ?? today;
  return {
    kind: "transcript",
    title,
    date,
    sentAtIso: `${date}T12:00:00.000Z`,
    sender: null,
    recipient: null,
    body: normalized,
    extractionText: normalized,
  };
}
