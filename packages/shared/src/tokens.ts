import { z } from 'zod';

/** Personal access tokens act as the user who created them, for AI clients (MCP) and scripts. */
export const PAT_PREFIX = 'pat_';
export const PAT_MAX_DAYS = 365;

export const personalTokenInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** Read-only tokens can only view; full tokens can do whatever the user can. */
  access: z.enum(['read', 'full']).default('read'),
  expiresInDays: z.number().int().min(1).max(PAT_MAX_DAYS).default(90),
});

export interface PersonalTokenDto {
  uuid: string;
  name: string;
  prefix: string;
  access: 'read' | 'full';
  lastUsedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

/** A tool the tool layer offers (MCP and the assistant share them). */
export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  /** Changes data; clients should confirm with the person first. */
  write: boolean;
}
