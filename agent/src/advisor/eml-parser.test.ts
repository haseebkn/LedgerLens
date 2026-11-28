import { describe, expect, it } from "vitest";
import {
  decodeQuotedPrintable,
  extractEmailAddress,
  normalizeIngestDocument,
  parseEml,
} from "./eml-parser.js";

describe("eml-parser", () => {
  it("parses RFC-5322 headers, folded lines, and plain-text body", () => {
    const raw = [
      "From: Priya Nair <priya.nair@example.com>",
      "To: Sarah Jenkins <sarah.jenkins@atlanticharbour.example>",
      "Subject: New mailing address and",
      " RRSP contribution plan",
      "Date: Thu, 15 Oct 2026 14:22:00 -0330",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Hi Sarah,",
      "",
      "We moved to 12 Water St, St. John's, NL A1C 1A1 last weekend.",
      "Please update our mailing address on file.",
    ].join("\r\n");

    const parsed = parseEml(raw);
    expect(parsed.from).toBe("Priya Nair <priya.nair@example.com>");
    expect(parsed.to).toBe("Sarah Jenkins <sarah.jenkins@atlanticharbour.example>");
    expect(parsed.subject).toBe("New mailing address and RRSP contribution plan");
    expect(parsed.date).toBe("2026-10-15");
    expect(parsed.body).toContain("12 Water St, St. John's, NL A1C 1A1");
    expect(extractEmailAddress(parsed.from)).toBe("priya.nair@example.com");
  });

  it("decodes quoted-printable and multipart/alternative emails", () => {
    const raw = [
      "From: Claire Brooks <claire.brooks@example.com>",
      "To: sarah.jenkins@atlanticharbour.example",
      "Subject: =?UTF-8?Q?Q4_Review_&_Follow-up?=",
      "Date: Tue, 20 Oct 2026 09:00:00 +0000",
      'Content-Type: multipart/alternative; boundary="bndry42"',
      "",
      "--bndry42",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Hello Sarah,=0AWe would like to review our balanced allocation=20=",
      "before year-end.",
      "--bndry42",
      "Content-Type: text/html; charset=UTF-8",
      "",
      "<p>Hello Sarah</p>",
      "--bndry42--",
    ].join("\n");

    const parsed = parseEml(raw);
    expect(parsed.subject).toBe("Q4 Review & Follow-up");
    expect(parsed.body).toContain("Hello Sarah");
    expect(parsed.body).toContain("balanced allocation before year-end.");
  });

  it("decodes base64 text/plain body and HTML-only fallback", () => {
    const b64 = Buffer.from("Please schedule a tuition planning call in November.", "utf-8").toString("base64");
    const rawB64 = [
      "From: david.chen@example.com",
      "To: sarah.jenkins@atlanticharbour.example",
      "Subject: Tuition call",
      "Content-Transfer-Encoding: base64",
      "",
      b64,
    ].join("\n");
    expect(parseEml(rawB64).body).toBe("Please schedule a tuition planning call in November.");

    const rawHtml = [
      "From: david.chen@example.com",
      "To: sarah.jenkins@atlanticharbour.example",
      "Subject: HTML note",
      "Content-Type: text/html; charset=UTF-8",
      "",
      "<p>Hello <b>Sarah</b>,<br/>Let&apos;s meet Friday &amp; discuss RESP.</p>",
    ].join("\n");
    expect(parseEml(rawHtml).body).toContain("Hello  Sarah");
    expect(parseEml(rawHtml).body).toContain("discuss RESP.");
  });

  it("normalizes both transcripts and .eml documents cleanly", () => {
    const transcript = normalizeIngestDocument({
      kind: "transcript",
      filename: "priya_q4_call.md",
      content: "# Q4 Portfolio Check-in — Priya Nair\nDate: 2026-10-18\nPriya confirmed her new address at 12 Water St.",
      now: new Date("2026-10-20T12:00:00Z"),
    });
    expect(transcript.title).toBe("Q4 Portfolio Check-in — Priya Nair");
    expect(transcript.date).toBe("2026-10-18");
    expect(transcript.sender).toBeNull();

    const eml = normalizeIngestDocument({
      kind: "eml",
      filename: "move.eml",
      content: "From: priya@example.com\nTo: sarah@atlanticharbour.example\nSubject: Address update\nDate: 2026-10-19T10:00:00Z\n\nNew address is 12 Water St.",
    });
    expect(eml.title).toBe("Address update");
    expect(eml.sender).toBe("priya@example.com");
    expect(eml.recipient).toBe("sarah@atlanticharbour.example");
    expect(eml.extractionText).toContain("Subject: Address update");
  });

  it("handles quoted-printable soft line breaks", () => {
    expect(decodeQuotedPrintable("Line one=\n continued =3D ok")).toBe("Line one continued = ok");
  });
});
