<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
	<xsl:output method="html" />
	<xsl:template match="/">
		<html>
			<head><title>XSLT OUTPUT</title></head>
			<body>
				<ul id="list">
					<xsl:for-each select="list/entry">
						<li><xsl:value-of select="." /></li>
					</xsl:for-each>
				</ul>
				<script>
					setTimeout(function () {
						window.__pi = {
							done: true,
							cases: {
								xslt: {
									title: document.title,
									items: document.querySelectorAll('li').length,
									href: location.href,
									top: top === window,
								},
							},
						};
					}, 500);
				</script>
			</body>
		</html>
	</xsl:template>
</xsl:stylesheet>
