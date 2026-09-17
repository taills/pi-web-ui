import express, { type Express, type Request } from "express";
import { mkdtemp, mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createArchive, extractArchive, safeDestination, safeEntryPath, type ConflictPolicy } from "./file-archives.js";
import { isAbsoluteWirePath, wireToAbs, workspacePath } from "./files-service.js";

/** Registered behind the host's authentication middleware; shared by Pi and DSH. */
export function registerFileTransferRoutes(
	app: Express,
	getCwd: (clientId: string) => string | undefined,
	temporaryRoot = tmpdir(),
): void {
	const busy = new Set<string>();
	function root(req: Request): string {
		const id = typeof req.query.clientId === "string" ? req.query.clientId : "";
		const cwd = getCwd(id);
		if (!cwd) throw new Error("Client is not connected; reconnect before transferring files");
		return cwd;
	}
	function path(cwd: string, raw: unknown): string {
		if (typeof raw !== "string" || raw === "@root") throw new Error("Invalid path");
		if (isAbsoluteWirePath(raw)) return wireToAbs(raw);
		const resolved = workspacePath(cwd, raw);
		if (!resolved) throw new Error("Path outside workspace");
		return resolved.abs;
	}
	// A cross-origin form cannot set this header. No CORS permission is granted.
	app.use("/api/file-transfer", (req, res, next) => {
		if (req.headers["x-file-operation"] !== "1") {
			res.status(403).send("Missing file operation header");
			return;
		}
		next();
	});
	app.post("/api/file-transfer/archive", async (req, res) => {
		let cwd: string | undefined;
		let acquired = false;
		let temp: string | undefined;
		try {
			cwd = root(req);
			if (busy.has(cwd)) {
				res.status(409).send("Another file operation is running");
				return;
			}
			busy.add(cwd);
			acquired = true;
			const source = path(cwd, req.body?.path);
			if (req.body?.action === "extract") {
				const result = await extractArchive(source, path(cwd, req.body.destination), req.body.policy as ConflictPolicy);
				res.json(result);
			} else if (req.body?.action === "compress" || req.body?.action === "download") {
				if (req.body.action === "download") temp = await mkdtemp(join(temporaryRoot, "pi-web-download-"));
				const archive = await createArchive(source, temp);
				if (temp) {
					if (res.destroyed) throw new Error("Download cancelled");
					if ((await stat(archive.path)).size > 200 * 1024 * 1024)
						throw new Error("Temporary download exceeds 200 MiB; compress in place and download the archive instead");
					// The callback runs on completion AND disconnect. Never expose a reusable temp URL.
					await new Promise<void>((ok, fail) =>
						res.download(archive.path, archive.name, (err) => (err ? fail(err) : ok())),
					);
				} else res.json({ name: archive.name });
			} else throw new Error("Invalid archive action");
		} catch (err) {
			if (!res.headersSent && !res.destroyed) res.status(400).send(err instanceof Error ? err.message : String(err));
		} finally {
			if (temp)
				await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch((err) =>
					console.error("Temporary archive cleanup failed:", err),
				);
			if (acquired && cwd) busy.delete(cwd);
		}
	});
	// One binary file per request, sequentially sent by the browser. Avoid base64 and WS message limits.
	app.post(
		"/api/file-transfer/upload",
		express.raw({ type: "application/octet-stream", limit: "32mb" }),
		async (req, res) => {
			try {
				const cwd = root(req);
				const dir = await realpath(path(cwd, req.query.dir));
				const name = safeEntryPath(typeof req.query.name === "string" ? req.query.name : "");
				const dest = await safeDestination(dir, name);
				if (!Buffer.isBuffer(req.body)) throw new Error("Expected a binary file");
				if (req.query.kind === "directory") {
					if (req.body.length) throw new Error("Directory requests cannot contain file data");
					await mkdir(dest, { recursive: true });
					res.json({ name });
					return;
				}
				await mkdir(dirname(dest), { recursive: true });
				const handle = await open(dest, "wx", 0o600); // Folder uploads never silently overwrite existing data.
				try {
					await handle.writeFile(req.body);
				} finally {
					await handle.close();
				}
				res.json({ name });
			} catch (err) {
				res
					.status((err as NodeJS.ErrnoException).code === "EEXIST" ? 409 : 400)
					.send(err instanceof Error ? err.message : String(err));
			}
		},
	);
}
