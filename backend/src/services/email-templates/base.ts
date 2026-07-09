/**
 * Base HTML email template with Ooosh branding.
 *
 * Two layout variants:
 * - 'client': Polished, full branding (logo, colours, professional footer)
 * - 'internal': Simpler but consistent styling for operational emails
 */

const OOOSH_PURPLE = '#7B5EA7';
const OOOSH_DARK = '#1e293b';
// Logo: stored in R2 at assets/ooosh-logo.png but no public URL yet.
// TODO: Add logo to emails once a public-accessible URL is available.

// ── Email signature (client-facing NEW emails only) ──────────────────────
// Mirrors the company Gmail signature. Applied to the 'client' base-layout
// footer only — NOT internal ops alerts, and NOT the auto-chase Gmail drafts
// (those are plain-text and get Gmail's own signature when a human sends them,
// so adding ours there would double up). Images are hosted on the existing
// signature CDN and all carry alt text + explicit dimensions, so the block
// still reads cleanly if a recipient's mail app blocks images.
const SIG_IMG = 'https://daphnis.wbnusystem.net/~wbplus/websites/AD2903129/images';
// Two company logos live on a signature variant not in this mailbox. Paste the
// image URLs here (right-click the image in a current signature email →
// "Copy image address"). Left blank ⇒ that logo is simply not rendered.
const OOOSH_LOGO_URL = 'https://pub-0e6f101eb29f4f26b299d7a184b5f609.r2.dev/email-assets/ooosh-tours-logo-small.jpg';        // Ooosh disc logo (130x119)
const ONE_PERCENT_LOGO_URL = 'https://pub-0e6f101eb29f4f26b299d7a184b5f609.r2.dev/email-assets/1percentbanner-ooosh.jpg';  // "1% for the Planet" banner (400x64)

/** The company signature block used in the client base-layout footer. */
function renderClientSignature(): string {
  const logoCell = OOOSH_LOGO_URL
    ? `<td style="vertical-align:top;padding-right:18px;"><a href="https://www.oooshtours.co.uk/" style="text-decoration:none;"><img src="${OOOSH_LOGO_URL}" alt="Ooosh Tours" width="120" height="110" style="display:block;border:0;max-width:120px;"></a></td>`
    : '';
  const onePercentRow = ONE_PERCENT_LOGO_URL
    ? `<tr><td style="padding:16px 0 0;"><a href="https://www.oooshtours.co.uk/contact/about-us" style="text-decoration:none;"><img src="${ONE_PERCENT_LOGO_URL}" alt="1% for the Planet member" width="200" height="32" style="display:block;border:0;max-width:200px;"></a></td></tr>`
    : '';

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="text-align:left;font-family:Arial,Helvetica,sans-serif;">
      <tr>
        <td style="padding:0 0 14px;font-size:13px;color:#334155;line-height:1.5;">
          <strong style="font-style:italic;">🎸 Have you thought about consumables for your tour or event?</strong><br>
          Check out our online shop <a href="https://www.thetour.store/" style="color:${OOOSH_PURPLE};text-decoration:none;">The Tour Store</a> for gaffa &amp; fluoro tape, batteries, Sharpies, drum heads, strings and loads more!<br>
          Collect from us, have delivered with your order, or we can ship worldwide.
        </td>
      </tr>
      <tr>
        <td style="border-top:1px solid #e4e4e7;padding:16px 0 0;">
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr>
              ${logoCell}
              <td style="vertical-align:top;font-size:13px;color:#334155;line-height:1.6;">
                <div><strong>E:</strong> <a href="mailto:info@oooshtours.co.uk" style="color:${OOOSH_PURPLE};text-decoration:none;">info@oooshtours.co.uk</a></div>
                <div><strong>P:</strong> +44 (0)1273 911382</div>
                <div><strong>W:</strong> <a href="https://oooshtours.co.uk" style="color:${OOOSH_PURPLE};text-decoration:none;">oooshtours.co.uk</a></div>
                <div style="padding-top:10px;">
                  <a href="https://www.instagram.com/oooshtours/?hl=en" style="text-decoration:none;"><img src="${SIG_IMG}/sm-instagram-50.png" alt="Instagram" width="28" height="28" style="border:0;vertical-align:middle;"></a>&nbsp;&nbsp;
                  <a href="https://en-gb.facebook.com/OooshToursLtd" style="text-decoration:none;"><img src="${SIG_IMG}/sm-face-50.png" alt="Facebook" width="28" height="28" style="border:0;vertical-align:middle;"></a>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      ${onePercentRow}
      <tr>
        <td style="padding:14px 0 0;font-size:11px;color:#71717a;line-height:1.5;">
          <strong>Ooosh! Tours Ltd</strong>, Compass House, 7 East Street, Portslade, Brighton, BN41 1DL<br>
          Registered in England &amp; Wales, company number 07590921 &middot; VAT registration number 114087243
        </td>
      </tr>
      <tr>
        <td style="padding:10px 0 0;font-size:10px;color:#a1a1aa;line-height:1.4;">
          This email and any attachments are confidential and intended only for the named recipient. If it's reached you by mistake, please let us know and delete it.
        </td>
      </tr>
    </table>`;
}

/**
 * Wrap email body content in the branded base layout.
 */
export function wrapInBaseLayout(
  bodyHtml: string,
  options: { variant: 'client' | 'internal'; preheader?: string } = { variant: 'internal' },
): string {
  const { variant, preheader } = options;

  const preheaderHtml = preheader
    ? `<div style="display:none;font-size:1px;color:#f8f8f8;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>`
    : '';

  if (variant === 'client') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ooosh Tours</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  ${preheaderHtml}
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;">
          <!-- Header -->
          <tr>
            <td style="background-color:${OOOSH_PURPLE};padding:24px 32px;border-radius:12px 12px 0 0;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">
                Ooosh Tours Ltd
              </h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="background-color:#ffffff;padding:32px;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7;">
              ${bodyHtml}
            </td>
          </tr>
          <!-- Footer / signature -->
          <tr>
            <td style="background-color:#fafafa;padding:24px 32px;border-radius:0 0 12px 12px;border:1px solid #e4e4e7;border-top:none;">
              ${renderClientSignature()}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  // Internal / operational variant
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ooosh Operations</title>
</head>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  ${preheaderHtml}
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#f8fafc;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;">
          <!-- Header -->
          <tr>
            <td style="padding:16px 24px;border-bottom:2px solid ${OOOSH_PURPLE};">
              <span style="font-size:14px;font-weight:700;color:${OOOSH_DARK};letter-spacing:-0.3px;">OOOSH OPS</span>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="background-color:#ffffff;padding:24px;border:1px solid #e2e8f0;border-top:none;">
              ${bodyHtml}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:12px 24px;">
              <p style="margin:0;font-size:11px;color:#94a3b8;text-align:center;">
                Ooosh Operations Platform &bull; Internal use only
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Generate a test mode banner showing the intended recipient.
 */
export function testModeBanner(intendedRecipient: string): string {
  return `
    <p style="margin:0 0 16px 0;font-size:12px;color:#6b7280;">
      TEST MODE — This email would have been sent to: ${intendedRecipient}
    </p>
  `;
}
