### Fidelity

- A `<style>` whose text contains `</script>` (inside a string or a comment)
  no longer breaks out of the stand-in script the proxy writes to keep the
  style's text readable (`adversarial-parse-html`).
