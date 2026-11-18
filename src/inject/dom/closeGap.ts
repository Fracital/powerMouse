// The document bundle's first act, before any other module of it runs: the
// gap view's getters come off the document (../../gapView.ts), so nothing of
// the bundle reads the page's values for the browser's
import { closeGapView } from '../../gapView';

closeGapView(document);
