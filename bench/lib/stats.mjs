// Medians and spreads, the shape every timing metric in results.json has.

function quantile(sorted, q) {
	if (!sorted.length) return null;
	const at = (sorted.length - 1) * q;
	const lo = Math.floor(at);
	const hi = Math.ceil(at);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/** { median, min, max, p25, p75, n, runs, dnf }; null/undefined runs count as dnf */
export function stat(values) {
	const runs = values.map((v) => (Number.isFinite(v) ? v : null));
	const ok = runs.filter((v) => v !== null).sort((a, b) => a - b);
	return {
		median: quantile(ok, 0.5),
		min: ok.length ? ok[0] : null,
		max: ok.length ? ok[ok.length - 1] : null,
		p25: quantile(ok, 0.25),
		p75: quantile(ok, 0.75),
		n: ok.length,
		runs,
		dnf: runs.length - ok.length,
	};
}

export const median = (values) =>
	quantile(
		values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b),
		0.5,
	);

export const mean = (values) => {
	const ok = values.filter((v) => Number.isFinite(v));
	return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
};

/**
 * The order of `items` for repeat `r`: rotated by one each repeat and
 * reversed after every full rotation, so over 2n repeats every item holds
 * every position twice and follows every other item (holyWisp's rule).
 */
export function rotation(items, r) {
	const n = items.length;
	const shift = r % n;
	const rotated = [...items.slice(shift), ...items.slice(0, shift)];
	return Math.floor(r / n) % 2 ? rotated.reverse() : rotated;
}
