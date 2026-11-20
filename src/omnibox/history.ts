/**
 * A history of the pages a host's tabs reached (after SystemYA
 * src/systemya/omni/history.ts and Fracital's src/libs/browsingHistory.ts),
 * kept only in the browser's localStorage under `key` and never sent
 * anywhere. The newest `cap` visits are kept, newest first.
 *
 * A tab reports where it is again and again (on load, while its page is on
 * show), and its title comes after its address, so a report of the address
 * the tab's last visit already has updates that visit instead of adding one.
 */
import { canonicalUrl, type HistoryEntry } from './rank';
import { safeIcon } from './sources';

export interface Visit extends HistoryEntry {
	id: string;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface HistoryOptions {
	/** the storage key; `omnibox:visits` by default */
	key?: string;
	/** the most visits kept (5000, Fracital's cap for a history kept only in the browser) */
	cap?: number;
	/** where it is kept; the page's localStorage by default */
	store?: Store | null;
}

export interface VisitHistory {
	/** the visits, newest first; parsed again only when the stored copy changed */
	visits(): Visit[];
	/** `tab` (any key) is on `entry.url`; only web pages count */
	record(
		tab: unknown,
		entry: { url: string; title?: string; icon?: unknown },
		now?: number,
	): void;
	/** forget every visit of the page `url` is */
	forget(url: string): void;
	/** forget every visit */
	clear(): void;
}

const isVisit = (v: unknown): v is Visit =>
	!!v &&
	typeof (v as Visit).id === 'string' &&
	typeof (v as Visit).url === 'string' &&
	typeof (v as Visit).title === 'string' &&
	typeof (v as Visit).at === 'number';

let counter = 0;
const newId = (now: number) =>
	`${now.toString(36)}${(++counter).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function visitHistory(options: HistoryOptions = {}): VisitHistory {
	const key = options.key ?? 'omnibox:visits';
	const cap = options.cap ?? 5000;
	const store = (): Store | null => {
		if (options.store !== undefined) return options.store;
		try {
			return globalThis.localStorage ?? null;
		} catch {
			return null;
		}
	};
	let cached: { raw: string | null; visits: Visit[] } = {
		raw: null,
		visits: [],
	};
	/** each tab's latest visit, so a report of the same address (with its title) lands on it */
	const lastByTab = new Map<unknown, string>();

	const visits = (): Visit[] => {
		let raw: string | null = null;
		try {
			raw = store()?.getItem(key) ?? null;
		} catch {
			// storage the page may not read: no history
		}
		if (raw === cached.raw) return cached.visits;
		let list: Visit[] = [];
		try {
			const saved: unknown = JSON.parse(raw ?? '[]');
			if (Array.isArray(saved)) list = saved.filter(isVisit);
		} catch {
			// a stored copy that is no list of visits reads as none
		}
		cached = { raw, visits: list };
		return list;
	};
	const save = (list: Visit[]) => {
		try {
			const raw = JSON.stringify(list);
			store()?.setItem(key, raw);
			cached = { raw, visits: list };
		} catch {
			// storage full or unavailable: this visit is not kept
		}
	};

	return {
		visits,
		record(tab, entry, now = Date.now()) {
			if (!/^https?:\/\//i.test(entry.url)) return;
			const title = entry.title?.trim() ?? '';
			const icon = safeIcon(entry.icon);
			const list = visits();
			const lastId = lastByTab.get(tab);
			const last = lastId ? list.find((v) => v.id === lastId) : undefined;
			if (last && last.url === entry.url) {
				if ((!title || title === last.title) && (!icon || icon === last.icon))
					return;
				save(
					list.map((v) =>
						v.id === last.id
							? { ...v, title: title || v.title, ...(icon && { icon }) }
							: v,
					),
				);
				return;
			}
			const visit: Visit = {
				id: newId(now),
				url: entry.url,
				title,
				...(icon && { icon }),
				at: now,
			};
			lastByTab.set(tab, visit.id);
			save([visit, ...list].slice(0, cap));
		},
		forget(url) {
			const page = canonicalUrl(url);
			save(visits().filter((v) => canonicalUrl(v.url) !== page));
		},
		clear() {
			lastByTab.clear();
			try {
				store()?.removeItem(key);
			} catch {
				// nothing kept to remove
			}
			cached = { raw: null, visits: [] };
		},
	};
}
