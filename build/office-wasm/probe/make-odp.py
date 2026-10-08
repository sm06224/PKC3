import sys, zipfile
out = sys.argv[1]
NS = ('xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
 'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" '
 'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
 'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" '
 'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" '
 'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" '
 'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" '
 'xmlns:xlink="http://www.w3.org/1999/xlink"')
mime = 'application/vnd.oasis.opendocument.presentation'
manifest = ('<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">'
 f'<manifest:file-entry manifest:full-path="/" manifest:media-type="{mime}"/>'
 '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>'
 '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>')
styles = ('<?xml version="1.0" encoding="UTF-8"?>'
 f'<office:document-styles {NS} office:version="1.2">'
 '<office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm" fo:page-width="28cm" fo:page-height="15.75cm" style:print-orientation="landscape"/></style:page-layout></office:automatic-styles>'
 '<office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles></office:document-styles>')
content = ('<?xml version="1.0" encoding="UTF-8"?>'
 f'<office:document-content {NS} office:version="1.2">'
 '<office:automatic-styles>'
 '<style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:stroke="solid" svg:stroke-color="#000000" draw:fill="solid" draw:fill-color="#ffffcc" fo:padding="0.2cm"/></style:style>'
 '<style:style style:name="dp1" style:family="drawing-page"/></office:automatic-styles>'
 '<office:body><office:presentation>'
 '<draw:page draw:name="page1" draw:style-name="dp1" draw:master-page-name="Default">'
 '<draw:frame draw:style-name="gr1" draw:name="box1" svg:x="2cm" svg:y="2cm" svg:width="24cm" svg:height="10cm">'
 '<draw:text-box><text:p>ORIG</text:p></draw:text-box></draw:frame>'
 '</draw:page></office:presentation></office:body></office:document-content>')
with zipfile.ZipFile(out, 'w') as z:
    z.writestr('mimetype', mime, zipfile.ZIP_STORED)
    z.writestr('META-INF/manifest.xml', manifest, zipfile.ZIP_DEFLATED)
    z.writestr('content.xml', content, zipfile.ZIP_DEFLATED)
    z.writestr('styles.xml', styles, zipfile.ZIP_DEFLATED)
print(out)
