import Env from '../utils/env';
import { v1 as uuidv1 } from 'uuid';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import config from '../../config/env';

export interface HashingService {
  hash(data: string, salt?: string): Promise<string>;
  compare(data: string, hash: string): Promise<boolean>;
  generateVerificationHash(): string;
  getHash(text: string): Promise<string>;
  verifyHash(text: string, hashedText: string): Promise<boolean>;
  decodeToken(token: string): object | string;
}

export class HashingServiceImpl implements HashingService {
  private readonly saltRound = Env.get<number>('SALT_ROUND');

  public async hash(
    data: string,
    salt = bcrypt.genSaltSync(Number(this.saltRound))
  ): Promise<string> {
    return bcrypt.hash(data, salt);
  }

  public async compare(data: string, hash: string): Promise<boolean> {
    return bcrypt.compare(data, hash);
  }

  public generateVerificationHash(): string {
    return uuidv1();
  }

  /**
   * Static method that generates and returns a hashed text
   * @param {string} text text to be hashed.
   * @returns {Promise<string>} hashed text
   */
  public async getHash(text: string): Promise<string> {
    try {
      console.log('INFO: Attempting to hash text in hashText.ts');
      const saltRounds = Number(config?.SALT_ROUND);
      const hash = await bcrypt.hash(text, saltRounds);

      console.log('INFO: Text successfully hashed in hashText.ts');
      return hash;
    } catch (err) {
      console.error(
        'ERROR: An error occurred while hashing text in hashText.ts'
      );
      throw new Error(
        'An error occurred. Please try again or contact support.'
      );
    }
  }

  /**
   * Verify token and return token doc (or throw an error if it is not valid)
   * @param {string} text text to compare with hash
   * @param {string} hashedText hashed text
   * @returns {Promise<boolean>} Whether the text matches the hashed text
   */
  public async verifyHash(text: string, hashedText: string): Promise<boolean> {
    try {
      console.log('INFO: Attempting to verify text in hashText.ts');
      const isTextAMatch = await bcrypt.compare(text, hashedText);

      console.log('INFO: Text successfully verified in hashText.ts');
      return isTextAMatch;
    } catch (error) {
      console.error(
        'ERROR: An error occurred while verifying text in hashText.ts'
      );
      throw new Error('Could not hash text.');
    }
  }

  /**
   * Decode token and return token doc (or throw an error if it is not valid)
   * @param {string} token JWT token to decode
   * @returns {object | string} Decoded token payload or error message
   */
  public decodeToken(token: string): object | string {
    try {
      console.log('INFO: Attempting to verify auth token in hashText.ts');
      return jwt.verify(token, String(config?.JWT_SECRET));
    } catch (error) {
      console.error(
        'ERROR: An error occurred while verifying auth token in hashText.ts'
      );
      return error;
    }
  }
}

const hashingService: HashingService = new HashingServiceImpl();

export default hashingService;
