import { z } from 'zod';

// The page CSP forbids eval; skip Zod's eval probe (it would log a CSP violation on every load).
// Zod reads this when each schema is created, so main.tsx imports this module before anything else.
z.config({ jitless: true });
