// Themes (docs/extensions.md "Themes"): a package whose manifest has a
// "theme" key is a theme, as Chrome reads it (Manifest::GetType). Chrome
// runs nothing of a theme and grants it nothing: the manifest features of
// extensions (background, content scripts, permissions, rules, pages)
// are ignored for one, with an install warning. The worker keeps a theme
// with the extensions (management.getAll lists it, as type "theme"), but
// loads it from the manifest this file leaves of it, so none of the request
// path, the content scripts, the rules or the hub ever sees code in it.
// One theme is shown at a time (ThemeService): the registry turns off the
// theme a new one replaced and drops it later (registry.ts #replaceThemes).
import { cleanPath } from '../../extensions/origin';
import type {
	ChromeTheme,
	Manifest,
	ThemeImageFile,
} from '../../extensions/types';
import { mimeOf } from './store';

/** whether a manifest is a theme's: it has the key, whatever its value (Manifest::GetTypeFromManifestValue) */
export function isTheme(manifest: Manifest): boolean {
	return Object.hasOwn(manifest, 'theme');
}

/** the manifest keys a theme keeps: the ones every type of package has */
const THEME_KEYS = new Set([
	'name',
	'short_name',
	'description',
	'version',
	'version_name',
	'manifest_version',
	'default_locale',
	'icons',
	'key',
	'update_url',
	'homepage_url',
	'author',
	'minimum_chrome_version',
	'theme',
]);

/** a theme's manifest without what Chrome ignores for a theme, and a warning for each key left out */
export function themeManifest(manifest: Manifest): {
	manifest: Manifest;
	warnings: string[];
} {
	const kept: Record<string, unknown> = {};
	const warnings: string[] = [];
	for (const key of Object.keys(manifest))
		if (THEME_KEYS.has(key)) kept[key] = manifest[key];
		else
			warnings.push(
				`"${key}" is ignored: a theme runs no code and has no permissions`,
			);
	return { manifest: kept as Manifest, warnings };
}

const SCALES = /^\d+_percent$/;

const section = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value)
		? { ...(value as Record<string, unknown>) }
		: {};

/**
 * manifest.theme's four sections, Chrome's keys and values unchanged, its
 * images read from the package (`read` gives a file's bytes, null for one
 * it does not have). An image Chrome could not load (a path that is no
 * file, a value that is neither a path nor a dictionary of scales) is left
 * out, as BrowserThemePack leaves it out.
 */
export async function themeSections(
	manifest: Manifest,
	read: (path: string) => Promise<Uint8Array | null>,
): Promise<ChromeTheme<ThemeImageFile>> {
	const theme = section(manifest.theme);
	const file = async (value: unknown): Promise<ThemeImageFile | null> => {
		if (typeof value !== 'string' || !value) return null;
		const path = cleanPath(value);
		const bytes = await read(path);
		if (!bytes) return null;
		return {
			path,
			type: mimeOf(path).split(';')[0],
			bytes: bytes.slice().buffer as ArrayBuffer,
		};
	};
	const images: ChromeTheme<ThemeImageFile>['images'] = {};
	for (const [key, value] of Object.entries(section(theme.images))) {
		if (typeof value === 'string') {
			const found = await file(value);
			if (found) images[key] = found;
		} else if (value && typeof value === 'object' && !Array.isArray(value)) {
			const scaled: Record<string, ThemeImageFile> = {};
			for (const [scale, path] of Object.entries(value))
				if (SCALES.test(scale)) {
					const found = await file(path);
					if (found) scaled[scale] = found;
				}
			if (Object.keys(scaled).length) images[key] = scaled;
		}
	}
	return {
		colors: section(theme.colors),
		tints: section(theme.tints),
		properties: section(theme.properties),
		images,
	};
}
