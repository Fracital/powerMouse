// dom/nodes: the insertion, removal, cloning and mutation-observer tests,
// the part of the directory the inject's insertion hooks can change (the
// wpt-dom-insertion suite). The rest of dom/nodes (selectors, collections,
// character data, ranges of names) runs no hooked path and stays out.
export const sparse = ['dom/nodes', 'common'];

export const include = [
	/^dom\/nodes\/insertion-removing-steps\/.*\.(html|js)$/,
	/^dom\/nodes\/Node-(appendChild|insertBefore|replaceChild|removeChild|cloneNode|textContent|baseURI|isConnected)[^/]*\.(html|js)$/,
	/^dom\/nodes\/(ParentNode-(append|prepend|replaceChildren)|ChildNode-(after|before|remove|replaceWith))[^/]*\.(html|js)$/,
	/^dom\/nodes\/Document-(createElement|createElementNS|importNode|adoptNode|URL)[^/]*\.(html|js)$/,
	/^dom\/nodes\/Element-(insertAdjacentElement|insertAdjacentText|remove|setAttribute|removeAttribute|hasAttribute|setAttributeNodeNS)[^/]*\.(html|js)$/,
	/^dom\/nodes\/(insert-adjacent|append-on-Document|adoption\.window|attributes|attributes-namednodemap|remove-unscopable|rootNode|query-target-in-load-event|query-target-in-load-event\.part)[^/]*\.(html|js)$/,
	/^dom\/nodes\/(MutationObserver-[^/]+\.(html|js)|mutationobservers\.js)$/,
	/^dom\/nodes\/pre-insertion-validation-(hierarchy|notfound)\.js$/,
	'dom/nodes/productions.js',
	'dom/nodes/creators.js',
	'common/dummy.xhtml',
	'common/dummy.xml',
];

export const exclude = [
	/^dom\/nodes\/.*-crash\.html$/,
	// fifty documents of every namespace: no hooked path in them
	'dom/nodes/Document-createElement-namespace.html',
	// driven by test_driver actions (a real pointer)
	'dom/nodes/insertion-removing-steps/change-event.window.js',
];
