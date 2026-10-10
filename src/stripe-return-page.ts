/**
 * The page Stripe sends the browser to after a card payment.
 *
 * Deliberately display-only: it never fulfils an order. A browser redirect is
 * not proof of payment, so fulfilment happens only in the signature-verified
 * Stripe webhook. This page reads the checkout's state and reports it.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderStripeReturnPage(options: {
  requestId: string;
  found: boolean;
  fulfilled: boolean;
}): string {
  const { requestId, found, fulfilled } = options;

  const headline = fulfilled
    ? "Payment received"
    : found
      ? "Confirming your payment"
      : "Checkout not found";

  const detail = fulfilled
    ? "Your request has been processed and the answer is on its way to your inbox."
    : found
      ? "We are confirming the payment with Stripe. You can close this page - the answer will be emailed as soon as the payment clears."
      : "We could not find that checkout reference. If you completed a payment and no email arrives, contact support with your reference.";

  const reference = requestId
    ? '<p class="ref">Reference: ' + escapeHtml(requestId) + "</p>"
    : "";

  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>" + escapeHtml(headline) + "</title>",
    "<style>",
    "  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;",
    "       color:#e6e8eb;display:flex;min-height:100vh;align-items:center;justify-content:center;",
    "       margin:0;padding:1.5rem}",
    "  .card{background:#171a21;border:1px solid #262b36;border-radius:12px;padding:2rem;max-width:34rem}",
    "  h1{font-size:1.25rem;margin:0 0 .75rem}",
    "  p{color:#9aa4b2;line-height:1.6;margin:0 0 1.25rem}",
    "  a{color:#7aa2f7;text-decoration:none}",
    "  .ref{font-size:.8rem;color:#5c6675;word-break:break-all;margin:0}",
    "</style></head>",
    '<body><div class="card">',
    "  <h1>" + escapeHtml(headline) + "</h1>",
    "  <p>" + escapeHtml(detail) + "</p>",
    '  <p><a href="/">Back to the dashboard</a></p>',
    "  " + reference,
    "</div></body></html>",
  ].join("\n");
}
