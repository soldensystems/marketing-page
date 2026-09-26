/**
 * Transactional email templates for soldenai.com.
 *
 * Email clients do not reliably support CSS custom properties, so the values
 * below are the resolved DESIGN.md tokens. Keeping them in one map makes the
 * intentional brand-token mapping explicit while the markup remains portable
 * across Outlook, Gmail, and Apple Mail.
 */
const EMAIL_COLORS = Object.freeze({
  navy: '#001137',
  teal: '#18BFB0',
  canvas: '#FBF9F6',
  canvasDeep: '#F4F0EA',
  surface: '#FFFFFF',
  inkSecondary: '#44403C',
  inkMuted: '#78716C',
  border: '#E9E2D6',
});

const FONT_STACK = "Inter, Arial, 'Helvetica Neue', Helvetica, sans-serif";
const SITE_URL = 'https://soldenai.com';
const MARK_URL = `${SITE_URL}/assets/solden-mark.png`;

export function escapeEmailHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]
  );
}

function cleanPlainText(value, maximum = 5000) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, maximum)
    .trim();
}

function cleanSubjectValue(value, maximum = 160) {
  return cleanPlainText(value, maximum)
    .replace(/[\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function multilineHtml(value) {
  return escapeEmailHtml(cleanPlainText(value)).replace(/\n/g, '<br>');
}

function firstNameFrom(value) {
  return cleanPlainText(value, 200).split(/\s+/)[0] || 'there';
}

function emailDocument({ preheader, content }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light">
  <title>Solden</title>
  <style>
    @media only screen and (max-width: 620px) {
      .solden-shell { width: 100% !important; }
      .solden-pad { padding-left: 24px !important; padding-right: 24px !important; }
      .solden-title { font-size: 26px !important; line-height: 32px !important; }
      .solden-button { display: block !important; text-align: center !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${EMAIL_COLORS.canvas};color:${EMAIL_COLORS.navy};font-family:${FONT_STACK};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${escapeEmailHtml(preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;background:${EMAIL_COLORS.canvas};">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" class="solden-shell" style="width:600px;max-width:600px;border-collapse:separate;background:${EMAIL_COLORS.surface};border:1px solid ${EMAIL_COLORS.border};border-radius:12px;overflow:hidden;">
          ${content}
        </table>
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" class="solden-shell" style="width:600px;max-width:600px;border-collapse:collapse;">
          <tr>
            <td class="solden-pad" style="padding:20px 40px 0;text-align:center;font-family:${FONT_STACK};font-size:12px;line-height:18px;color:${EMAIL_COLORS.inkMuted};">
              Solden Systems Ltd &nbsp;&middot;&nbsp; <a href="${SITE_URL}" style="color:${EMAIL_COLORS.inkSecondary};text-decoration:underline;">soldenai.com</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function brandHeader() {
  return `<tr>
  <td class="solden-pad" style="padding:28px 40px 24px;border-bottom:1px solid ${EMAIL_COLORS.border};">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">
      <tr>
        <td style="vertical-align:middle;padding-right:10px;">
          <a href="${SITE_URL}" style="text-decoration:none;"><img src="${MARK_URL}" width="26" height="26" alt="" style="display:block;width:26px;height:26px;border:0;"></a>
        </td>
        <td style="vertical-align:middle;font-family:${FONT_STACK};font-size:20px;line-height:24px;font-weight:700;color:${EMAIL_COLORS.navy};">
          <a href="${SITE_URL}" style="color:${EMAIL_COLORS.navy};text-decoration:none;">solden</a>
        </td>
      </tr>
    </table>
  </td>
</tr>`;
}

function detailRow(label, value) {
  const cleanValue = cleanPlainText(value);
  if (!cleanValue) return '';
  return `<tr>
  <td width="128" style="width:128px;padding:10px 16px 10px 0;border-bottom:1px solid ${EMAIL_COLORS.border};vertical-align:top;font-family:${FONT_STACK};font-size:12px;line-height:18px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${EMAIL_COLORS.inkMuted};">${escapeEmailHtml(label)}</td>
  <td style="padding:10px 0;border-bottom:1px solid ${EMAIL_COLORS.border};vertical-align:top;font-family:${FONT_STACK};font-size:14px;line-height:21px;color:${EMAIL_COLORS.navy};word-break:break-word;">${escapeEmailHtml(cleanValue)}</td>
</tr>`;
}

export function buildProspectConfirmationEmail(lead, { replyTo } = {}) {
  const firstName = firstNameFrom(lead?.name);
  const isDemo = cleanPlainText(lead?.topic, 60).toLowerCase() === 'demo';
  const heading = isDemo ? 'Your request is with us.' : 'We received your note.';
  const preheader = isDemo
    ? 'We have your Solden working-session request and will be in touch within one business day.'
    : 'We received your note to Solden and will be in touch within one business day.';
  const introduction = isDemo
    ? `Thanks, ${firstName}. We have your request for a focused working session. Our team will review the context you shared and contact you within one business day.`
    : `Thanks, ${firstName}. We have your note and our team will reply within one business day.`;
  const subject = isDemo
    ? 'Your Solden demo request'
    : 'We got your note to Solden';
  const safeReplyTo = cleanSubjectValue(replyTo || '', 254);

  const html = emailDocument({
    preheader,
    content: `${brandHeader()}
<tr>
  <td class="solden-pad" style="padding:40px 40px 16px;">
    <p style="margin:0 0 14px;font-family:${FONT_STACK};font-size:11px;line-height:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${EMAIL_COLORS.inkMuted};">${isDemo ? 'Demo request received' : 'Message received'}</p>
    <h1 class="solden-title" style="margin:0 0 16px;font-family:${FONT_STACK};font-size:30px;line-height:38px;font-weight:650;letter-spacing:-.02em;color:${EMAIL_COLORS.navy};">${escapeEmailHtml(heading)}</h1>
    <p style="margin:0;font-family:${FONT_STACK};font-size:16px;line-height:26px;color:${EMAIL_COLORS.inkSecondary};">${escapeEmailHtml(introduction)}</p>
  </td>
</tr>
<tr>
  <td class="solden-pad" style="padding:16px 40px 8px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:separate;background:${EMAIL_COLORS.canvasDeep};border:1px solid ${EMAIL_COLORS.border};border-radius:8px;">
      <tr>
        <td width="4" style="width:4px;background:${EMAIL_COLORS.teal};font-size:0;line-height:0;">&nbsp;</td>
        <td style="padding:18px 20px;">
          <p style="margin:0 0 6px;font-family:${FONT_STACK};font-size:14px;line-height:20px;font-weight:700;color:${EMAIL_COLORS.navy};">Solden is the AI finance team that does the work.</p>
          <p style="margin:0;font-family:${FONT_STACK};font-size:14px;line-height:22px;color:${EMAIL_COLORS.inkSecondary};">It runs recurring accounting and finance operations across your existing systems, escalating only the decisions that require human judgement.</p>
        </td>
      </tr>
    </table>
  </td>
</tr>
${isDemo ? `<tr>
  <td class="solden-pad" style="padding:28px 40px 8px;">
    <p style="margin:0 0 8px;font-family:${FONT_STACK};font-size:13px;line-height:20px;font-weight:700;color:${EMAIL_COLORS.navy};">What we will map together</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;">
      ${detailRow('Responsibility', 'One recurring finance outcome your team still carries manually.')}
      ${detailRow('Boundaries', 'Systems, evidence, controls, and the decisions that must remain human.')}
      ${detailRow('Completion', 'The authoritative result that would prove the work is actually finished.')}
    </table>
  </td>
</tr>` : ''}
<tr>
  <td class="solden-pad" style="padding:28px 40px 40px;">
    <p style="margin:0 0 20px;font-family:${FONT_STACK};font-size:14px;line-height:22px;color:${EMAIL_COLORS.inkSecondary};">Have more context to add? Reply directly to this email${safeReplyTo ? ` and it will reach us at ${escapeEmailHtml(safeReplyTo)}` : ''}.</p>
    <a href="${SITE_URL}/#how-it-works" class="solden-button" style="display:inline-block;padding:12px 18px;border-radius:8px;background:${EMAIL_COLORS.teal};color:${EMAIL_COLORS.navy};font-family:${FONT_STACK};font-size:14px;line-height:20px;font-weight:700;text-decoration:none;">See how Solden works</a>
  </td>
</tr>`,
  });

  const text = [
    `Hi ${firstName},`,
    '',
    introduction,
    '',
    'Solden is the AI finance team that does the work.',
    'It runs recurring accounting and finance operations across your existing systems, escalating only the decisions that require human judgement.',
    ...(isDemo ? [
      '',
      'What we will map together',
      '- Responsibility: One recurring finance outcome your team still carries manually.',
      '- Boundaries: Systems, evidence, controls, and the decisions that must remain human.',
      '- Completion: The authoritative result that would prove the work is actually finished.',
    ] : []),
    '',
    'Have more context to add? Reply directly to this email.',
    `${SITE_URL}/#how-it-works`,
    '',
    'Solden Systems Ltd',
  ].join('\n');

  return { subject, html, text };
}

export function buildInternalLeadEmail(lead) {
  const name = cleanPlainText(lead?.name, 200) || 'Unknown contact';
  const company = cleanPlainText(lead?.company, 200);
  const email = cleanPlainText(lead?.email, 254);
  const topic = cleanPlainText(lead?.topic, 60);
  const isDemo = topic.toLowerCase() === 'demo';
  const leadId = cleanPlainText(lead?.id, 200) || 'unassigned';
  const submissionId = cleanPlainText(lead?.submission_id, 200);
  const message = cleanPlainText(lead?.message, 5000);
  const actionSubject = isDemo
    ? 'Re: your Solden demo request'
    : 'Re: your note to Solden';
  const replyHref = email
    ? `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(actionSubject)}`
    : SITE_URL;
  const preheader = `${isDemo ? 'New demo request' : 'New Solden lead'} from ${name}${company ? ` at ${company}` : ''}.`;
  const rows = [
    detailRow('Name', name),
    detailRow('Email', email),
    detailRow('Company', company),
    detailRow('Role', lead?.role),
    detailRow('ERP', lead?.erp),
    detailRow('Topic', topic),
  ].join('');
  const safeSubjectName = cleanSubjectValue(name) || 'Unknown contact';
  const safeSubjectCompany = cleanSubjectValue(company);
  const subject = `New lead: ${safeSubjectName}${safeSubjectCompany ? ` (${safeSubjectCompany})` : ''}`;

  const html = emailDocument({
    preheader,
    content: `${brandHeader()}
<tr>
  <td class="solden-pad" style="padding:36px 40px 16px;">
    <p style="margin:0 0 10px;font-family:${FONT_STACK};font-size:11px;line-height:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${EMAIL_COLORS.teal};">${isDemo ? 'New demo request' : 'New website lead'}</p>
    <h1 class="solden-title" style="margin:0;font-family:${FONT_STACK};font-size:28px;line-height:35px;font-weight:650;letter-spacing:-.02em;color:${EMAIL_COLORS.navy};">${escapeEmailHtml(name)}</h1>
    ${company ? `<p style="margin:6px 0 0;font-family:${FONT_STACK};font-size:15px;line-height:23px;color:${EMAIL_COLORS.inkSecondary};">${escapeEmailHtml(company)}</p>` : ''}
  </td>
</tr>
<tr>
  <td class="solden-pad" style="padding:14px 40px 8px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;">${rows}</table>
  </td>
</tr>
${message ? `<tr>
  <td class="solden-pad" style="padding:24px 40px 4px;">
    <p style="margin:0 0 8px;font-family:${FONT_STACK};font-size:12px;line-height:18px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${EMAIL_COLORS.inkMuted};">Their note</p>
    <div style="padding:16px 18px;background:${EMAIL_COLORS.canvasDeep};border-left:3px solid ${EMAIL_COLORS.teal};font-family:${FONT_STACK};font-size:14px;line-height:22px;color:${EMAIL_COLORS.inkSecondary};word-break:break-word;">${multilineHtml(message)}</div>
  </td>
</tr>` : ''}
<tr>
  <td class="solden-pad" style="padding:28px 40px 24px;">
    <a href="${escapeEmailHtml(replyHref)}" class="solden-button" style="display:inline-block;padding:12px 18px;border-radius:8px;background:${EMAIL_COLORS.teal};color:${EMAIL_COLORS.navy};font-family:${FONT_STACK};font-size:14px;line-height:20px;font-weight:700;text-decoration:none;">Reply to ${escapeEmailHtml(firstNameFrom(name))}</a>
  </td>
</tr>
<tr>
  <td class="solden-pad" style="padding:18px 40px 28px;border-top:1px solid ${EMAIL_COLORS.border};font-family:${FONT_STACK};font-size:12px;line-height:19px;color:${EMAIL_COLORS.inkMuted};">
    Lead ${escapeEmailHtml(leadId)}${submissionId ? ` &nbsp;&middot;&nbsp; Submission ${escapeEmailHtml(submissionId)}` : ''}<br>
    Source: soldenai.com. Replying to this email reaches ${escapeEmailHtml(email)}.
  </td>
</tr>`,
  });

  const role = cleanPlainText(lead?.role, 200);
  const erp = cleanPlainText(lead?.erp, 60);
  const text = [
    isDemo ? 'New Solden demo request' : 'New Solden website lead',
    '',
    `Name: ${name}`,
    email ? `Email: ${email}` : null,
    company ? `Company: ${company}` : null,
    role ? `Role: ${role}` : null,
    erp ? `ERP: ${erp}` : null,
    topic ? `Topic: ${topic}` : null,
    ...(message ? ['', 'Their note:', message] : []),
    '',
    email ? `Reply: ${email}` : null,
    `Lead: ${leadId}`,
    submissionId ? `Submission: ${submissionId}` : null,
    'Source: soldenai.com',
  ]
    .filter((line) => line !== null)
    .join('\n');

  return { subject, html, text };
}
