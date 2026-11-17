// NamedNodeMap's methods called on the view of an element's attributes that
// Element.attributes hands the page (src/inject/dom/modules/DOMHooks.ts): a
// deferred part (./deferred.ts), made at the first such call, which most
// documents never make. Its top level reads no global (./deferredParts.ts).

export interface AttributeView {
	map: NamedNodeMap;
	owner: Element;
	visible: () => Attr[];
	named: (name: string) => Attr | undefined;
}

export type ViewMethod = (
	view: AttributeView,
	args: unknown[],
	key: string,
) => unknown;

export interface AttributeViewContext {
	/** whether `name` is a marker's name on `element` */
	isMarkerOn: (element: unknown, name: unknown) => boolean;
	/** `name` as the element names its attributes */
	attributeName: (element: unknown, name: string) => string;
	/** the realm's Attr */
	Attr: typeof Attr;
	/** NamedNodeMap.prototype's own methods, as they were */
	nativeNamedNodeMap: Record<string, unknown>;
	/** the element's hooked setAttributeNode and setAttributeNodeNS */
	setNamedItems: {
		setAttributeNode?: Element['setAttributeNode'];
		setAttributeNodeNS?: Element['setAttributeNodeNS'];
	};
}

/**
 * By index and by name over the attributes the page sees, an attribute node
 * set through the map set on the element (through its hooks, so what it
 * loads is routed)
 */
export function attributeViewMethods(
	context: AttributeViewContext,
): Record<string, ViewMethod> {
	const { isMarkerOn, attributeName, nativeNamedNodeMap, setNamedItems } =
		context;
	const setNamedItemOf =
		(method: keyof typeof setNamedItems): ViewMethod =>
		({ map, owner }, args, key) => {
			const set = setNamedItems[method];
			// the browser's own errors (not an Attr, a node in use) name the
			// map's method
			const attr = args[0];
			if (
				!set ||
				!(attr instanceof context.Attr) ||
				(attr.ownerElement && attr.ownerElement !== owner)
			)
				return Reflect.apply(
					Reflect.get(nativeNamedNodeMap, key) as Function,
					map,
					args,
				);
			return Reflect.apply(set, owner, args);
		};
	return {
		item: ({ visible }, args) => visible()[(args[0] as number) >>> 0] ?? null,
		getNamedItem: ({ map, owner, named }, args) =>
			isMarkerOn(owner, args[0])
				? null
				: (map.getNamedItem(String(args[0])) ??
					named(attributeName(owner, String(args[0]))) ??
					null),
		setNamedItem: setNamedItemOf('setAttributeNode'),
		setNamedItemNS: setNamedItemOf('setAttributeNodeNS'),
	};
}
