// The document inject's rewriter library (src/rewriterLight.ts): the wasm
// glue for scripts, with the scanner for stylesheets and the suffix lookup
// for hosts. A proxied top's copy is handed the controller's module (adopt);
// a call made before it has arrived stops for it (rewriterLight's `needs`).
import { LAZY_CONTEXTS, MAY_ROUTE } from './cssURL';
import { library, run, stopped } from './rewriterLight';
import { linkInWasm } from './wasm/rewriter';
import { rewriteStyles } from './wasm/scanner';
import { domainOf, publicSuffixOf, suffixListPin } from './wasm/suffix';

/** the stylesheets and style attributes this copy rewrote in the scanner */
const styles = { wasm: 0 };

export const api = {
	...library({
		modifyCSS: (text, url, context = 'stylesheet') => {
			// a context the scanner does not rewrite is left as written
			if (!LAZY_CONTEXTS.includes(context)) return undefined;
			// as modifyCSS itself: nothing in it to route
			if (!MAY_ROUTE.test(text)) return text;
			const output = rewriteStyles(text, url, context);
			// no module in this realm yet: the call stops for one (`needs`)
			if (output === null) return undefined;
			styles.wasm++;
			return output;
		},
		// with the list's private section, where Chrome ends a site
		getDomain: (host) => domainOf(host, true),
		getPublicSuffix: (host) => publicSuffixOf(host, true),
		suffixList: () => {
			const pin = suffixListPin();
			return pin ? `${pin.commit} ${pin.date}` : '';
		},
	}),
	/**
	 * The modules of an import cycle, apart by NUL, merged into one
	 * (rust/rwjs/src/link.rs): the merged module and each one's facade,
	 * apart by NUL, or null when they do not link (a document no service
	 * worker controls, src/inject/dom/moduleGraph.ts; a worker has none)
	 */
	link(modules: string): string | null {
		return run(() => {
			const answered = linkInWasm(`${modules}`);
			if (!answered) stopped();
			return answered?.linked ?? null;
		}, null);
	},
	/** how many of this copy's CSS rewrites the scanner made (css suites) */
	styleRewrites(): string {
		return `${styles.wasm} 0`;
	},
};
