import type { BrandingAssetSlot } from '@app/shared';
import { db } from '../../db/knex';
import type { AuthUser, RequestContext } from '../../http/context';
import { audit } from '../audit/audit.service';
import { storeFile } from '../files/files.service';
import { getBrandingAssets, setRaw } from './settings.service';

/**
 * Stores an image as a branding asset (logo, favicon, sign-in background): images only, public,
 * audited, and the previous file in that slot is retired. Used by uploads and by AI setup.
 */
export async function saveBrandingAsset(
  ctx: RequestContext,
  user: AuthUser,
  slot: BrandingAssetSlot,
  file: { buffer: Buffer; originalName: string },
) {
  const assets = await getBrandingAssets();
  return db.transaction(async (trx) => {
    const f = await storeFile(trx, ctx, {
      buffer: file.buffer,
      originalName: file.originalName,
      entity: 'branding',
      imagesOnly: true,
      isPublic: true,
    });
    await setRaw(
      'branding.assets',
      'branding',
      { ...assets, [slot]: f.uuid },
      { isPublic: true, userId: user.id, conn: trx },
    );
    const previous = assets[slot];
    if (previous)
      await trx('files').where({ uuid: previous }).update({ deleted_at: new Date(), is_public: false });
    await audit(trx, ctx, {
      action: 'settings.branding_asset_updated',
      entity: 'settings',
      diff: { slot, file: f.uuid },
    });
    return f;
  });
}
