// A small client-side router: links change the URL with pushState, the view
// fetches its data as JSON and renders it. Each finished render is recorded
// with performance.now() in data-bench-result for the harness.
(function () {
	const ROUTES = 20;
	const nav = document.getElementById('nav');
	const view = document.getElementById('view');
	const renders = [];
	for (let i = 0; i < ROUTES; i++) {
		const a = document.createElement('a');
		a.href = `/speed/spa.html?route=${i}`;
		a.dataset.route = String(i);
		a.id = `route-${i}`;
		a.textContent = `Route ${i}`;
		nav.append(a);
	}
	async function render(route) {
		const response = await fetch(`/speed/api/item/${route}`);
		const data = await response.json();
		const list = document.createElement('div');
		for (const row of data.rows) {
			const item = document.createElement('article');
			const h = document.createElement('h3');
			h.textContent = `${data.title}: ${row.slice(0, 30)}`;
			const p = document.createElement('p');
			p.textContent = row;
			item.append(h, p);
			list.append(item);
		}
		view.replaceChildren(list);
		document.title = data.title;
		// one frame later the new view has been laid out
		await new Promise((resolve) => requestAnimationFrame(() => resolve()));
		renders.push({ route, t: performance.now() });
		document.documentElement.setAttribute(
			'data-bench-result',
			JSON.stringify({ done: true, renders }),
		);
	}
	nav.addEventListener('click', (event) => {
		const a = event.target.closest('a[data-route]');
		if (!a) return;
		event.preventDefault();
		history.pushState({}, '', a.href);
		render(Number(a.dataset.route));
	});
	addEventListener('popstate', () =>
		render(Number(new URLSearchParams(location.search).get('route') || 0)),
	);
	render(Number(new URLSearchParams(location.search).get('route') || 0));
})();
