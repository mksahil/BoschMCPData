import {
  PublicClientApplication,
  IPublicClientApplication,
  AuthenticationResult,
  SilentRequest,
  RedirectRequest,
  AccountInfo,
} from '@azure/msal-browser';

/**
 * Azure AD Authentication Service
 * Handles Microsoft Entra ID (Azure AD) login and token management
 */

const msalConfig = {
  auth: {
    clientId: import.meta.env.VITE_AZURE_CLIENT_ID || '',
    authority: `https://login.microsoftonline.com/${
      import.meta.env.VITE_AZURE_TENANT_ID || ''
    }`,
    redirectUri: `${window.location.origin}/login`,
  },
  cache: {
    cacheLocation: 'sessionStorage',
    storeAuthStateInCookie: false,
  },
};

const loginRequest = {
  scopes: [
    `api://${import.meta.env.VITE_AZURE_CLIENT_ID}/.default`,
  ],
} as RedirectRequest;

let msalInstance: IPublicClientApplication | null = null;
let msalInitializePromise: Promise<void> | null = null;

/**
 * Initialize MSAL instance
 */
export const initializeMsal = (): IPublicClientApplication => {
  if (!msalInstance) {
    msalInstance = new PublicClientApplication(msalConfig);
  }
  return msalInstance;
};

/**
 * Get MSAL instance
 */
export const getMsalInstance = (): IPublicClientApplication => {
  if (!msalInstance) {
    return initializeMsal();
  }
  return msalInstance;
};

/**
 * Ensure MSAL browser client is initialized before calling any MSAL APIs.
 */
const getInitializedMsalInstance = async (): Promise<IPublicClientApplication> => {
  const instance = getMsalInstance();

  if (msalInitializePromise === null) {
    msalInitializePromise = instance.initialize();
  }

  await msalInitializePromise;
  return instance;
};

/**
 * Perform interactive login with Azure AD
 */
export const loginWithAzureAD = async (): Promise<AuthenticationResult | null> => {
  try {
    const instance = await getInitializedMsalInstance();
    await instance.loginRedirect(loginRequest);
    return null;
  } catch (error) {
    console.error('Azure AD login error:', error);
    throw error;
  }
};

/**
 * Get access token silently
 */
export const getAccessTokenSilently = async (): Promise<string | null> => {
  try {
    const instance = await getInitializedMsalInstance();
    const accounts = instance.getAllAccounts();
    
    if (accounts.length === 0) {
      return null;
    }

    const silentRequest: SilentRequest = {
      scopes: loginRequest.scopes,
      account: accounts[0],
    };

    const response = await instance.acquireTokenSilent(silentRequest);
    return response.accessToken;
  } catch (error) {
    console.error('Error acquiring token silently:', error);
    return null;
  }
};

/**
 * Get access token (with fallback to interactive if silent fails)
 */
export const getAccessToken = async (): Promise<string | null> => {
  try {
    const instance = await getInitializedMsalInstance();

    const accounts = instance.getAllAccounts();

    if (accounts.length === 0) {
      // No account, start redirect login.
      await instance.loginRedirect(loginRequest);
      return null;
    }

    // Try silent token acquisition
    const silentRequest: SilentRequest = {
      scopes: loginRequest.scopes,
      account: accounts[0],
    };

    try {
      const response = await instance.acquireTokenSilent(silentRequest);
      return response.accessToken;
    } catch (silentError) {
      console.log('Silent token acquisition failed, falling back to redirect');
      await instance.acquireTokenRedirect(loginRequest);
      return null;
    }
  } catch (error) {
    console.error('Error getting access token:', error);
    throw error;
  }
};

/**
 * Process Azure AD redirect callback and exchange token if present.
 */
export const handleSSORedirectCallback = async (): Promise<any | null> => {
  try {
    const instance = await getInitializedMsalInstance();
    const redirectResult = await instance.handleRedirectPromise();

    if (!redirectResult?.accessToken) {
      return null;
    }

    return await exchangeAzureTokenForArenaToken(redirectResult.accessToken);
  } catch (error) {
    console.error('Error handling SSO redirect callback:', error);
    throw error;
  }
};

/**
 * Get current account
 */
export const getCurrentAccount = async (): Promise<AccountInfo | null> => {
  try {
    const instance = await getInitializedMsalInstance();
    const accounts = instance.getAllAccounts();
    return accounts.length > 0 ? accounts[0] : null;
  } catch (error) {
    console.error('Error getting current account:', error);
    return null;
  }
};

/**
 * Logout from Azure AD
 */
export const logoutAzureAD = async (): Promise<void> => {
  try {
    const instance = await getInitializedMsalInstance();
    const account = await getCurrentAccount();
    
    await instance.logoutRedirect({
      account: account || undefined,
      postLogoutRedirectUri: `${window.location.origin}/login`,
    });
  } catch (error) {
    console.error('Error logging out from Azure AD:', error);
  }
};

/**
 * Exchange Azure AD token for Arena token
 * Calls the backend exchange-token endpoint
 */
export const exchangeAzureTokenForArenaToken = async (
  azureToken: string
): Promise<any> => {
  try {
    const exchangeTokenUrl =
      import.meta.env.VITE_EXCHANGE_TOKEN_URL ||
      'https://bgsw-bmam-dev-001.azurewebsites.net/api/Auth/exchange-token';

    const response = await fetch(exchangeTokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${azureToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/plain',
      },
      body: JSON.stringify({
        deviceToken: 'webSSO',
        isAndroid: true,
        isIOS: false,
        requestSource: 'Web',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Token exchange failed: ${response.status} ${errorText}`
      );
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Token exchange error:', error);
    throw error;
  }
};

/**
 * Complete SSO flow: Azure AD login → Token exchange → Arena token
 */
export const performSSO = async (): Promise<any> => {
  try {
    // Step 1: Get Azure AD token
    console.log('Step 1: Performing Azure AD login...');
    const azureToken = await getAccessToken();
    
    if (!azureToken) {
      // Redirect-based login has been initiated; browser navigation will continue flow.
      return null;
    }
    console.log('✓ Azure AD token obtained');

    // Step 2: Exchange for Arena token
    console.log('Step 2: Exchanging Azure AD token for Arena token...');
    const arenaTokenData = await exchangeAzureTokenForArenaToken(azureToken);
    console.log('✓ Arena token obtained');

    return arenaTokenData;
  } catch (error) {
    console.error('SSO flow error:', error);
    throw error;
  }
};
