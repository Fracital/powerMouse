/**
 * The search engines `controller.suggest()` knows, by id: where a search
 * goes (`search`, a SearchBuilder template) and where its completions come
 * from (`suggest`, the engine's OpenSearch suggest endpoint, `%s` the
 * query). Startpage publishes no suggest endpoint, so DuckDuckGo's
 * completions stand in for it.
 */
export interface SearchEngine {
	id: string;
	name: string;
	/** the results page, `%s` the query (a SearchBuilder template) */
	search: string;
	/** the OpenSearch suggest endpoint, `%s` the query; it answers `[query, [completion, ...]]` */
	suggest: string;
}

const DUCKDUCKGO_SUGGEST = 'https://duckduckgo.com/ac/?q=%s&type=list';

export const SEARCH_ENGINES: readonly SearchEngine[] = [
	{
		id: 'google',
		name: 'Google',
		search: 'https://www.google.com/search?q=%s',
		suggest: 'https://www.google.com/complete/search?client=chrome&q=%s',
	},
	{
		id: 'duckduckgo',
		name: 'DuckDuckGo',
		search: 'https://duckduckgo.com/?q=%s',
		suggest: DUCKDUCKGO_SUGGEST,
	},
	{
		id: 'bing',
		name: 'Bing',
		search: 'https://www.bing.com/search?q=%s',
		suggest: 'https://www.bing.com/osjson.aspx?query=%s',
	},
	{
		id: 'brave',
		name: 'Brave',
		search: 'https://search.brave.com/search?q=%s',
		suggest: 'https://search.brave.com/api/suggest?q=%s',
	},
	{
		id: 'startpage',
		name: 'Startpage',
		search: 'https://www.startpage.com/do/search?q=%s',
		suggest: DUCKDUCKGO_SUGGEST,
	},
];

/** the part of a template before its query: what two templates of one engine share */
const stem = (template: string) =>
	template.slice(0, template.indexOf('%s')).replace(/^https?:\/\/(www\.)?/, '');

/**
 * The engine `name` names: an id (`'brave'`), or a results template of one
 * (SearchBuilder's, `'https://search.brave.com/search?q=%s'`); null for
 * anything else.
 */
export function searchEngine(name: string): SearchEngine | null {
	return (
		SEARCH_ENGINES.find(
			(engine) =>
				engine.id === name ||
				(name.includes('%s') && stem(engine.search) === stem(name)),
		) ?? null
	);
}
