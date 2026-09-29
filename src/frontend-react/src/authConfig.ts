import { PublicClientApplication, type Configuration } from '@azure/msal-browser';

const tenantId = import.meta.env.VITE_ENTRA_TENANT_ID;
const clientId = import.meta.env.VITE_ENTRA_CLIENT_ID;       // the React app's registration
const apiClientId = import.meta.env.VITE_API_CLIENT_ID;      // the Python API's registration

const msalConfig: Configuration = {
    auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        //redirectUri: window.location.origin,                  // http://localhost:5173 in dev
        redirectUri: `${window.location.origin}/redirect.html`,        
    },
    cache: {
        cacheLocation: 'sessionStorage',                      // or 'localStorage' to stay signed in across tabs
    },
};

const msalInstance = new PublicClientApplication(msalConfig);

export { msalInstance, msalConfig };

export const apiScope = `api://${apiClientId}/access_as_user`;