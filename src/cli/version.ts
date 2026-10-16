import { readFileSync } from 'node:fs';

export function readVersion(): string {
  const pkg = new URL('../../package.json', import.meta.url);
  return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;
}
