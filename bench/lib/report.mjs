// results.md and results.csv from results.json: one table per measurement,
// rows as lines, medians in the cells (holyWisp's bench writes the same).

const fmt = (v, digits = 0) => {
	if (v === null || v === undefined || Number.isNaN(v)) return 'DNF';
	if (Math.abs(v) >= 100 || digits === 0)
		return Math.round(v).toLocaleString('en-US');
	return v.toFixed(digits);
};
const pct = (v) =>
	v === null || v === undefined ? 'n/a' : `${Math.round(v * 100)}`;

const SHORT = {
	article: 'article',
	many: '200 subresources',
	scripts: 'script corpus',
	'article-fcp': 'article, FCP',
	'article-lcp': 'article, LCP',
	'many-fcp': '200 subresources, FCP',
	'many-lcp': '200 subresources, LCP',
	'scripts-fcp': 'script corpus, FCP',
	'scripts-lcp': 'script corpus, LCP',
	cold: 'first visit (start + load)',
	boot: 'proxy start alone',
	warm: 'second load, same tab',
	navigation: 'per navigation',
	in_browser: 'in the browser, through the proxy',
	offline: 'rewriter alone, shared scripts',
	offline_all: 'rewriter alone, own scripts',
	pss_blank_mb: 'all processes, blank tab (MB)',
	pss_frames_mb: 'all processes, 20 frames (MB)',
	per_frame_kb: 'per ad-like frame (KB)',
	heap_blank_mb: 'JS heap, blank tab (MB)',
	heap_frames_mb: 'JS heap, 20 frames (MB)',
	'article-browser': 'article, Chrome',
	'article-server': 'article, server',
	'many-browser': '200 subresources, Chrome',
	'many-server': '200 subresources, server',
	'scripts-browser': 'script corpus, Chrome',
	'scripts-server': 'script corpus, server',
};

/**
 * One table per measurement family: a line per scenario, a column per row
 * (native first, as the reference), each cell the median with the range of
 * the repeats, the best proxied row of each line in bold.
 */
function statTable(title, groups, rows, labels, digits = 0) {
	const keys = Object.keys(groups || {});
	if (!keys.length) return '';
	const unit = groups[keys[0]].unit || '';
	const higher = groups[keys[0]].lower_better === false;
	let out = `### ${title}${unit ? ` (${unit}, median of repeats, range in brackets; ${higher ? 'higher' : 'lower'} is better)` : ''}\n\n`;
	out += `| | ${rows.map((r) => labels[r] || r).join(' | ')} |\n`;
	out += `|---|${rows.map(() => '---').join('|')}|\n`;
	for (const k of keys) {
		const g = groups[k];
		const better = g.lower_better === false ? -1 : 1;
		const proxied = rows
			.filter((r) => r !== 'native')
			.map((r) => g.rows?.[r]?.median)
			.filter((v) => v !== null && v !== undefined);
		const best = proxied.length
			? better > 0
				? Math.min(...proxied)
				: Math.max(...proxied)
			: null;
		const cells = rows.map((row) => {
			const st = g.rows?.[row];
			if (!st) return '';
			if (st.median === null || st.median === undefined) return 'DNF';
			let cell = fmt(st.median, digits);
			if (row !== 'native' && st.median === best) cell = `**${cell}**`;
			if (st.n > 1 && st.min !== st.max)
				cell += ` (${fmt(st.min, digits)}-${fmt(st.max, digits)})`;
			if (st.dnf) cell += ` ${st.dnf} DNF`;
			return cell;
		});
		const name = g.short || SHORT[k] || k;
		out += `| ${name} | ${cells.join(' | ')} |\n`;
	}
	return `${out}\n`;
}

function metaMarkdown(meta) {
	if (!meta) return '';
	const h = meta.host || {};
	let md = `Run on ${meta.date?.slice(0, 10)} (UTC), ${h.cpu} (x${h.cores}), ${h.mem_gb} GB, ${h.os}, kernel ${h.kernel}.\n`;
	md += `Chrome ${meta.chrome}, Node ${meta.node}, ${meta.holywisp?.version} (${meta.holywisp?.sha?.slice(0, 8)}).\n`;
	const l = meta.load || {};
	const f = (a) => (a ? a.map((x) => x.toFixed(2)).join(' ') : 'n/a');
	md += `Load average before ${f(l.before)}, after ${f(l.after)}; ${meta.repeats} repeats per timing; site support ${meta.headful_sites ? 'headful (Xvfb)' : 'headless'}.\n\n`;
	md += '| row | version | transport |\n|---|---|---|\n';
	for (const r of meta.rows || []) {
		const d = r.describe || {};
		const version = [
			d.sha
				? `${d.repo || ''} ${/^[0-9a-f]{12,}$/.test(d.sha) ? d.sha.slice(0, 8) : d.sha}${d.dirty ? ' (modified)' : ''}`
				: '',
			// the integrity hashes and asset names stay in results.json
			...Object.entries(d.packages || {}).map(
				([k, v]) => `${k} ${String(v).split(' ')[0]}`,
			),
		]
			.filter(Boolean)
			.join('; ');
		md += `| ${r.label} | ${version || (r.row === 'native' ? `Chrome ${meta.chrome}` : '')} | ${(d.transport || '').replaceAll('|', '/')} |\n`;
	}
	return `${md}\n`;
}

export function resultsMarkdown(results) {
	const { rows, labels } = results;
	let md = metaMarkdown(results.meta);
	const site = results.site_support;
	if (site?.summary) {
		md += '### Site support\n\n';
		md +=
			'| | score | pass | partial | challenge | fail | boot fail | sites scored | extra JS errors (median) | load time vs native (median) |\n|---|---|---|---|---|---|---|---|---|---|\n';
		for (const row of rows) {
			const s = site.summary[row];
			if (!s) continue;
			md += `| ${labels[row]} | ${pct(s.score)} | ${s.pass} | ${s.partial} | ${s.challenge} | ${s.fail} | ${s.boot_fail} | ${s.sites} | ${fmt(s.extra_js_errors_median)} | ${s.ttl_ratio_median ? s.ttl_ratio_median.toFixed(2) + 'x' : 'n/a'} |\n`;
		}
		const cats = [...new Set(site.sites.map((s) => s.category))];
		md += `\n### Site support by category (score 0-100)\n\n| | ${cats.join(' | ')} |\n|---|${cats.map(() => '---').join('|')}|\n`;
		for (const row of rows) {
			const s = site.summary[row];
			if (!s) continue;
			md += `| ${labels[row]} | ${cats.map((c) => pct(s.by_category[c])).join(' | ')} |\n`;
		}
		md += '\n';
	}
	const speed = results.speed || {};
	md += statTable(
		'Fixture page loads, go() to the load event',
		speed.fixtures,
		rows,
		labels,
	);
	md += statTable('Paint on the fixture pages', speed.paint, rows, labels);
	md += statTable('First visit against warm', speed.first_visit, rows, labels);
	md += statTable('Single-page app navigation', speed.spa, rows, labels, 1);
	md += statTable(
		'Real sites, go() to the load event',
		speed.real,
		rows,
		labels,
	);
	md += statTable(
		'Real sites, largest contentful paint',
		speed.real_lcp,
		rows,
		labels,
	);
	md += statTable('Rewrite throughput', speed.rewrite, rows, labels, 2);
	md += statTable('Memory', speed.memory, rows, labels);
	md += statTable('CPU time per load', speed.cpu, rows, labels);
	md += statTable('Bytes per load', speed.transfer, rows, labels);
	md += statTable(
		'Bytes per real-site load',
		speed.real_transfer,
		rows,
		labels,
	);
	const fid = results.fidelity;
	if (fid?.summary) {
		const groups = [...new Set((fid.checks || []).map((c) => c.group))];
		md += `### Fidelity (checks equal to native)\n\n| | total | ${groups.join(' | ')} |\n|---|---|${groups.map(() => '---').join('|')}|\n`;
		for (const row of rows) {
			const s = fid.summary[row];
			if (!s) continue;
			md += `| ${labels[row]} | ${s.passed}/${s.total} | ${groups.map((g) => (s.by_group?.[g] ? `${s.by_group[g][0]}/${s.by_group[g][1]}` : '')).join(' | ')} |\n`;
		}
		md += '\n';
		if (fid.leaks?.summary) {
			md +=
				'### Leaks (escape vectors that reached the network outside the proxy)\n\n| | vectors leaked | requests leaked |\n|---|---|---|\n';
			for (const row of rows) {
				const s = fid.leaks.summary[row];
				if (s)
					md += `| ${labels[row]} | ${s.vectors_leaked}/${s.vectors} | ${s.requests} |\n`;
			}
			md += '\n';
		}
	}
	if (results.size) {
		md +=
			'### Size of what the browser downloads for the proxy itself (KB)\n\n| | raw | brotli |\n|---|---|---|\n';
		for (const row of rows) {
			const s = results.size[row];
			if (s)
				md += `| ${labels[row]} | ${fmt(s.raw_total / 1024)} | ${fmt(s.br_total / 1024)} |\n`;
		}
		md += '\n';
	}
	return md;
}

export function resultsCSV(results) {
	const lines = ['section,metric,row,median,min,max,p25,p75,n,dnf'];
	const walk = (section, groups) => {
		for (const [metric, g] of Object.entries(groups || {}))
			for (const [row, s] of Object.entries(g.rows || {}))
				lines.push(
					[
						section,
						metric,
						row,
						s.median,
						s.min,
						s.max,
						s.p25,
						s.p75,
						s.n,
						s.dnf,
					]
						.map((v) => (v === null || v === undefined ? '' : v))
						.join(','),
				);
	};
	for (const [section, groups] of Object.entries(results.speed || {}))
		walk(section, groups);
	for (const [siteId, perRow] of Object.entries(
		results.site_support?.results || {},
	))
		for (const [row, r] of Object.entries(perRow))
			lines.push(`site:${r.verdict},${siteId},${row},${r.score ?? ''},,,,,1,`);
	for (const [row, s] of Object.entries(results.fidelity?.summary || {}))
		lines.push(`fidelity,passed,${row},${s.passed},,,,,${s.total},`);
	for (const [row, s] of Object.entries(results.fidelity?.leaks?.summary || {}))
		lines.push(
			`leaks,vectors_leaked,${row},${s.vectors_leaked},,,,,${s.vectors},`,
		);
	for (const [row, s] of Object.entries(results.size || {})) {
		lines.push(`size,raw_bytes,${row},${s.raw_total},,,,,1,`);
		lines.push(`size,br_bytes,${row},${s.br_total},,,,,1,`);
	}
	return lines.join('\n') + '\n';
}
