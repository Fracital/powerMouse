// a written script that writes the next one, as an ad chain does (blank-order.html)
window.__order.push('chain');
document.write(
	'<script src="' +
		new URL('order-b.js?chained', document.baseURI).href +
		'"></scr' +
		'ipt>',
);
