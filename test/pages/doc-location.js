// adv-navigation.html and doc-location-frame.html (adversarial-navigation
// suite): a navigation of another window through its document's location,
// by `f`
window.writeDocLocation = (d, f, dest) => {
	if (f === 'set') d.location = dest;
	else if (f === 'href') d.location.href = dest;
	else if (f === 'assign') d.location.assign(dest);
	else if (f === 'replace') d.location.replace(dest);
	else if (f === 'computed') d[['loc', 'ation'].join('')] = dest;
	else if (f === 'reflect') Reflect.set(d, 'location', dest);
	else if (f === 'object-assign') Object.assign(d, { location: dest });
	else if (f === 'setter')
		Object.getOwnPropertyDescriptor(d, 'location').set.call(d, dest);
	else if (f === 'href-setter') {
		const l = d.location;
		Object.getOwnPropertyDescriptor(l, 'href').set.call(l, dest);
	} else if (f === 'destructure') {
		const { location } = d;
		location.href = dest;
	} else if (f === 'with') {
		with (d) location = dest;
	} else if (f === 'view') d.defaultView.location = dest;
};
