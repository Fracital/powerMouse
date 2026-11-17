// Where a bundle has the text of its mixed content notices
// (../mixedContentNotices.ts): the document bundle's is a deferred part
// (./dom/deferred.ts), evaluated with a document's first notice, and the
// worker bundle's is its own. Each bundle's entry says which
// (dom/document.ts, worker/entry.ts).
import type { noticeText } from '../mixedContentNotices';

export const mixedContentParts: {
	noticeText?: () => typeof noticeText;
} = {};
