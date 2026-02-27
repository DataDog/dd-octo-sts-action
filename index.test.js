// Set required environment variables before requiring index.js,
// which has top-level guards that call process.exit(1) if these are missing.
process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'test-token';
process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://test.example.com';
process.env.INPUT_POLICY = 'test-policy';
process.env.INPUT_SCOPE = 'test-org';
process.env.GITHUB_STEP_SUMMARY = '/dev/null';

const { parseJwtClaims } = require('./index');

describe('parseJwtClaims', () => {
  function createTestJwt(payload) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = 'test-signature';
    return `${header}.${payloadStr}.${signature}`;
  }

  describe('valid tokens', () => {
    it('should parse a valid JWT token and return claims', () => {
      const expectedClaims = {
        iss: 'https://token.actions.githubusercontent.com',
        sub: 'repo:octo-org/octo-repo:ref:refs/heads/main',
        aud: 'https://github.com/octo-org',
        exp: 1234567890,
        iat: 1234567800,
      };
      const token = createTestJwt(expectedClaims);
      expect(parseJwtClaims(token)).toEqual(expectedClaims);
    });

    it('should parse tokens with nested claims', () => {
      const expectedClaims = {
        iss: 'test-issuer',
        sub: 'test-subject',
        nested: { property: 'value', array: [1, 2, 3] },
      };
      const token = createTestJwt(expectedClaims);
      expect(parseJwtClaims(token)).toEqual(expectedClaims);
    });

    it('should parse tokens with special characters in claims', () => {
      const expectedClaims = {
        message: 'Special chars: !@#$%^&*()',
        unicode: '\u65e5\u672c\u8a9e',
      };
      const token = createTestJwt(expectedClaims);
      expect(parseJwtClaims(token)).toEqual(expectedClaims);
    });
  });

  describe('invalid tokens', () => {
    it('should throw error for null token', () => {
      expect(() => parseJwtClaims(null)).toThrow('Token value is missing');
    });

    it('should throw error for undefined token', () => {
      expect(() => parseJwtClaims(undefined)).toThrow('Token value is missing');
    });

    it('should throw error for empty string token', () => {
      expect(() => parseJwtClaims('')).toThrow('Token value is missing');
    });

    it('should throw error for token with wrong number of parts', () => {
      expect(() => parseJwtClaims('only-one-part')).toThrow(
        'Invalid JWT structure: expected 3 parts, got 1'
      );
      expect(() => parseJwtClaims('two.parts')).toThrow(
        'Invalid JWT structure: expected 3 parts, got 2'
      );
      expect(() => parseJwtClaims('a.b.c.d')).toThrow(
        'Invalid JWT structure: expected 3 parts, got 4'
      );
    });

    it('should throw error for token with invalid base64 payload', () => {
      expect(() => parseJwtClaims('header.!!!invalid!!!.signature')).toThrow(
        'Failed to parse token payload: invalid JSON'
      );
    });

    it('should throw error for token with non-JSON payload', () => {
      const nonJson = Buffer.from('not json at all').toString('base64url');
      expect(() => parseJwtClaims(`header.${nonJson}.signature`)).toThrow(
        'Failed to parse token payload: invalid JSON'
      );
    });

    it('should not leak token data in error messages', () => {
      const sensitivePayload = Buffer.from('sensitive-data').toString('base64url');
      try {
        parseJwtClaims(`header.${sensitivePayload}.signature`);
      } catch (e) {
        expect(e.message).not.toContain('sensitive-data');
        expect(e.message).not.toContain(sensitivePayload);
      }
    });
  });
});
