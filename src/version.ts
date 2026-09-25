import { readFileSync } from 'node:fs';

/** The running node package, independent of the core and persisted config versions. */
export const NODE_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
