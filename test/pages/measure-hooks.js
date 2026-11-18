// Kernels for test/suites/measure-hooks.mjs: the page work the inject's
// hooks sit on (reads of location, document.cookie, top, parent and frames;
// markup and element insertion; URL attributes; fetch, XHR and postMessage
// setup; mutation observers). The page runs in a frame of another site than
// its parent (measure-hooks.html), as an ad or an embed does, so `parent`
// and `top` are windows of another origin. Each kernel is timed over
// `rounds` rounds after `warm` warm-up rounds and reports its median and a
// checksum that must be the same natively and through the proxy. Every
// kernel runs once before any is timed. `?only=a,b` runs the kernels named,
// `?rounds=` and `?warm=` set the counts.
(function () {
	'use strict';

	const kernels = [];
	/** `make()` builds the state once, `run(state)` is one timed round (it may return a promise) */
	const kernel = (name, make, run) => kernels.push({ name, make, run });

	const box = document.createElement('div');
	box.hidden = true;
	document.body.append(box);
	document.cookie = 'measure=hooks; path=/';
	document.cookie = 'second=value; path=/';

	kernel(
		'control',
		() => null,
		() => {
			let x = 1;
			for (let i = 0; i < 3000000; i++)
				x = (Math.imul(x, 1664525) + 1013904223) | 0;
			return x & 1;
		},
	);

	// reads of the page's own location and cookie jar
	kernel(
		'location.href',
		() => null,
		() => {
			let t = 0;
			for (let i = 0; i < 20000; i++) t += location.href.length;
			return t;
		},
	);
	kernel(
		'location.pathname',
		() => null,
		() => {
			let t = 0;
			for (let i = 0; i < 20000; i++) t += location.pathname.length;
			return t;
		},
	);
	kernel(
		'document.location.host',
		() => null,
		() => {
			let t = 0;
			for (let i = 0; i < 20000; i++) t += document.location.host.length;
			return t;
		},
	);
	kernel(
		'document.URL',
		() => null,
		() => {
			let t = 0;
			for (let i = 0; i < 20000; i++) t += document.URL.length;
			return t;
		},
	);
	kernel(
		'document.cookie',
		() => null,
		() => {
			let t = 0;
			for (let i = 0; i < 2000; i++)
				t += document.cookie.indexOf('measure=hooks') >= 0 ? 1 : 0;
			return t;
		},
	);

	// windows: this frame's parent and top are of another origin
	kernel(
		'top',
		() => null,
		() => {
			let t = 0;
			for (let i = 0; i < 20000; i++) if (top !== window) t++;
			return t;
		},
	);
	kernel(
		'parent',
		() => null,
		() => {
			let t = 0;
			for (let i = 0; i < 20000; i++) if (parent !== window) t++;
			return t;
		},
	);
	kernel(
		'window.top',
		() => null,
		() => {
			let t = 0;
			for (let i = 0; i < 20000; i++) if (window.top === parent) t++;
			return t;
		},
	);
	kernel(
		'parent.top',
		() => null,
		() => {
			let t = 0;
			for (let i = 0; i < 20000; i++) if (parent.top === top) t++;
			return t;
		},
	);
	kernel(
		'self.window',
		() => null,
		() => {
			let t = 0;
			for (let i = 0; i < 20000; i++) if (self.window === window) t++;
			return t;
		},
	);
	kernel(
		'window.frames',
		() => null,
		() => {
			let t = 0;
			for (let i = 0; i < 20000; i++) t += window.frames.length;
			return t;
		},
	);
	kernel(
		'frames[i]',
		() => null,
		() => {
			let t = 0;
			for (let i = 0; i < 20000; i++) if (frames[i & 1] !== undefined) t++;
			return t;
		},
	);
	kernel(
		'parent.frames[0]',
		() => null,
		() => {
			let t = 0;
			for (let i = 0; i < 5000; i++) if (parent.frames[0] === window) t++;
			return t;
		},
	);

	// markup: a template of what a page writes, with URL attributes
	const markup = (i) =>
		`<div class="card c${i}"><a href="/item/${i}?q=${i}" title="t">item ${i}</a>` +
		`<img loading="lazy" src="/img/${i}.png" alt="">` +
		`<span style="color: red">text</span><p>more <b>text</b> ${i}</p></div>`;
	kernel(
		'innerHTML set',
		() => {
			const parts = [];
			for (let i = 0; i < 50; i++) parts.push(markup(i));
			return parts.join('');
		},
		(html) => {
			let t = 0;
			for (let r = 0; r < 20; r++) {
				box.innerHTML = html;
				t += box.childElementCount;
			}
			box.textContent = '';
			return t;
		},
	);
	kernel(
		'innerHTML get',
		() => {
			const parts = [];
			for (let i = 0; i < 50; i++) parts.push(markup(i));
			const div = document.createElement('div');
			div.innerHTML = parts.join('');
			box.append(div);
			return div;
		},
		(div) => {
			let t = 0;
			for (let r = 0; r < 50; r++) t += div.innerHTML.length;
			return t;
		},
	);
	kernel(
		'insertAdjacentHTML',
		() => markup(1),
		(html) => {
			for (let r = 0; r < 500; r++) box.insertAdjacentHTML('beforeend', html);
			const t = box.childElementCount;
			box.textContent = '';
			return t;
		},
	);
	kernel(
		'createElement div',
		() => null,
		() => {
			for (let r = 0; r < 2000; r++) {
				const div = document.createElement('div');
				div.className = 'x';
				div.textContent = 'x';
				box.appendChild(div);
			}
			const t = box.childElementCount;
			box.textContent = '';
			return t;
		},
	);
	kernel(
		'appendChild a[href]',
		() => null,
		() => {
			for (let r = 0; r < 1000; r++) {
				const a = document.createElement('a');
				a.href = `/link/${r}`;
				a.textContent = 'x';
				box.appendChild(a);
			}
			const t = box.childElementCount;
			box.textContent = '';
			return t;
		},
	);
	kernel(
		'appendChild script',
		() => null,
		() => {
			window.__measureRan = 0;
			for (let r = 0; r < 100; r++) {
				const script = document.createElement('script');
				script.textContent = `window.__measureRan++;`;
				box.appendChild(script);
			}
			const t = window.__measureRan;
			box.textContent = '';
			return t;
		},
	);
	kernel(
		'appendChild script[src]',
		() => null,
		() => {
			// a type the browser never fetches: the hooks route it all the same
			for (let r = 0; r < 500; r++) {
				const script = document.createElement('script');
				script.type = 'text/x-measure';
				script.src = `/script/${r}.js`;
				box.appendChild(script);
			}
			const t = box.childElementCount;
			box.textContent = '';
			return t;
		},
	);
	kernel(
		'appendChild link',
		() => null,
		() => {
			for (let r = 0; r < 500; r++) {
				const link = document.createElement('link');
				link.rel = 'alternate';
				link.href = `/style/${r}.css`;
				box.appendChild(link);
			}
			const t = box.childElementCount;
			box.textContent = '';
			return t;
		},
	);
	kernel(
		'cloneNode deep',
		() => {
			const div = document.createElement('div');
			for (let i = 0; i < 20; i++)
				div.insertAdjacentHTML('beforeend', markup(i));
			return div;
		},
		(div) => {
			for (let r = 0; r < 30; r++) box.appendChild(div.cloneNode(true));
			const t = box.getElementsByTagName('*').length;
			box.textContent = '';
			return t;
		},
	);
	kernel(
		'keyed move styled',
		() => {
			// a list a framework keeps, each row's style set through the CSSOM
			// (in the document itself: other kernels empty the box)
			const list = document.createElement('div');
			list.hidden = true;
			document.body.append(list);
			const rows = [];
			for (let i = 0; i < 200; i++) {
				const row = document.createElement('div');
				row.style.width = `${i}px`;
				list.append(row);
				rows.push(row);
			}
			return { list, rows };
		},
		({ list, rows }) => {
			for (let r = 0; r < 5; r++)
				for (const row of rows) {
					row.style.height = `${r}px`;
					list.insertBefore(row, list.firstChild);
				}
			return list.firstChild.style.cssText.length + list.childElementCount;
		},
	);

	// URL attributes and plain ones
	kernel(
		'setAttribute href',
		() => {
			const a = document.createElement('a');
			box.append(a);
			return a;
		},
		(a) => {
			for (let r = 0; r < 5000; r++) a.setAttribute('href', `/to/${r & 63}`);
			return a.getAttribute('href').length;
		},
	);
	kernel(
		'getAttribute href',
		() => {
			const a = document.createElement('a');
			a.setAttribute('href', '/to/somewhere?x=1');
			box.append(a);
			return a;
		},
		(a) => {
			let t = 0;
			for (let r = 0; r < 20000; r++) t += a.getAttribute('href').length;
			return t;
		},
	);
	kernel(
		'a.href get',
		() => {
			const a = document.createElement('a');
			a.setAttribute('href', '/to/somewhere?x=1');
			box.append(a);
			return a;
		},
		(a) => {
			let t = 0;
			for (let r = 0; r < 20000; r++) t += a.href.length;
			return t;
		},
	);
	kernel(
		'img.src set',
		() => {
			const img = document.createElement('img');
			img.loading = 'lazy';
			box.append(img);
			return img;
		},
		(img) => {
			for (let r = 0; r < 2000; r++) img.src = `/img/${r & 63}.png`;
			return img.getAttribute('src').length;
		},
	);
	kernel(
		'setAttribute class',
		() => {
			const div = document.createElement('div');
			box.append(div);
			return div;
		},
		(div) => {
			for (let r = 0; r < 20000; r++) div.setAttribute('class', `c${r & 7}`);
			return div.getAttribute('class').length;
		},
	);
	kernel(
		'getAttribute class',
		() => {
			const div = document.createElement('div');
			div.className = 'one two';
			box.append(div);
			return div;
		},
		(div) => {
			let t = 0;
			for (let r = 0; r < 20000; r++) t += div.getAttribute('class').length;
			return t;
		},
	);
	kernel(
		'style.prop set',
		() => {
			const div = document.createElement('div');
			box.append(div);
			return div;
		},
		(div) => {
			for (let r = 0; r < 20000; r++) div.style.width = `${r & 255}px`;
			return div.style.width.length;
		},
	);
	kernel(
		'classList.toggle',
		() => {
			const div = document.createElement('div');
			box.append(div);
			return div;
		},
		(div) => {
			for (let r = 0; r < 20000; r++) div.classList.toggle('on');
			return div.classList.length;
		},
	);
	kernel(
		'style.setProperty',
		() => {
			const div = document.createElement('div');
			box.append(div);
			return div;
		},
		(div) => {
			for (let r = 0; r < 20000; r++)
				div.style.setProperty('width', `${r & 255}px`);
			return div.style.getPropertyValue('width').length;
		},
	);
	kernel(
		'style.getPropertyValue',
		() => {
			const div = document.createElement('div');
			div.style.width = '3px';
			box.append(div);
			return div;
		},
		(div) => {
			let t = 0;
			for (let r = 0; r < 20000; r++)
				t += div.style.getPropertyValue('width').length;
			return t;
		},
	);

	// network setup and messages
	kernel(
		'new Request',
		() => null,
		() => {
			let t = 0;
			for (let r = 0; r < 2000; r++)
				t += new Request(`/api/${r & 63}`).method.length;
			return t;
		},
	);
	kernel(
		'fetch aborted',
		() => {
			const controller = new AbortController();
			controller.abort();
			return controller.signal;
		},
		async (signal) => {
			const calls = [];
			for (let r = 0; r < 300; r++)
				calls.push(fetch(`/api/${r & 63}`, { signal }).catch(() => 1));
			const results = await Promise.all(calls);
			return results.length;
		},
	);
	kernel(
		'XHR open',
		() => null,
		() => {
			let t = 0;
			for (let r = 0; r < 2000; r++) {
				const xhr = new XMLHttpRequest();
				xhr.open('GET', `/api/${r & 63}`);
				xhr.setRequestHeader('x-measure', '1');
				t += xhr.readyState;
			}
			return t;
		},
	);
	kernel(
		'postMessage self',
		() => null,
		() =>
			new Promise((resolve) => {
				let seen = 0;
				const N = 1000;
				const listener = (event) => {
					if (event.data !== 'measure') return;
					if (++seen === N) {
						removeEventListener('message', listener);
						resolve(seen);
					}
				};
				addEventListener('message', listener);
				for (let r = 0; r < N; r++) window.postMessage('measure', '*');
			}),
	);
	kernel(
		'parent.postMessage',
		() => null,
		() => {
			for (let r = 0; r < 1000; r++) parent.postMessage('measure-ignore', '*');
			return 1;
		},
	);
	kernel(
		'event listeners',
		() => document.createElement('button'),
		(button) => {
			let t = 0;
			const handler = () => t++;
			for (let r = 0; r < 2000; r++) {
				button.addEventListener('click', handler);
				button.dispatchEvent(new Event('click'));
				button.removeEventListener('click', handler);
			}
			return t;
		},
	);

	// mutation observers over a subtree a page churns
	kernel(
		'MutationObserver childList',
		() => null,
		() =>
			new Promise((resolve) => {
				let records = 0;
				const observer = new MutationObserver((list) => {
					records += list.length;
					for (const record of list)
						for (const node of record.addedNodes) records += node.nodeType;
				});
				observer.observe(box, { childList: true, subtree: true });
				for (let r = 0; r < 2000; r++) {
					const div = document.createElement('div');
					div.appendChild(document.createElement('span'));
					box.appendChild(div);
				}
				Promise.resolve().then(() => {
					observer.disconnect();
					box.textContent = '';
					resolve(records);
				});
			}),
	);
	kernel(
		'MutationObserver attributes',
		() => {
			const div = document.createElement('div');
			box.append(div);
			return div;
		},
		(div) =>
			new Promise((resolve) => {
				let records = 0;
				const observer = new MutationObserver((list) => {
					for (const record of list)
						records += record.attributeName.length + (record.oldValue ? 1 : 0);
				});
				observer.observe(div, { attributes: true, attributeOldValue: true });
				for (let r = 0; r < 5000; r++) {
					div.setAttribute('data-n', `${r}`);
					div.className = `c${r & 3}`;
				}
				Promise.resolve().then(() => {
					observer.disconnect();
					resolve(records);
				});
			}),
	);

	const median = (values) => {
		const sorted = values.slice().sort((a, b) => a - b);
		return sorted[sorted.length >> 1];
	};
	const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

	window.__hooksRun = async (options = {}) => {
		const rounds = options.rounds || 7;
		const warm = options.warm === undefined ? 2 : options.warm;
		const report = { done: false, rounds, warm, order: [], kernels: {} };
		window.__hooks = report;
		const chosen = kernels.filter(
			(entry) => !options.only || options.only.includes(entry.name),
		);
		const states = new Map();
		for (const entry of chosen) {
			states.set(entry, entry.make());
			await entry.run(states.get(entry));
			await tick();
		}
		for (const entry of chosen) {
			const state = states.get(entry);
			let result = 0;
			for (let i = 0; i < warm; i++) result = await entry.run(state);
			await tick();
			const times = [];
			for (let i = 0; i < rounds; i++) {
				const start = performance.now();
				result = await entry.run(state);
				times.push(performance.now() - start);
				await tick();
			}
			report.order.push(entry.name);
			report.kernels[entry.name] = {
				ms: median(times),
				least: Math.min(...times),
				times,
				checksum: String(result),
			};
		}
		report.done = true;
		return report;
	};

	const query = new URLSearchParams(location.search);
	const only = query.get('only');
	// the frames below this one load first, and the page around it settles
	const start = () =>
		setTimeout(() => {
			window.__hooksRun({
				rounds: Number(query.get('rounds')) || undefined,
				warm: query.has('warm') ? Number(query.get('warm')) : undefined,
				only: only ? only.split(',') : undefined,
			});
		}, 500);
	if (document.readyState === 'complete') start();
	else addEventListener('load', start);
})();
