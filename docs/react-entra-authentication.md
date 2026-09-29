# Adding Entra authentication to the React app

The API side is already done. The Python API validates Entra tokens in [auth.py](../src/pyapp/auth.py), and the Blazor app already calls it with the `api://<api-client-id>/access_as_user` scope. The React app just needs to sign the user in with MSAL.js, get a token for that same scope, and send it as a Bearer header. The API's CORS setup already allows the `Authorization` header from any origin, so the Python side needs no changes.

This guide uses MSAL.js v5 (`@azure/msal-browser` 5.x, `@azure/msal-react` 5.x). v5 needs a redirect bridge page for popup sign-in, which earlier versions didn't (see [The redirect bridge page](#the-redirect-bridge-page)).

## 1. Create an app registration for the React app (Entra portal)

You need a new registration, separate from the Blazor app's. The Blazor app is a confidential "Web" client with a secret, and a browser app can't use that.

1. **New registration**, e.g. "AspirePy React". Choose single tenant.
2. **Authentication → Add a platform → Single-page application**, and add the redirect URI `http://localhost:5173/redirect.html`. It must be the SPA platform. If you add it under "Web", sign-in fails with `AADSTS9002326`.

   The redirect URI points at the [redirect bridge page](#the-redirect-bridge-page), not the app's home page. It must match the `redirectUri` in `authConfig.ts` exactly, including the port. That means fixing the Vite port in the AppHost (see step 3).

   Entra rejects `http://` redirect URIs except when the host is exactly `localhost`. So `http://localhost:5173/redirect.html` is accepted, but the URL the Aspire dashboard links to (`http://frontend-react-aspirepy.dev.localhost:<port>`) is refused. If you need that URL, or any other non-`localhost` host, see [Serving the React app over HTTPS](#alternative-serving-the-react-app-over-https).
3. **API permissions → Add → My APIs →** your Python API registration, then tick `access_as_user`. Grant admin consent, or let users consent when they first sign in.
4. Copy the new **Application (client) ID**.

## 2. Add MSAL to the React app

```
npm install @azure/msal-browser @azure/msal-react
```

- **`src/authConfig.ts`:** create a `PublicClientApplication` with `auth: { clientId, authority: 'https://login.microsoftonline.com/<tenant>', redirectUri: `${window.location.origin}/redirect.html` }`, and export `apiScope = 'api://<api-client-id>/access_as_user'`.
- **`main.tsx`:** call `await msalInstance.initialize()`, then wrap `<App />` in `<MsalProvider instance={msalInstance}>`.
- **Redirect bridge:** add `redirect.html` and `src/redirect.ts`. See [The redirect bridge page](#the-redirect-bridge-page).
- **Sign-in UI:** use `useMsal()` and call `instance.loginPopup({ scopes: [apiScope] })` or `loginRedirect(...)`. Show content based on whether the user is signed in, using `<AuthenticatedTemplate>` and `<UnauthenticatedTemplate>`. See [The sign-in button](#the-sign-in-button).
- **HelloPanel:** before calling the API, get a token:

  ```ts
  const { instance, accounts } = useMsal();
  const { accessToken } = await instance.acquireTokenSilent({ scopes: [apiScope], account: accounts[0] });
  fetch(`${HELLO_ENDPOINT}/${encodeURIComponent(name.trim())}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
  });
  ```

  If this throws `InteractionRequiredAuthError`, fall back to `acquireTokenPopup` with the same request.

### The redirect bridge page

Entra now sends a `Cross-Origin-Opener-Policy` header on its sign-in pages. That header stops a sign-in popup from passing the result back to the app window the way earlier MSAL versions did. MSAL v5 solves this with a small "bridge" page: Entra redirects the popup to it, and it passes the response back to the app.

Without the bridge, these calls fail: `loginPopup`, `acquireTokenPopup`, `ssoSilent`, and `acquireTokenSilent` when it falls back to a hidden iframe. The bridge also handles `loginRedirect`, where it sends the browser back to the app's home page.

**`redirect.html`** goes in the project root, next to `index.html`. It's an HTML page that loads the bridge script:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Signing in…</title>
  </head>
  <body>
    <script type="module" src="/src/redirect.ts"></script>
  </body>
</html>
```

**`src/redirect.ts`** is the script it loads:

```ts
import { broadcastResponseToMainFrame } from '@azure/msal-browser/redirect-bridge';

broadcastResponseToMainFrame();
```

**`src/authConfig.ts`** points MSAL at the page:

```ts
redirectUri: `${window.location.origin}/redirect.html`,
```

**Entra:** the SPA redirect URI must be the same address, `http://localhost:5173/redirect.html` (see step 1).

**Production builds:** the Vite dev server serves any HTML file in the project root, so `redirect.html` works in development without extra config. `vite build` only bundles `index.html` by default. Add the bridge as a second input in `vite.config.ts` (Vite 8 uses `rolldownOptions`, which replaces the older `rollupOptions`):

```ts
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        redirect: resolve(__dirname, 'redirect.html'),
      },
    },
  },
})
```

Rules from the MSAL v5 migration guide:

- **Same origin:** serve the bridge page from the same origin as the app, never from a CDN.
- **No COOP header:** don't serve the bridge page with a `Cross-Origin-Opener-Policy` header.

`logoutPopup` probably needs the bridge too, but the migration guide only lists the sign-in and token calls.

### The sign-in button

`src/components/AuthButton.tsx` shows a "Sign in" or "Sign out" button depending on whether the user is signed in:

```tsx
import { InteractionStatus } from '@azure/msal-browser';
import { useIsAuthenticated, useMsal } from '@azure/msal-react';
import { apiScope } from '../authConfig';

function AuthButton() {
    const { instance, accounts, inProgress } = useMsal();
    const isAuthenticated = useIsAuthenticated();
    const busy = inProgress !== InteractionStatus.None;

    if (isAuthenticated) {
        return (
            <p>
                Signed in as {accounts[0]?.name}{' '}
                <button className="hello-button" type="button" disabled={busy}
                    onClick={() => instance.logoutPopup()}>
                    Sign out
                </button>
            </p>
        );
    }

    return (
        <button className="hello-button" type="button" disabled={busy}
            onClick={() => instance.loginPopup({ scopes: [apiScope] })}>
            Sign in
        </button>
    );
}

export default AuthButton;
```

`App.tsx` shows the button above the hello panel, and only shows the panel once the user is signed in:

```tsx
<section id="hello-panel">
    <AuthButton />
    <AuthenticatedTemplate>
        <HelloPanel />
    </AuthenticatedTemplate>
    <UnauthenticatedTemplate>
        <p>Sign in to get a greeting from the Python API.</p>
    </UnauthenticatedTemplate>
</section>
```

#### How it works

- **`useIsAuthenticated()`** returns true once MSAL has a signed-in account, so the button switches between "Sign in" and "Sign out" by itself. `<AuthenticatedTemplate>` and `<UnauthenticatedTemplate>` use the same check to decide what to render.
- **`inProgress`** tells you whether a popup or redirect is already open. The buttons are disabled while it's busy, because a second click would throw `interaction_in_progress`.
- **`loginPopup({ scopes: [apiScope] })`** asks the user to consent to the API scope during sign-in. That way the `acquireTokenSilent` call in `HelloPanel` usually succeeds without another prompt. The popup finishes on `redirect.html`, which passes the result back to the app.
- **`accounts[0].name`** is the display name from the user's Entra account.
- **Styling:** the buttons reuse the existing `hello-button` class.

**Popup or redirect:** if the browser blocks popups, use `loginRedirect` and `logoutRedirect` instead. Entra sends the browser to `redirect.html`, the bridge sends it back to the app, and MSAL finishes sign-in when the app loads, because `initialize()` runs before rendering in `main.tsx`. You don't need any other code.

## 3. Pass the config from the AppHost

Vite only exposes environment variables that start with `VITE_`. In [AppHost.cs](../src/AspirePy.AppHost/AppHost.cs), add a parameter for the new client ID and pass these to the `frontend-react` resource:

```csharp
var entraSpaClientId = builder.AddParameter("entra-spa-client-id");
// on the frontend-react resource:
.WithEnvironment("VITE_ENTRA_TENANT_ID", entraTenantId)
.WithEnvironment("VITE_ENTRA_CLIENT_ID", entraSpaClientId)
.WithEnvironment("VITE_API_CLIENT_ID", entraApiClientId)
```

Put the value in user secrets (`Parameters:entra-spa-client-id`), as for the other Entra parameters. Then read them in `authConfig.ts` with `import.meta.env.VITE_...`.

### Fix the Vite port

By default Aspire gives the Vite app a random port on each run, so a registered redirect URI stops matching after a restart and sign-in fails. Fix the port to 5173 so it matches what you registered:

```csharp
const int ReactAppPort = 5173;

builder.AddViteApp("frontend-react", "../frontend-react")
    .WithHttpEndpoint(port: ReactAppPort)
    // ...
```

`AddViteApp` already creates an endpoint named `http`. In Aspire 13.5.4, `WithHttpEndpoint` updates an existing endpoint with the same name instead of adding a second one, so this just pins that endpoint's port.

### Open the app at `http://localhost:5173`

Aspire lists two URLs for `frontend-react`:

- `http://frontend-react-aspirepy.dev.localhost:5173` is the one the dashboard links to.
- `http://localhost:5173` is the same app on the plain `localhost` name.

The redirect URI is built from `window.location.origin`, so it uses whatever address is in the browser. Always open the app at `http://localhost:5173`. If you open it from the dashboard link, MSAL sends `http://frontend-react-aspirepy.dev.localhost:5173/redirect.html`, which isn't registered, and sign-in fails with a redirect URI mismatch.

## Alternative: serving the React app over HTTPS

Use this if Entra refuses `http://localhost:5173/redirect.html`, or if you want to open the app from the dashboard's `dev.localhost` link. Aspire 13.5.4 has no HTTPS option specific to Vite; the only Vite-specific setting is `WithViteConfig`. So HTTPS has to be set up in both Vite and the AppHost:

- **Vite:** give Vite a certificate in `vite.config.ts` under `server.https`. The simplest way is to export the .NET dev certificate, which the machine already trusts:

  ```
  dotnet dev-certs https --export-path <file> --format Pem --no-password
  ```

  `@vitejs/plugin-basic-ssl` also works, but the browser shows a warning because its certificate isn't trusted.
- **AppHost:** switch the endpoint to HTTPS and fix the port:

  ```csharp
  .WithEndpoint("http", e => { e.UriScheme = "https"; e.Port = 5173; })
  ```

- **Entra:** register `https://localhost:5173/redirect.html`, or `https://…dev.localhost:5173/redirect.html`, as the SPA redirect URI.

This approach hasn't been tested with Aspire's proxy yet and may need adjusting.

## Gotchas

- **Token version:** the Python code expects v2 tokens (issuer `.../v2.0`, audience = the API's client ID GUID). The Blazor flow presumably already works, which means the API registration is set up for v2 tokens. If you see "Invalid audience" or "Invalid issuer" errors, check `accessTokenAcceptedVersion: 2` in the API registration's manifest.
- **Deploying:** Vite writes the `VITE_*` values into the bundle when it builds. They're not read at runtime, so the values must be set at build time. Add the deployed app's `/redirect.html` address as another SPA redirect URI, and make sure `redirect.html` is in the build (see [Production builds](#the-redirect-bridge-page)).
- **Redirect URI mismatch:** if Entra reports `AADSTS50011`, the `redirectUri` MSAL sent doesn't exactly match a registered one. Check the scheme, host, port and the `/redirect.html` path.
