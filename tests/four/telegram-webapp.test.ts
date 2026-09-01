import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
  buildStubInitData,
  validateTelegramWebAppInitData,
} from '../../src/modules/four/telegram/telegramWebAppAuth';

const BOT = 'test-bot-token-12345';

describe('four: telegram webapp initData', () => {
  it('validates a correctly signed payload', () => {
    const initData = buildStubInitData(424242, BOT);
    const result = validateTelegramWebAppInitData(initData, BOT);
    expect(result.ok).to.equal(true);
    if (result.ok) {
      expect(result.user.id).to.equal(424242);
    }
  });

  it('rejects tampered payloads', () => {
    const initData = buildStubInitData(424242, BOT);
    const tampered = initData.replace('424242', '999999');
    const result = validateTelegramWebAppInitData(tampered, BOT);
    expect(result.ok).to.equal(false);
  });

  it('rejects missing hash', () => {
    const result = validateTelegramWebAppInitData('user=%7B%7D', BOT);
    expect(result.ok).to.equal(false);
  });
});
