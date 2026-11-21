// the tab-status suite's steps, run by the page's own (rewritten) code
window.step = (what) => {
	if (what === 'link') document.getElementById('next').click();
	else if (what === 'push') history.pushState({}, '', '?pushed');
	else if (what === 'fragment') location.hash = 'frag';
	else if (what === 'back') history.back();
	else if (what === 'forward') history.forward();
	else if (what === 'reload') location.reload();
	return what;
};
