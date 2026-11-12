import { z } from 'zod';
import {
  addPreset,
  applySetupDraft,
  setupDraftSchema,
  setupOverview,
  type ToolDef,
} from '@app/api/module-api';

/**
 * Tools that change how the workspace is set up (names, fields, pipelines, modules, roles). Offered
 * only to admins, and only after an admin turns setup on in the assistant settings. Changes run
 * through the blueprint engine in `add` mode: missing items are created as the admin's own work,
 * nothing that exists is overwritten except names and settings, and every change is audited.
 */
const report = (r: Awaited<ReturnType<typeof applySetupDraft>>) => ({
  summary: r.summary,
  willAdd: r.created,
  willUpdate: r.updated,
  alreadyThere: r.conflicts.map((c) => c.item),
  warnings: r.warnings,
});

const draft = setupDraftSchema.describe(
  'Partial workspace setup. vocabulary: {"contact":{"singular":"Patient","plural":"Patients"}} for contact, organization, lead, deal, activity. ' +
    'custom_fields: {"contact":[{"key":"insurance_id","label":"Insurance ID","type":"text"}]} (key lowercase_with_underscores; types: text, textarea, number, decimal, currency, date, datetime, boolean, select, multi_select, url, email, phone; select options: [{"key":"a","label":"A"}]). ' +
    'pipelines: [{"key":"admissions","name":"Admissions","entity":"deal","stages":[{"key":"enquiry","name":"Enquiry","probability":10},{"key":"won","name":"Enrolled","is_won":true},{"key":"lost","name":"Lost","is_lost":true}]}]. ' +
    'modules: module keys from setup_overview. settings: {"general":{"currency":"EUR"},"contacts":{"sources":["Web","Referral"]}}. roles: [{"key":"reception","name":"Reception","permissions":["core.contacts.*"]}].',
);

const presetKey = z.object({ key: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/) });

export const SETUP_TOOLS: ToolDef[] = [
  {
    name: 'setup_overview',
    title: 'Look at the workspace setup',
    description:
      'For setting up the CRM for this business: the names records use now, every module (enabled or not) and the industry presets that can be added. Call describe_schema too for current fields and pipelines.',
    write: false,
    input: z.object({}),
    handler: (_input, { user }) => setupOverview(user),
  },
  {
    name: 'preview_setup',
    title: 'Preview setup changes',
    description:
      'Dry run of a workspace setup: lists what would be added or updated and what already exists. Changes nothing. Always preview before apply_setup, and fix any error it reports.',
    write: false,
    input: z.object({ setup: draft }),
    handler: async ({ setup }, { user, ctx }) =>
      report(await applySetupDraft(setup, { user, ctx, dryRun: true })),
  },
  {
    name: 'apply_setup',
    title: 'Set up the workspace',
    description:
      'Applies a workspace setup (same input as preview_setup) after the admin confirms. Only adds what is missing; existing fields, pipelines and roles are left as they are, names and settings are updated.',
    write: true,
    input: z.object({ setup: draft }),
    handler: async ({ setup }, { user, ctx }) => report(await applySetupDraft(setup, { user, ctx })),
  },
  {
    name: 'preview_preset',
    title: 'Preview an industry preset',
    description: 'Dry run of add_preset: what adding this preset would change. Changes nothing.',
    write: false,
    input: presetKey,
    handler: async ({ key }, { user, ctx }) => report(await addPreset(key, { user, ctx, dryRun: true })),
  },
  {
    name: 'add_preset',
    title: 'Add an industry preset',
    description:
      'Adds one industry preset from setup_overview (its names, fields, pipelines, roles and modules) after the admin confirms. Preview it with preview_preset first.',
    write: true,
    input: presetKey,
    handler: async ({ key }, { user, ctx }) => report(await addPreset(key, { user, ctx })),
  },
] as ToolDef[];

export const SETUP_PROMPT = [
  'You can also set up this CRM for the business. When the admin describes their business or asks for changes to names, fields, pipelines, modules or roles:',
  '1. Call setup_overview and describe_schema to see what exists. If a preset fits the industry, suggest add_preset first.',
  '2. Ask at most two short questions if something essential is unclear; otherwise propose a sensible setup for that industry.',
  '3. Call preview_setup with the draft, fix any errors, then call apply_setup with the same draft. The admin confirms before anything changes.',
  'Keep setups focused: the fields and stages the business really uses, not every possible one.',
].join('\n');
