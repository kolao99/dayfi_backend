import jwt from 'jsonwebtoken';
import dayjs from 'dayjs';
import config from '../../config/env';

class TokenService {
  // constructor() {}

  /**
   * Method to generate a signed JWT token
   * @param {object||string} data information to sign with JWT
   * @param {dayjs.Dayjs} timeToLive instance of dayjs package object.
   * @returns {string} JWT signed token
   */
  generateToken(data: object | string, timeToLive: dayjs.Dayjs): string {
    const payload = {
      data,
      exp: timeToLive.unix(),
    };
    return jwt.sign(payload, String(config?.JWT_SECRET));
  }

  /**
   * Method to sign and return JWT signed object
   * @param {object} user user information to sign with JWT
   * @returns {Promise<{ token: string, expires: Date }>} JWT signed token object
   */
  async generateAuthToken(user: any): Promise<any> {
    if (!user) {
      console.error(
        'Error: Admin object required to generate token for TokenService::generateAuthToken in token.service.js'
      );
      throw new Error(
        "We've encountered an issue. Please retry in a few minutes."
      );
    }
    try {
      const timeToLive = dayjs().add(6, 'hours');
      const data = {
        user_id: user.user_id,
        email: user.email,
      };
      const accessToken = this.generateToken(data, timeToLive);
      return {
        token: accessToken,
        expires: timeToLive.toDate(),
      };
    } catch (error) {
      console.error('Error: An error occurred generating token');
      throw new Error(
        "We've encountered an issue. Please retry in a few minutes. If the issue persists, please contact support."
      );
    }
  }
}

export default TokenService;
