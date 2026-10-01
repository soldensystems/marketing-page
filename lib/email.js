// Transactional email for the invite form: the note to the team and the confirmation to the
// prospect. Both are table-based HTML with inline styles (what mail clients actually honour)
// plus a plain-text twin. Colours are the site's tokens written out, since clients ignore CSS
// variables. Every field is escaped here; the handler has already trimmed and capped them.

const SITE = "https://soldenai.com";
const LOCKUP = `${SITE}/assets/solden-lockup-dark.png`;
const C = {
  canvas: "#fbfaf6",
  surface: "#ffffff",
  ink: "#0b1530",
  inkSoft: "#2b3550",
  muted: "#5e6778",
  rule: "#e6e6ea",
  teal: "#18bfb0",
  tealInk: "#0a6f67",
  tealSoft: "#e3f6f3",
};
const SANS = "Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const SERIF = "Georgia, 'Iowan Old Style', 'Times New Roman', serif";
const MONO = "'Geist Mono', 'SFMono-Regular', Menlo, Consolas, monospace";

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "there";
}

function label(text) {
  return `<p style="margin:0 0 10px;font-family:${MONO};font-size:11px;line-height:16px;letter-spacing:.12em;text-transform:uppercase;color:${C.tealInk};">${escapeHtml(text)}</p>`;
}

function heading(text) {
  return `<h1 style="margin:0 0 14px;font-family:${SERIF};font-size:30px;line-height:36px;font-weight:normal;letter-spacing:-.01em;color:${C.ink};">${escapeHtml(text)}</h1>`;
}

function para(text, opts = {}) {
  const color = opts.muted ? C.muted : C.inkSoft;
  return `<p style="margin:0 0 ${opts.last ? 0 : 14}px;font-family:${SANS};font-size:16px;line-height:25px;color:${color};">${text}</p>`;
}

function row(name, value, opts = {}) {
  if (!value) return "";
  const body = opts.html ? value : escapeHtml(value);
  return `<tr>
  <td width="140" style="width:140px;padding:11px 16px 11px 0;border-top:1px solid ${C.rule};vertical-align:top;font-family:${SANS};font-size:13px;line-height:20px;color:${C.muted};">${escapeHtml(name)}</td>
  <td style="padding:11px 0;border-top:1px solid ${C.rule};vertical-align:top;font-family:${SANS};font-size:14px;line-height:21px;color:${C.ink};word-break:break-word;">${body}</td>
</tr>`;
}

function rows(items) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;border-bottom:1px solid ${C.rule};">${items.join("")}</table>`;
}

function quote(text) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:separate;">
  <tr>
    <td width="3" style="width:3px;background:${C.teal};font-size:0;line-height:0;">&nbsp;</td>
    <td style="padding:14px 18px;background:${C.canvas};font-family:${SANS};font-size:15px;line-height:24px;color:${C.ink};word-break:break-word;">${escapeHtml(text)}</td>
  </tr>
</table>`;
}

function button(text, href) {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 20px;border-radius:6px;background:${C.ink};font-family:${SANS};font-size:15px;line-height:18px;font-weight:500;color:#ffffff;text-decoration:none;">${escapeHtml(text)}</a>`;
}

function section(inner, opts = {}) {
  const pad = opts.pad || "0 40px 28px";
  return `<tr><td style="padding:${pad};">${inner}</td></tr>`;
}

function document({ title, preheader, sections, footer }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.canvas};color:${C.ink};font-family:${SANS};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;background:${C.canvas};">
<tr><td align="center" style="padding:32px 16px 40px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:600px;max-width:100%;border-collapse:separate;background:${C.surface};border:1px solid ${C.rule};border-radius:10px;">
<tr><td style="padding:28px 40px 24px;border-bottom:1px solid ${C.rule};">
  <a href="${SITE}" style="text-decoration:none;"><img src="${LOCKUP}" width="110" height="27" alt="Solden" style="display:block;width:110px;height:27px;border:0;"></a>
</td></tr>
<tr><td style="height:28px;font-size:0;line-height:0;">&nbsp;</td></tr>
${sections.join("\n")}
<tr><td style="padding:18px 40px 26px;border-top:1px solid ${C.rule};font-family:${SANS};font-size:12px;line-height:19px;color:${C.muted};">${footer}</td></tr>
</table>
<p style="margin:18px 0 0;font-family:${SANS};font-size:12px;line-height:18px;color:${C.muted};">Solden Systems Ltd. &nbsp;&middot;&nbsp; <a href="${SITE}" style="color:${C.muted};">soldenai.com</a></p>
</td></tr>
</table>
</body>
</html>`;
}

// To the team. Reply-to is the prospect, so a reply from the inbox goes straight back to them.
export function buildInternalEmail(fields, { leadId = null, source = "" } = {}) {
  const first = firstName(fields.name);
  const replyHref = `mailto:${encodeURIComponent(fields.email)}?subject=${encodeURIComponent("Re: your invite request to Solden")}`;
  const subject = `Invite request: ${fields.company}`;
  const html = document({
    title: subject,
    preheader: `${fields.name} at ${fields.company} asked for an invite.`,
    sections: [
      section(`${label("Invite request")}${heading(fields.name)}${para(escapeHtml(fields.company), { muted: true, last: true })}`),
      section(rows([
        row("Work email", `<a href="mailto:${escapeHtml(fields.email)}" style="color:${C.ink};">${escapeHtml(fields.email)}</a>`, { html: true }),
        row("Company", fields.company),
        row("Submitted from", source ? `${source} page` : ""),
        row("Lead", leadId ? String(leadId) : ""),
      ])),
      section(`${label("How their close runs today")}${quote(fields.message)}`),
      section(button(`Reply to ${first}`, replyHref), { pad: "0 40px 32px" }),
    ],
    footer: `Replying to this email reaches ${escapeHtml(fields.email)}. Sent by the invite form on soldenai.com.`,
  });
  const text = [
    "Invite request",
    "",
    `Name: ${fields.name}`,
    `Work email: ${fields.email}`,
    `Company: ${fields.company}`,
    source ? `Submitted from: ${source} page` : null,
    leadId ? `Lead: ${leadId}` : null,
    "",
    "How their close runs today:",
    fields.message,
    "",
    `Reply to this email to reach ${fields.email}.`,
  ].filter((line) => line !== null).join("\n");
  return { subject, html, text };
}

// To the prospect. Reply-to is the team inbox, so anything they add lands with the request.
export function buildProspectEmail(fields) {
  const first = firstName(fields.name);
  const subject = "Your invite request to Solden";
  const intro = `Thanks, ${first}. Your request has reached us. Next is a short call to pick the period and scope for your replay: one close you have already reported, run again and set beside your own figures.`;
  const expect = [
    ["Read-only first", "Every connection starts read-only, and you see each scope before you grant it."],
    ["Writes only after your activation", "Nothing is written to your ERP until you sign the write activation. After that, every post is reviewed first and read back."],
    ["One monthly price", "Set by entities and transaction volume, quoted after the replay."],
  ];
  const html = document({
    title: subject,
    preheader: "We reply within two business days, then a short call to scope your replay.",
    sections: [
      section(`${label("Invite requested")}${heading("We reply within two business days.")}${para(escapeHtml(intro), { last: true })}`),
      section(`${label("What to expect")}${rows(expect.map(([k, v]) => row(k, v)))}`),
      section(`${label("What you sent")}${rows([row("Company", fields.company), row("How your close runs today", fields.message)])}`),
      section(button("How responsibility transfers", `${SITE}/how-it-works`), { pad: "0 40px 32px" }),
    ],
    footer: "Reply to this email to add anything, and it reaches the same inbox as your request.",
  });
  const text = [
    `Thanks, ${first}.`,
    "",
    "We reply within two business days.",
    intro,
    "",
    "What to expect",
    ...expect.map(([k, v]) => `- ${k}: ${v}`),
    "",
    "What you sent",
    `- Company: ${fields.company}`,
    `- How your close runs today: ${fields.message}`,
    "",
    `How responsibility transfers: ${SITE}/how-it-works`,
    "",
    "Reply to this email to add anything.",
    "Solden Systems Ltd · soldenai.com",
  ].join("\n");
  return { subject, html, text };
}
