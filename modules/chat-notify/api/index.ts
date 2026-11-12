import {
  AppError,
  appUrl,
  assertSafeUrl,
  enqueue,
  eventTouchesRestricted,
  getModuleSettings,
  isModuleEnabled,
  onEvent,
  registerJob,
  type ApiModule,
  type DomainEvent,
} from '@app/api/module-api';

/**
 * Reference integration: posts a short message to a chat channel's incoming webhook.
 *
 * - Settings come from the manifest (`getModuleSettings`); the webhook address is a secret.
 * - Events are handled with `onEvent` and sent from a background job, never inline, so a slow
 *   chat service never slows down saving a record, and failed posts are retried.
 * - Nothing is sent about a restricted person, and messages never carry names of people.
 */

const KEY = 'chat-notify';
const JOB = 'chat-notify.send';

/** Which events each "What to post" choice sends. */
const PRESETS: Record<string, string[]> = {
  won: ['deal.won'],
  deals: ['deal.created', 'deal.won'],
  all: ['lead.created', 'deal.created', 'deal.won', 'ticket.created'],
};

const PATHS: Record<string, string> = { deal: '/deals', lead: '/leads', ticket: '/m/tickets' };

/** The message for an event. Titles only when the admin allows them; never a person's name. */
export function messageFor(
  e: Pick<DomainEvent, 'type' | 'entity' | 'uuid' | 'record'>,
  includeTitles: boolean,
) {
  const title = includeTitles && typeof e.record.title === 'string' ? `: ${e.record.title}` : '';
  const what: Record<string, string> = {
    'deal.won': `A deal was won${title}`,
    'deal.created': `New deal${title}`,
    'lead.created': 'A new lead came in',
    'ticket.created': `New ticket${title}`,
  };
  const path = PATHS[e.entity];
  const link = path ? ` ${appUrl(`${path}/${e.uuid}`)}` : '';
  return `${what[e.type] ?? e.type}${link}`;
}

async function post(url: string, text: string) {
  await assertSafeUrl(url, 'webhook_url');
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AppError('UPSTREAM_FAILED', 'The chat service could not be reached.');
  }
  if (res.status === 401 || res.status === 403 || res.status === 404)
    throw new AppError(
      'UPSTREAM_FAILED',
      'The chat service refused the webhook address. Check it and try again.',
    );
  if (!res.ok) throw new AppError('UPSTREAM_FAILED', `The chat service answered ${res.status}.`);
}

onEvent(async (e) => {
  if (!isModuleEnabled(KEY)) return;
  const settings = await getModuleSettings(KEY);
  if (!settings.webhook_url) return;
  if (!(PRESETS[String(settings.events)] ?? PRESETS.won!).includes(e.type)) return;
  if (await eventTouchesRestricted(e)) return;
  await enqueue(JOB, { text: messageFor(e, settings.include_titles === true) });
});

registerJob(JOB, async (job) => {
  // Read the address when sending, so a changed or removed address takes effect for queued messages.
  const { webhook_url } = await getModuleSettings(KEY);
  if (!webhook_url || !isModuleEnabled(KEY)) return;
  await post(String(webhook_url), String(job.payload.text));
});

export const chatNotify: ApiModule = {
  testConnection: async (settings) => {
    if (!settings.webhook_url)
      throw new AppError('UPSTREAM_FAILED', 'Add the incoming webhook address first.');
    await post(
      String(settings.webhook_url),
      'Test message: notifications from this workspace will appear here.',
    );
    return { message: 'Sent a test message. Check the channel.' };
  },
};
