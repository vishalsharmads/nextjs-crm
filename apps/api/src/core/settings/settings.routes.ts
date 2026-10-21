import { z } from 'zod';
import multer from 'multer';
import {
  BRANDING_ASSET_SLOTS,
  SETTINGS_GROUPS,
  brandingSchema,
  checkPaletteContrast,
  type PublicBranding,
  type SettingsGroup,
} from '@app/shared';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { env } from '../../config/env';
import { AppError, notFound } from '../../lib/errors';
import { storage } from '../../lib/storage';
import { audit } from '../audit/audit.service';
import { storeFile } from '../files/files.service';
import { getLabels, clearLabelCache } from '../labels/labels.service';
import {
  clearSettingsCache,
  getBranding,
  getBrandingAssets,
  getDemoAccounts,
  getGroup,
  getRaw,
  isInstalled,
  setRaw,
} from './settings.service';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
const assetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.UPLOAD_MAX_MB * 1024 * 1024, files: 1 },
});
export { assetUpload };

const groupParam = z.object({
  group: z.enum(Object.keys(SETTINGS_GROUPS) as [SettingsGroup, ...SettingsGroup[]]),
});
const slotParam = z.object({ slot: z.enum(BRANDING_ASSET_SLOTS) });

async function publicBranding(): Promise<PublicBranding> {
  const branding = await getBranding();
  const assets = await getBrandingAssets();
  const general = await getGroup('general').catch(() => ({ locale: 'en' }));
  const { emailFromAddress: _a, emailFromName: _n, ...rest } = branding;
  return {
    ...rest,
    locale: general.locale,
    installed: await isInstalled(),
    demoAccounts: await getDemoAccounts(),
    assets: Object.fromEntries(
      Object.entries(assets).map(([slot, uuid]) => [
        slot,
        `/api/v1/public/branding/assets/${slot}?v=${uuid.slice(-8)}`,
      ]),
    ),
  };
}

export const publicRoutes = defineRoutes('/public', ['public'])
  .add({
    method: 'get',
    path: '/branding',
    permission: 'public',
    summary: 'Branding for the login page and app shell',
    handler: async ({ res }) => {
      res.set('Cache-Control', 'no-cache');
      return publicBranding();
    },
  })
  .add({
    method: 'get',
    path: '/branding/assets/:slot',
    permission: 'public',
    params: slotParam,
    handler: async ({ res, params }) => {
      const assets = await getBrandingAssets();
      const uuid = assets[params.slot];
      if (!uuid) throw notFound('Asset');
      const file = await db('files').where({ uuid, is_public: true }).whereNull('deleted_at').first();
      if (!file) throw notFound('Asset');
      res.set('Content-Type', file.mime);
      res.set('Cache-Control', 'public, max-age=86400');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
      res.send(await storage.get(file.storage_key));
    },
  })
  .add({
    method: 'get',
    path: '/manifest.webmanifest',
    permission: 'public',
    handler: async ({ res }) => {
      const b = await publicBranding();
      res.type('application/manifest+json');
      res.send(
        JSON.stringify({
          name: b.appName,
          short_name: b.appName.slice(0, 12),
          start_url: '/',
          display: 'standalone',
          background_color: b.colors.light.canvas,
          theme_color: b.colors.light.primary,
          icons: b.assets.favicon ? [{ src: b.assets.favicon, sizes: 'any' }] : [],
        }),
      );
    },
  });

export const settingsRoutes = defineRoutes('/settings', ['settings'])
  .add({
    method: 'delete',
    path: '/demo-login',
    permission: 'core.settings.manage',
    summary: 'Stop showing demo sign-in details on the sign-in screen',
    handler: async ({ ctx }) => {
      await db('settings').where({ key: 'demo_login' }).delete();
      clearSettingsCache();
      await audit(db, ctx, { action: 'settings.demo_login_removed', entity: 'settings' });
    },
  })
  .add({
    method: 'get',
    path: '/',
    permission: 'core.settings.manage',
    handler: async () => {
      const out: Record<string, unknown> = {};
      for (const g of Object.keys(SETTINGS_GROUPS) as SettingsGroup[]) out[g] = await getGroup(g);
      return out;
    },
  })
  .add({
    method: 'get',
    path: '/branding',
    permission: 'core.branding.manage',
    handler: async () => {
      const branding = await getBranding();
      return {
        branding,
        assets: (await publicBranding()).assets,
        warnings: checkPaletteContrast(branding.colors),
      };
    },
  })
  .add({
    method: 'put',
    path: '/branding',
    permission: 'core.branding.manage',
    body: brandingSchema,
    handler: async ({ ctx, user, body }) => {
      const before = await getBranding();
      await db.transaction(async (trx) => {
        await setRaw('branding', 'branding', body, { isPublic: true, userId: user.id, conn: trx });
        await audit(trx, ctx, {
          action: 'settings.branding_updated',
          entity: 'settings',
          diff: { before, after: body },
        });
      });
      return {
        branding: body,
        assets: (await publicBranding()).assets,
        warnings: checkPaletteContrast(body.colors),
      };
    },
  })
  .add({
    method: 'post',
    path: '/branding/assets/:slot',
    permission: 'core.branding.manage',
    params: slotParam,
    before: [upload.single('file')],
    handler: async ({ req, ctx, user, params }) => {
      if (!req.file) throw new AppError('VALIDATION_FAILED', 'Choose a file to upload');
      const assets = await getBrandingAssets();
      const stored = await db.transaction(async (trx) => {
        const f = await storeFile(trx, ctx, {
          buffer: req.file!.buffer,
          originalName: req.file!.originalname,
          entity: 'branding',
          imagesOnly: true,
          isPublic: true,
        });
        await setRaw(
          'branding.assets',
          'branding',
          { ...assets, [params.slot]: f.uuid },
          { isPublic: true, userId: user.id, conn: trx },
        );
        const previous = assets[params.slot];
        if (previous)
          await trx('files').where({ uuid: previous }).update({ deleted_at: new Date(), is_public: false });
        await audit(trx, ctx, {
          action: 'settings.branding_asset_updated',
          entity: 'settings',
          diff: { slot: params.slot, file: f.uuid },
        });
        return f;
      });
      return {
        slot: params.slot,
        url: `/api/v1/public/branding/assets/${params.slot}?v=${stored.uuid.slice(-8)}`,
      };
    },
  })
  .add({
    method: 'delete',
    path: '/branding/assets/:slot',
    permission: 'core.branding.manage',
    params: slotParam,
    handler: async ({ ctx, user, params }) => {
      const assets = await getBrandingAssets();
      const { [params.slot]: removed, ...rest } = assets;
      await db.transaction(async (trx) => {
        await setRaw('branding.assets', 'branding', rest, { isPublic: true, userId: user.id, conn: trx });
        if (removed) await trx('files').where({ uuid: removed }).update({ deleted_at: new Date() });
        await audit(trx, ctx, {
          action: 'settings.branding_asset_removed',
          entity: 'settings',
          diff: { slot: params.slot },
        });
      });
    },
  })
  .add({
    method: 'patch',
    path: '/:group',
    permission: 'core.settings.manage',
    params: groupParam,
    body: z.record(z.string(), z.unknown()),
    handler: async ({ ctx, user, params, body }) => {
      const current = (await getRaw(params.group)) ?? {};
      const next = SETTINGS_GROUPS[params.group].parse({ ...(current as object), ...body });
      await db.transaction(async (trx) => {
        await setRaw(params.group, params.group, next, { userId: user.id, conn: trx });
        await audit(trx, ctx, {
          action: 'settings.updated',
          entity: 'settings',
          diff: { group: params.group, before: current, after: next },
        });
      });
      return next;
    },
  });

const labelsBody = z.object({
  locale: z.string().min(2).max(10).default('en'),
  labels: z.record(
    z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
    z.object({ singular: z.string().trim().min(1).max(60), plural: z.string().trim().min(1).max(60) }),
  ),
});

export const labelsRoutes = defineRoutes('/labels', ['settings'])
  .add({
    method: 'get',
    path: '/',
    permission: 'authenticated',
    query: z.object({ locale: z.string().max(10).default('en') }),
    handler: ({ query }) => getLabels(query.locale),
  })
  .add({
    method: 'put',
    path: '/',
    permission: 'core.labels.manage',
    body: labelsBody,
    handler: async ({ ctx, body }) => {
      await db.transaction(async (trx) => {
        for (const [entityKey, l] of Object.entries(body.labels)) {
          await trx('labels')
            .insert({ entity_key: entityKey, locale: body.locale, singular: l.singular, plural: l.plural })
            .onConflict(['entity_key', 'locale'])
            .merge({ singular: l.singular, plural: l.plural, customized: true });
        }
        await audit(trx, ctx, { action: 'labels.updated', entity: 'labels', diff: body });
      });
      clearLabelCache();
      return getLabels(body.locale);
    },
  });
