/**
 * Four Phase 1 (C12) — E.164 normalization.
 *
 * Pure unit tests, no database. Divergence here is an account-takeover bug:
 * two spellings of one number MUST collapse to a single identity key.
 *
 * Run: npm run test:four-phone
 */

import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
  maskPhoneE164,
  normalizePhoneE164,
  toPhoneE164OrNull,
  toPhoneE164OrThrow,
} from '../../src/shared/utils/phoneE164';

describe('four: phone E.164 normalization', () => {
  describe('Nigerian numbers collapse to one canonical form', () => {
    const canonical = '+2348012345678';
    const spellings = [
      '08012345678',
      '8012345678',
      '2348012345678',
      '+2348012345678',
      '+234 801 234 5678',
      '+234-801-234-5678',
      '0801 234 5678',
      '(0801) 234-5678',
      '002348012345678',
      '  +2348012345678  ',
    ];

    spellings.forEach((input) => {
      it(`normalizes ${JSON.stringify(input)} -> ${canonical}`, () => {
        const result = normalizePhoneE164(input);
        expect(result.ok, `expected ${input} to normalize`).to.equal(true);
        if (result.ok) expect(result.e164).to.equal(canonical);
      });
    });

    it('maps every spelling to exactly one identity key', () => {
      const keys = new Set(spellings.map((s) => toPhoneE164OrNull(s)));
      expect(keys.size).to.equal(1);
      expect([...keys][0]).to.equal(canonical);
    });
  });

  describe('accepts valid NG mobile prefixes', () => {
    [
      ['07012345678', '+2347012345678'],
      ['08112345678', '+2348112345678'],
      ['09012345678', '+2349012345678'],
    ].forEach(([input, expected]) => {
      it(`${input} -> ${expected}`, () => {
        expect(toPhoneE164OrNull(input)).to.equal(expected);
      });
    });
  });

  describe('rejects invalid input', () => {
    const cases: Array<[string | null | undefined, string]> = [
      [null, 'empty'],
      [undefined, 'empty'],
      ['', 'empty'],
      ['   ', 'empty'],
      ['not-a-number', 'contains_letters'],
      ['+234801234567a', 'contains_letters'],
      ['0801234567', 'too_short'],
      ['080123456789', 'too_long'],
      ['06012345678', 'invalid_national_number'],
      ['+1234', 'too_short'],
      ['+1234567890123456', 'too_long'],
    ];

    cases.forEach(([input, reason]) => {
      it(`rejects ${JSON.stringify(input)} (${reason})`, () => {
        const result = normalizePhoneE164(input);
        expect(result.ok).to.equal(false);
        if (!result.ok) expect(result.reason).to.equal(reason);
      });
    });

    it('returns null rather than throwing in the nullable variant', () => {
      expect(toPhoneE164OrNull('garbage')).to.equal(null);
    });

    it('throws in the strict variant', () => {
      expect(() => toPhoneE164OrThrow('garbage')).to.throw(
        /Invalid phone number/
      );
    });
  });

  describe('passes through already-valid international numbers', () => {
    [
      ['+14155552671', '+14155552671'],
      ['+442071838750', '+442071838750'],
      ['+27831234567', '+27831234567'],
    ].forEach(([input, expected]) => {
      it(`${input} -> ${expected}`, () => {
        expect(toPhoneE164OrNull(input)).to.equal(expected);
      });
    });

    it('does not guess a country for a bare non-NG national number', () => {
      // 4155552671 is a US number, but without a + Four must not assume.
      // Under the NG default it is simply not a valid NG NSN.
      expect(toPhoneE164OrNull('4155552671')).to.equal(null);
    });
  });

  describe('masking for logs', () => {
    it('hides the middle of the number', () => {
      expect(maskPhoneE164('+2348012345678')).to.equal('+234•••5678');
    });

    it('never leaks a short/garbage value', () => {
      expect(maskPhoneE164('123')).to.equal('•••');
    });
  });
});
