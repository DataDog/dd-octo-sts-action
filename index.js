/**
 * Parses JWT token and extracts claims from the payload.
 * @param {string} token - The JWT token to parse
 * @returns {Object} The parsed claims object
 * @throws {Error} If the token is invalid or cannot be parsed (without including token data)
 */
function parseJwtClaims(token) {
  if (!token) {
    throw new Error('Token value is missing');
  }
  const tokenParts = token.split('.');
  if (tokenParts.length !== 3) {
    throw new Error(`Invalid JWT structure: expected 3 parts, got ${tokenParts.length}`);
  }
  let payload;
  try {
    payload = Buffer.from(tokenParts[1], 'base64url').toString('utf8');
  } catch (decodeErr) {
    throw new Error('Failed to decode token payload: invalid base64url encoding');
  }
  let claims;
  try {
    claims = JSON.parse(payload);
  } catch (parseErr) {
    throw new Error('Failed to parse token payload: invalid JSON');
  }
  return claims;
}

const fs = require('fs');
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
const actionsToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
const actionsUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;

if (!actionsToken || !actionsUrl) {
  console.log(`::error::Missing required environment variables; have you set 'id-token: write' in your workflow permissions?`);
  process.exit(1);
}

const domain = process.env.INPUT_DOMAIN;
const audience = process.env.INPUT_AUDIENCE;
const scope = process.env.INPUT_SCOPE;
const identity = process.env.INPUT_POLICY;
const poolName = process.env.INPUT_POOL_NAME;
const applicationId = process.env.INPUT_APPLICATION_ID;
const scopeEnterprise = process.env.INPUT_SCOPE_ENTERPRISE;
const debugMode = (process.env.INPUT_DEBUG || 'false').toLowerCase() === 'true';

const usePoolEndpoint = !!(poolName || applicationId);

if (!identity) {
  console.log(`::error::Missing required input 'policy'`);
  process.exit(1);
}

if (scope) {
  const slashCount = (scope.match(/\//g) || []).length;
  if (slashCount > 1) {
    console.log(`::error::Invalid 'scope': must be "org" or "org/repo", got too many slashes`);
    process.exit(1);
  }
  if (scope.endsWith('/')) {
    console.log(`::error::Invalid 'scope': must be "org" or "org/repo", not "org/"`);
    process.exit(1);
  }
}

if (usePoolEndpoint) {
  if (poolName && applicationId) {
    console.log(`::error::Cannot specify both 'pool_name' and 'application_id'`);
    process.exit(1);
  }
  if (scope && scopeEnterprise) {
    console.log(`::error::Cannot specify both 'scope' and 'scope_enterprise'`);
    process.exit(1);
  }
  if (!scope && !scopeEnterprise) {
    console.log(`::error::Pool endpoint requires 'scope' or 'scope_enterprise'`);
    process.exit(1);
  }
} else {
  if (!scope) {
    console.log(`::error::Missing required input 'scope'`);
    process.exit(1);
  }
}

async function fetchWithRetry(url, options = {}, retries = 3, initialDelay = 1000) {
  let attempt = 1;
  while (retries > 0) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        errorBody = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, ${errorBody}`);
      }
      return response;
    } catch (error) {
      console.warn(`Attempt ${attempt} failed for URL: ${url}. Error: ${error.message}`);
      const jitter = Math.floor(Math.random() * 5000);
      const delay = Math.min(2 ** attempt * initialDelay + jitter, 10000); // Limit max delay to 10 seconds
      await new Promise(resolve => setTimeout(resolve, delay));
      attempt++;
      retries--;
    }
  }
  throw new Error(`Fetch failed after ${attempt} attempts for URL: ${url}.`);
}

function buildExchangeUrl() {
  if (usePoolEndpoint) {
    const params = new URLSearchParams();
    params.append('policy', identity);

    if (poolName) {
      params.append('pool_name', poolName);
    } else {
      params.append('application_id', applicationId);
    }

    if (scopeEnterprise) {
      params.append('scope_enterprise.enterprise', scopeEnterprise);
    } else if (scope.includes('/')) {
      const [org, repo] = scope.split('/');
      params.append('scope_repository.organization', org);
      params.append('scope_repository.repository', repo);
    } else {
      params.append('scope_organization.organization', scope);
    }

    return `https://${domain}/sts/pool/exchange?${params.toString()}`;
  } else {
    return `https://${domain}/sts/exchange?scope=${scope}&identity=${identity}`;
  }
}

function decodeJwtClaims(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
}

function formatClaimsMarkdown(claims, title, debugCmd) {
  const lines = [
    `### ${title}`,
    '',
    'OIDC token claims:',
    '',
    '```json',
    JSON.stringify(claims, null, 2),
    '```',
  ];

  if (debugCmd) {
    lines.push(
      '',
      'For local debugging via `dd-octo-sts` cli, run:',
      '```shell',
      `DDOCTOSTS_ID_TOKEN='${JSON.stringify(claims)}' \\`,
      debugCmd,
      '```'
    );
  }

  return lines.join('\n');
}

(async function main() {
  try {
    const res = await fetchWithRetry(`${actionsUrl}&audience=${audience}`, { headers: { 'Authorization': `Bearer ${actionsToken}` } }, 5);
    const json = await res.json();

    // Always emit claims as debug log (visible when ACTIONS_STEP_DEBUG=true)
    const oidcClaims = decodeJwtClaims(json.value);
    const claimsJson = JSON.stringify(oidcClaims, null, 2);
    for (const line of claimsJson.split('\n')) {
      console.log(`::debug::OIDC claim: ${line}`);
    }

    if (debugMode) {
      console.log('Debug mode enabled. Printing OIDC token claims and exiting.');
      console.log('');
      console.log('OIDC token claims:');
      console.log(claimsJson);

      const markdown = formatClaimsMarkdown(oidcClaims, 'OIDC Token Claims (debug mode)');
      fs.appendFileSync(summaryPath, markdown + '\n');
      return;
    }

    let res2, json2, tok;
    try {
      res2 = await fetchWithRetry(
        buildExchangeUrl(),
        {
          headers: {
            'Authorization': `Bearer ${json.value}`,
            'x-datadog-target-release': 'dd-octo-sts.dd-octo-sts'
          }
        }
      );
      json2 = await res2.json();

      if (usePoolEndpoint) {
        if (!json2.token || !json2.token.token) {
          console.log(`::error::${json2.message || 'Pool endpoint did not return a token'}`);
          process.exit(1);
        }
        tok = json2.token.token;
      } else {
        if (!json2.token) { console.log(`::error::${json2.message}`); process.exit(1); }
        tok = json2.token;
      }
    } catch (error) {
      const claims = parseJwtClaims(json.value);
      console.log('JWT claims:\n', JSON.stringify(claims, null, 2));

      let debugCmd;
      if (usePoolEndpoint) {
        const poolArg = poolName ? `-pool ${poolName}` : `-app ${applicationId}`;
        let scopeArg;
        if (scopeEnterprise) {
          scopeArg = `-scope-enterprise ${scopeEnterprise}`;
        } else if (scope.includes('/')) {
          scopeArg = `-scope-repo ${scope}`;
        } else {
          scopeArg = `-scope-org ${scope}`;
        }
        debugCmd = `dd-octo-sts check-pool ${poolArg} ${scopeArg} -p ${identity}`;
      } else {
        debugCmd = `dd-octo-sts check -s ${scope} -p ${identity}`;
      }

      const markdown = [
        '### \u26a0\ufe0f DD Octo STS request failed',
        '',
        'OIDC token claims for debugging:',
        '',
        '```json',
        JSON.stringify(claims, null, 2),
        '```',
        '',
        'For local debugging via `dd-octo-sts` cli, run:',
        '```shell',
        `DDOCTOSTS_ID_TOKEN='${JSON.stringify(claims)}' \\`,
        debugCmd,
        '```'
      ].join('\n');

      fs.appendFileSync(summaryPath, markdown + '\n');
      throw error;
    }

    const crypto = require('crypto');
    const tokHash = crypto.createHash('sha256').update(tok).digest('hex');
    console.log(`Token hash: ${tokHash}`);

    console.log(`::add-mask::${tok}`);
    fs.appendFile(process.env.GITHUB_OUTPUT, `token=${tok}`, function (err) { if (err) throw err; });
    fs.appendFile(process.env.GITHUB_STATE, `token=${tok}`, function (err) { if (err) throw err; });
  } catch (err) {
    console.log(`::error::${err.stack}`); process.exit(1);
  }
})();

module.exports = { parseJwtClaims };
