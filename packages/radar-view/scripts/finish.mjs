import { URL } from 'node:url';
import { copyFile } from 'node:fs/promises';
await copyFile(
  new URL('../src/radar.css', import.meta.url),
  new URL('../dist/radar.css', import.meta.url),
);
