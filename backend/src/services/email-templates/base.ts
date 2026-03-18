/**
 * Base HTML email template with Ooosh branding.
 *
 * Two layout variants:
 * - 'client': Polished, full branding (logo, colours, professional footer)
 * - 'internal': Simpler but consistent styling for operational emails
 */

const OOOSH_ORANGE = '#f97316';
const OOOSH_DARK = '#1e293b';

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
            <td style="background-color:${OOOSH_ORANGE};padding:24px 32px;border-radius:12px 12px 0 0;text-align:center;">
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
          <!-- Footer -->
          <tr>
            <td style="background-color:#fafafa;padding:20px 32px;border-radius:0 0 12px 12px;border:1px solid #e4e4e7;border-top:none;">
              <p style="margin:0;font-size:12px;color:#71717a;text-align:center;line-height:1.5;">
                Ooosh Tours Ltd &bull; Event Production &amp; Logistics<br>
                <a href="https://oooshtours.co.uk" style="color:${OOOSH_ORANGE};text-decoration:none;">oooshtours.co.uk</a>
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
            <td style="padding:16px 24px;border-bottom:2px solid ${OOOSH_ORANGE};">
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
    <div style="background-color:#fef3c7;border:2px solid #f59e0b;border-radius:8px;padding:12px 16px;margin-bottom:20px;">
      <p style="margin:0;font-size:13px;color:#92400e;font-weight:600;">
        TEST MODE — This email would have been sent to: ${intendedRecipient}
      </p>
    </div>
  `;
}
