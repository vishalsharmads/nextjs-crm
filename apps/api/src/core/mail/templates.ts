import Handlebars from 'handlebars';
import { DEFAULT_LABELS, readableForeground, type LabelEntityKey } from '@app/shared';
import { db } from '../../db/knex';
import { getBranding } from '../settings/settings.service';
import { getLabels } from '../labels/labels.service';
import { sendMail } from '../../lib/mailer';

/** Built-in email templates. Instances override them via the templates table (same key). */
export const DEFAULT_EMAIL_TEMPLATES: Record<string, { name: string; subject: string; body: string }> = {
  'auth.password_reset': {
    name: 'Password reset',
    subject: 'Reset your {{branding.appName}} password',
    body: '<p>Hi {{user.firstName}},</p><p>Someone asked to reset the password for your account. If that was you, choose a new password:</p><p><a class="button" href="{{link}}">Choose a new password</a></p><p>This link works for 60 minutes. If you did not ask for this, you can ignore this email.</p>',
  },
  'auth.invite': {
    name: 'User invitation',
    subject: 'You have been invited to {{branding.appName}}',
    body: '<p>Hi {{user.firstName}},</p><p>{{inviter}} invited you to join {{branding.appName}}.</p><p><a class="button" href="{{link}}">Set your password</a></p><p>This link works for 7 days.</p>',
  },
  'notification.generic': {
    name: 'Notification',
    subject: '{{title}}',
    body: '<p>{{title}}</p>{{#if body}}<p>{{body}}</p>{{/if}}{{#if link}}<p><a class="button" href="{{link}}">Open</a></p>{{/if}}',
  },
  'activity.reminder': {
    name: 'Activity reminder',
    subject: 'Reminder: {{subject}}',
    body: '<p>{{subject}} is due {{due}}.</p><p><a class="button" href="{{link}}">Open {{labels.activity.singular}}</a></p>',
  },
};

const compiled = new Map<string, HandlebarsTemplateDelegate>();
function compile(source: string) {
  let fn = compiled.get(source);
  if (!fn) {
    fn = Handlebars.compile(source, { strict: false });
    compiled.set(source, fn);
  }
  return fn;
}

export async function resolveTemplate(
  key: string,
  channel: 'email' | 'notification' | 'document',
  locale = 'en',
) {
  const row = await db('templates')
    .where({ key, channel })
    .whereIn('locale', [locale, 'en'])
    .orderByRaw('locale = ? desc', [locale])
    .first();
  if (row) return { subject: row.subject as string, body: row.body as string };
  const fallback = DEFAULT_EMAIL_TEMPLATES[key];
  if (!fallback) throw new Error(`Unknown template ${key}`);
  return fallback;
}

async function baseVars() {
  const branding = await getBranding();
  const labels = await getLabels('en');
  const labelVars = Object.fromEntries(
    (Object.keys(DEFAULT_LABELS) as LabelEntityKey[]).map((k) => [k, labels[k] ?? DEFAULT_LABELS[k]]),
  );
  return { branding, labels: labelVars };
}

function layout(html: string, branding: Awaited<ReturnType<typeof getBranding>>) {
  const c = branding.colors.light;
  const esc = Handlebars.escapeExpression;
  return `<!doctype html><html><body style="margin:0;background:${c.canvas};font-family:system-ui,sans-serif;color:${c.ink}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:${c.surface};border:1px solid ${c.line};border-radius:${branding.radius}px">
<tr><td style="padding:24px 28px;font-size:18px;font-weight:600">${esc(branding.appName)}</td></tr>
<tr><td style="padding:0 28px 28px;font-size:15px;line-height:1.55">${html.replace(/class="button"/g, `style="display:inline-block;background:${c.primary};color:${readableForeground(c.primary)};padding:10px 16px;border-radius:${branding.radius}px;text-decoration:none;font-weight:600"`)}</td></tr>
</table>
${branding.footerText ? `<p style="font-size:12px;color:${c.secondary};margin-top:16px">${esc(branding.footerText)}</p>` : ''}
</td></tr></table></body></html>`;
}

function htmlToText(html: string) {
  return html
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g, '$2: $1')
    .replace(/<\/p>/g, '\n\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .trim();
}

/** Render a template with branding and vocabulary in scope, wrap it in the branded layout, and send. */
export async function sendTemplatedEmail(key: string, to: string, vars: Record<string, unknown>) {
  const tpl = await resolveTemplate(key, 'email');
  const base = await baseVars();
  const ctx = { ...base, ...vars };
  const subject = compile(tpl.subject)(ctx);
  const body = compile(tpl.body)(ctx);
  await sendMail({
    to,
    subject,
    html: layout(body, base.branding),
    text: htmlToText(body),
    fromName: base.branding.emailFromName || base.branding.appName,
    fromAddress: base.branding.emailFromAddress || undefined,
  });
}
