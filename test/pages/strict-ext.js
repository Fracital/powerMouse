'use strict';
try {
	undeclaredVariable2 = 1;
	window.__strict.external = 'sloppy';
} catch (e) {
	window.__strict.external = e.name;
}
