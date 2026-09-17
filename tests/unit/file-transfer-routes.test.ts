import express from "express";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { registerFileTransferRoutes } from "../../server/file-transfer-routes.js";

const cleanup: { server: Server; root: string }[] = [];
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-transfer-http-"));
	const temporary = join(root, "temporary");
	await mkdir(temporary);
	await writeFile(join(root, "a.txt"), "archive me");
	const app = express();
	app.use(express.json());
	registerFileTransferRoutes(app, (id) => (id === "test-client" ? root : undefined), temporary);
	const server = createServer(app);
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	cleanup.push({ server, root });
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test address");
	const url = `http://127.0.0.1:${address.port}/api/file-transfer`;
	function archive(action: string, path = "a.txt", headers: Record<string, string> = { "X-File-Operation": "1" }) {
		return fetch(`${url}/archive?clientId=test-client`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify({ action, path }),
		});
	}
	function upload(name: string, body = "hello") {
		return fetch(`${url}/upload?${new URLSearchParams({ clientId: "test-client", dir: "", name })}`, {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream", "X-File-Operation": "1" },
			body,
		});
	}
	return { root, temporary, url, archive, upload };
}
afterEach(async () => {
	for (const { server, root } of cleanup.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((ok, fail) => server.close((err) => (err ? fail(err) : ok())));
		await rm(root, { recursive: true, force: true });
	}
});

describe("file transfer HTTP routes", () => {
	it("requires explicit operation header and a connected client", async () => {
		const f = await fixture();
		expect((await f.archive("compress", "a.txt", {})).status).toBe(403);
		const unknown = await fetch(`${f.url}/archive?clientId=unknown`, {
			method: "POST",
			headers: { "X-File-Operation": "1", "Content-Type": "application/json" },
			body: JSON.stringify({ action: "compress", path: "a.txt" }),
		});
		expect(unknown.status).toBe(400);
		expect((await f.archive("compress", "../outside")).status).toBe(400);
	});
	it("uploads folder hierarchy, including empty files, without overwriting conflicts", async () => {
		const f = await fixture();
		expect((await f.upload("folder/nested/中文.txt")).status).toBe(200);
		expect((await f.upload("folder/empty.txt", "")).status).toBe(200);
		expect(await readFile(join(f.root, "folder/nested/中文.txt"), "utf8")).toBe("hello");
		expect((await f.upload("folder/nested/中文.txt", "replace")).status).toBe(409);
		expect(await readFile(join(f.root, "folder/nested/中文.txt"), "utf8")).toBe("hello");
		expect((await f.upload("../escape")).status).toBe(400);
		expect((await f.upload("C:/escape")).status).toBe(400);
	});
	it("downloads a temporary archive and deletes it after sending", async () => {
		const f = await fixture();
		const res = await f.archive("download");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-disposition")).toContain("a.txt.tar.gz");
		const bytes = Buffer.from(await res.arrayBuffer());
		expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
		await expect.poll(() => readdir(f.temporary)).toEqual([]);
		await expect(readFile(join(f.root, "a.txt.tar.gz"))).rejects.toThrow();
	});
	it("cleans temporary archives when the download is disconnected", async () => {
		const f = await fixture();
		await writeFile(join(f.root, "a.txt"), randomBytes(4 * 1024 * 1024));
		const res = await f.archive("download");
		expect(res.status).toBe(200);
		await res.body?.cancel();
		await expect.poll(() => readdir(f.temporary), { timeout: 5000 }).toEqual([]);
	});
	it("cleans temporary archives on failure", async () => {
		const f = await fixture();
		expect((await f.archive("download", "missing")).status).toBe(400);
		await expect.poll(() => readdir(f.temporary)).toEqual([]);
	});
	it("compresses alongside the source without overwriting it", async () => {
		const f = await fixture();
		expect((await f.archive("compress")).status).toBe(200);
		expect(await readdir(f.root)).toContain("a.txt.tar.gz");
		await expect.poll(async () => (await f.archive("compress")).status).toBe(400);
		expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("archive me");
	});
});
