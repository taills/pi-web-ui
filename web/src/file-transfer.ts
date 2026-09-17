import { appUrl } from "./base-url";
import { withToken } from "./auth-token";
import { getClientId } from "./use-chat";
import { saveDownloadBlob } from "./download";

export const isExtractableArchive = (name: string): boolean => /\.(zip|tar|tar\.gz|tgz|gz)$/i.test(name);
export type ArchiveAction = "compress" | "extract" | "download";

// Only same-origin application routes are allowed; file paths remain encoded query parameters.
function url(endpoint: "archive" | "upload", extra: Record<string, string> = {}): URL {
	const allowed = { archive: appUrl("/api/file-transfer/archive"), upload: appUrl("/api/file-transfer/upload") };
	const result = new URL(
		withToken(`${allowed[endpoint]}?${new URLSearchParams({ clientId: getClientId(), ...extra })}`),
		window.location.href,
	);
	if (
		result.origin !== window.location.origin ||
		result.pathname !== new URL(allowed[endpoint], window.location.href).pathname
	) {
		throw new Error("File transfers must use an allowlisted same-origin endpoint");
	}
	return result;
}

export async function archiveAction(
	action: ArchiveAction,
	path: string,
	options?: { destination: string; policy: string },
): Promise<void> {
	const res = await fetch(url("archive"), {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-File-Operation": "1" },
		body: JSON.stringify({ action, path, ...options }),
	});
	if (!res.ok) throw new Error(await res.text());
	if (action === "download") {
		const disposition = res.headers.get("content-disposition") ?? "";
		const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
		const plain = /filename="([^"]+)"/i.exec(disposition)?.[1];
		const name = encoded ? decodeURIComponent(encoded) : (plain ?? "archive.tar.gz");
		const result = await saveDownloadBlob(await res.blob(), name);
		if (!result.ok && !result.cancelled) throw new Error(result.error);
	}
}

export interface FolderEntry {
	path: string;
	file?: File;
}
interface PickedFile {
	kind: "file";
	name: string;
	getFile(): Promise<File>;
}
interface PickedDirectory {
	kind: "directory";
	name: string;
	values(): AsyncIterableIterator<PickedDirectory | PickedFile>;
}

/** File System Access preserves empty directories; null requests the webkitdirectory fallback. */
export async function pickFolder(): Promise<FolderEntry[] | null> {
	const picker = (window as Window & { showDirectoryPicker?: () => Promise<PickedDirectory> }).showDirectoryPicker;
	if (!picker) return null;
	const root = await picker.call(window);
	const entries: FolderEntry[] = [];
	async function walk(handle: PickedDirectory | PickedFile, path: string): Promise<void> {
		if (entries.length >= 20_000) throw new Error("Folder exceeds 20,000 entries");
		entries.push(handle.kind === "file" ? { path, file: await handle.getFile() } : { path });
		if (handle.kind === "directory")
			for await (const child of handle.values()) await walk(child, `${path}/${child.name}`);
	}
	await walk(root, root.name);
	return entries;
}

/** Sequential requests retain relative paths and keep memory bounded to one file. */
export async function uploadFolder(
	dir: string,
	entries: FolderEntry[],
	progress?: (done: number) => void,
): Promise<void> {
	if (entries.length > 20_000) throw new Error("Folder exceeds 20,000 entries");
	for (const entry of entries) {
		if (entry.file && entry.file.size > 32 * 1024 * 1024) throw new Error(`File exceeds 32 MiB: ${entry.path}`);
	}
	let done = 0;
	for (const entry of entries) {
		// url() validates the same-origin destination against the two fixed route names.
		const endpoint = url("upload", { dir, name: entry.path, kind: entry.file ? "file" : "directory" });
		const res = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream", "X-File-Operation": "1" },
			body: entry.file ?? new Blob(),
		});
		if (!res.ok) throw new Error(`${entry.path}: ${await res.text()}`);
		progress?.(++done);
	}
}
