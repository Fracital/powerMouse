import type { SiteContext } from '../transport/messages';
import { arrivingHints, departingHints } from './clientHints';
import { rememberUpgradeInsecure, upgradesInsecure } from './insecureRequests';

/**
 * The site pool (src/controller/sitePool.ts): a frame of a site another slot
 * shows is served by that slot's worker, which never served the frame's
 * parent or its main frame. What the frame's navigation is judged by there
 * in one origin (the parent's permissions policy and delegate-ch, the main
 * frame's policy, accepted hints and viewport, the parent's
 * upgrade-insecure-requests) goes with it (SiteArrival.context), and the
 * worker it arrives at keeps it as if it had served them: the frame's later
 * navigations find it there too. `referrer`: the parent's routed URL on
 * this worker's origin; `top`: the main frame's origin (a nested route's).
 */
export async function contextDeparture(
	referrer: string | null,
	top: string | null,
	directory: string,
): Promise<SiteContext | undefined> {
	const hints = await departingHints(referrer, top, directory);
	const upgradeInsecure = !!referrer && upgradesInsecure(undefined, referrer);
	if (!Object.keys(hints).length && !upgradeInsecure) return undefined;
	return {
		...(Object.keys(hints).length ? { hints } : {}),
		...(upgradeInsecure ? { upgradeInsecure } : {}),
	};
}

/**
 * The site pool: the context a navigation from another slot came with
 * (contextDeparture), kept here; `referrer` is the parent's route on this
 * worker's origin, as the navigation's referrer reads here (siteArrived)
 */
export function contextArrived(
	context: SiteContext | undefined,
	referrer: string | null,
	directory: string,
	topLevel: boolean,
) {
	if (!context || typeof context !== 'object') return;
	if (context.hints && typeof context.hints === 'object')
		arrivingHints(context.hints, referrer, directory, topLevel);
	if (context.upgradeInsecure === true && referrer)
		rememberUpgradeInsecure(referrer);
}
