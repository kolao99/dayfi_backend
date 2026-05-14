import dayjs from 'dayjs';

export const CURRENT_TIME_STAMP = `${dayjs().format('DD-MMM-YYYY, HH:mm:ss')}`;

export const GET_USER_MIDDLEWARE = 'UserMiddleware::getUser';
export const CHECK_EXPIRY_MIDDLEWARE = 'UserMiddleware:checkExpiry';
export const HASH_DATA_MIDDLEWARE = 'AuthMiddleware::hashData';
export const RESET_PASSWORD_CONTROLLER = 'AuthController::resetPassword';
export const GET_AUTH_TOKEN_MIDDLEWARE = 'AuthMiddleware::getAuthToken';
export const VALIDATE_USER_AUTH_TOKEN_MIDDLEWARE =
  'AuthMiddleware::validateUserAuthToken';
export const VALIDATE_PASSWORD_MIDDLEWARE = 'AuthMiddleware::validatePassword';
export const VALIDATE_PASSWORD_OR_PIN_MIDDLEWARE =
  'AuthMiddleware::validatePasswordOrPin';
