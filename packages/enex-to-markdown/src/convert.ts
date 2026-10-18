import { once } from "node:events";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  convertSources,
  type EnexSource,
  type Output,
  type RunOptions,
  type RunSummary,
  type Staged,
  WARNINGS_FILE,
} from "./core.ts";

export {
  type FileEvent,
  type Progress,
  RESOURCES_DIR,
  type RunSummary,
  WARNINGS_FILE,
} from "./core.ts";

const TMP_DIR = ".enex-to-markdown-tmp";

export interface ConvertOptions extends Omit<RunOptions, "rootLength"> {
  outDir: string;
  /** Write into an output folder that already has files in it (files with the same names are replaced). */
  overwrite?: boolean;
}

export class UsageError extends Error {}

/** The `.enex` files to convert: files as given, folders searched (symlinks and junctions are not followed). */
export async function findEnexFiles(inputs: readonly string[]): Promise<{ path: string; relDir: string }[]> {
  const out: { path: string; relDir: string }[] = [];
  for (const input of inputs) {
    const abs = resolve(input);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(abs);
    } catch {
      throw new UsageError(`Can't find ${input}`);
    }
    if (info.isFile()) {
      out.push({ path: abs, relDir: "" });
      continue;
    }
    const found: { path: string; relDir: string }[] = [];
    const walk = async (dir: string) => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const p = join(dir, e.name);
        if (e.isSymbolicLink() || (await lstat(p)).isSymbolicLink()) continue;
        if (e.isDirectory()) await walk(p);
        else if (e.isFile() && /\.enex$/i.test(e.name))
          found.push({ path: p, relDir: relative(abs, dir).split(/[\\/]/).filter(Boolean).join("/") });
      }
    };
    await walk(abs);
    if (!found.length) throw new UsageError(`No .enex files in ${input}`);
    out.push(...found);
  }
  return out;
}

export async function convertEnex(inputs: readonly string[], options: ConvertOptions): Promise<RunSummary> {
  const found = await findEnexFiles(inputs);
  if (!found.length) throw new UsageError("Give at least one .enex file or a folder of them.");
  const outRoot = resolve(options.outDir);
  await prepareOutput(outRoot, options.overwrite === true || options.dryRun === true);
  const sources: EnexSource[] = [];
  for (const f of found)
    sources.push({
      name: basename(f.path),
      label: f.path,
      relDir: f.relDir,
      size: (await stat(f.path)).size,
      open: () => createReadStream(f.path, { highWaterMark: 1 << 20 }),
    });
  const output = new FolderOutput(outRoot);
  if (!options.dryRun) await mkdir(output.tmp, { recursive: true });
  try {
    const summary = await convertSources(sources, output, { ...options, rootLength: outRoot.length });
    return {
      ...summary,
      outDir: outRoot,
      warningsFile: summary.warningsFile ? join(outRoot, summary.warningsFile) : null,
    };
  } finally {
    if (!options.dryRun) await rm(output.tmp, { recursive: true, force: true });
  }
}

async function prepareOutput(outRoot: string, overwrite: boolean): Promise<void> {
  let entries: string[] = [];
  try {
    if (!(await stat(outRoot)).isDirectory()) throw new UsageError(`${outRoot} is a file, not a folder.`);
    entries = await readdir(outRoot);
  } catch (err) {
    if (err instanceof UsageError) throw err;
  }
  // A report from a dry run may be there: converting for real afterwards is the point of it.
  if (entries.some((e) => e !== TMP_DIR && e !== WARNINGS_FILE) && !overwrite)
    throw new UsageError(`The output folder ${outRoot} isn't empty. Choose another with -o, or add --overwrite.`);
  await mkdir(outRoot, { recursive: true });
}

/** Writes into a folder; attachments wait in a temporary folder inside it until their names are known. */
class FolderOutput implements Output {
  readonly tmp: string;
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
    this.tmp = join(root, TMP_DIR);
  }

  stage(key: string): Staged {
    return createWriteStream(join(this.tmp, key));
  }

  async commit(staged: Staged, path: string): Promise<void> {
    await closed(staged);
    await rename(String((staged as WriteStream).path), join(this.root, path));
  }

  async discard(staged: Staged): Promise<void> {
    await closed(staged);
    await unlink(String((staged as WriteStream).path)).catch(() => {});
  }

  async dir(path: string): Promise<void> {
    await mkdir(join(this.root, path), { recursive: true });
  }

  async write(path: string, data: string | Uint8Array, mtime: Date | null): Promise<void> {
    const abs = join(this.root, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, data);
    if (mtime) await utimes(abs, mtime, mtime).catch(() => {});
  }
}

async function closed(staged: Staged): Promise<void> {
  const ws = staged as WriteStream;
  if (!ws.closed) await once(ws, "close");
}
