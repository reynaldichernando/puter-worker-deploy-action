import * as core from "@actions/core";
import "@heyputer/puter.js/dist/puter.cjs";
import fs from "node:fs/promises";
import path from "node:path";
import util from "node:util";

const NOT_FOUND_CODES = new Set(["entity_not_found", "not_found"]);
const ALREADY_EXISTS_CODES = new Set(["already_exists", "entity_exists", "file_exists", "exists", "directory_exists"]);

function safeJSON(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function formatError(error) {
    if (error instanceof Error) {
        return error.stack || error.message;
    }
    if (typeof error === "string") {
        return error;
    }
    return util.inspect(error, { depth: 6, breakLength: 120 });
}

function isNotFoundError(error) {
    const code = error?.error?.code ?? error?.code;
    if (code && NOT_FOUND_CODES.has(String(code).toLowerCase())) {
        return true;
    }

    const status = error?.error?.status ?? error?.status;
    if (status === 404) {
        return true;
    }

    const message = [
        error?.error?.message,
        error?.message,
        typeof error === "string" ? error : "",
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

    return message.includes("not found") || message.includes("no entry found");
}

function isAlreadyExistsError(error) {
    const code = error?.error?.code ?? error?.code;
    if (code && ALREADY_EXISTS_CODES.has(String(code).toLowerCase())) {
        return true;
    }

    const message = [
        error?.error?.message,
        error?.message,
        typeof error === "string" ? error : "",
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

    return message.includes("already exists");
}

function isDirectoryMetadata(entry) {
    if (!entry || typeof entry !== "object") {
        return false;
    }

    if (entry.isDirectory === true || entry.is_dir === true || entry.isDir === true) {
        return true;
    }

    const type = String(entry.type ?? entry.kind ?? entry.entry_type ?? "").toLowerCase();
    return type === "directory" || type === "dir" || type === "folder";
}

function normalizeWorkerName(input) {
    const raw = String(input || "").trim().toLowerCase();
    if (!raw) {
        return "";
    }

    // Worker names are a single label. Strip an accidental https:// or .puter.work suffix.
    const noProtocol = raw.replace(/^https?:\/\//, "");
    const hostOnly = noProtocol.split("/")[0];
    const noSuffix = hostOnly.endsWith(".puter.work")
        ? hostOnly.slice(0, -".puter.work".length)
        : hostOnly;

    if (!noSuffix) {
        return "";
    }

    if (noSuffix.includes(".")) {
        throw new Error(
            `Invalid 'worker_name' input: '${input}'. Use a single label (e.g. 'my-api') or '<label>.puter.work'.`,
        );
    }

    if (!/^[a-z0-9][a-z0-9-]*$/.test(noSuffix)) {
        throw new Error(
            `Invalid 'worker_name' input: '${input}'. Use only lowercase letters, digits, and hyphens.`,
        );
    }

    return noSuffix;
}

function joinPuterPath(basePath, relativePath = "") {
    const normalizedBase = String(basePath).replace(/\\/g, "/").replace(/\/+$/, "");
    const normalizedRelative = String(relativePath).replace(/\\/g, "/").replace(/^\/+/, "");

    if (!normalizedRelative) return normalizedBase;
    if (!normalizedBase) return normalizedRelative;
    return `${normalizedBase}/${normalizedRelative}`;
}

async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

async function collectFiles(sourcePath, includeHidden) {
    const sourceStat = await fs.lstat(sourcePath);
    const files = [];

    const shouldSkipName = (name) => !includeHidden && name.startsWith(".");

    if (sourceStat.isFile()) {
        files.push({
            absolutePath: sourcePath,
            relativePath: path.basename(sourcePath),
        });
        return files;
    }

    if (!sourceStat.isDirectory()) {
        throw new Error(`source_path must be a file or directory. Received: ${sourcePath}`);
    }

    async function walk(currentPath) {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });

        for (const entry of entries) {
            if (shouldSkipName(entry.name)) {
                continue;
            }

            const absoluteEntryPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                await walk(absoluteEntryPath);
                continue;
            }

            if (entry.isFile()) {
                files.push({
                    absolutePath: absoluteEntryPath,
                    relativePath: path.relative(sourcePath, absoluteEntryPath),
                });
                continue;
            }

            if (entry.isSymbolicLink()) {
                core.info(`Skipping symlink: ${absoluteEntryPath}`);
            }
        }
    }

    await walk(sourcePath);
    return files;
}

async function ensureRemoteDirectory(puter, puterPath) {
    try {
        const existing = await puter.fs.stat(puterPath);
        if (!isDirectoryMetadata(existing)) {
            throw new Error(`Puter path exists but is not a directory: ${puterPath}. stat=${safeJSON(existing)}`);
        }
        return existing;
    } catch (error) {
        if (!isNotFoundError(error)) {
            throw error;
        }
    }

    try {
        await puter.fs.mkdir(puterPath, { createMissingParents: true });
    } catch (error) {
        if (!isAlreadyExistsError(error)) {
            throw error;
        }

        // mkdir may fail due to races/exists; stat() below is the source of truth.
        core.info(`mkdir reported existing directory, rechecking target: ${safeJSON(error)}`);
    }

    const created = await puter.fs.stat(puterPath);
    if (!isDirectoryMetadata(created)) {
        throw new Error(`Failed to create Puter directory: ${puterPath}. stat=${safeJSON(created)}`);
    }
    return created;
}

async function withConcurrency(items, limit, worker) {
    if (!items.length) {
        return;
    }

    const bounded = Math.max(1, Math.min(limit, items.length));
    let nextIndex = 0;
    let completed = 0;

    const runners = Array.from({ length: bounded }, async () => {
        while (true) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= items.length) {
                return;
            }

            await worker(items[index], index);
            completed += 1;

            if (completed % 25 === 0 || completed === items.length) {
                core.info(`Uploaded ${completed}/${items.length} files`);
            }
        }
    });

    await Promise.all(runners);
}

async function deployWorker(puter, workerName, entryPuterPath) {
    // Get-first: does the worker already exist? Swallow not-found to null.
    let existing = null;
    try {
        existing = await puter.workers.get(workerName);
    } catch (error) {
        if (!isNotFoundError(error)) {
            throw error;
        }
    }

    // Register only when new. For an existing worker the in-place file
    // overwrite (done before this) is enough — re-creating would be redundant.
    if (existing) {
        return { action: "updated", result: existing };
    }

    const result = await puter.workers.create(workerName, entryPuterPath);
    if (!result?.success && !result?.url) {
        throw new Error(`Worker deployment failed: ${safeJSON(result)}`);
    }

    return { action: "created", result };
}

// The bundled Puter SDK's XHR/fetch shim calls
// `resp.headers.get('content-type').includes(...)` with no null-guard, which
// throws when a response omits Content-Type — exactly what the signed-URL PUT
// uploads (the fast, parallel signed-batch-write path) return. Patch the global
// Headers.get so a missing content-type reads as '' instead of null; this keeps
// the fast upload path working. Idempotent. Remove once the SDK null-guards it.
function patchHeadersContentType() {
    if (typeof Headers === "undefined") return;
    if (Headers.prototype.__puterContentTypePatched) return;
    const original = Headers.prototype.get;
    Headers.prototype.get = function (name) {
        const value = original.call(this, name);
        if (value === null && String(name).toLowerCase() === "content-type") {
            return "";
        }
        return value;
    };
    Headers.prototype.__puterContentTypePatched = true;
}

function initPuterFromBundle(token) {
    patchHeadersContentType();

    const puter = globalThis.puter;
    if (!puter || typeof puter.setAuthToken !== "function") {
        throw new Error("Failed to initialize Puter SDK from bundled runtime.");
    }

    puter.setAuthToken(token);
    return puter;
}

async function run() {
    const workerNameInput = core.getInput("worker_name", { required: true }).trim();
    const workerName = normalizeWorkerName(workerNameInput);
    const puterPath = core.getInput("puter_path", { required: true }).trim();
    const token = core.getInput("puter_token", { required: true }).trim();
    const sourcePathInput = core.getInput("source_path") || ".";
    const entryFileInput = (core.getInput("entry_file") || "index.js").trim();
    const includeHidden = core.getBooleanInput("include_hidden");
    const concurrencyInput = Number.parseInt(core.getInput("concurrency") || "8", 10);
    const concurrency = Number.isFinite(concurrencyInput) && concurrencyInput > 0 ? concurrencyInput : 8;
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const sourcePath = path.resolve(workspace, sourcePathInput);

    if (!workerName) {
        throw new Error("Input 'worker_name' cannot be empty.");
    }
    if (!puterPath) {
        throw new Error("Input 'puter_path' cannot be empty.");
    }
    if (!token) {
        throw new Error("Input 'puter_token' cannot be empty.");
    }

    const sourceExists = await pathExists(sourcePath);
    if (!sourceExists) {
        throw new Error(`source_path does not exist: ${sourcePath}`);
    }

    core.info(`Source path: ${sourcePath}`);
    core.info(`Puter path: ${puterPath}`);
    core.info(`Worker name: ${workerName}`);
    core.info(`Entry file: ${entryFileInput}`);

    const puter = initPuterFromBundle(token);
    await ensureRemoteDirectory(puter, puterPath);
    const files = await collectFiles(sourcePath, includeHidden);

    core.info(`Discovered ${files.length} file(s) to upload`);

    // Determine the entry file's remote path. For a single-file source the entry
    // is that file; otherwise it is resolved relative to the source root.
    const sourceStat = await fs.lstat(sourcePath);
    let entryRelative;
    if (sourceStat.isFile()) {
        entryRelative = path.basename(sourcePath);
    } else {
        entryRelative = entryFileInput.replace(/^\.?\//, "");
        const entryAbsolute = path.resolve(sourcePath, entryRelative);
        if (!(await pathExists(entryAbsolute))) {
            throw new Error(
                `entry_file '${entryFileInput}' not found under source_path '${sourcePath}'.`,
            );
        }
    }
    const entryPuterPath = joinPuterPath(puterPath, entryRelative.split(path.sep).join("/"));

    await withConcurrency(files, concurrency, async (file) => {
        const relativePosix = file.relativePath.split(path.sep).join("/");
        const remoteFilePath = joinPuterPath(puterPath, relativePosix);
        const data = await fs.readFile(file.absolutePath);

        await puter.fs.write(remoteFilePath, data, {
            overwrite: true,
            dedupeName: false,
            createMissingParents: true,
        });
    });

    core.info(`Deploying worker '${workerName}' from entry: ${entryPuterPath}`);
    const deployment = await deployWorker(puter, workerName, entryPuterPath);
    const workerURL = deployment.result?.url ?? `https://${workerName}.puter.work`;

    core.setOutput("deployed_files", String(files.length));
    core.setOutput("worker_url", workerURL);
    core.setOutput("deploy_action", deployment.action);

    core.info(`Deploy action: ${deployment.action}`);
    core.info(`Worker URL: ${workerURL}`);
}

// The Puter SDK holds an open connection that keeps the event loop alive, so
// the action won't exit on its own once the deploy finishes. Force an exit
// after flushing both streams (writing '' invokes the callback once pending
// output has drained), so logs and `core` output are never truncated.
function flushAndExit(code) {
    let pending = 2;
    const done = () => {
        if (--pending === 0) process.exit(code);
    };
    process.stdout.write("", done);
    process.stderr.write("", done);
}

run().then(
    () => flushAndExit(0),
    (error) => {
        core.setFailed(formatError(error));
        flushAndExit(1);
    },
);
