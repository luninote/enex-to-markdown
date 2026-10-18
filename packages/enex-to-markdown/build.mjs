// Bundles the command into one file, dist/cli.js, and the browser converter into one worker script,
// dist/browser/enex-to-markdown-worker.js, each with every dependency inside it and the licenses of the bundled
// third-party packages listed next to it. Usage: node build.mjs [--outdir <folder>]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { outdir: { type: "string" } } });
const outdir = resolve(values.outdir ?? join(here, "dist"));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const shim = (name) => join(here, "src", "browser", "shims", name);

const cli = await build({
  entryPoints: [join(here, "src", "bin.ts")],
  outfile: join(outdir, "cli.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: true,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
  define: { __VERSION__: JSON.stringify(pkg.version) },
  // Some bundled dependencies are CommonJS and require Node's built-in modules.
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
});
licenses(cli.metafile, join(outdir, "THIRD-PARTY-LICENSES.txt"), "dist/cli.js");

// A classic (not module) worker, so browsers without module workers run it too. The shared ENEX reader is written
// for Node; the shims give it the few Node APIs it uses.
const worker = await build({
  entryPoints: [join(here, "src", "browser", "worker.ts")],
  outfile: join(outdir, "browser", "enex-to-markdown-worker.js"),
  bundle: true,
  platform: "browser",
  target: ["es2022", "chrome105", "firefox110", "safari16"],
  format: "iife",
  minify: true,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
  alias: {
    "node:crypto": shim("crypto.ts"),
    "node:events": shim("events.ts"),
    "node:stream/promises": shim("events.ts"),
    stream: shim("empty.ts"),
  },
  inject: [shim("buffer.ts")],
  define: { "process.env.NODE_ENV": '"production"' },
});
licenses(worker.metafile, join(outdir, "browser", "THIRD-PARTY-LICENSES.txt"), "enex-to-markdown-worker.js");

function licenses(metafile, file, bundle) {
  // pnpm keeps packages under node_modules/.pnpm/<name>@<version>/node_modules/<name>/; the last node_modules wins.
  const packageDirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const path = input.replace(/\\/g, "/");
    const at = path.lastIndexOf("node_modules/");
    if (at < 0) continue;
    const rest = path.slice(at + "node_modules/".length).split("/");
    const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
    packageDirs.add(resolve(path.slice(0, at + "node_modules/".length) + name));
  }
  const sections = [];
  for (const dir of [...packageDirs].sort()) {
    const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const licenseFile = existsSync(dir) ? readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f)) : null;
    const text = licenseFile ? readFileSync(join(dir, licenseFile), "utf8").trim() : `License: ${meta.license}`;
    sections.push(`${meta.name}@${meta.version} (${meta.license})\n\n${text}`);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${bundle} includes the following packages.\n\n${sections.join(`\n\n${"-".repeat(72)}\n\n`)}\n`);
}
