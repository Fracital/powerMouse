// The inject's own writes into Trusted Types sinks (docs/csp.md). Where a
// page's policy requires Trusted Types, the browser refuses a string at
// every sink (an innerHTML, a script's text, eval) and hands it to the
// page's default policy first: the page's rewritten markup, its rewritten
// scripts and the inject's own code would be refused, reported, or shown
// to the page. They carry values of a policy of the inject's own instead,
// made in this realm under a name every list of policy names the browser
// gets allows (src/csp.ts browserPolicy), which no page knows. A trusted
// value of one realm is one in every realm (measured), so one policy does
// for every document this bundle runs in.

/** what of the browser's Trusted Types the inject uses (TypeScript's DOM types have none) */
type TrustedTypePolicy = Record<
	'createHTML' | 'createScript' | 'createScriptURL',
	(value: string) => unknown
>;
interface TrustedTypePolicyFactory {
	createPolicy: Function;
	getAttributeType: Function;
	getPropertyType: Function;
}
const factory = (globalThis as { trustedTypes?: TrustedTypePolicyFactory })
	.trustedTypes;
const createPolicy = factory?.createPolicy;
const policyPrototype = (
	globalThis as { TrustedTypePolicy?: { prototype: TrustedTypePolicy } }
).TrustedTypePolicy?.prototype;
const makers = [
	policyPrototype?.createHTML,
	policyPrototype?.createScript,
	policyPrototype?.createScriptURL,
];
const nativeEval = globalThis.eval;

let name: string | null = null;
let policy: TrustedTypePolicy | null | undefined;

/**
 * Whether a document of this realm's requires Trusted Types of the page's
 * own sinks (scriptFacts.rtt), so the inject judges the page's attribute
 * writes (trustedSink). Separate from `name`: the inject's own policy never
 * activates in stage 2 (its own writes carry no trusted value), but the page's
 * Trusted Types are still enforced against the page's code (src/csp.ts).
 */
let pageSinks = false;
export function usePageSinks(on: boolean) {
	pageSinks = on;
}

/**
 * Note that a document of this realm's has Trusted Types directives, and
 * the name of the inject's policy its browser policies allow (the first
 * one this realm is told of: the policy is made in this realm, whose own
 * document is its first). Returns the name in use.
 */
export function useTrustedTypes(given?: string, made?: unknown): string {
	name ??= given ?? `p${Math.random().toString(36).slice(2, 10)}-t`;
	// (a worker's bootstrap made it, to import the inject: trustedWorker)
	if (
		typeof (made as TrustedTypePolicy | undefined)?.createScript === 'function'
	)
		policy ??= made as TrustedTypePolicy;
	return name;
}

/**
 * What a blob: worker's bootstrap starts with where its document's Trusted
 * Types are in use (the worker inherits its policy): the inject's policy,
 * made under the document's name, for the inject to take with the other
 * facts (`facts`, the statement's object text, named by `key`), and
 * importScripts handed its URLs as trusted values (the bootstrap's import
 * of the inject, and the inject's own)
 */
export function trustedWorker(key: string, facts: string): string {
	return name === null
		? ''
		: `{const p=trustedTypes.createPolicy(${JSON.stringify(name)},{createScript:s=>s,createScriptURL:s=>s,createHTML:s=>s}),i=importScripts;globalThis[${key}]=Object.assign(${facts},{policy:p});importScripts=function(){return i.apply(this,[...arguments].map(u=>p.createScriptURL(u)))}}`;
}

const same = (value: string) => value;

/** `value` as a trusted value of `kind` (0 HTML, 1 script, 2 script URL), or as it is where no document needs one */
function trusted(kind: number, value: string): string {
	if (name === null || !createPolicy) return value;
	if (policy === undefined)
		try {
			policy = Reflect.apply(createPolicy, factory, [
				name,
				{ createHTML: same, createScript: same, createScriptURL: same },
			]) as TrustedTypePolicy;
		} catch (error) {
			policy = null;
		}
	return policy
		? (Reflect.apply(makers[kind]!, policy, [value]) as unknown as string)
		: value;
}

/** `value` as a trusted value of `kind` (TRUSTED_KINDS' index) */
export const trustedOf = (kind: number, value: string) => trusted(kind, value);
export const trustedHTML = (value: string) => trusted(0, value);
export const trustedScript = (value: string) => trusted(1, value);
export const trustedScriptURL = (value: string) => trusted(2, value);

/** whether the inject's writes carry trusted values (a document of this realm's has Trusted Types) */
export const trustedTypesUsed = () => name !== null;

/**
 * A function of `realm` made from `body` with `parameters` where Trusted
 * Types are in use, else null: the Function constructor takes no trusted
 * value (only a default policy lets it through, measured), and eval does
 */
export function trustedFunction(
	realm: typeof globalThis,
	parameters: string[],
	body: string,
): Function | null {
	if (name === null) return null;
	return (realm === globalThis ? nativeEval : realm.eval)(
		trustedScript(`(function(${parameters.join(',')}\n) {\n${body}\n})`),
	) as Function;
}

const attributeType = factory?.getAttributeType;
const propertyType = factory?.getPropertyType;
// (a worker has no elements)
const elementGetter = (key: string) =>
	typeof Element === 'function'
		? Reflect.getOwnPropertyDescriptor(Element.prototype, key)?.get
		: undefined;
const nativeLocalName = elementGetter('localName')!;
const nativeNamespace = elementGetter('namespaceURI')!;
/** the Trusted Types, by kind (0 HTML, 1 script, 2 script URL) */
export const TRUSTED_KINDS = [
	'TrustedHTML',
	'TrustedScript',
	'TrustedScriptURL',
] as const;
export type TrustedKind = (typeof TRUSTED_KINDS)[number];

/**
 * The Trusted Type the browser requires of attribute (or property)
 * `attribute` of `element` (`on*`, a script's src, an iframe's srcdoc), by
 * kind, and Chrome's name of its sink (`Element onclick`, `HTMLScriptElement
 * src`); null for none, or where no document of this realm's has Trusted
 * Types
 */
export function trustedSink(
	element: Element,
	attribute: string,
	property = false,
	namespace: string | null = null,
): [kind: 0 | 1 | 2, sink: string] | null {
	if ((name === null && !pageSinks) || !attributeType || !propertyType)
		return null;
	try {
		const local = Reflect.apply(nativeLocalName, element, []) as string;
		const space = Reflect.apply(nativeNamespace, element, []) as string;
		const kind = (TRUSTED_KINDS as readonly string[]).indexOf(
			Reflect.apply(
				property ? propertyType : attributeType,
				factory,
				property
					? [local, attribute, space]
					: [local, attribute, space, namespace],
			) as string,
		) as -1 | 0 | 1 | 2;
		if (kind === -1) return null;
		const owner =
			kind === 1 && /^on/i.test(attribute)
				? 'Element'
				: `${space.endsWith('svg') ? 'SVG' : 'HTML'}${local === 'iframe' ? 'IFrame' : 'Script'}Element`;
		return [kind, `${owner} ${attribute.replace(/^xlink:/i, '')}`];
	} catch (error) {
		// not an element
		return null;
	}
}

/** `value` of attribute `attribute` of `element` as the browser requires it of the inject's writes (trustedSink) */
export function trustedAttribute(
	element: Element,
	attribute: string,
	value: string,
	namespace: string | null = null,
	property = false,
): string {
	const sink = trustedSink(element, attribute, property, namespace);
	return sink ? trusted(sink[0], value) : value;
}

/** scripts the inject writes markup from (a style's stand-in): their outerHTML is the inject's write */
export const ownScripts = new WeakSet<object>();

/** the element whose attributes the inject copies from the browser's parse of the page's markup (asParsed) */
let parsed: object | null = null;
/**
 * Run `copy`, which sets the attributes of `element` that the browser
 * parsed from the page's markup (cloneRawNode): the parser's, which no
 * Trusted Types judge (trustedSink's callers ask isParsed)
 */
export function asParsed<T>(element: object, copy: () => T): T {
	const was = parsed;
	parsed = element;
	try {
		return copy();
	} finally {
		parsed = was;
	}
}
export const isParsed = (element: unknown) => element === parsed;
