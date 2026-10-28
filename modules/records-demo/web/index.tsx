import type { WebModule } from '@app/module-sdk';

/**
 * List, detail and trash pages of this module's record types are added by the app from the
 * record type definition. Add routes here only for screens beyond those.
 */
const mod: WebModule = { key: 'records-demo', routes: [] };

export default mod;
