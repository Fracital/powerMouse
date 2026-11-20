### Demo and API

- The demo's page names `omnibox.js` in a deferred tag, which its server stamps with the file's hash and serves immutable, so a reload no longer revalidates it. A page without the tag, or whose tag fails, still loads it by `assetName('omnibox')`.
