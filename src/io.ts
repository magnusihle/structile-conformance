import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
}

export interface ListFilesOptions {
  ignored?: readonly string[];
}

export async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function hashFile(path: string): Promise<string> {
  return sha256(await readFile(path));
}

export async function command(program: string, args: readonly string[], options: CommandOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const result = await runFile(program, args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    timeout: options.timeout ?? 120_000,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    encoding: "utf8"
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function listFiles(root: string, options: ListFilesOptions = {}): Promise<string[]> {
  const ignored = new Set(options.ignored ?? [".git", "node_modules", "dist", "coverage", "evidence", "artifacts"]);
  const files: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const name of await readdir(path)) {
      if (ignored.has(name)) continue;
      const child = join(path, name);
      const info = await stat(child);
      if (info.isDirectory()) await visit(child);
      else if (info.isFile()) files.push(relative(root, child));
    }
  }
  await visit(resolve(root));
  return files.sort();
}
