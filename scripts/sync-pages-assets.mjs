import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PUBLIC_DIR = path.join(projectRoot, 'public');
const DOCS_DIR = path.join(projectRoot, 'docs');

async function copyDirectory(source, target) {
  await fsp.mkdir(target, { recursive: true });
  const entries = await fsp.readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop
      await copyDirectory(sourcePath, targetPath);
    } else {
      // eslint-disable-next-line no-await-in-loop
      await fsp.copyFile(sourcePath, targetPath);
    }
  }
}

async function main() {
  if (!fs.existsSync(PUBLIC_DIR)) {
    throw new Error('Missing public directory');
  }

  await copyDirectory(PUBLIC_DIR, DOCS_DIR);
  console.log(`Synced ${path.relative(projectRoot, PUBLIC_DIR)} -> ${path.relative(projectRoot, DOCS_DIR)}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
