import { v7 } from 'uuid';

/** Public identifiers are UUIDv7 (time-ordered, index friendly). */
export const newUuid = (): string => v7();
