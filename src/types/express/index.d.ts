import 'express';
import { User } from '../../modules/authentication/services';
import { JwtPayload } from 'jsonwebtoken';

declare global {
  namespace Express {
    interface Request {
      user?: User | JwtPayload;
      validatedBody?: any;
      validatedQuery?: any;
      hashed?: string;
      token?: string;
      business?: any;
    }
  }
}
