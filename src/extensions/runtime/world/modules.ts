// An isolated world's modules (docs/extensions.md "Isolated worlds"): a
// content script's `import()` loads the extension's module in the world,
// with the world's `chrome` and globals, as Chrome evaluates it in the
// isolated world (LanguageTool's content script loads its content.js so).
// The world's realm has no module loader of its own (its frame is gone), so
// the worker hands each module as a description (src/server/extensions/
// worldSource.ts worldModule): its static imports, the bindings it imports
// and re-exports, and its body as an async generator that defines its
// exports and stops, then runs. Links are live: an import reads the
// exporting module's binding through its namespace each time.
import { displayExtensionURL, extensionOfURL } from '../../origin';
import { CONTENT_SCRIPT_ROUTE } from '../../types';
import { natives } from '../natives';

/** what the worker's description of a module is, once evaluated */
interface Description {
	/** the specifiers of its static imports, in order */
	i: string[];
	/** its imported bindings: [import, name or '*', local name] */
	b: [number, string, string][];
	/** its re-exports: [import, name or '*', exported name, or null for `export *`] */
	r: [number, string, string | null][];
	/** its body, as a function of the world's globals */
	f: (...args: unknown[]) => () => AsyncGenerator<unknown, unknown, unknown>;
}

interface ModuleRecord {
	url: string;
	namespace: Record<PropertyKey, unknown>;
	description: Description | null;
	imports: ModuleRecord[];
	linked: boolean;
	body: AsyncGenerator<unknown, unknown, unknown> | null;
	evaluated: Promise<void> | null;
	ready: Promise<ModuleRecord>;
}

/** the world's globals a module's body is a function of (./index.ts globalsOf) */
export type Globals = (url: string) => unknown[];

const { defineProperty, ownKeys, get } = Reflect;
const objectCreate = Object.create;

export class ModuleLoader {
	readonly #records = new Map<string, ModuleRecord>();

	constructor(
		readonly id: string,
		readonly generation: number,
		/** the controller's address */
		readonly channel: string,
		/** the world's globals for code at `url`, then its import(), as modules take them */
		readonly globals: Globals,
		/** evaluate a description's text in the world's realm */
		readonly evaluate: (text: string) => unknown,
	) {}

	/** the URL a specifier names, from `base` */
	resolve(specifier: string, base: string): string {
		// (one record per file, as Chrome names it: chrome-extension://)
		return displayExtensionURL(new natives.URL(String(specifier), base).href);
	}

	/** `import(specifier)` of code at `base` */
	import(specifier: unknown, base: string): Promise<unknown> {
		return (async () => {
			const url = this.resolve(String(specifier), base);
			const record = await this.#load(url);
			await this.#link(record, new Set());
			await this.#evaluate(record, new Set());
			return record.namespace;
		})();
	}

	/** import.meta of a module */
	meta(url: string): Record<string, unknown> {
		const meta = objectCreate(null) as Record<string, unknown>;
		meta.url = url;
		meta.resolve = (specifier: unknown) => this.resolve(String(specifier), url);
		return meta;
	}

	#route(url: string): string | null {
		if (extensionOfURL(url) !== this.id) return null;
		const parsed = new natives.URL(url);
		// (the worker judges web_accessible_resources by the requesting
		// document's origin, which it knows by the request's client)
		return `${this.channel}${CONTENT_SCRIPT_ROUTE}/${this.id}/${this.generation}/m${parsed.pathname}`;
	}

	#load(url: string): Promise<ModuleRecord> {
		const known = this.#records.get(url);
		if (known) return known.ready;
		const namespace = objectCreate(null) as Record<PropertyKey, unknown>;
		defineProperty(namespace, Symbol.toStringTag, { value: 'Module' });
		const record: ModuleRecord = {
			url,
			namespace,
			description: null,
			imports: [],
			linked: false,
			body: null,
			evaluated: null,
			ready: null as unknown as Promise<ModuleRecord>,
		};
		record.ready = (async () => {
			const route = this.#route(url);
			const response = route ? await natives.fetch(route) : null;
			if (!response || !response.ok)
				throw new natives.TypeError(
					`Failed to fetch dynamically imported module: ${url}`,
				);
			const description = this.evaluate(await response.text()) as Description;
			record.description = description;
			record.imports = await natives.Promise.all(
				description.i.map((specifier) =>
					this.#load(this.resolve(specifier, url)),
				),
			);
			return record;
		})();
		this.#records.set(url, record);
		return record.ready;
	}

	/** make a module's namespace and run its body to where its exports are defined */
	async #link(record: ModuleRecord, visiting: Set<ModuleRecord>) {
		if (record.linked || visiting.has(record)) return;
		visiting.add(record);
		for (const dependency of record.imports) {
			await dependency.ready;
			await this.#link(dependency, visiting);
		}
		const description = record.description!;
		const scope = objectCreate(null) as Record<string, unknown>;
		for (const [at, name, local] of description.b) {
			const from = record.imports[at];
			defineProperty(scope, local, {
				get: () => (name === '*' ? from.namespace : from.namespace[name]),
				enumerable: true,
			});
		}
		const namespace = record.namespace;
		const define = (name: string, read: () => unknown) => {
			if (Object.prototype.hasOwnProperty.call(namespace, name)) return;
			defineProperty(namespace, name, { get: read, enumerable: true });
		};
		for (const [at, name, exported] of description.r) {
			const from = record.imports[at];
			if (exported === null) {
				for (const key of ownKeys(from.namespace))
					if (typeof key === 'string' && key !== 'default')
						define(key, () => from.namespace[key]);
			} else
				define(exported, () =>
					name === '*' ? from.namespace : get(from.namespace, name),
				);
		}
		const exports = (getters: Record<string, () => unknown>) => {
			for (const name of ownKeys(getters))
				if (typeof name === 'string') define(name, getters[name]);
		};
		const body = description.f(
			...this.globals(record.url),
			this.meta(record.url),
			exports,
			scope,
		)();
		record.body = body;
		// (to its first `yield`: the exports are defined, nothing else ran)
		await body.next();
		record.linked = true;
	}

	/** run a module's body after its imports' (one of a cycle that is under way is not waited for) */
	#evaluate(record: ModuleRecord, stack: Set<ModuleRecord>): Promise<void> {
		if (stack.has(record)) return natives.Promise.resolve();
		if (record.evaluated) return record.evaluated;
		const inner = new Set(stack).add(record);
		record.evaluated = (async () => {
			for (const dependency of record.imports)
				await this.#evaluate(dependency, inner);
			await record.body!.next();
		})();
		return record.evaluated;
	}
}
