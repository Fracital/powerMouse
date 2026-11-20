// An extension package read down to its files, its manifest and its id
// (docs/extensions.md "Installing"): a .crx (2 or 3) or a .zip as bytes, or
// an unpacked extension's files. The id is Chrome's: from manifest `key`,
// else the CRX3 header's, else the CRX2 key's; an extension that carries
// none gets one from its name and file name, stable across reinstalls.
// Ported from STicks (Sticks.install).
import { idFromKey, idFromText, parseCrx } from '../../extensions/crx';
import { parseManifest } from '../../extensions/manifest';
import { cleanPath } from '../../extensions/origin';
import { ExtensionError, type Manifest } from '../../extensions/types';
import { readZip } from '../../extensions/zip';
import type { PackedFile, PackIndex } from './store';

export interface ReadPackage {
	id: string;
	manifest: Manifest;
	/** the package's bytes, and where each file is in them (PackageFiles) */
	pack: Blob;
	index: PackIndex;
}

const decode = (bytes: Uint8Array | undefined) =>
	bytes ? new TextDecoder().decode(bytes) : '';

function base64Bytes(text: string): Uint8Array {
	const binary = atob(text.replace(/\s+/g, ''));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function idOf(
	manifest: Manifest,
	crxId: string | null,
	publicKey: Uint8Array | null,
	filename: string,
): Promise<string> {
	if (typeof manifest.key === 'string' && manifest.key)
		try {
			return await idFromKey(base64Bytes(manifest.key));
		} catch (error) {
			throw new ExtensionError(
				'bad-manifest',
				'manifest.json has a "key" that is not base64',
			);
		}
	if (crxId) return crxId;
	if (publicKey) return idFromKey(publicKey);
	return idFromText(`${manifest.name}\n${filename}`);
}

/** a file of the package before it is stored: where it is in the blob, and its manifest's bytes */
interface Found {
	at: PackedFile;
	read(): Promise<Uint8Array>;
}

/** the files of a file map whose manifest may sit in a folder of its own */
function rooted(all: Map<string, Found>): Map<string, Found> {
	if (all.has('manifest.json')) return all;
	const nested = [...all.keys()]
		.filter((name) => name.endsWith('/manifest.json'))
		.sort((a, b) => a.split('/').length - b.split('/').length)[0];
	if (!nested)
		throw new ExtensionError(
			'no-manifest',
			'the package has no manifest.json (at its root or in one folder)',
		);
	const prefix = nested.slice(0, -'manifest.json'.length);
	const out = new Map<string, Found>();
	for (const [name, found] of all)
		if (name.startsWith(prefix)) out.set(name.slice(prefix.length), found);
	return out;
}

async function finish(
	all: Map<string, Found>,
	pack: Blob,
	crxId: string | null,
	publicKey: Uint8Array | null,
	filename: string,
): Promise<ReadPackage> {
	const found = rooted(all);
	let manifest: Manifest;
	try {
		manifest = parseManifest(decode(await found.get('manifest.json')?.read()));
	} catch (error) {
		throw new ExtensionError(
			'bad-manifest',
			error instanceof Error ? error.message : String(error),
		);
	}
	const index: PackIndex = {};
	for (const [name, file] of found) index[name] = file.at;
	return {
		id: await idOf(manifest, crxId, publicKey, filename),
		manifest,
		pack,
		index,
	};
}

/**
 * A .crx or .zip: its ZIP is kept as it came, and only its manifest is
 * inflated now (every other file when it is read, PackageFiles)
 */
export async function readPackage(
	bytes: Uint8Array,
	filename: string,
): Promise<ReadPackage> {
	let parts;
	try {
		parts = parseCrx(bytes);
	} catch (error) {
		throw new ExtensionError(
			'bad-package',
			`${filename} is not a package STomp can read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const all = new Map<string, Found>();
	try {
		for (const entry of readZip(parts.zip)) {
			if (entry.name.startsWith('__MACOSX/')) continue;
			const name = cleanPath(entry.name);
			if (name)
				all.set(name, {
					at: [
						entry.dataOffset(),
						entry.compressedSize,
						entry.size,
						entry.method,
					],
					read: entry.read,
				});
		}
	} catch (error) {
		throw new ExtensionError(
			'bad-package',
			`${filename} is neither a .crx nor a .zip STomp can read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return finish(
		all,
		new Blob([parts.zip as Uint8Array<ArrayBuffer>]),
		parts.crxId,
		parts.publicKey,
		filename,
	);
}

/** an unpacked extension's files, stored end to end in one blob */
export async function readUnpacked(
	given: Record<string, ArrayBuffer>,
	filename: string,
): Promise<ReadPackage> {
	const all = new Map<string, Found>();
	const parts: ArrayBuffer[] = [];
	let at = 0;
	for (const [name, data] of Object.entries(given)) {
		const clean = cleanPath(name);
		if (!clean) continue;
		const bytes = new Uint8Array(data);
		all.set(clean, {
			at: [at, bytes.byteLength, bytes.byteLength, 0],
			read: async () => bytes,
		});
		parts.push(data);
		at += bytes.byteLength;
	}
	return finish(all, new Blob(parts), null, null, filename);
}
/**
 * The Web Store id a source names: an id, a Web Store detail page
 * (`chromewebstore.google.com/detail/<slug>/<id>`, the old
 * `chrome.google.com/webstore/detail/...`), or an update service URL with
 * `x=id%3D<id>`; null for anything else
 */
export function webStoreId(source: string): string | null {
	const text = source.trim();
	if (/^[a-p]{32}$/.test(text)) return text;
	let url: URL;
	try {
		url = new URL(text);
	} catch (error) {
		return null;
	}
	const x = url.searchParams.get('x');
	if (x) {
		const id = /(?:^|&)id=([a-p]{32})/.exec(x)?.[1];
		if (id) return id;
	}
	if (
		/(^|\.)chromewebstore\.google\.com$/.test(url.hostname) ||
		(/(^|\.)chrome\.google\.com$/.test(url.hostname) &&
			url.pathname.startsWith('/webstore'))
	)
		return /\/([a-p]{32})(?:[/?#]|$)/.exec(url.pathname)?.[1] ?? null;
	return null;
}

/** the update service URL a Web Store id downloads from */
export function webStoreDownload(id: string, chromeVersion: string): string {
	return `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${chromeVersion}&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
}
