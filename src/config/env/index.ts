import development from './development';
import production from './prod';
import { JwtSignature } from '../../shared/interfaces';

export const JwtSignOptions: JwtSignature = {
  issuer: 'Template',
  subject: 'Authentication Token',
  audience: 'https://template.com',
};

export default {
  development,
  production,
}[process.env.SWITCH_NODE_ENV || 'development'];
