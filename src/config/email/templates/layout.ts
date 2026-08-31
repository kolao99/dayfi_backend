import {
  DAYFI_EMAIL_BRAND,
  dayfiEmailLogoUrl,
  dayfiPublicUrl,
} from './brand';

type LayoutOptions = {
  preheader?: string;
  content: string;
};

export function dayfiEmailLayout({ preheader, content }: LayoutOptions): string {
  const { canvas, muted, border } = DAYFI_EMAIL_BRAND;
  const logoUrl = dayfiEmailLogoUrl();
  const siteUrl = dayfiPublicUrl();
  const year = new Date().getFullYear();
  const hiddenPreheader = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${preheader}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>Dayfi</title>
</head>
<body style="margin:0;padding:0;background-color:${canvas};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  ${hiddenPreheader}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${canvas};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;">
          <tr>
            <td align="center" style="padding:0 0 24px;">
              <a href="${siteUrl}" style="text-decoration:none;">
                <img src="${logoUrl}" width="120" height="32" alt="Dayfi" style="display:block;height:32px;width:auto;max-width:120px;border:0;outline:none;text-decoration:none;" />
              </a>
            </td>
          </tr>
          <tr>
            <td style="background-color:#ffffff;border:1px solid ${border};border-radius:20px;padding:32px 28px;box-shadow:0 18px 40px rgba(11,14,26,0.06);">
              ${content}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:20px 8px 0;font-family:Inter,Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:${muted};">
              <p style="margin:0 0 6px;">Payment infrastructure for Africa</p>
              <p style="margin:0;">
                <a href="${siteUrl}" style="color:${muted};text-decoration:underline;">dayfi.co</a>
                &nbsp;·&nbsp;© ${year} Dayfi Technologies Ltd.
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

export function dayfiEmailHeading(text: string): string {
  const { ink } = DAYFI_EMAIL_BRAND;
  return `<h1 style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:800;line-height:1.15;letter-spacing:-0.04em;text-transform:uppercase;color:${ink};">${text}</h1>`;
}

export function dayfiEmailParagraph(
  html: string,
  opts?: { muted?: boolean; marginBottom?: number }
): string {
  const { ink, muted } = DAYFI_EMAIL_BRAND;
  const color = opts?.muted ? muted : ink;
  const mb = opts?.marginBottom ?? 16;
  return `<p style="margin:0 0 ${mb}px;font-family:Inter,Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;letter-spacing:-0.01em;color:${color};">${html}</p>`;
}
