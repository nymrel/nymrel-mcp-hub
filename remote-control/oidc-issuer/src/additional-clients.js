export const VERCEL_CALLBACK = 'https://connect.vercel.com/callback';
const READ_SCOPES = 'devices:read tools:read';

// This issuer supports at most one additional public client for Vercel Connect.
// Keep its callback and authentication method fixed; never accept client secrets.
export function validateAdditionalClients(additionalClients = [], primaryClientId) {
  if (!Array.isArray(additionalClients) || additionalClients.length > 1) throw new Error('At most one additional public client is supported');
  const seen = new Set([primaryClientId]);
  return additionalClients.map(client => {
    if (!client || typeof client !== 'object' || Array.isArray(client)
      || Object.keys(client).sort().join(',') !== 'callback,clientId') throw new Error('Additional clients require only clientId and callback');
    const { clientId, callback } = client;
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(clientId) || seen.has(clientId)) throw new Error('Additional client ID must be a distinct 1–128 character identifier');
    if (callback !== VERCEL_CALLBACK) throw new Error('Additional client callback must exactly match Vercel Connect');
    seen.add(clientId);
    return { client_id: clientId, redirect_uris: [VERCEL_CALLBACK], token_endpoint_auth_method: 'none',
      response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'], scope: `openid offline_access ${READ_SCOPES}` };
  });
}

export function parseAdditionalClients(raw, primaryClientId) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('NYMREL_OIDC_ADDITIONAL_CLIENTS must be valid JSON'); }
  return validateAdditionalClients(parsed, primaryClientId).map(({ client_id, redirect_uris }) => ({ clientId: client_id, callback: redirect_uris[0] }));
}
