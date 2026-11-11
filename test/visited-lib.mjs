// What the visited suite reads :visited with. Script cannot (every getter
// answers as for an unvisited link), so the links of test/visited-server.mjs
// are squares whose colour a screenshot shows: the pixels come from the
// DevTools protocol, not from the page.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import { CHROME, sleep } from './lib.mjs';

/** the pixels of a PNG screenshot (8 bit RGB or RGBA, not interlaced) */
export function decodePNG(buffer) {
	let offset = 8;
	let width = 0;
	let height = 0;
	let channels = 0;
	const data = [];
	while (offset < buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString('latin1', offset + 4, offset + 8);
		const body = buffer.subarray(offset + 8, offset + 8 + length);
		if (type === 'IHDR') {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			const colour = body[9];
			if (body[8] !== 8 || (colour !== 2 && colour !== 6) || body[12] !== 0)
				throw new Error(`unsupported PNG (depth ${body[8]}, type ${colour})`);
			channels = colour === 6 ? 4 : 3;
		} else if (type === 'IDAT') data.push(body);
		offset += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(data));
	const stride = width * channels;
	const pixels = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const line = y * (stride + 1) + 1;
		for (let x = 0; x < stride; x++) {
			const a = x >= channels ? pixels[y * stride + x - channels] : 0;
			const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
			const c =
				x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
			let predicted = 0;
			if (filter === 1) predicted = a;
			else if (filter === 2) predicted = b;
			else if (filter === 3) predicted = (a + b) >> 1;
			else if (filter === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			pixels[y * stride + x] = (raw[line + x] + predicted) & 255;
		}
	}
	return {
		width,
		height,
		at: (x, y) => [
			...pixels.subarray(y * stride + x * channels).subarray(0, 3),
		],
	};
}

const RESOLVER =
	'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1';

/**
 * Chrome with a profile that keeps history (a persistent context; the
 * suites' default context is a throwaway one, as incognito, and records no
 * visit). `resolver` replaces the suites' host resolver rules (every name
 * but the loopback ones fails to resolve). `close()` ends the browser and
 * removes the profile; `close({ keep: true })` leaves it for another launch
 * (`profile`).
 */
export async function launchWithHistory(
	args = [],
	resolver = RESOLVER,
	profile = mkdtempSync(join(tmpdir(), 'stomp-visited-')),
) {
	const context = await chromium.launchPersistentContext(profile, {
		executablePath: CHROME,
		headless: true,
		viewport: { width: 1280, height: 800 },
		args: ['--no-sandbox', `--host-resolver-rules=${resolver}`, ...args],
	});
	return {
		context,
		profile,
		close: async ({ keep = false } = {}) => {
			await context.close();
			if (!keep) rmSync(profile, { recursive: true, force: true });
		},
	};
}

/**
 * Which of the first `count` link squares of `frame` (a Playwright frame of
 * `page`, at any depth) are painted visited: an array of booleans. Throws
 * when a square is neither colour (the frame is covered or not there).
 */
export async function readLinks(page, frame, count) {
	let x = 0;
	let y = 0;
	if (frame.parentFrame()) {
		const element = await frame.frameElement();
		const box = await element.boundingBox();
		if (!box) throw new Error('the frame is not shown');
		({ x, y } = box);
	}
	const shot = decodePNG(
		await page.screenshot({
			clip: { x, y, width: count * 20, height: 20 },
			animations: 'disabled',
		}),
	);
	const scale = shot.width / (count * 20);
	return Array.from({ length: count }, (unused, i) => {
		const [r, g, b] = shot.at(
			Math.floor((i * 20 + 10) * scale),
			Math.floor(10 * scale),
		);
		if (r > 200 && g < 60 && b < 60) return true;
		if (b > 200 && r < 60 && g < 60) return false;
		throw new Error(`link ${i} is painted rgb(${r},${g},${b})`);
	});
}

/**
 * readLinks, repeated until it equals `expected` or `timeout` passed: the
 * history thread and the renderers' visited tables trail a navigation. The
 * last reading is returned either way.
 */
export async function readLinksUntil(
	page,
	frame,
	count,
	expected,
	timeout = 4000,
) {
	const start = Date.now();
	let last;
	for (;;) {
		try {
			last = await readLinks(page, frame, count);
		} catch (error) {
			last = String(error.message);
		}
		if (JSON.stringify(last) === JSON.stringify(expected)) return last;
		if (Date.now() - start > timeout) return last;
		await sleep(150);
	}
}
