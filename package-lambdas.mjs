// Packages each esbuild-produced handler in `dist/` into a Lambda zip at
// `infrastructure/build/<name>.zip`. Each zip contains a single `index.js`
// file matching the `handler = "index.handler"` setting in lambda.tf.
//
// Run after `npm run build`:
//   npm run package
// Or in one shot:
//   npm run build:lambdas   (runs build then package)

import AdmZip from "adm-zip";
import {
  readFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname);
const DIST = join(ROOT, "dist");
const OUT = join(ROOT, "infrastructure", "build");

if (!existsSync(DIST)) {
  console.error(
    "dist/ not found — run `npm run build` before packaging Lambda zips."
  );
  process.exit(1);
}

// Wipe and recreate the output dir so stale zips can't linger.
if (existsSync(OUT)) {
  rmSync(OUT, { recursive: true, force: true });
}
mkdirSync(OUT, { recursive: true });

const handlerFiles = readdirSync(DIST).filter(
  (f) => f.endsWith(".js") && !f.endsWith(".map")
);

if (handlerFiles.length === 0) {
  console.error("No handler .js files found in dist/.");
  process.exit(1);
}

let total = 0;
for (const file of handlerFiles) {
  const name = file.replace(/\.js$/, "");
  const bundled = readFileSync(join(DIST, file));

  const zip = new AdmZip();
  // Lambda's `handler = "index.handler"` expects a file named `index.js`
  // at the root of the zip, exporting a `handler` function.
  zip.addFile("index.js", bundled);
  const zipPath = join(OUT, `${name}.zip`);
  zip.writeZip(zipPath);
  total++;
  console.log(`  Packaged ${name}.zip (${bundled.length} bytes)`);
}

console.log(`\nWrote ${total} Lambda zip(s) to infrastructure/build/`);
