import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { archiveName, createArchive, extractArchive, safeEntryPath } from "../../server/file-archives.js";

const roots: string[] = [];
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-archive-test-"));
	roots.push(root);
	await mkdir(join(root, "folder", "nested"), { recursive: true });
	await mkdir(join(root, "folder", "empty"));
	await mkdir(join(root, "out"));
	await writeFile(join(root, "folder", "nested", "中文.txt"), "hello");
	await writeFile(join(root, "folder", "empty.txt"), "");
	return root;
}
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("archive file operations", () => {
	it("uses timestamp only for folders", () => {
		expect(archiveName("/tmp/a.txt", false)).toBe("a.txt.tar.gz");
		expect(archiveName("/tmp/folder", true, new Date("2026-01-02T03:04:05Z"))).toBe(
			"folder-2026-01-02T03-04-05-000Z.tar.gz",
		);
	});
	it.each([
		"../escape",
		"/absolute",
		"C:\\escape",
		"a/../../x",
		"a\\..\\x",
		"a//x",
		"NUL.txt",
		"a/x:stream",
		"a/\u0000x",
		"a/x.\u0020",
	])("rejects unsafe paths: %s", (name) => {
		expect(() => safeEntryPath(name)).toThrow();
	});
	it("round-trips a recursive folder, unicode names, empty files and empty directories", async () => {
		const root = await fixture();
		const archive = await createArchive(join(root, "folder"));
		expect(archive.name).toMatch(/^folder-.*\.tar\.gz$/);
		expect(await extractArchive(archive.path, join(root, "out"), "skip")).toEqual({ written: 2, skipped: 0 });
		expect(await readFile(join(root, "out/folder/nested/中文.txt"), "utf8")).toBe("hello");
		expect(await readdir(join(root, "out/folder/empty"))).toEqual([]);
		expect(await readFile(join(root, "out/folder/empty.txt"), "utf8")).toBe("");
	});
	it("does not overwrite an existing compression output", async () => {
		const root = await fixture();
		const file = join(root, "file.txt");
		await writeFile(file, "original");
		const first = await createArchive(file);
		const content = await readFile(first.path);
		await expect(createArchive(file)).rejects.toThrow();
		expect(await readFile(first.path)).toEqual(content);
	});
	it("supports skip, overwrite and preflight conflict rejection", async () => {
		const root = await fixture();
		const archive = await createArchive(join(root, "folder"));
		await mkdir(join(root, "out/folder/nested"), { recursive: true });
		const existing = join(root, "out/folder/nested/中文.txt");
		await writeFile(existing, "keep");
		await expect(extractArchive(archive.path, join(root, "out"), "error")).rejects.toThrow("already exists");
		await expect(readFile(join(root, "out/folder/empty.txt"))).rejects.toThrow();
		await extractArchive(archive.path, join(root, "out"), "skip");
		expect(await readFile(existing, "utf8")).toBe("keep");
		await extractArchive(archive.path, join(root, "out"), "overwrite");
		expect(await readFile(existing, "utf8")).toBe("hello");
	});
	it("extracts gzip files", async () => {
		const root = await fixture();
		const path = join(root, "hello.txt.gz");
		await writeFile(path, gzipSync("gzip content"));
		await extractArchive(path, join(root, "out"), "skip");
		expect(await readFile(join(root, "out/hello.txt"), "utf8")).toBe("gzip content");
	});
	it("accepts normal tar archives whose paths begin with ./", async () => {
		const root = await fixture();
		const path = join(root, "normal.tar");
		await tar.c({ file: path, cwd: join(root, "folder") }, ["."]);
		await extractArchive(path, join(root, "out"), "skip");
		expect(await readFile(join(root, "out/nested/中文.txt"), "utf8")).toBe("hello");
	});
	it("extracts ZIP and rejects ZIP traversal before touching the destination", async () => {
		const root = await fixture();
		const good =
			"UEsDBBQAAAAIAPGRMV112oQwDQAAAAsAAAAQAAAAZm9sZGVyL2hlbGxvLnR4dKvKLFBIzs8rSc0rAQBQSwECFAMUAAAACADxkTFdddqEMA0AAAALAAAAEAAAAAAAAAAAAAAAgAEAAAAAZm9sZGVyL2hlbGxvLnR4dFBLBQYAAAAAAQABAD4AAAA7AAAAAAA=";
		const bad =
			"UEsDBBQAAAAIAPGRMV112oQwDQAAAAsAAAANAAAALi4vZXNjYXBlLnR4dKvKLFBIzs8rSc0rAQBQSwECFAMUAAAACADxkTFdddqEMA0AAAALAAAADQAAAAAAAAAAAAAAgAEAAAAALi4vZXNjYXBlLnR4dFBLBQYAAAAAAQABADsAAAA4AAAAAAA=";
		const zip = join(root, "test.zip");
		await writeFile(zip, Buffer.from(good, "base64"));
		await extractArchive(zip, join(root, "out"), "skip");
		expect(await readFile(join(root, "out/folder/hello.txt"), "utf8")).toBe("zip content");
		await writeFile(zip, Buffer.from(bad, "base64"));
		await expect(extractArchive(zip, join(root, "out"), "overwrite")).rejects.toThrow();
		await expect(readFile(join(root, "escape.txt"))).rejects.toThrow();
	});
	it.each(["../escape.txt", "/absolute.txt", "C:/escape.txt"])("rejects unsafe TAR header %s", async (path) => {
		const root = await fixture();
		const header = new tar.Header({ path, type: "File", size: 1, mode: 0o600 });
		header.encode();
		const archive = join(root, "bad.tar");
		await writeFile(archive, Buffer.concat([header.block!, Buffer.from("x"), Buffer.alloc(1535)]));
		await expect(extractArchive(archive, join(root, "out"), "overwrite")).rejects.toThrow();
		expect(await readdir(join(root, "out"))).toEqual([]);
	});
	it.skipIf(process.platform === "win32")("rejects symlinks both in archives and in destination parents", async () => {
		const root = await fixture();
		const archive = await createArchive(join(root, "folder"));
		await symlink(join(root, "folder"), join(root, "out/folder"), "dir");
		await expect(extractArchive(archive.path, join(root, "out"), "overwrite")).rejects.toThrow("Symbolic link");
		await rm(join(root, "out/folder"));
		await symlink("/tmp", join(root, "folder/unsafe"), "dir");
		const bad = join(root, "links.tar");
		await tar.c({ file: bad, cwd: root }, ["folder"]);
		await expect(extractArchive(bad, join(root, "out"), "overwrite")).rejects.toThrow("link");
		expect(await readdir(join(root, "out"))).toEqual([]);
	});
});
