import type DocumentClient from './Client';
import { deferred } from './deferred';
import type { DeferredParts } from './deferredParts';

/**
 * An xml-stylesheet processing instruction that is a child of a document
 * loads its href as a stylesheet (an XSLT in an XML document), in HTML and
 * XML documents alike, and loads it again whenever its data changes: the
 * href would go out as the page wrote it, past the worker (an absolute
 * one) or to a route of nothing (a relative one against the routed URL).
 * Such a PI's real data carries the routed href from the moment it lands
 * in a document or is edited there; everything the page reads (`data`,
 * `nodeValue`, `textContent`, its pseudo-attributes, serialized markup)
 * is the data it wrote. Every edit is made on a detached copy holding the
 * page's data, so its result and its errors are the browser's own.
 *
 * The hooks are the style text hooks' (DOMContentHooks, DOMHooks,
 * CSSReadback), which hand a PI here; what routes and reads it back is a
 * deferred part (./instructions.ts) made at the first stylesheet PI a
 * document meets. A frame pays a few functions for this and never reads
 * the ProcessingInstruction interface (one read makes it in every frame):
 * a PI's nodeName is its target.
 */

type Method = (this: unknown, ...args: unknown[]) => unknown;

// the browser's own, taken as the bundle runs (before any hook or page
// script); a DOM accessor of this realm reads a node of any
const accessor = (object: object, name: string) =>
	Reflect.getOwnPropertyDescriptor(object, name)!;
const data = accessor(CharacterData.prototype, 'data');
const nodeTypeGet = accessor(Node.prototype, 'nodeType').get as Method;
const nodeNameGet = accessor(Node.prototype, 'nodeName').get as Method;
const natives = {
	getData: data.get as Method,
	setData: data.set as Method,
	nodeTypeGet,
	parentGet: accessor(Node.prototype, 'parentNode').get as Method,
	childNodesGet: accessor(Node.prototype, 'childNodes').get as Method,
	createPI: Document.prototype.createProcessingInstruction as Method,
};
export type InstructionNatives = typeof natives;

const typeOf = (node: unknown): number | null => {
	if (typeof node !== 'object' || node === null) return null;
	try {
		return Reflect.apply(nodeTypeGet, node, []) as number;
	} catch (error) {
		return null;
	}
};

/** whether `node` is an xml-stylesheet PI, whose edits are made here */
export const isStylesheetPI = (node: unknown): node is ProcessingInstruction =>
	typeOf(node) === 7 &&
	Reflect.apply(nodeNameGet, node, []) === 'xml-stylesheet';

const cores = new WeakMap<
	DocumentClient,
	ReturnType<DeferredParts['instructionData']>
>();
/**
 * What routes and reads back `client`'s stylesheet PIs, made the first time
 * one is met (with the natives taken at boot)
 */
export function stylesheetPIs(client: DocumentClient) {
	let core = cores.get(client);
	if (!core)
		cores.set(client, (core = deferred().instructionData(client, natives)));
	return core;
}

/** `node` about to land in a document: an xml-stylesheet PI in it is routed */
export function landStylesheetPIs(client: DocumentClient, node: unknown) {
	const type = typeOf(node);
	// routed as it lands: its parent is the document only after
	if (type === 7) {
		if (!isStylesheetPI(node)) return;
		const core = stylesheetPIs(client);
		core.settle(node, core.pageOf(node), true);
	} else if (type === 11)
		for (const child of [
			...(Reflect.apply(natives.childNodesGet, node, []) as NodeListOf<Node>),
		])
			landStylesheetPIs(client, child);
}
