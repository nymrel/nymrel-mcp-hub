import * as oidc from 'openid-client';

export const GOOGLE_ISSUER = 'https://accounts.google.com';

export async function createGoogleClient({ clientId, clientSecret, redirectUri, fetchImpl }) {
  if (!clientId || !clientSecret) throw new Error('Google client configuration required');
  const config = await oidc.discovery(new URL(GOOGLE_ISSUER), clientId,
    { client_secret: clientSecret, id_token_signed_response_alg: 'RS256' },
    oidc.ClientSecretPost(clientSecret), {
      timeout: 10,
      execute: [oidc.enableNonRepudiationChecks],
      ...(fetchImpl ? { [oidc.customFetch]: fetchImpl } : {})
    });
  return {
    async begin() {
      const state = oidc.randomState(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri, response_type: 'code', scope: 'openid', state, nonce,
        code_challenge_method: 'S256', code_challenge: await oidc.calculatePKCECodeChallenge(verifier)
      });
      return { state, nonce, verifier, url: url.href };
    },
    async finish(url, binding) {
      const tokens = await oidc.authorizationCodeGrant(config, url, {
        expectedState: binding.state, expectedNonce: binding.nonce, pkceCodeVerifier: binding.verifier,
        idTokenExpected: true
      });
      const claims = tokens.claims();
      if (claims?.iss !== GOOGLE_ISSUER || typeof claims.sub !== 'string' || !claims.sub) throw new Error('Identity denied');
      return { issuer: claims.iss, subject: claims.sub };
    }
  };
}
