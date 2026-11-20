/**
 * The omnibox's dropdown on any text input (SystemYA src/systemya/omni/box.ts,
 * after Fracital's useOmniSuggestions and useOmniBox), with no framework.
 *
 * Local rows rank at once. An engine's completions are asked 250 ms after
 * the last keystroke and only for two characters or more, one request at a
 * time: new text aborts the one in flight, and an answer for older text is
 * dropped. Until the new answer comes, the last one's completions that
 * still start with the text stay. The empty box shows top picks once it is
 * clicked or ArrowDown is pressed (not when a page focuses it). The arrows
 * move (from "nothing" down to the first row, up to the last, and round
 * the ends), Enter opens the highlighted row and otherwise lets the form
 * submit as it did, Tab fills the box with the row's text, Escape closes,
 * Shift+Delete forgets a row that can be forgotten, hovering highlights.
 * The input keeps the focus and names the highlighted option
 * (aria-activedescendant).
 */
import SearchBuilder from '../bootstrapper/SearchBuilder';
import { searchEngine } from '../bootstrapper/searchEngines';
import {
	fold,
	hostOf,
	rankAndGroup,
	topPicks,
	type GroupKey,
	type PickParts,
	type Ranked,
	type RankOptions,
	type Suggestion,
} from './rank';

const REMOTE_DELAY_MS = 250;
const REMOTE_MIN_CHARS = 2;
const EMPTY: Ranked = { groups: [], rows: [] };

/** the headers of the groups the default renderer draws; a group without one has none */
export const HEADERS: Partial<Record<GroupKey, string>> = {
	tab: 'Open tabs',
	url: 'Sites',
	page: 'Pages',
	completion: 'Search suggestions',
	jump: 'Jump back in',
	top: 'Top sites',
};
/** what picking a row does, at its right end */
export const HINTS: Partial<Record<string, string>> = {
	tab: 'Switch to tab',
	url: 'Open',
	page: 'Open',
	search: 'Search',
	completion: 'Search',
};

export interface OmniboxOptions {
	input: HTMLInputElement;
	/** emptied and refilled with the headers and rows; empty while closed */
	list: HTMLElement;
	/** the results page, `%s` the query (SearchBuilder's template) */
	search: string;
	/** what the default row opens for the text; SearchBuilder's query of `search` by default */
	toUrl?(text: string): string;
	/** the engine's name in the default row ("Search Brave for ..."); `search`'s engine's by default */
	engineName?: string;
	/** the rows of what the host knows (tabs, history, bookmarks), scored for the text */
	local(text: string): Suggestion[];
	/** the engine's completions (`controller.suggest(text, { engine, signal })`) */
	complete?(text: string, signal: AbortSignal): Promise<string[]>;
	/** rows of the host's from elsewhere, asked like the completions */
	remote?(text: string, signal: AbortSignal): Promise<Suggestion[]>;
	/** the empty box's rows */
	picks?(): PickParts;
	/**
	 * Suggest for what was typed since the focus, not for the text the box
	 * already shows (an address bar showing its page's address)
	 */
	typedOnly?: boolean;
	/** open a row that has a URL and no action of its own */
	navigate(row: Suggestion): void;
	/** draw a row; the default draws an icon, the title, the subtitle and the hint */
	row?(row: Suggestion, text: string): HTMLElement;
	/** draw a group's header; the default draws HEADERS' */
	header?(key: GroupKey): HTMLElement | null;
	/** the class of the default renderer's rows (`omnibox-row`) */
	rowClass?: string;
	/** the list opened or closed */
	toggled?(open: boolean): void;
}

export interface Omnibox {
	/** rank again, after something a source reads has changed */
	refresh(): void;
	/** close the list until the text changes or the input is focused again (the form was submitted) */
	close(): void;
	/** whether the list is open */
	readonly open: boolean;
	destroy(): void;
}

let boxes = 0;

function make(tag: string, className: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/** the completions as rows of the engine's results */
export function completionRows(
	texts: string[],
	toUrl: (text: string) => string,
): Suggestion[] {
	return texts.map((text, i) => ({
		kind: 'completion',
		id: `completion:${text.toLowerCase()}`,
		title: text,
		url: toUrl(text),
		displayUrl: text,
		score: 0.55 - i * 0.02,
		fill: text,
	}));
}

export function attachOmnibox(o: OmniboxOptions): Omnibox {
	const { input, list } = o;
	const builder = new SearchBuilder(o.search);
	const toUrl = o.toUrl ?? ((text: string) => builder.query(text));
	const searchPrefix = o.search.slice(0, o.search.indexOf('%s'));
	const engineName =
		o.engineName ?? searchEngine(o.search)?.name ?? hostOf(searchPrefix);
	const searchText = (text: string) =>
		builder.template.replace('%s', encodeURIComponent(text));
	const listId = list.id || `omnibox-${++boxes}`;
	list.id = listId;
	list.setAttribute('role', 'listbox');
	input.setAttribute('role', 'combobox');
	input.setAttribute('aria-autocomplete', 'list');
	input.setAttribute('aria-controls', listId);
	input.setAttribute('aria-expanded', 'false');
	input.autocomplete = 'off';
	input.spellcheck = false;

	let enabled = false;
	let closed = false;
	let query = '';
	let index = -1;
	let ranked = EMPTY;
	let elements: HTMLElement[] = [];
	let remote: { forQuery: string; rows: Suggestion[] } | null = null;
	let controller: AbortController | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let wasOpen = false;

	const rankOptions = (q: string): RankOptions => {
		const url = toUrl(q);
		return { urlLike: !url.startsWith(searchPrefix), defaultUrl: url };
	};
	const isOpen = () => enabled && !closed && ranked.rows.length > 0;

	const drawRow = (s: Suggestion): HTMLElement => {
		const el = make('div', o.rowClass ?? 'omnibox-row');
		if (typeof s.icon === 'string') {
			const img = document.createElement('img');
			img.className = 'omnibox-icon';
			img.src = s.icon;
			img.alt = '';
			img.addEventListener('error', () => img.remove());
			el.append(img);
		} else if (s.icon) el.append(s.icon);
		const text = make('span', 'omnibox-text');
		if (s.id === 'default' && s.kind === 'search')
			text.append(`Search ${engineName} for "${s.title}"`);
		else if (s.id === 'default') text.append(`Go to ${s.title}`);
		else {
			text.append(s.title);
			if (s.subtitle) text.append(make('span', 'omnibox-sub', s.subtitle));
		}
		el.append(text);
		const hint = HINTS[s.kind];
		if (hint) el.append(make('span', 'omnibox-hint', hint));
		return el;
	};
	const drawHeader = (key: GroupKey): HTMLElement | null => {
		const text = HEADERS[key];
		if (!text) return null;
		const el = make('div', 'omnibox-head', text);
		el.setAttribute('role', 'presentation');
		return el;
	};

	const highlight = () => {
		elements.forEach((el, i) => {
			el.toggleAttribute('data-hover', i === index);
			el.setAttribute('aria-selected', String(i === index));
		});
		if (isOpen() && index >= 0 && elements[index]) {
			input.setAttribute('aria-activedescendant', elements[index].id);
			elements[index].scrollIntoView?.({ block: 'nearest' });
		} else input.removeAttribute('aria-activedescendant');
	};

	const draw = () => {
		const open = isOpen();
		elements = [];
		if (!open) list.replaceChildren();
		else {
			const nodes: HTMLElement[] = [];
			for (const group of ranked.groups) {
				const head = (o.header ?? drawHeader)(group.key);
				if (head) nodes.push(head);
				for (const row of group.rows) {
					const i = elements.length;
					const el = (o.row ?? drawRow)(row, query.trim());
					el.id = `${listId}-${i}`;
					el.setAttribute('role', 'option');
					// the input keeps the focus
					el.addEventListener('mousedown', (event) => event.preventDefault());
					el.addEventListener('mouseenter', () => {
						index = i;
						highlight();
					});
					el.addEventListener('click', () => pick(row));
					elements.push(el);
					nodes.push(el);
				}
			}
			list.replaceChildren(...nodes);
		}
		input.setAttribute('aria-expanded', String(open));
		highlight();
		if (open !== wasOpen) {
			wasOpen = open;
			o.toggled?.(open);
		}
	};

	const rank = () => {
		const q = query.trim();
		if (!enabled) ranked = EMPTY;
		else if (!q) ranked = o.picks ? topPicks(o.picks()) : EMPTY;
		else {
			// the last answer's rows that still fit the text, until the new one
			const typed = fold(q);
			const rows = !remote
				? []
				: remote.forQuery === q
					? remote.rows
					: remote.rows.filter(
							(row) =>
								row.kind === 'completion' && fold(row.title).startsWith(typed),
						);
			ranked = rankAndGroup(q, [...o.local(q), ...rows], rankOptions(q));
		}
		if (index >= ranked.rows.length) index = -1;
		draw();
	};

	const ask = async (q: string, signal: AbortSignal) => {
		const [texts, rows] = await Promise.all([
			o.complete?.(q, signal).catch(() => [] as string[]) ?? [],
			o.remote?.(q, signal).catch(() => [] as Suggestion[]) ?? [],
		]);
		return [...completionRows(texts, searchText), ...rows];
	};

	const fetchRemote = () => {
		controller?.abort();
		controller = null;
		clearTimeout(timer);
		list.removeAttribute('aria-busy');
		const q = query.trim();
		if (
			!enabled ||
			(!o.complete && !o.remote) ||
			q.length < REMOTE_MIN_CHARS ||
			rankOptions(q).urlLike
		)
			return;
		const ac = new AbortController();
		controller = ac;
		timer = setTimeout(() => {
			list.setAttribute('aria-busy', 'true');
			ask(q, ac.signal).then((rows) => {
				// an answer for text that is no longer the box's is dropped
				if (ac.signal.aborted) return;
				controller = null;
				list.removeAttribute('aria-busy');
				remote = { forQuery: q, rows };
				rank();
			});
		}, REMOTE_DELAY_MS);
	};

	/** new text or a new focus: nothing highlighted, the list showing again */
	const setQuery = (text: string) => {
		query = text;
		index = -1;
		closed = false;
		rank();
		fetchRemote();
	};

	function pick(row: Suggestion) {
		closed = true;
		draw();
		if (row.run) row.run();
		else if (row.url) o.navigate(row);
		input.blur();
	}

	const onFocus = () => {
		enabled = true;
		setQuery(o.typedOnly ? '' : input.value);
		// a page that focuses its box when it shows (a new tab's) opens no
		// list: the top picks wait for a click or ArrowDown, as Chrome's do
		if (!query.trim()) {
			closed = true;
			draw();
		}
	};
	/** a click in the box, or ArrowDown, opens a list that was closed */
	const reopen = () => {
		if (!enabled || !closed) return false;
		closed = false;
		rank();
		return true;
	};
	const onClick = () => reopen();
	const onBlur = () => {
		enabled = false;
		controller?.abort();
		controller = null;
		clearTimeout(timer);
		list.removeAttribute('aria-busy');
		rank();
	};
	const onInput = () => setQuery(input.value);
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.isComposing) return;
		const open = isOpen();
		const rows = ranked.rows;
		const row = open && index >= 0 ? rows[index] : undefined;
		if (event.key === 'Enter') {
			// nothing highlighted: the form submits what was typed, as it did
			if (row) {
				event.preventDefault();
				event.stopImmediatePropagation();
				pick(row);
			}
			return;
		}
		if (!open) {
			if (event.key === 'ArrowDown' && reopen()) event.preventDefault();
			return;
		}
		const move =
			event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
		if (move) {
			event.preventDefault();
			// -1 is "nothing": down from it goes to the first row, up to the last
			index =
				index + move < -1
					? rows.length - 1
					: index + move >= rows.length
						? -1
						: index + move;
			highlight();
			return;
		}
		if (event.key === 'Tab' && !event.shiftKey && row) {
			event.preventDefault();
			input.value = row.fill ?? row.url ?? row.title;
			setQuery(input.value);
			return;
		}
		if (event.key === 'Delete' && event.shiftKey && row?.forget) {
			event.preventDefault();
			row.forget();
			const keep = index;
			rank();
			index = Math.min(keep, ranked.rows.length - 1);
			highlight();
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closed = true;
			draw();
		}
	};

	input.addEventListener('focus', onFocus);
	input.addEventListener('blur', onBlur);
	input.addEventListener('input', onInput);
	input.addEventListener('keydown', onKeyDown);
	input.addEventListener('click', onClick);
	if (document.activeElement === input) onFocus();

	return {
		refresh: () => {
			if (enabled) rank();
		},
		close: () => {
			controller?.abort();
			controller = null;
			clearTimeout(timer);
			list.removeAttribute('aria-busy');
			closed = true;
			draw();
		},
		get open() {
			return isOpen();
		},
		destroy: () => {
			onBlur();
			input.removeEventListener('focus', onFocus);
			input.removeEventListener('blur', onBlur);
			input.removeEventListener('input', onInput);
			input.removeEventListener('keydown', onKeyDown);
			input.removeEventListener('click', onClick);
		},
	};
}
