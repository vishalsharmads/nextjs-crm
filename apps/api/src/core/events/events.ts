import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { logger } from '../../lib/logger';

/**
 * Domain events. Services emit after their transaction commits; subscribers
 * (webhooks, automations) enqueue jobs, so a slow consumer never blocks a request.
 */
export const EVENT_TYPES = [
  'contact.created',
  'contact.updated',
  'contact.deleted',
  'organization.created',
  'organization.updated',
  'organization.deleted',
  'lead.created',
  'lead.updated',
  'lead.deleted',
  'lead.converted',
  'lead.stage_changed',
  'deal.created',
  'deal.updated',
  'deal.deleted',
  'deal.stage_changed',
  'deal.won',
  'deal.lost',
  'activity.created',
  'activity.updated',
  'activity.completed',
  'form.submitted',
  // Commercial modules (emitted only while the module is enabled).
  'quote.created',
  'quote.sent',
  'quote.accepted',
  'quote.declined',
  'invoice.created',
  'invoice.issued',
  'invoice.paid',
  'invoice.overdue',
  'invoice.voided',
  'payment.recorded',
  'contract.created',
  'contract.activated',
  'contract.renewal_due',
  'contract.renewed',
  'contract.expired',
  'contract.cancelled',
  'booking.created',
  'booking.updated',
  'booking.cancelled',
  'ticket.created',
  'ticket.updated',
  'ticket.replied',
  'ticket.resolved',
  'ticket.deleted',
  'document.shared',
  'document.signed',
  'document_request.submitted',
  'document_request.reviewed',
  'asset.assigned',
  'asset.returned',
  'stock.low',
] as const;
/** Core and module events, plus created/updated/deleted of module record types. */
export type EventType = (typeof EVENT_TYPES)[number] | `${string}.${'created' | 'updated' | 'deleted'}`;

/** Events of module record types, added by `registerRecordType` (whether or not the module is enabled). */
const recordTypeEvents = new Set<string>();

export function registerRecordTypeEvents(entity: string) {
  for (const action of ['created', 'updated', 'deleted']) recordTypeEvents.add(`${entity}.${action}`);
}

/** Set by the module registry: whether a record type's module is enabled (avoids an import cycle). */
let recordTypeEnabled: (entity: string) => boolean = () => true;

export function setRecordTypeEventGate(fn: (entity: string) => boolean) {
  recordTypeEnabled = fn;
}

/** Every event automations and webhooks can subscribe to (record types of enabled modules only). */
export function eventTypes(): string[] {
  return [...EVENT_TYPES, ...[...recordTypeEvents].filter((t) => recordTypeEnabled(t.split('.')[0]!))];
}

export const eventTypeSchema = z.string().refine((t) => eventTypes().includes(t), 'Unknown event');

export interface DomainEvent {
  type: EventType;
  entity: string;
  uuid: string;
  /** The record as the actor's DTO (already field-visibility filtered for that actor). */
  record: Record<string, unknown>;
  /** Field changes on update: key → { from, to } (raw columns / custom.<key>). */
  changes?: Record<string, { from: unknown; to: unknown }>;
  actorId: number | null;
  /** Automation chain depth, to stop runaway loops. */
  depth: number;
  at: string;
}

type Handler = (e: DomainEvent) => Promise<void>;
const handlers: Handler[] = [];

export function onEvent(handler: Handler) {
  handlers.push(handler);
}

export async function emit(e: Omit<DomainEvent, 'at' | 'depth'> & { depth?: number }) {
  const event: DomainEvent = { ...e, depth: e.depth ?? currentDepth(), at: new Date().toISOString() };
  for (const h of handlers) {
    try {
      await h(event);
    } catch (err) {
      logger.error({ err, event: event.type }, 'Event handler failed');
    }
  }
}

/** Depth of the automation currently running (set by the automation runner via AsyncLocalStorage). */
export const eventDepth = new AsyncLocalStorage<number>();
export const currentDepth = () => eventDepth.getStore() ?? 0;
