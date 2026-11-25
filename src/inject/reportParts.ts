// Where a bundle has the un-routing of the reports a page reads through
// ReportingObserver (./reportsSeen.ts): the document bundle's is a deferred
// part (./dom/deferred.ts), evaluated when a document's first report
// reaches the page, and the worker bundle's is its own. Each bundle's entry
// says which (dom/document.ts, worker/entry.ts).
import type { madeReport, observerCalls, reportsSeen } from './reportsSeen';

export const reportParts: {
	seen?: () => typeof reportsSeen;
	/** what the page's observers do past their hooks */
	calls?: () => typeof observerCalls;
	/** the reports the inject makes itself (a document's only) */
	made?: () => typeof madeReport;
} = {};
