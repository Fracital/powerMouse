// Rulesets compiled as Chrome indexes them: a static ruleset at install
// (file_backed_ruleset_source.cc ParseRulesFromJSON, ruleset_source.cc
// IndexRules: rules that are not Rules are install warnings, invalid ones
// fail the install, a regex over the memory limit is a warning), and the
// dynamic and session rules on each update (rules_monitor_service.cc,
// file_sequence_helper.cc GetNewDynamicRules: removals first, then
// additions, then the limits; an invalid rule is the call's error).

import { LIMIT_MESSAGES, parseErrorMessage } from './errors';
import {
	indexRule,
	isSafeAction,
	type IndexContext,
	type IndexedRule,
} from './indexRule';
import {
	GUARANTEED_MINIMUM_STATIC_RULES,
	MAX_NUMBER_OF_REGEX_RULES,
	MAX_STATIC_RULES_PER_PROFILE,
	type Rule,
} from './types';

/** a ruleset ready for the matcher: plain data, stored and sent as is */
export interface CompiledRuleset {
	format: 1;
	rules: IndexedRule[];
	ruleCount: number;
	regexCount: number;
	unsafeCount: number;
}

export interface StaticCompileResult {
	/** null when the ruleset fails the install */
	ruleset: CompiledRuleset | null;
	/** install warnings, as Chrome words them (the file name first) */
	warnings: string[];
	/** the install error, when there is one */
	error?: string;
	/** a ruleset over the indexing limit is ignored, not an error */
	ignored?: boolean;
}

const finish = (rules: IndexedRule[]): CompiledRuleset => ({
	format: 1,
	rules,
	ruleCount: rules.length,
	regexCount: rules.filter((rule) => rule.regex !== undefined).length,
	unsafeCount: rules.filter((rule) => !isSafeAction(rule.action)).length,
});

const isRuleShape = (value: unknown): value is Rule => {
	// Rule::FromValue: the schema check is part of indexRule, which tells the
	// two failures apart by its ERROR_SCHEMA
	return typeof value === 'object' && value !== null;
};

/** the static ruleset limit: no ruleset bigger can ever be enabled whole */
export const STATIC_RULESET_LIMIT =
	GUARANTEED_MINIMUM_STATIC_RULES + MAX_STATIC_RULES_PER_PROFILE;

/**
 * Compile one static ruleset of a manifest's rule_resources at install
 * (the extension's install fails on `error`)
 */
export function compileStatic(
	json: unknown,
	options: IndexContext & { path: string; rulesetId?: number },
): StaticCompileResult {
	const file = options.path.split('/').pop() || options.path;
	const prefix = (message: string) => `${file}: ${message}`;
	if (!Array.isArray(json))
		return {
			ruleset: null,
			warnings: [],
			error: prefix(LIMIT_MESSAGES.listNotPassed),
		};
	if (json.length > STATIC_RULESET_LIMIT)
		return {
			ruleset: null,
			warnings: [
				prefix(
					LIMIT_MESSAGES.indexingRuleLimit(String(options.rulesetId ?? 1)),
				),
			],
			ignored: true,
		};
	const warnings: string[] = [];
	const rules: IndexedRule[] = [];
	const ids = new Set<number>();
	let regexCount = 0;
	let regexWarned = false;
	let parsed = 0;
	const ignored: string[] = [];
	for (let i = 0; i < json.length; i++) {
		const value = json[i];
		const result = indexRule(value, { ...options, session: false });
		if (!result.ok && result.error === 'ERROR_SCHEMA') {
			const id =
				isRuleShape(value) && Number.isInteger((value as { id?: unknown }).id)
					? `id ${(value as { id: number }).id}`
					: `index ${i + 1}`;
			warnings.push(
				prefix(
					LIMIT_MESSAGES.ruleNotParsed(id, result.detail ?? 'invalid rule'),
				),
			);
			continue;
		}
		// the rule parsed: the count limits apply before indexing
		if (parsed === STATIC_RULESET_LIMIT) {
			warnings.push(prefix(LIMIT_MESSAGES.ruleCountExceeded));
			break;
		}
		const rule = value as Rule;
		if (
			rule.condition?.regexFilter !== undefined &&
			++regexCount > MAX_NUMBER_OF_REGEX_RULES
		) {
			if (!regexWarned) {
				regexWarned = true;
				warnings.push(prefix(LIMIT_MESSAGES.regexRuleCountExceeded));
			}
			continue;
		}
		parsed++;
		if (ids.has(rule.id))
			return {
				ruleset: null,
				warnings,
				error: prefix(parseErrorMessage('ERROR_DUPLICATE_IDS', rule.id)),
			};
		ids.add(rule.id);
		if (!result.ok) {
			if (result.error === 'ERROR_REGEX_TOO_LARGE') {
				ignored.push(prefix(parseErrorMessage(result.error, rule.id)));
				continue;
			}
			return {
				ruleset: null,
				warnings,
				error: prefix(parseErrorMessage(result.error, rule.id, result.detail)),
			};
		}
		rules.push(result.rule);
	}
	warnings.push(...ignored);
	// kMaxUnparsedRulesWarnings
	if (warnings.length > 5) {
		warnings.length = 5;
		warnings.push(prefix(LIMIT_MESSAGES.tooManyParseFailures(5)));
	}
	return { ruleset: finish(rules), warnings };
}

export interface DynamicCompileResult {
	ruleset?: CompiledRuleset;
	/** the rules as the extension gave them, for getDynamicRules / getSessionRules */
	source?: Rule[];
	error?: string;
}

export interface DynamicLimits {
	rules: number;
	unsafe: number;
	/** the regex rules this kind may hold: 1000 less the other kind's */
	regex: number;
	messages: { rules: string; unsafe: string; regex: string };
}

/**
 * GetNewDynamicRules and IndexRules for an update of the dynamic or the
 * session rules: `current` less `removeRuleIds`, plus `addRules`
 */
export function compileUpdate(
	current: Rule[],
	removeRuleIds: number[] | undefined,
	addRules: unknown[] | undefined,
	limits: DynamicLimits,
	context: IndexContext & {
		/** session rules refuse every regex over the memory limit, dynamic ones only new ones */
		session?: boolean;
	},
): DynamicCompileResult {
	const remove = new Set(removeRuleIds ?? []);
	const kept = current.filter((rule) => !remove.has(rule.id));
	const added = (addRules ?? []) as Rule[];
	const next = [...kept, ...added];
	// the limits, on the rules as given (IsRuleSafe reads the action type)
	if (next.length > limits.rules) return { error: limits.messages.rules };
	const unsafe = next.filter(
		(rule) => !isSafeAction(rule?.action?.type),
	).length;
	if (unsafe > limits.unsafe) return { error: limits.messages.unsafe };
	const regex = next.filter(
		(rule) => rule?.condition?.regexFilter !== undefined,
	).length;
	if (regex > limits.regex) return { error: limits.messages.regex };
	const addedIds = new Set(added.map((rule) => rule?.id));
	const ids = new Set<number>();
	const rules: IndexedRule[] = [];
	for (const rule of next) {
		const result = indexRule(rule, context);
		const id = (rule as { id?: number })?.id ?? 0;
		if (ids.has(id))
			return { error: parseErrorMessage('ERROR_DUPLICATE_IDS', id) };
		ids.add(id);
		if (!result.ok) {
			if (
				result.error === 'ERROR_REGEX_TOO_LARGE' &&
				!context.session &&
				!addedIds.has(id)
			)
				// a rule added before that no longer fits is dropped silently
				continue;
			return { error: parseErrorMessage(result.error, id, result.detail) };
		}
		rules.push(result.rule);
	}
	return { ruleset: finish(rules), source: structuredClone(next) };
}
