/**
 * The PDF pipeline test page: a canonical document the post-deploy
 * smoke renders through QAAgent's qaPrintPdf and emails as a PDF
 * attachment, proving the same print -> attach -> send path the
 * opportunity-hunt report uses (issue #135), on every deploy.
 */
export function printTestHtml(stamp: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>PDF Pipeline Test</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 2rem; color: #111; }
  h1 { font-size: 1.3rem; }
  table { border-collapse: collapse; margin-top: 1rem; }
  td, th { border: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; }
  th { background: #f3f4f6; }
</style></head><body>
<h1>PDF pipeline test</h1>
<p>Generated ${stamp} by QAAgent via Page.printToPDF and delivered by the EmailAgent as an application/pdf attachment. If you are reading this as a PDF, the render, attach, and send stages all work - the same path the opportunity-hunt report email uses.</p>
<table>
  <tr><th>Stage</th><th>Component</th></tr>
  <tr><td>Render</td><td>Browser Rendering - Page.printToPDF</td></tr>
  <tr><td>Attach</td><td>EmailAgent - application/pdf, base64 decoded to binary</td></tr>
  <tr><td>Deliver</td><td>Workers email binding</td></tr>
</table>
</body></html>`;
}

export function printTestSubject(stamp: string): string {
  return `PDF Pipeline Test: ${stamp.slice(0, 10)}`;
}

export function printTestBody(stamp: string): string {
  return [
    `Attached: the PDF pipeline test page, rendered by QAAgent via Page.printToPDF at ${stamp} and sent as an application/pdf attachment.`,
    "This exercises the same path as the opportunity-hunt report email (issue #135) on every deploy.",
  ].join("\n");
}
