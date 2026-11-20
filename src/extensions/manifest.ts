// manifest.json and _locales as extension authors write them, and
// chrome.i18n's message substitution. Ported from STicks (src/manifest.ts).
import type { Manifest } from './types';

/** JSON as extension authors write it: comments, trailing commas and a BOM are allowed */
export function parseLooseJson(text: string): unknown {
	let out = '';
	let inString = false;
	for (let at = text.charCodeAt(0) === 0xfeff ? 1 : 0; at < text.length; at++) {
		const char = text[at];
		if (inString) {
			out += char;
			if (char === '\\') out += text[++at] ?? '';
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			out += char;
		} else if (char === '/' && text[at + 1] === '/') {
			while (at < text.length && text[at] !== '\n') at++;
			out += '\n';
		} else if (char === '/' && text[at + 1] === '*') {
			at = text.indexOf('*/', at + 2);
			if (at < 0) break;
			at++;
		} else if (char === ',' && /^\s*[}\]]/.test(text.slice(at + 1, at + 200)))
			continue;
		else out += char;
	}
	return JSON.parse(out);
}

export function parseManifest(text: string): Manifest {
	let value: unknown;
	try {
		value = parseLooseJson(text);
	} catch (error) {
		throw new Error(
			`manifest.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
			{ cause: error },
		);
	}
	if (
		!value ||
		typeof value !== 'object' ||
		typeof (value as Manifest).name !== 'string'
	)
		throw new Error('manifest.json has no "name"');
	const version = (value as Manifest).manifest_version;
	if (version !== undefined && version !== 2 && version !== 3)
		throw new Error(
			`manifest.json says manifest_version ${String(version)}; STomp runs 2 and 3`,
		);
	return value as Manifest;
}

export type Message = {
	message: string;
	placeholders?: Record<string, { content: string }>;
};
export type Messages = Record<string, Message>;

/** a messages.json, keys lowercased (getMessage is case-insensitive) */
export function normalizeMessages(raw: unknown): Messages {
	const out: Messages = {};
	if (!raw || typeof raw !== 'object') return out;
	for (const [key, value] of Object.entries(raw as Record<string, Message>))
		if (value && typeof value.message === 'string')
			out[key.toLowerCase()] = value;
	return out;
}

/** the locales to try, most specific first: the browser's language, its base, the default */
export function localeChain(
	defaultLocale: string | undefined,
	language: string,
): string[] {
	const ui = language.replace('-', '_');
	const chain = [ui, ui.split('_')[0]];
	if (defaultLocale) chain.push(defaultLocale);
	return [...new Set(chain)];
}

/** the `@@` messages Chrome predefines */
export function specialMessages(
	id: string,
	uiLocale: string,
): Record<string, string> {
	return {
		'@@extension_id': id,
		'@@ui_locale': uiLocale,
		'@@bidi_dir': 'ltr',
		'@@bidi_reversed_dir': 'rtl',
		'@@bidi_start_edge': 'left',
		'@@bidi_end_edge': 'right',
	};
}

/** chrome.i18n.getMessage over catalogs, most specific first */
export function getMessage(
	catalogs: Messages[],
	name: string,
	substitutions: unknown,
	special: Record<string, string>,
): string {
	const key = String(name);
	if (key.startsWith('@@')) return special[key.toLowerCase()] ?? '';
	let entry: Message | undefined;
	for (const catalog of catalogs) {
		entry = catalog[key.toLowerCase()];
		if (entry) break;
	}
	if (!entry) return '';
	const subs = (
		Array.isArray(substitutions)
			? substitutions
			: substitutions === undefined
				? []
				: [substitutions]
	).map(String);
	const fill = (text: string) =>
		text.replace(
			/\$(\d)/g,
			(_, digit: string) => subs[Number(digit) - 1] ?? '',
		);
	const placeholders: Record<string, string> = {};
	for (const [placeholder, value] of Object.entries(entry.placeholders ?? {}))
		placeholders[placeholder.toLowerCase()] = fill(value?.content ?? '');
	return entry.message
		.replace(
			/\$([a-zA-Z0-9_@]+)\$/g,
			(whole, placeholder: string) =>
				placeholders[placeholder.toLowerCase()] ?? whole,
		)
		.replace(/\$(\d)/g, (_, digit: string) => subs[Number(digit) - 1] ?? '')
		.replace(/\$\$/g, '$');
}

/** `__MSG_name__` filled in (manifest strings, content-script CSS) */
export function localize(
	text: string,
	catalogs: Messages[],
	special: Record<string, string>,
): string {
	return text.replace(
		/__MSG_([A-Za-z0-9_@]+)__/g,
		(whole, name: string) =>
			getMessage(catalogs, name, undefined, special) || whole,
	);
}

/** the icon of the size nearest above `size` (the largest when none is) */
export function pickIcon(
	icons: string | Record<string, string> | undefined,
	size = 32,
): string | null {
	if (!icons) return null;
	if (typeof icons === 'string') return icons;
	const sizes = Object.keys(icons)
		.map(Number)
		.filter(Number.isFinite)
		.sort((a, b) => a - b);
	const best = sizes.find((candidate) => candidate >= size) ?? sizes.at(-1);
	return best === undefined ? null : icons[String(best)];
}
