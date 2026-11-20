// chrome.declarativeNetRequest on STomp's service worker
// (docs/extensions-dnr.md). Two ways in:
//
//   compile(rulesets) => CompiledRules, then match(request, compiled) =>
//   DnrAction[]: one extension's rules, the decision for one request before
//   it goes out (and, with `responseHeaders`, after its headers come in);
//
//   DnrEngine: every extension of a profile, Chrome's API surface over them,
//   and the request path's stages (beforeRequest, beforeSendHeaders,
//   headersReceived, onNavigationCommitted) the service worker calls.

import type { HeaderLines } from './actions';
import { compileStatic } from './compile';
import {
	DnrEngine,
	type ExtensionInfo,
	type StaticRulesetInfo,
} from './engine';
import type { DnrAction, DnrRequest, Rule } from './types';

export * from './types';
export { DnrEngine } from './engine';
export type {
	CommitInfo,
	DnrOutcome,
	DnrRequestState,
	EngineHooks,
	ExtensionInfo,
	ExtensionPermissions,
	ExtensionState,
	StaticRulesetInfo,
	TestMatchRequestDetails,
} from './engine';
export { compileStatic, compileUpdate, STATIC_RULESET_LIMIT } from './compile';
export type { CompiledRuleset, StaticCompileResult } from './compile';
export { applyRequestHeaders, applyResponseHeaders } from './actions';
export type { HeaderList, HeaderLines, HeaderOps } from './actions';
export type { PageAccess } from './match';
export type {
	MatchedRuleInfo,
	MatchedRuleInfoDebug,
	RequestDetails,
} from './tracker';
export { compileRE2 } from './re2';

export interface RulesetSource {
	/** the manifest's id */
	id: string;
	/** enabled by default; true when absent */
	enabled?: boolean;
	/** the parsed JSON of the ruleset's file */
	rules: unknown;
	/** the file name its warnings name (rules.json) */
	path?: string;
}

export interface CompiledRules {
	extensionId: string;
	rulesets: StaticRulesetInfo[];
	dynamic?: Rule[];
	session?: Rule[];
	/** install warnings, as Chrome words them */
	warnings: string[];
	/** the install error, when a ruleset fails it */
	error?: string;
}

export interface CompileOptions {
	extensionId?: string;
	extensionBase?: string;
	/** updateDynamicRules' rules */
	dynamic?: Rule[];
	/** updateSessionRules' rules */
	session?: Rule[];
}

/** one extension's static rulesets (and optionally its dynamic and session rules), compiled as Chrome installs them */
export function compile(
	rulesets: RulesetSource[],
	options: CompileOptions = {},
): CompiledRules {
	const extensionId = options.extensionId ?? 'extension';
	const extensionBase =
		options.extensionBase ?? `chrome-extension://${extensionId}/`;
	const out: CompiledRules = { extensionId, rulesets: [], warnings: [] };
	rulesets.forEach((source, index) => {
		const result = compileStatic(source.rules, {
			extensionBase,
			path: source.path ?? `${source.id}.json`,
			rulesetId: index + 1,
		});
		out.warnings.push(...result.warnings);
		if (result.error && !out.error) out.error = result.error;
		out.rulesets.push({
			id: source.id,
			enabled: source.enabled ?? true,
			ruleset: result.ruleset,
		});
	});
	if (options.dynamic) out.dynamic = options.dynamic;
	if (options.session) out.session = options.session;
	return out;
}

const engines = new WeakMap<CompiledRules, DnrEngine>();

function engineFor(compiled: CompiledRules): DnrEngine {
	let engine = engines.get(compiled);
	if (engine) return engine;
	engine = new DnrEngine();
	const info: ExtensionInfo = {
		id: compiled.extensionId,
		staticRulesets: compiled.rulesets,
		permissions: {
			declarativeNetRequest: true,
			declarativeNetRequestFeedback: true,
		},
		state: compiled.dynamic ? { dynamicRules: compiled.dynamic } : undefined,
	};
	engine.install(info);
	if (compiled.session)
		void engine.updateSessionRules(compiled.extensionId, {
			addRules: compiled.session,
		});
	engines.set(compiled, engine);
	return engine;
}

/**
 * The actions Chrome takes on `request` with `compiled`'s rules: one block,
 * collapse, redirect, upgradeScheme or allow, or the modifyHeaders ones,
 * highest first; none for no match. With `responseHeaders`, the
 * headersReceived stage runs too, as testMatchOutcome runs it
 */
export function match(
	request: DnrRequest & { responseHeaders?: HeaderLines },
	compiled: CompiledRules,
): DnrAction[] {
	const engine = engineFor(compiled);
	const { state, outcome } = engine.beforeRequest(request);
	if (outcome.type !== 'none' || !request.responseHeaders) return state.actions;
	const after = engine.headersReceived(state, request.responseHeaders);
	return after.outcome.action ? [after.outcome.action] : state.actions;
}
