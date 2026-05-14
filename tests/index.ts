// Unit tests
import './unit/base-entity';
import './unit/middlewares/globalLogger';
import './unit/error';
import './unit/env';
import './unit/middlewares/validator';

// Integration tests
import './integration/admin/authentication/index';
import './integration/roles/index';
import './integration/authentication/index';
import './integration/customer/index'
import './integration/admin/shared/index';
import './integration/admin/user/index';
import './integration/tiers/index'
import './integration/settings/index'
import './integration/notifications/index'
import './integration/payments/index'
