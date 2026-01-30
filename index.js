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
const scopeOrganization = process.env.INPUT_SCOPE_ORGANIZATION;

const usePoolEndpoint = !!(poolName || applicationId);

if (!identity) {
  console.log(`::error::Missing required input 'policy'`);
  process.exit(1);
}

if (usePoolEndpoint) {
  if (poolName && applicationId) {
    console.log(`::error::Cannot specify both 'pool_name' and 'application_id'`);
    process.exit(1);
  }
  if (!scopeEnterprise && !scopeOrganization) {
    console.log(`::error::Pool endpoint requires 'scope_enterprise' or 'scope_organization'`);
    process.exit(1);
  }
  if (scopeEnterprise && scopeOrganization) {
    console.log(`::error::Cannot specify both 'scope_enterprise' and 'scope_organization'`);
    process.exit(1);
  }
} else {
  if (!scope) {
    console.log(`::error::Missing required input 'scope' for legacy endpoint`);
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
      console.warn(`Attempt ${attempt} failed. Error: ${error.message}`);
      const jitter = Math.floor(Math.random() * 5000);
      const delay = Math.min(2 ** attempt * initialDelay + jitter, 10000); // Limit max delay to 10 seconds
      await new Promise(resolve => setTimeout(resolve, delay));
      attempt++;
      retries--;
    }
  }
  throw new Error(`Fetch failed after ${attempt} attempts.`);
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
    } else {
      params.append('scope_organization.organization', scopeOrganization);
    }

    return `https://${domain}/sts/pool/exchange?${params.toString()}`;
  } else {
    return `https://${domain}/sts/exchange?scope=${scope}&identity=${identity}`;
  }
}

(async function main() {
  // You can use await inside this function block
  try {
    const res = await fetchWithRetry(`${actionsUrl}&audience=${audience}`, { headers: { 'Authorization': `Bearer ${actionsToken}` } }, 5);
    const json = await res.json();
    let res2, json2, tok, expiresAt = '', appId = '', appName = '';
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
        if (json2.token.expires_seconds) {
          expiresAt = new Date(json2.token.expires_seconds * 1000).toISOString();
        }
        if (json2.token.token_installation) {
          appId = json2.token.token_installation.application_id || '';
          appName = json2.token.token_installation.application_name || '';
        }
      } else {
        if (!json2.token) {
          console.log(`::error::${json2.message}`);
          process.exit(1);
        }
        tok = json2.token;
      }
    } catch (error) {
      const claims = JSON.parse(Buffer.from(json.value.split('.')[1], 'base64').toString());
      console.log('JWT claims:\n', JSON.stringify(claims, null, 2));

      const debugCmd = usePoolEndpoint
        ? `dd-octo-sts check-pool -pool ${poolName || ''} -app ${applicationId || ''} -scope-enterprise ${scopeEnterprise || ''} -scope-org ${scopeOrganization || ''} -p ${identity}`
        : `dd-octo-sts check -s ${scope} -p ${identity}`;

      const markdown = [
        '### ⚠️ DD Octo STS request failed',
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
    if (usePoolEndpoint) {
      console.log(`Application ID: ${appId}`);
      console.log(`Application Name: ${appName}`);
      console.log(`Expires At: ${expiresAt}`);
    }

    console.log(`::add-mask::${tok}`);
    const outputs = [
      `token=${tok}`,
      `expires_at=${expiresAt}`,
      `application_id=${appId}`,
      `application_name=${appName}`
    ].join('\n');
    fs.appendFile(process.env.GITHUB_OUTPUT, outputs + '\n', function (err) { if (err) throw err; });
    fs.appendFile(process.env.GITHUB_STATE, `token=${tok}`, function (err) { if (err) throw err; });
  } catch (err) {
    console.log(`::error::${err.stack}`); process.exit(1);
  }
})();
