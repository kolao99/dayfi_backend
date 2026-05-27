export const welcomeUserEmail = (
  firstName: string,
  
  userOtp: string
) => ` <!DOCTYPE html>
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
  </head>
  <body
    style="
      font-family: 'Inter', Arial, sans-serif;
      background-color: #ffffff;
      margin: 0;
      padding: 0;
    "
  >
    <table
      role="presentation"
      cellspacing="0"
      cellpadding="0"
      border="0"
      width="100%"
      style="width: 100%; max-width: 480px; margin: auto; padding: 20px 40px"
    >
      <tr>
        <td align="center" style="padding-bottom: 32px">
          <img
            style="height: 24px"
            src="https://res.cloudinary.com/kneenk/image/upload/v1742317902/tikket-logo_m6glgp.png"
            alt="Tikket Logo"
          />
        </td>
      </tr>

      <tr>
        <td
          style="
            width: 100%;
            margin: auto;
            border: 1px solid #e7ecf2;
            padding: 32px;
            border-radius: 8px;
          "
        >
          <h2 style="font-size: 20px; font-weight: 600; color: #171c26">
            Log In to Tikket
          </h2>
          <p style="font-size: 14px; font-weight: 400; color: #171c26">
            Hi ${firstName}, <br /><br />
            Please enter the OTP below to complete your log in.
          </p>

          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td align="center">
                <table
                  role="presentation"
                  cellspacing="0"
                  cellpadding="0"
                  border="0"
                  width="100%"
                >
                  <tr>
                    <td
                      align="center"
                      style="
                        border: 1px solid #e7ecf2;
                        border-radius: 6px;
                        padding: 16px;
                      "
                    >
                      <p
                        style="
                          font-size: 20px;
                          font-weight: 600;
                          color: #171c26;
                          margin: 0;
                        "
                      >
                        ${userOtp}
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>

          <p style="font-size: 14px; font-weight: 400; color: #171c26">
            This code expires in 5 minutes.
          </p>
          <p
            style="
              font-size: 14px;
              font-weight: 400;
              line-height: 140%;
              color: #171c26;
            "
          >
            If you didn’t request this OTP, we strongly advise you reset your
            password immediately to secure your account and notify us as soon as
            possible.
          </p>
          <p
            style="
              font-size: 14px;
              font-weight: 400;
              line-height: 140%;
              color: #171c26;
            "
          >
            Best Regards
            <span style="display: flex; margin-bottom: 4px"></span>Tikket Team
          </p>
        </td>
      </tr>

      <tr>
        <td align="center" style="padding-top: 16px">
          <p style="font-size: 14px; color: #171c26">
            © Tikket 2025
            <br />Modern Event Platform for Africa
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>

  `;
