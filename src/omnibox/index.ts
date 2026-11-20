/**
 * The omnibox module (dist/omnibox.mjs, and dist/omnibox.js as the classic
 * script global `Omnibox`): a dropdown of ranked suggestions for any text
 * input, fed by the host's own sources and an engine's completions
 * (`controller.suggest()`). No proxied page loads it; it is in no inject
 * bundle and the controller bundles do not carry it.
 */
export {
	attachOmnibox,
	completionRows,
	HEADERS,
	HINTS,
	type Omnibox,
	type OmniboxOptions,
} from './box';
export {
	visitHistory,
	type HistoryOptions,
	type Visit,
	type VisitHistory,
} from './history';
export {
	canonicalUrl,
	defaultRow,
	fold,
	frecentSites,
	hostOf,
	matchScore,
	rankAndGroup,
	recencyWeight,
	scoreUrl,
	topPicks,
	urlMatch,
	type FrecentSite,
	type GroupKey,
	type HistoryEntry,
	type PickParts,
	type RankOptions,
	type Ranked,
	type Suggestion,
	type SuggestionGroup,
	type SuggestionKind,
} from './rank';
export {
	bookmarkRows,
	historyPicks,
	historyRows,
	safeIcon,
	siteRow,
	tabRows,
	type Bookmark,
	type OpenTab,
} from './sources';
export {
	SEARCH_ENGINES,
	searchEngine,
	type SearchEngine,
} from '../bootstrapper/searchEngines';
