// The Accept-Language header Chrome sends, from the user's language list
// (navigator.languages, which a service worker and a page read alike): the
// first language as it is, each next one with a weight 0.1 lower, never
// below 0.1, and a regional language followed by its base language when
// the list does not name that (["en-US"] goes as "en-US,en;q=0.9"). The
// network stack adds the header after the service worker, so a request the
// worker sees never carries it.
export function acceptLanguage(
	languages: readonly string[] | undefined,
): string | null {
	const list: string[] = [];
	for (const language of languages ?? []) {
		if (typeof language !== 'string' || !language || list.includes(language))
			continue;
		list.push(language);
		const base = language.split('-')[0];
		if (
			base !== language &&
			!(languages ?? []).includes(base) &&
			!list.includes(base)
		)
			list.push(base);
	}
	if (!list.length) return null;
	return list
		.map((language, i) => {
			if (i === 0) return language;
			const weight = Math.max(1, 10 - i) / 10;
			return `${language};q=${weight.toFixed(1)}`;
		})
		.join(',');
}
