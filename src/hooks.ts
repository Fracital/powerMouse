/**
 * Host code run inside every proxied realm (scramjet's `Frame.hooks.init`):
 * `pre` before the inject installs its hooks, `post` after, before the
 * page's first script. These are scripts that travel, not closures: a realm
 * on the proxy origin cannot reach the host's objects, so the host hands
 * over source text (or a URL the controller fetches once at construction,
 * whose text then travels), the config carries it to the worker, every
 * shell and worker preamble, and on to about:blank children, popups and
 * srcdoc frames. The code is trusted host code: it runs raw, with the
 * realm's real globals (the real `top` in same-origin mode), and what it
 * leaves on the window is reachable by the page.
 */

/** host code for one phase: the text itself, or a URL fetched once at construction */
export type HookScript = { source: string } | { url: string };

/** `init.hooks` on both controllers */
export interface InitHooks {
	init?: {
		/** runs before the inject installs its hooks: natives to capture, prototypes untouched */
		pre?: HookScript;
		/** runs after the inject installed its hooks, before the page's first script */
		post?: HookScript;
	};
	/** also run in dedicated and shared workers (default false: documents only) */
	workers?: boolean;
}

/** what travels in the config: the text of each phase */
export interface ResolvedHooks {
	pre?: string;
	post?: string;
	workers?: boolean;
}

export type HookPhase = 'pre' | 'post';

/** the argument a hook function receives */
export interface HookContext {
	/** the page's real URL */
	url: string;
	/** the page's real origin */
	origin: string;
	/** the outermost proxied document */
	isTop: boolean;
	/** a child of a proxied page (a nested frame, an about:blank child, a srcdoc frame) */
	nested: boolean;
	kind: 'document' | 'worker' | 'sharedWorker';
	phase: HookPhase;
	/** the deployment's helper names (the access API is `window[names.access]`) */
	names: {
		access: string;
		client: string;
		globalProxy: string;
		globalName: string;
	};
	/** the controller's id (`controller.id`), so a hook can tag what it posts to the host */
	frameId?: string;
	/** the realm's real global */
	window: typeof globalThis;
}

/** a hook that threw, or a hook URL that could not be fetched (`phase: 'url'`) */
export interface HookErrorInfo {
	phase: HookPhase | 'url';
	kind?: HookContext['kind'];
	/** the page's URL, or the hook URL for a fetch failure */
	url: string;
	message: string;
	stack?: string;
}

function isScript(value: unknown): value is HookScript {
	if (typeof value !== 'object' || value === null) return false;
	const { source, url } = value as { source?: unknown; url?: unknown };
	return (
		(typeof source === 'string' && url === undefined) ||
		(typeof url === 'string' && source === undefined)
	);
}

/** throws a TypeError when `hooks` is not an InitHooks */
export function validateHooks(hooks: unknown): void {
	if (hooks === undefined) return;
	if (typeof hooks !== 'object' || hooks === null)
		throw new TypeError('Stomp hooks must be an object');
	const { init, workers, ...rest } = hooks as InitHooks &
		Record<string, unknown>;
	for (const key of Object.keys(rest))
		throw new TypeError(`Stomp hooks: ${key} is not a hook`);
	if (workers !== undefined && typeof workers !== 'boolean')
		throw new TypeError('Stomp hooks.workers must be a boolean');
	if (init === undefined) return;
	if (typeof init !== 'object' || init === null)
		throw new TypeError('Stomp hooks.init must be an object');
	for (const key of Object.keys(init))
		if (key !== 'pre' && key !== 'post')
			throw new TypeError(`Stomp hooks.init: ${key} is not a phase`);
	for (const phase of ['pre', 'post'] as const) {
		const script = init[phase];
		if (script !== undefined && !isScript(script))
			throw new TypeError(
				`Stomp hooks.init.${phase} must be { source } or { url }`,
			);
	}
}

/**
 * The text of each phase: a URL is fetched once, here, so a redeploy of the
 * hook file needs a controller restart. A fetch that fails leaves the phase
 * out and reports it (the controller dispatches `hookerror`); the controller
 * boots without the hook rather than not at all.
 */
export async function resolveHooks(
	hooks: InitHooks | undefined,
	base: string,
): Promise<{ hooks: ResolvedHooks | undefined; errors: HookErrorInfo[] }> {
	if (!hooks) return { hooks: undefined, errors: [] };
	const resolved: ResolvedHooks = {};
	const errors: HookErrorInfo[] = [];
	if (hooks.workers) resolved.workers = true;
	for (const phase of ['pre', 'post'] as const) {
		const script = hooks.init?.[phase];
		if (!script) continue;
		if ('source' in script) {
			resolved[phase] = script.source;
			continue;
		}
		const url = new URL(script.url, base).href;
		try {
			const response = await fetch(url, { cache: 'no-store' });
			if (!response.ok)
				throw new Error(`${response.status} ${response.statusText}`.trim());
			resolved[phase] = await response.text();
		} catch (error) {
			errors.push({
				phase: 'url',
				url,
				message: `Stomp hooks.init.${phase}: ${url} could not be fetched: ${
					error instanceof Error ? error.message : String(error)
				}`,
			});
		}
	}
	return {
		hooks: resolved.pre || resolved.post ? resolved : undefined,
		errors,
	};
}
