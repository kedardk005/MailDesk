/**
 * Transactional email templates.
 *
 * Every message the product sends is built here, so branding, spacing and tone
 * cannot drift between controllers. Previously each call site carried its own
 * copy of a <div>-based layout, which meant three slightly different emails and
 * one (task completion) with no HTML at all.
 *
 * Why the markup looks dated on purpose:
 *
 *   - TABLES, not flexbox or divs. Outlook on Windows renders with Word's HTML
 *     engine: no flex, no grid, unreliable max-width on block elements. Tables
 *     are the only layout primitive that behaves everywhere.
 *   - INLINE styles. Gmail strips <style> blocks in many contexts, so anything
 *     that must survive is set on the element.
 *   - A PREHEADER span. Without it, inbox previews show whatever text comes
 *     first — usually "View in browser" or the brand name repeated.
 *   - No web fonts. They fail in most clients and fall back unpredictably; the
 *     system stack renders consistently instead.
 *
 * Colours match the application's own tokens so mail and UI agree:
 * primary #2563EB, ink #0F172A, muted #475569, hairline #E2E8F0.
 */

const BRAND = 'K M KOTHARI';

const C = {
  primary: '#2563EB',
  primaryDark: '#1D4ED8',
  ink: '#0F172A',
  body: '#334155',
  muted: '#475569',
  faint: '#64748B',
  line: '#E2E8F0',
  canvas: '#F1F5F9',
  surface: '#FFFFFF',
  successBg: '#F0FDF4',
  successText: '#166534',
  warningBg: '#FFFBEB',
  warningText: '#92400E',
  dangerBg: '#FEF2F2',
  dangerText: '#991B1B'
};

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

/** Escape untrusted values before they enter the markup. */
const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const appUrl = () => (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');

/**
 * Bulletproof CTA button. The MSO conditional draws a VML rectangle because
 * Outlook ignores padding on anchors, which otherwise collapses the button to
 * bare underlined text.
 */
const button = (label, href) => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;">
  <tr><td align="center" bgcolor="${C.primary}" style="border-radius:6px;">
    <!--[if mso]>
    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
      href="${esc(href)}" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="14%"
      strokecolor="${C.primary}" fillcolor="${C.primary}">
      <w:anchorlock/><center style="color:#ffffff;font-family:${FONT};font-size:15px;font-weight:600;">${esc(label)}</center>
    </v:roundrect>
    <![endif]-->
    <!--[if !mso]><!-- -->
    <a href="${esc(href)}"
       style="display:inline-block;padding:13px 28px;font-family:${FONT};font-size:15px;font-weight:600;
              color:#ffffff;text-decoration:none;border-radius:6px;background:${C.primary};">${esc(label)}</a>
    <!--<![endif]-->
  </td></tr>
</table>`;

/** A label/value detail table — used for task and account facts. */
const details = (rows) => {
  if (!rows || rows.length === 0) return '';
  const cells = rows
    .map(
      ([k, v], i) => `
      <tr>
        <td style="padding:10px 0;${i ? `border-top:1px solid ${C.line};` : ''}font-family:${FONT};
                   font-size:13px;color:${C.faint};width:38%;vertical-align:top;">${esc(k)}</td>
        <td style="padding:10px 0;${i ? `border-top:1px solid ${C.line};` : ''}font-family:${FONT};
                   font-size:14px;color:${C.ink};font-weight:500;">${v}</td>
      </tr>`
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
            style="margin:20px 0;border:1px solid ${C.line};border-radius:8px;padding:4px 16px;">${cells}</table>`;
};

/** A coloured status chip. Text always carries the meaning, never colour alone. */
const chip = (text, tone = 'info') => {
  const map = {
    success: [C.successBg, C.successText],
    warning: [C.warningBg, C.warningText],
    danger: [C.dangerBg, C.dangerText],
    info: ['#EFF6FF', '#1E40AF']
  };
  const [bg, fg] = map[tone] || map.info;
  return `<span style="display:inline-block;padding:4px 10px;border-radius:4px;background:${bg};
            color:${fg};font-family:${FONT};font-size:12px;font-weight:600;">${esc(text)}</span>`;
};

/**
 * Wrap content in the shared shell.
 *
 * @param {Object} o
 * @param {String} o.preheader - inbox preview line; never rendered in the body
 * @param {String} o.title
 * @param {String} o.content - inner HTML
 * @returns {String}
 */
const layout = ({ preheader, title, content }) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.canvas};">
<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;
             mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;overflow:hidden;">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.canvas};">
  <tr><td align="center" style="padding:32px 16px;">

    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
           style="width:600px;max-width:600px;background:${C.surface};border:1px solid ${C.line};border-radius:10px;">

      <tr><td style="padding:24px 32px;border-bottom:1px solid ${C.line};">
        <span style="font-family:${FONT};font-size:16px;font-weight:700;color:${C.ink};letter-spacing:-0.01em;">${BRAND}</span>
      </td></tr>

      <tr><td style="padding:32px;">${content}</td></tr>

      <tr><td style="padding:20px 32px;border-top:1px solid ${C.line};background:${C.canvas};border-radius:0 0 9px 9px;">
        <p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.5;color:${C.faint};">
          Automated message from ${BRAND}. Please do not reply to this address.
        </p>
      </td></tr>
    </table>

    <p style="margin:16px 0 0;font-family:${FONT};font-size:11px;color:#94A3B8;">
      ${BRAND} &middot; Email and task workspace
    </p>

  </td></tr>
</table>
</body></html>`;

const h1 = (t) =>
  `<h1 style="margin:0 0 14px;font-family:${FONT};font-size:20px;line-height:1.35;font-weight:600;color:${C.ink};">${esc(t)}</h1>`;
const p = (t) =>
  `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.65;color:${C.body};">${t}</p>`;
const small = (t) =>
  `<p style="margin:14px 0 0;font-family:${FONT};font-size:13px;line-height:1.6;color:${C.faint};">${t}</p>`;

/* ------------------------------------------------------------------------ *
 * Templates. Each returns { subject, text, html }.
 * The plain-text part is written by hand rather than stripped from the HTML —
 * a tag-stripped body reads like debris, and plenty of people still read mail
 * as text.
 * ------------------------------------------------------------------------ */

const accountApproved = ({ name, email, role }) => {
  const url = `${appUrl()}/login`;
  return {
    subject: `Your ${BRAND} account is ready`,
    text:
      `Hello ${name},\n\n` +
      `Your request to join ${BRAND} has been approved. You can sign in now as ${role}.\n\n` +
      `Sign in: ${url}\nAccount: ${email}\n\n` +
      `— ${BRAND}\n`,
    html: layout({
      preheader: `Your account has been approved — you can sign in now.`,
      title: 'Account approved',
      content:
        h1('Your account is ready') +
        p(`Hello <strong style="color:${C.ink};">${esc(name)}</strong>,`) +
        p(`An administrator has approved your request to join ${BRAND}. You can sign in straight away.`) +
        details([
          ['Account', esc(email)],
          ['Role', chip(role, 'info')]
        ]) +
        button('Sign in', url) +
        small(`If the button does not work, paste this into your browser:<br><span style="color:${C.muted};word-break:break-all;">${esc(url)}</span>`)
    })
  };
};

const passwordReset = ({ name, resetLink, expiresMinutes = 30 }) => ({
  subject: `Reset your ${BRAND} password`,
  text:
    `Hello ${name},\n\n` +
    `You asked to reset your ${BRAND} password. Open the link below to choose a new one. ` +
    `It works once and expires in ${expiresMinutes} minutes.\n\n${resetLink}\n\n` +
    `If you did not request this, ignore this email — your password has not changed.\n\n— ${BRAND}\n`,
  html: layout({
    preheader: `Reset your password. This link expires in ${expiresMinutes} minutes.`,
    title: 'Password reset',
    content:
      h1('Reset your password') +
      p(`Hello <strong style="color:${C.ink};">${esc(name)}</strong>,`) +
      p(`You asked to reset your ${BRAND} password. Choose a new one using the button below.`) +
      button('Choose a new password', resetLink) +
      p(
        `<span style="color:${C.warningText};font-weight:600;">This link works once and expires in ${expiresMinutes} minutes.</span>`
      ) +
      small(
        `If you did not request this, you can ignore this email — your password has not been changed.<br><br>` +
          `Button not working? Paste this into your browser:<br><span style="color:${C.muted};word-break:break-all;">${esc(resetLink)}</span>`
      )
  })
});

const taskCompleted = ({ recipientName, taskTitle, completedBy, completedAt, clientName, taskUrl }) => ({
  subject: `Completed: ${taskTitle}`,
  text:
    `Hello ${recipientName},\n\n` +
    `${completedBy} marked "${taskTitle}" as completed.\n\n` +
    (clientName ? `Client: ${clientName}\n` : '') +
    `Completed: ${completedAt}\n\n` +
    (taskUrl ? `View the task: ${taskUrl}\n\n` : '') +
    `— ${BRAND}\n`,
  html: layout({
    preheader: `${completedBy} completed "${taskTitle}".`,
    title: 'Task completed',
    content:
      h1('Task completed') +
      p(`Hello <strong style="color:${C.ink};">${esc(recipientName)}</strong>,`) +
      p(`A task you created has been marked complete.`) +
      details(
        [
          ['Task', esc(taskTitle)],
          clientName ? ['Client', esc(clientName)] : null,
          ['Completed by', esc(completedBy)],
          ['Completed', esc(completedAt)],
          ['Status', chip('Completed', 'success')]
        ].filter(Boolean)
      ) +
      (taskUrl ? button('View the task', taskUrl) : '')
  })
});

const taskAssigned = ({ recipientName, taskTitle, assignedBy, deadline, priority, clientName, taskUrl }) => ({
  subject: `Assigned to you: ${taskTitle}`,
  text:
    `Hello ${recipientName},\n\n` +
    `${assignedBy} assigned you "${taskTitle}".\n\n` +
    (clientName ? `Client: ${clientName}\n` : '') +
    `Priority: ${priority}\nDue: ${deadline}\n\n` +
    (taskUrl ? `Open the task: ${taskUrl}\n\n` : '') +
    `— ${BRAND}\n`,
  html: layout({
    preheader: `${assignedBy} assigned you "${taskTitle}" — due ${deadline}.`,
    title: 'New task assigned',
    content:
      h1('A task was assigned to you') +
      p(`Hello <strong style="color:${C.ink};">${esc(recipientName)}</strong>,`) +
      p(`<strong style="color:${C.ink};">${esc(assignedBy)}</strong> has assigned you a new task.`) +
      details(
        [
          ['Task', esc(taskTitle)],
          clientName ? ['Client', esc(clientName)] : null,
          ['Priority', chip(priority, priority === 'Urgent' || priority === 'High' ? 'warning' : 'info')],
          ['Due', esc(deadline)]
        ].filter(Boolean)
      ) +
      (taskUrl ? button('Open the task', taskUrl) : '')
  })
});

const taskOverdue = ({ recipientName, taskTitle, deadline, overdueBy, clientName, taskUrl }) => ({
  subject: `Overdue: ${taskTitle}`,
  text:
    `Hello ${recipientName},\n\n` +
    `"${taskTitle}" passed its deadline ${overdueBy} ago.\n\n` +
    (clientName ? `Client: ${clientName}\n` : '') +
    `Was due: ${deadline}\n\n` +
    (taskUrl ? `Open the task: ${taskUrl}\n\n` : '') +
    `— ${BRAND}\n`,
  html: layout({
    preheader: `"${taskTitle}" is ${overdueBy} past its deadline.`,
    title: 'Task overdue',
    content:
      h1('A task is overdue') +
      p(`Hello <strong style="color:${C.ink};">${esc(recipientName)}</strong>,`) +
      p(`This task has passed its deadline and still needs attention.`) +
      details(
        [
          ['Task', esc(taskTitle)],
          clientName ? ['Client', esc(clientName)] : null,
          ['Was due', esc(deadline)],
          ['Overdue by', `<span style="color:${C.dangerText};font-weight:600;">${esc(overdueBy)}</span>`],
          ['Status', chip('Late', 'danger')]
        ].filter(Boolean)
      ) +
      (taskUrl ? button('Open the task', taskUrl) : '')
  })
});

module.exports = {
  accountApproved,
  passwordReset,
  taskCompleted,
  taskAssigned,
  taskOverdue,
  // exported for tests and previews
  layout,
  esc,
  BRAND,
  COLORS: C
};
