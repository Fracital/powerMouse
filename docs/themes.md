# Themes in the demo

The demo UI (demo/public) has themes: Default (powerMouse's own look, black
with the noise and the striped header), Light, Dark, Follow system (Light or
Dark as the system's `prefers-color-scheme` is), and the Chrome Web Store
themes a user installs. The menu's Settings has the picker. The theme system
is the demo's, not the library's: `pm/theme.js` and the tokens in
`pm/main.css`, with `globalThis.PMTheme` as the interface the picker and the
Web Store install use.

The demo-themes suite covers it (see [Tests](#tests)).

## How it works

Every colour and background of the UI is a CSS custom property, a token,
named `--pm-<name>`. `:root` in `pm/main.css` holds the Default theme's
values. `:root[data-pm-theme='light']` and `:root[data-pm-theme='dark']` hold
Light's and Dark's. An installed theme is Light or Dark (its `scheme`) with
its own values for the tokens it sets. `pm/theme.js` writes those values into
a rule of its own, `:root[data-pm-theme][data-pm-custom]` in
`<style id="pmTheme">`, one `setProperty` call per token.

`pm/theme.js` is a classic script in `index.html`'s `<head>`, right after
`main.css`. It reads the saved choice and puts it on the root before the body
is parsed, so the first frame is already in the chosen theme. The suite checks
this at the first animation frame and again when the body arrives. The
pictures of an installed theme are kept in IndexedDB. Reading them back is
asynchronous, so until they arrive the theme shows its colours with no
picture. The pictures of the theme under it never show through.

The attributes on `<html>`:

| Attribute             | Meaning                                                                         |
| --------------------- | ------------------------------------------------------------------------------- |
| `data-pm-theme`       | `light` or `dark`; absent for Default                                           |
| `data-pm-choice`      | the chosen theme's id (`default`, `light`, `dark`, `system` or an installed id) |
| `data-pm-custom`      | an installed theme is shown                                                     |
| `data-pm-ntp-image`   | it has a new tab page picture (`theme_ntp_background`)                          |
| `data-pm-attribution` | it has an attribution picture as well, which Chrome shows only with one         |
| `data-pm-inactive`    | the window does not have the focus (Chrome's inactive frame colour)             |

Where the choice is kept (the demo page's own origin, like the other
settings):

| Key                                           | What                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `localStorage['stomp-demo:theme']`            | the chosen theme's id                                                |
| `localStorage['stomp-demo:themes']`           | the installed themes, with `'stored'` in place of each picture       |
| IndexedDB `stomp-demo-themes`, store `images` | the pictures, keyed `<id>\n<image name>` (and `\n<scale>` per scale) |

Another window of the demo follows a change through the `storage` event.

### Default stays as it was

Default's values are the ones the page had before themes, and the suite
checks every element's computed colours and backgrounds against a fixture.
Two rules keep Default's literal backgrounds rather than `var()`: `.head`
(the home page's title bar) and the base of `.listing`. Chrome antialiases
the rounded corners of a `display: table` box a shade differently once its
background comes through `var()`, or has an explicit position, size or
repeat. The themed rules (`:root[data-pm-theme] .head`,
`:root[data-pm-ntp-image] .listing`) carry the tokens instead.

What no theme changes: the quick links' coloured tiles, the white canvas
under a page (as in Chrome), and a card's close button over its page.

## The tokens

`PMTheme.TOKENS` lists them all (134), without the `--pm-` prefix. A token
ending in `-rgb` is three channels (`255, 255, 255`), which rules use at an
alpha of their own: `rgba(var(--pm-panel-fg-rgb), 0.12)`. `--pm-shadow-k`
scales the alpha of every shadow: Light's 0.35 softens Default's shadows,
which were drawn for a black page.

| Surface                                   | Tokens                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Home page (new tab page)                  | `page`, `page-image`, `text`, `ntp`, `ntp-image`, `ntp-position`, `ntp-size`, `ntp-repeat`, `ntp-text`, `ntp-attribution`                                                                                                                                                                                                                                                                                                                                                      |
| General                                   | `border`, `link`, `link-hover`, `link-active`, `link-bright`, `focus`, `status`, `error`, `error-soft`, `muted`, `hover`, `raised`, `raised-ring`, `rail`, `avatar`                                                                                                                                                                                                                                                                                                            |
| Accent (the GitHub button's yellow)       | `accent`, `accent-hover`, `accent-active`, `accent-text`, `on-accent`                                                                                                                                                                                                                                                                                                                                                                                                          |
| Title bar (Chrome's frame)                | `frame`, `frame-image`, `frame-overlay`, `frame-text`, `frame-inactive`                                                                                                                                                                                                                                                                                                                                                                                                        |
| Toolbar and the bar's buttons             | `toolbar`, `toolbar-image`, `toolbar-text`, `toolbar-button`, `toolbar-fg-rgb`, `navbar`, `navbar-icon`, `navbar-icon-hover`, `navbar-press`, `navbar-press-icon`                                                                                                                                                                                                                                                                                                              |
| Address boxes and suggestions             | `field`, `field-active`, `field-text`, `field-border`, `field-muted`, `field-focus`, `field-focus-ring`, `field-divider`, `field-hover`, `field-hover-text`, `field-fg-rgb`                                                                                                                                                                                                                                                                                                    |
| Chips and badges                          | `chip`, `chip-text`, `badge`, `badge-text`, `letter`, `letter-text`, `ext-badge`, `ext-badge-text`, `ext-highlight`                                                                                                                                                                                                                                                                                                                                                            |
| powerMouse's outline buttons              | `btn-blue`, `btn-green`, `btn-orange`, `btn-red`, `btn-text`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Tab manager (the tab strip)               | `recents`, `tab-image`, `tab-text`, `tab-icon`, `tab-text-muted`, `tab-pill`, `tab-pill-border`, `tab-hover`, `tab-line`                                                                                                                                                                                                                                                                                                                                                       |
| Request viewer                            | `sheet`, `sheet-fg-rgb`, `sheet-pill`, `sheet-ok`, `sheet-warn`, `sheet-error`, `sheet-link`, `sheet-on-link`, `sheet-tag`, `sheet-tag-border`                                                                                                                                                                                                                                                                                                                                 |
| Bookmarks sidebar                         | `bookmark-text`, `handle`, `handle-hover`, `handle-active`, `scrim`                                                                                                                                                                                                                                                                                                                                                                                                            |
| Permission, passkey and Web Store dialogs | `dialog`, `dialog-text`, `dialog-muted`, `dialog-focus`, `dialog-scrim`                                                                                                                                                                                                                                                                                                                                                                                                        |
| Popovers and the settings pages           | `panel`, `panel-sunken`, `panel-raised`, `panel-raised-hover`, `panel-control`, `panel-gutter`, `panel-text`, `panel-text-2`, `panel-text-3`, `panel-text-4`, `panel-strong`, `panel-accent`, `panel-accent-rgb`, `panel-on-accent`, `panel-accent-border`, `panel-accent-hover`, `panel-icon`, `panel-divider`, `panel-outline`, `panel-thumb`, `panel-fg-rgb`, `panel-warn`, `panel-warn-rgb`, `panel-good`, `panel-bad`, `panel-danger`, `panel-on-danger`, `panel-chevron` |
| Custom filters editor                     | `code-domain`, `code-sep`, `code-selector`, `code-option`, `code-exception`                                                                                                                                                                                                                                                                                                                                                                                                    |
| Shadows                                   | `shadow-rgb`, `shadow-k`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

The `panel-*` tokens were `--sh-*` before themes.

## PMTheme

```js
PMTheme.list(); // every theme: the four built-in ones, then the installed ones
PMTheme.current(); // the theme shown
PMTheme.apply('dark'); // choose a theme by id, and keep the choice
PMTheme.apply(theme); // show a theme object that is not installed, for this visit only
await PMTheme.install(theme); // keep a theme and switch to it
await PMTheme.remove(id); // forget an installed theme (uninstall is the same method)
PMTheme.fromChrome(manifest.theme, { id, name, extensionId, version }); // a Chrome theme as a theme
PMTheme.addEventListener('change', (event) => event.detail); // { reason, id, theme }
PMTheme.addEventListener('remove', (event) => event.detail); // { id, extensionId }
PMTheme.TOKENS; // the token names
PMTheme.IMAGES; // the Chrome image names a theme can have
```

A theme:

```js
{
	id: 'chrome-theme:<extension id>', // letters, digits and . : @ - _, at most 128
	name: 'Forest environment',
	source: 'builtin' | 'webstore',
	extensionId: '<extension id>', // optional
	version: '1.0', // optional
	scheme: 'light' | 'dark', // the built-in theme it starts from
	tokens: { frame: 'rgb(71, 105, 91)', ... }, // token name (no --pm-) to a CSS value
	images: { theme_frame: 'blob:...', theme_ntp_background: { '100_percent': 'blob:...', '200_percent': 'blob:...' } },
}
```

- `apply(id)` chooses a built-in or installed theme and saves the choice.
  `apply(object)` with a theme that is not installed shows it for this visit
  only and does not save it, which is how a preview works. An unknown id
  throws a `TypeError`.
- `install(theme)` validates the theme. It copies the pictures (blob: or
  data: URLs, or Blobs) into IndexedDB, so they outlive the URLs. Then it
  saves the theme and switches to it, as Chrome does when a theme is
  installed, and resolves the theme. A theme with the id of an installed one
  replaces it (an update). The same version of an installed theme again
  (same id, version, name, tokens and picture names) changes nothing and
  leaves the choice alone: the Web Store side hands the shown theme over on
  every load, and a user who went back to Light stays in Light.
- `remove(id)` forgets the theme and its pictures. When it was the one shown,
  the page goes back to Default, as Chrome resets to its default theme. It
  fires `remove` and then `change`, and resolves `false` for an id that is
  not installed. `uninstall` is the same method.
- `change` fires on every change of the theme shown. `reason` is `apply`,
  `preview`, `install`, `remove`, `system` (Follow system's scheme changed)
  or `storage` (another window changed it).
- `tokens` values are single CSS values. A value with `;`, `{`, `}`, `<`,
  `>`, `\` or `url(` is dropped, and so is a name that is not a token or is
  an image token: pictures come only through `images`. A built-in theme's id
  cannot be installed over. A picture is a `blob:`, `data:image/`, `http:`
  or `https:` URL, or a Blob, for one of the names in `PMTheme.IMAGES`. A
  picture per scale (`<n>_percent` keys) is shown as an `image-set()`.

The picker's Remove on a Web Store theme also calls
`controller.extensions.remove(extensionId)`, so the theme's extension is
uninstalled the way Chrome removes it.

## Chrome themes: fromChrome

`PMTheme.fromChrome({ colors, tints, properties, images }, meta)` takes a
manifest's `theme` key with Chrome's names. Each image is a URL or a Blob the
caller made of the package's file, or a dictionary of them per scale. It
returns a theme whose `source` is `webstore`. A colour the theme does not
give is derived as Chromium derives it (BrowserThemePack, ThemeHelper and
the colour mixers), so a theme that names only its frame still has a
toolbar, text that contrasts and so on. The colours Chromium resolved are on
the returned theme's non-enumerable `chrome` property as `[r, g, b, a]`
arrays, which the suite checks.

Colours are `[r, g, b]` or `[r, g, b, a]` with `a` from 0 to 1. A colour
with alpha is painted over what Chrome paints it over: white for
`ntp_background`, the toolbar for `omnibox_background`. A malformed colour
counts as missing, and so does a tint that is not three numbers. A tint
channel outside 0 to 1 means "keep".

| Chrome                | Default when missing                                                                             | Tokens                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `frame`               | #DEE1E6 shifted by the `frame` tint                                                              | `frame`                                                                                                  |
| `frame_inactive`      | the frame shifted by the `frame_inactive` tint (lightness 0.642), #E7EAED for Chrome's own frame | `frame-inactive`                                                                                         |
| `toolbar`             | white                                                                                            | `toolbar`, `navbar`, `tab-pill`                                                                          |
| `toolbar_text`        | Grey 800 (#3C4043), blended for 4.5:1 on the toolbar                                             | `toolbar-text`, `toolbar-fg-rgb`, `chip`                                                                 |
| `toolbar_button_icon` | Grey 700 (#5F6368) shifted by the `buttons` tint                                                 | `navbar-icon`, `navbar-icon-hover`, `navbar-press`, `navbar-press-icon`                                  |
| `tab_text`            | `toolbar_text`                                                                                   | `tab-text`, `tab-pill-border`                                                                            |
| `tab_background_text` | `toolbar_text` blended for 7.98:1 on the background tab                                          | `frame-text`, `tab-icon`, `tab-text-muted`, `tab-line`                                                   |
| `bookmark_text`       | `toolbar_text`                                                                                   | `bookmark-text`                                                                                          |
| `ntp_background`      | the toolbar                                                                                      | `page`, `ntp`, and the home page's hover and raised shades                                               |
| `ntp_text`            | the colour of most contrast with the page when a colour or picture is set, else black            | `text`, `ntp-text`, `muted`                                                                              |
| `ntp_link`            | Blue 700 (#1967D2)                                                                               | `link`, `link-hover`, `link-active`, `link-bright`, `focus`, `status`, `field-focus`, `field-focus-ring` |
| `ntp_header`          | `ntp_section`, else #969696                                                                      | `accent` and its shades, `border` (at 0x50)                                                              |
| `omnibox_background`  | the colour of most contrast with the text                                                        | `field-active` (the focused box and the suggestions), `field-hover`, `field-divider`                     |
| `omnibox_text`        | the colour of most contrast with the box                                                         | `field-text`, `field-hover-text`, `field-fg-rgb`, `field-border`, `field-muted`                          |
| `button_background`   | none                                                                                             | none (see below)                                                                                         |
| `background_tab`      | the frame shifted by the `background_tab` tint                                                   | the base of `recents`                                                                                    |

The address box at rest (`field`) is the toolbar pushed to 1.3:1 against
itself, as Chrome's location bar is. "The colour of most contrast" is white
on a dark colour and Grey 900 (#202124) on a light one, split at Chromium's
luminance midpoint (0.2117).

| Picture                 | Token             | Where                                                                                   |
| ----------------------- | ----------------- | --------------------------------------------------------------------------------------- |
| `theme_frame`           | `frame-image`     | the home page's title bar, and the tab strip (`recents`), tiled from the top left       |
| `theme_frame_overlay`   | `frame-overlay`   | over the frame picture, at the top left, once                                           |
| `theme_toolbar`         | `toolbar-image`   | the bar with the address box, the request viewer's and the cards' bars                  |
| `theme_tab_background`  | `tab-image`       | the tab strip, over the frame                                                           |
| `theme_ntp_background`  | `ntp-image`       | the home page's card, placed by `ntp_background_alignment` and `ntp_background_repeat`  |
| `theme_ntp_attribution` | `ntp-attribution` | the card's top right corner, only when there is a `theme_ntp_background` (as in Chrome) |

`ntp_background_alignment` is words among `top`, `bottom`, `left`, `right`
and `center` (`left` and `top` win over `right` and `bottom`, the default is
centred). `ntp_background_repeat` is `repeat`, `repeat-x` or `repeat-y`;
anything else is `no-repeat`. `ntp_logo_alternate` is read into
`chrome.ntp_logo_alternate` and is otherwise unused.

The `scheme` (which of Light and Dark the panels, menus and dialogs come
from) is dark when the frame is dark by Chromium's `IsDark`. Chromium itself
takes no scheme from a theme: the user's light or dark setting decides it.

What is not mapped, and why:

- `button_background` is the background of the window's caption buttons
  (minimize, maximize, close). The demo has none, and Chrome gives the
  toolbar's buttons no background, so `toolbar-button` stays transparent.
- `frame_incognito`, `frame_incognito_inactive` and the incognito pictures:
  the demo has no incognito window.
- `theme_frame_inactive`, `theme_window_control_background`,
  `theme_button_background` and `theme_tab_background_inactive`: there is no
  surface for them. `theme_tab_background_v` is Chrome's vertical tabs.
- Chrome picks a theme's colours from its pictures (k-means) only for the
  colours the user's own colour picker makes. Store themes give their
  colours, and fromChrome does not read the pictures.

## The Web Store

A theme installed from the store page reaches the demo through the
controller (docs/extensions.md). The demo hands the manifest's `theme` to
`fromChrome`, and the result to `install` with the extension's id and name.
When the theme changes or is reset, it removes the one it installed.

## Tests

`test/suites/demo-themes.mjs` checks:

- Default's computed colours and backgrounds on the home page, the browser
  view and the Shields panel against `test/fixtures/demo-themes-default.json`.
  The fixture was made from the demo before themes, and `UPDATE_EXPECTED=1`
  rewrites it from a run after a deliberate change to Default.
- `PMTheme.TOKENS` matches the tokens `main.css` defines and uses, and each
  built-in theme gives every token a value.
- Light, Dark and Follow system, through the picker and its arrow keys, on a
  dark system that turns light, and in another window.
- The theme after a reload, from the first frame.
- fromChrome on three manifests: Chrome's own colours for an empty theme,
  tints and alpha, a theme that names every colour, and pictures per scale.
- install, the reload with the pictures read back from IndexedDB, the
  picker's Remove and the `remove` event, a reinstall of the same version,
  and the values install refuses.
