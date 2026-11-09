// Every way a script can write the window's location (location-writes
// suite). A case runs in a location-write.html frame as a classic script of
// its own at the top level (`module` cases as a module script) and
// navigates to U(name), the same page marked landed; `child` cases run in a
// frame or popup another case opens; `alone` cases navigate the top page,
// so the harness runs each of those in a page of its own. The controls at
// the end bind a location of their own and navigate nothing.
function U(name) {
	return new URL('location-write.html?c=' + name + '&landed', location.href)
		.href;
}
var LOCATION_WRITES = {
	// a top-level var declares nothing new: it assigns the window's location
	'var-plain': "var location = U('var-plain');",
	'var-object': "var {location} = {location: U('var-object')};",
	'var-object-default': "var {location = U('var-object-default')} = {};",
	'var-object-nested':
		"var {a: {b: location}} = {a: {b: U('var-object-nested')}};",
	'var-array': "var [location] = [U('var-array')];",
	'var-array-default': "var [location = U('var-array-default')] = [];",
	'var-array-nested': "var [[location]] = [[U('var-array-nested')]];",
	'var-array-rest': "var [...location] = [U('var-array-rest')];",
	'var-block': "{ var location = U('var-block'); }",
	'var-if': "if (true) var location = U('var-if');",
	'var-try': "try { var location = U('var-try'); } finally {}",
	'var-label': "label: var location = U('var-label');",
	'var-for-init': "for (var location = U('var-for-init'); false; );",
	'for-var-of': "for (var location of [U('for-var-of')]);",
	'for-var-in': "for (var location in {[U('for-var-in')]: 1});",
	'for-var-of-pattern': "for (var [location] of [[U('for-var-of-pattern')]]);",
	// loop heads and assignment patterns
	'for-of': "for (location of [U('for-of')]);",
	'for-in': "for (location in {[U('for-in')]: 1});",
	'for-of-pattern': "for ({location} of [{location: U('for-of-pattern')}]);",
	'assign-object': "({location} = {location: U('assign-object')});",
	'assign-object-default': "({location = U('assign-object-default')} = {});",
	'assign-object-alias': "({a: location} = {a: U('assign-object-alias')});",
	'assign-object-nested':
		"({a: [location]} = {a: [U('assign-object-nested')]});",
	'assign-array': "[location] = [U('assign-array')];",
	'assign-array-default': "[[location = U('assign-array-default')]] = [[]];",
	'assign-array-rest': "[...location] = [U('assign-array-rest')];",
	// implicit global writes inside functions
	'function-assign': "(function () { location = U('function-assign'); })();",
	'function-pattern':
		"(function () { [location] = [U('function-pattern')]; })();",
	'function-for-of': "(() => { for (location of [U('function-for-of')]); })();",
	'function-object-pattern':
		"(() => { ({location} = {location: U('function-object-pattern')}); })();",
	'strict-pattern':
		"(function () { 'use strict'; [location] = [U('strict-pattern')]; })();",
	// compound and logical assignment (location is an object: `||=` and
	// `??=` assign nothing)
	'plus-assign': "location += '&landed';",
	'and-assign': "location &&= U('and-assign');",
	'or-assign': "location ||= U('or-assign');",
	'nullish-assign': "location ??= U('nullish-assign');",
	// scope chains
	'with-window': "with (window) { location = U('with-window'); }",
	'with-document': "with (document) { location = U('with-document'); }",
	'with-pattern': "with (window) { [location] = [U('with-pattern')]; }",
	// code from strings
	eval: 'eval("location = U(\'eval\')");',
	'eval-pattern': 'eval("[location] = [U(\'eval-pattern\')]");',
	'eval-var': 'eval("var location = U(\'eval-var\')");',
	'eval-indirect': '(0, eval)("location = U(\'eval-indirect\')");',
	'eval-window': 'window.eval("for (location of [U(\'eval-window\')]);");',
	function: 'Function("location = U(\'function\')")();',
	'function-new-pattern':
		"new Function('u', '[location] = [u]')(U('function-new-pattern'));",
	timeout: 'setTimeout("location = U(\'timeout\')");',
	'timeout-pattern':
		'setTimeout("({location} = {location: U(\'timeout-pattern\')})");',
	// markup: inline handlers and javascript: URLs
	handler: "document.getElementById('handler').click();",
	'handler-pattern': "document.getElementById('handler-pattern').click();",
	'handler-set':
		"var b = document.createElement('button'); b.setAttribute('onclick', '[location] = [U(\"handler-set\")]'); document.body.append(b); b.click();",
	'javascript-url': "document.getElementById('javascript-url').click();",
	'javascript-url-pattern':
		"document.getElementById('javascript-url-pattern').click();",
	'javascript-location':
		'location = \'javascript:void (location = U("javascript-location"))\';',
	// modules are strict: a global write is legal, a var is the module's own
	module: { module: true, code: "location = U('module');" },
	'module-pattern': {
		module: true,
		code: "[location] = [U('module-pattern')];",
	},
	'module-for-of': {
		module: true,
		code: "for (location of [U('module-for-of')]);",
	},
	'module-var': { module: true, code: "var location = U('module-var');" },
	// members
	self: "self.location = U('self');",
	'window-computed': "window['loc' + 'ation'] = U('window-computed');",
	globalThis: "globalThis.location = U('globalThis');",
	document: "document.location = U('document');",
	'document-pattern': "[document.location] = [U('document-pattern')];",
	'window-pattern': "({a: window.location} = {a: U('window-pattern')});",
	'window-for-of': "for (window.location of [U('window-for-of')]);",
	'window-literal-pattern':
		"[window['location']] = [U('window-literal-pattern')];",
	'href-pattern': "[location.href] = [U('href-pattern')];",
	// other windows
	parent:
		"var f = document.createElement('iframe'); f.src = 'location-write.html?c=parent-child'; document.body.append(f);",
	'parent-child': { child: true, code: "parent.location = U('parent');" },
	'parent-pattern':
		"var f = document.createElement('iframe'); f.src = 'location-write.html?c=parent-pattern-child'; document.body.append(f);",
	'parent-pattern-child': {
		child: true,
		code: "[parent.location] = [U('parent-pattern')];",
	},
	frames:
		"var f = document.createElement('iframe'); f.src = 'location-write.html?c=idle'; f.onload = function () { f.onload = null; frames[0].location = U('frames'); }; document.body.append(f);",
	'frames-pattern':
		"var f = document.createElement('iframe'); f.src = 'location-write.html?c=idle'; f.onload = function () { f.onload = null; [frames[0].location] = [U('frames-pattern')]; }; document.body.append(f);",
	idle: { child: true, code: '' },
	opener:
		"var w = open(); w.location = new URL('location-write.html?c=opener-child', location.href).href;",
	'opener-child': { child: true, code: "opener.location = U('opener');" },
	'opener-pattern':
		"var w = open(); w.location = new URL('location-write.html?c=opener-pattern-child', location.href).href;",
	'opener-pattern-child': {
		child: true,
		code: "for (opener.location of [U('opener-pattern')]);",
	},
	top: { alone: true, code: "top.location = U('top');" },
	'top-pattern': { alone: true, code: "[top.location] = [U('top-pattern')];" },
	'top-for-of': {
		alone: true,
		code: "for (top.location of [U('top-for-of')]);",
	},
	'top-reflect': {
		alone: true,
		code: "Reflect.set(top, 'location', U('top-reflect'));",
	},
	// reflection
	'reflect-set': "Reflect.set(window, 'location', U('reflect-set'));",
	'object-assign': "Object.assign(window, {location: U('object-assign')});",
	'descriptor-set':
		"Reflect.apply(Object.getOwnPropertyDescriptor(window, 'location').set, window, [U('descriptor-set')]);",
	'descriptor-href':
		"Reflect.apply(Object.getOwnPropertyDescriptor(location, 'href').set, location, [U('descriptor-href')]);",
	'document-descriptor':
		"Object.getOwnPropertyDescriptor(document, 'location').set.call(document, U('document-descriptor'));",
	'lookup-setter':
		"window.__lookupSetter__('location').call(window, U('lookup-setter'));",
	// controls: a location of their own
	'function-var': "(function () { var location = U('function-var'); })();",
	'param-pattern': "(function ([location]) {})([U('param-pattern')]);",
	catch: "try { throw U('catch'); } catch (location) {}",
	'block-let': "{ let location = U('block-let'); }",
	'local-pattern':
		"(function () { var location; [location] = [U('local-pattern')]; for (location of [U('local-pattern')]); })();",
};
