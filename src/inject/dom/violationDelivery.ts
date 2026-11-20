// Where a violation of the page's own policy goes besides the page: the
// policy's report-uri endpoints, as Chrome sends to them (measured, Chrome
// 157): one POST of application/csp-report to each as the violation is
// made, no-cors, with Sec-Fetch-Dest: report, the cookies of an endpoint of
// the document's own origin only, its Referer by the document's policy,
// and none for a report that reads as one the document sent already. The
// browser never gets the page's report-uri (src/csp.ts browserPolicy: it
// would post the proxy's URLs), so the inject sends them, for the
// violations it makes (./policyChecks.ts makeReport) and for the browser's
// the page sees (./violations.ts violationShows). A deferred part
// (./deferred.ts): only a page whose policy reports reaches it.
import type { Policy } from '../../csp';
import { routeXHR } from '../../routeURL';
import StompURL from '../../StompURL';
import { LazySet, LazyWeakMap } from '../ownCollections';
import type { ViolationReportBody } from '../reportsSeen';
import type DocumentClient from './Client';
import { loadFetch } from './loadGrants';

/** each document's reports sent, as their bodies read */
const sentReports = new LazyWeakMap<object, LazySet<string>>();

/**
 * Send the report of a violation of `policy` (`body`, as a
 * ReportingObserver reads it) to the policy's report-uri endpoints
 */
export function deliverReport(
	client: DocumentClient,
	policy: Policy,
	body: ViolationReportBody,
) {
	// (a policy with report-to reports there, and to no report-uri)
	if (policy.directives.has('report-to')) return;
	const endpoints = policy.directives.get('report-uri');
	if (!endpoints?.length) return;
	// Chrome's members, in its order: the place only where there is one
	const report: Record<string, unknown> = {
		'document-uri': body.documentURL,
		referrer: body.referrer,
		'violated-directive': body.effectiveDirective,
		'effective-directive': body.effectiveDirective,
		'original-policy': body.originalPolicy,
		disposition: body.disposition,
		'blocked-uri': body.blockedURL,
	};
	if (body.sourceFile) {
		report['line-number'] = body.lineNumber;
		report['column-number'] = body.columnNumber;
		report['source-file'] = body.sourceFile;
	}
	report['status-code'] = body.statusCode;
	report['script-sample'] = body.sample;
	const text = JSON.stringify({ 'csp-report': report });
	let sent = sentReports.get(client);
	if (!sent) sentReports.set(client, (sent = new LazySet()));
	if (sent.has(text)) return;
	sent.add(text);
	for (const endpoint of endpoints) {
		let url: URL;
		try {
			url = new URL(endpoint, client.url.url);
		} catch (error) {
			continue;
		}
		if (!/^https?:$/.test(url.protocol)) continue;
		try {
			loadFetch(
				client,
				routeXHR(new StompURL(url, client.url)),
				'report no-cors',
				{
					method: 'POST',
					body: text,
					credentials: 'same-origin',
					keepalive: true,
					headers: { 'content-type': 'application/csp-report' },
				},
			).catch(() => {});
		} catch (error) {
			// a document being torn down
		}
	}
}
