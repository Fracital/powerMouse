import type { RequestRule, RequestRuleAction } from '../transport/messages';

export interface CompiledRule {
	/** the rule's index in the host's list, reported through onRequest */
	index: number;
	action: 'block' | RequestRuleAction;
	matches(url: URL, method: string, destination: string, site: string): boolean;
}

interface URLPatternLike {
	test(input: string): boolean;
}

/**
 * Compile the host's rules once. URLPattern is Chrome-only today: when the
 * constructor is missing or a pattern is invalid, that rule is skipped with
 * one warning naming it, the rest apply.
 */
export function compileRules(rules: RequestRule[]): CompiledRule[] {
	const compiled: CompiledRule[] = [];
	const Pattern = (globalThis as Record<string, unknown>).URLPattern as
		(new (input: string) => URLPatternLike) | undefined;
	for (const [index, rule] of rules.entries()) {
		let pattern: URLPatternLike | null = null;
		if (rule.match.url !== undefined) {
			try {
				if (typeof Pattern !== 'function')
					throw new Error('URLPattern is not available in this browser');
				pattern = new Pattern(rule.match.url);
			} catch (error) {
				console.warn(
					`Stomp: request rule skipped, its url pattern ${JSON.stringify(rule.match.url)} cannot be compiled: ${String(error)}`,
				);
				continue;
			}
		}
		const methods = rule.match.method?.map((method) => method.toUpperCase());
		const destinations = rule.match.destination;
		const sites = rule.match.site as string[] | undefined;
		compiled.push({
			index,
			action: rule.action,
			matches: (url, method, destination, site) =>
				(pattern === null || pattern.test(url.href)) &&
				(methods === undefined || methods.includes(method.toUpperCase())) &&
				(destinations === undefined || destinations.includes(destination)) &&
				(sites === undefined || sites.includes(site)),
		});
	}
	return compiled;
}

/** set and delete headers as an action says */
export function applyHeaderRule(
	headers: Headers,
	changes: Record<string, string | null> | undefined,
) {
	if (!changes) return;
	for (const [name, value] of Object.entries(changes))
		if (value === null) headers.delete(name);
		else headers.set(name, value);
}
