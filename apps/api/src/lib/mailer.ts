import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from './logger';

let transporter: Transporter | null = null;

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
  fromName?: string;
  fromAddress?: string;
  replyTo?: string;
  /** Extra headers, for example List-Unsubscribe on marketing email. */
  headers?: Record<string, string>;
}

/** Test hook: when set, mail is captured instead of sent. */
export const mailbox: { capture: OutgoingMail[] | null } = { capture: null };

function getTransport() {
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return transporter;
}

export async function sendMail(mail: OutgoingMail) {
  if (mailbox.capture) {
    mailbox.capture.push(mail);
    return;
  }
  const address = mail.fromAddress || env.MAIL_FROM;
  const from = mail.fromName ? { name: mail.fromName, address } : address;
  try {
    await getTransport().sendMail({
      from,
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      replyTo: mail.replyTo,
      headers: mail.headers,
    });
  } catch (err) {
    logger.error({ err, to: mail.to }, 'Failed to send mail');
    throw err;
  }
}
