'use strict';
self.onmessage = () => {
	let r;
	try {
		undeclaredVariable3 = 1;
		r = 'sloppy';
	} catch (e) {
		r = e.name;
	}
	self.postMessage(r);
};
