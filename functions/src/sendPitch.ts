// Emails a sandbox pitch card PDF to the people at a table, through Resend.
// Shared by the Firebase function (index.ts) and the Vite dev server (vite.config.ts),
// so it must not import anything Firebase-specific.

const SENDER = "marisha.boyd@oxygyconsulting.com";
const FROM = `OXYGY Innovation Sandbox <${SENDER}>`;
const MAX_RECIPIENTS = 8;
const MAX_PDF_BYTES = 6 * 1024 * 1024;
const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/;

export interface SendPitchResult {
  status: number;
  body: { ok?: true; sent?: number; error?: string };
}

export async function sendPitch(apiKey: string | undefined, input: unknown): Promise<SendPitchResult> {
  if (!apiKey) return { status: 503, body: { error: "Email sending is not set up yet. Save the PDF instead." } };

  const { emails, tableName, pdfBase64 } = (input ?? {}) as Record<string, unknown>;

  const to = Array.isArray(emails)
    ? [...new Set(emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))]
    : [];
  if (!to.length) return { status: 400, body: { error: "Add at least one email address." } };
  if (to.length > MAX_RECIPIENTS) return { status: 400, body: { error: `Send to ${MAX_RECIPIENTS} people at most.` } };
  const invalid = to.filter((e) => !EMAIL_RE.test(e));
  if (invalid.length) return { status: 400, body: { error: `Check these addresses: ${invalid.join(", ")}` } };

  const pdf = typeof pdfBase64 === "string" ? Buffer.from(pdfBase64, "base64") : Buffer.alloc(0);
  if (!pdf.length || pdf.length > MAX_PDF_BYTES || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return { status: 400, body: { error: "The pitch card PDF is missing or invalid." } };
  }

  const table = String(tableName ?? "").replace(/[\r\n<>&"]/g, " ").trim().slice(0, 60) || "Your table";
  const slug = table.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "table";

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to,
      reply_to: SENDER,
      subject: `Your pitch card · ${table}`,
      text: `Hello,\n\nAttached is the pitch card ${table} built in the OXYGY Innovation Sandbox.\n\nOXYGY`,
      html: `<p>Hello,</p><p>Attached is the pitch card <strong>${table}</strong> built in the OXYGY Innovation Sandbox.</p><p>OXYGY</p>`,
      attachments: [{ filename: `pitch-card-${slug}.pdf`, content: pdf.toString("base64") }],
    }),
  });

  if (!resp.ok) {
    console.error("send-pitch: Resend error", resp.status, await resp.text());
    return { status: 502, body: { error: "The email could not be sent. Try again, or save the PDF instead." } };
  }
  return { status: 200, body: { ok: true, sent: to.length } };
}
