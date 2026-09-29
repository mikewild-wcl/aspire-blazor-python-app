# Blazor: "No account or login hint" after a restart

The Blazor app can show an error when calling the Python API even though the user is still signed in. Before the fix below, the only way round it was to sign out and sign in again. This page explains why it happens, what the app does about it now, and how to remove the cause completely.

## Symptom

After restarting the AppHost (or just the Blazor app), you open the Blazor app. You're still signed in: the page loads and `[Authorize]` lets you through. But clicking **Say Hello** fails with an MSAL error such as:

```
Error: IDW10502: An MsalUiRequiredException was thrown due to a challenge for the user.
```

or, in the inner exception:

```
MsalUiRequiredException: No account or login hint was passed to the AcquireTokenSilent call.
```

Signing out and in again makes it go away until the next restart.

## Cause

The Blazor app keeps two separate pieces of sign-in state, and they're stored in different places:

| State | What it's for | Where it's stored | Survives an app restart? |
|---|---|---|---|
| Sign-in cookie | Proves who the user is to the Blazor app | The user's browser | Yes |
| MSAL token cache | Access and refresh tokens for calling the Python API | The Blazor app's memory (`AddInMemoryTokenCaches()` in [Program.cs](../src/AspirePy.Web/Program.cs)) | No |

When the app restarts, the token cache is emptied but the browser still sends the cookie. So:

1. The cookie is still valid, so the app treats the user as signed in and renders the page.
2. `PythonApiService` calls `ITokenAcquisition.GetAccessTokenForUserAsync` to get a token for `api://<api-client-id>/access_as_user`.
3. MSAL looks in its cache for the user's account and refresh token and finds nothing, so it can't get a token silently. It throws `MsalUiRequiredException`: user interaction is needed.
4. Microsoft.Identity.Web wraps that in `MicrosoftIdentityWebChallengeUserException`, meaning "send the user through sign-in again".

Signing out and in again works because a fresh sign-in puts the account and a new refresh token back in the cache.

### When the cache is lost

- **Local development:** every time the AppHost is restarted, or the Blazor project is rebuilt and relaunched. Hot reload keeps the process running, so it keeps the cache.
- **Deployed to Azure Container Apps:** whenever a container restarts or a new revision is deployed. If the app scales out to more than one replica, each replica has its own separate cache, so a request that reaches a different replica can hit the same error.

### Why the React app isn't affected

The React app gets its tokens in the browser with MSAL.js, and keeps them in the browser's session storage. There's no server-side cache to lose, so restarting the AppHost doesn't affect it. The two apps also use separate app registrations and separate caches, so signing in to one doesn't cause this error in the other.

## Fix 1: re-authenticate when the page loads (implemented)

The fix has two parts. The main one catches the problem on the first request after a restart, before the user has typed anything. A fallback in `Home.razor` handles any case the main one misses.

### Main fix: reject the cookie when the account isn't in the cache

[RejectSessionCookieWhenAccountNotInCacheEvents.cs](../src/AspirePy.Web/RejectSessionCookieWhenAccountNotInCacheEvents.cs) hooks into cookie validation, which runs on every request that carries the sign-in cookie. It tries to get a token for the Python API from the cache. If MSAL reports that the user's account isn't in the cache (`user_null`), it rejects the cookie:

```csharp
public class RejectSessionCookieWhenAccountNotInCacheEvents(string[] downstreamScopes) : CookieAuthenticationEvents
{
    public override async Task ValidatePrincipal(CookieValidatePrincipalContext context)
    {
        try
        {
            var tokenAcquisition = context.HttpContext.RequestServices.GetRequiredService<ITokenAcquisition>();
            await tokenAcquisition.GetAccessTokenForUserAsync(downstreamScopes, user: context.Principal);
        }
        catch (MicrosoftIdentityWebChallengeUserException ex) when (AccountDoesNotExistInTokenCache(ex))
        {
            context.RejectPrincipal();
        }
    }

    private static bool AccountDoesNotExistInTokenCache(MicrosoftIdentityWebChallengeUserException ex) =>
        ex.InnerException is MsalUiRequiredException { ErrorCode: "user_null" };
}
```

It's registered in [Program.cs](../src/AspirePy.Web/Program.cs) with the Python API's scope:

```csharp
builder.Services.Configure<CookieAuthenticationOptions>(CookieAuthenticationDefaults.AuthenticationScheme, options =>
{
    options.Events = new RejectSessionCookieWhenAccountNotInCacheEvents(
        [$"api://{builder.Configuration["PythonApi:ClientId"]}/access_as_user"]);
});
```

This is the pattern Microsoft.Identity.Web recommends for in-memory token caches.

#### How it works

1. After a restart, the browser requests the Blazor page with the old sign-in cookie.
2. Cookie validation runs `ValidatePrincipal`. The token cache is empty, so `GetAccessTokenForUserAsync` fails with `user_null`, and the cookie is rejected.
3. The request is now treated as signed out. The Home page has `[Authorize]`, so ASP.NET Core sends an OpenID Connect challenge, which redirects the browser to Entra.
4. The browser is still signed in to Entra itself (Entra's own session cookie on `login.microsoftonline.com`), so Entra normally signs the user straight back in without asking for a password. The user just sees the page take a moment longer to load.
5. Entra redirects back to `/signin-oidc`. Microsoft.Identity.Web stores the account and refresh token in the cache, issues a new cookie, and returns the user to the page they asked for.
6. The page loads with a working token cache, so the first **Say Hello** succeeds.

When the account is in the cache, `GetAccessTokenForUserAsync` returns the cached access token (or refreshes it with the cached refresh token). The check is cheap and the request carries on as normal.

#### Why only `user_null`

The cookie is only rejected when the account is missing from the cache. Signing in again fixes that. Other reasons MSAL can need the user, such as missing consent to the API scope or a Conditional Access requirement, aren't fixed by a plain sign-in. Rejecting the cookie for those would send the user round the sign-in loop forever.

### Fallback: catch the error on the API call

[Home.razor](../src/AspirePy.Web/Components/Pages/Home.razor) also catches the challenge exception when calling the API, and sends the user through the app's existing `/login` endpoint, returning them to the page they were on:

```csharp
@using Microsoft.Identity.Web
@inject NavigationManager Navigation

// in SendHello():
catch (MicrosoftIdentityWebChallengeUserException)
{
    var returnUrl = "/" + Navigation.ToBaseRelativePath(Navigation.Uri);
    Navigation.NavigateTo($"/login?returnUrl={Uri.EscapeDataString(returnUrl)}", forceLoad: true);
}
catch (Exception ex)
{
    // existing handling: show the error message
}
```

The more specific `MicrosoftIdentityWebChallengeUserException` catch must come before the general `Exception` catch, or it never runs. `forceLoad: true` makes the navigation a full page load, not a Blazor route change, because `/login` is a server endpoint, not a Razor component.

On its own, this fallback was the first version of the fix, and it had a real drawback. The error only surfaced once the user had typed a name and clicked **Say Hello**. The redirect then reloaded the page, which reset `GreetingState`, so the user landed back on the page with the name cleared and no greeting. It looked like the button just reloaded the page. The main fix avoids this by re-authenticating before the user has typed anything.

The fallback is still useful because the check only runs on HTTP requests. A Blazor Server page keeps a live connection (a circuit) after it loads, and clicks go over that connection, not as new requests. If the cache is emptied while a page is already open, or a cached token stops working mid-session, the fallback catches it on the next click.

### Limitations

- **Expired Entra session:** if the user's Entra session has also expired, Entra shows the normal sign-in page instead of a silent redirect.
- **Missing consent:** neither part asks for the API scope during sign-in. The app depends on the user or an admin having already consented to `access_as_user`; the README's setup grants admin consent. The main fix deliberately ignores consent errors (see [Why only `user_null`](#why-only-user_null)). The fallback doesn't, so if consent were ever removed, clicking **Say Hello** would keep redirecting to sign-in.
- **Fallback coverage:** the fallback only covers the Home page's greeting call. Any new page that calls `PythonApiService` needs the same `catch`. The main fix covers every page.
- **Scope in two places:** the API scope is built both in `Program.cs` (for the cookie check) and in `PythonApiService`. Keep them in sync if the scope changes.

### How to test it

1. Start the AppHost, open the Blazor app, sign in and click **Say Hello**. It should succeed.
2. Restart the AppHost. This empties the in-memory token cache, but the browser keeps the sign-in cookie.
3. Open the Blazor app again, or refresh the page. It briefly redirects to Entra and back as it loads, with no password prompt.
4. Type a name and click **Say Hello**. It succeeds first time.

The `web` resource's log in the Aspire dashboard still shows a `fail: Microsoft.Identity.Web.TokenAcquisition` entry with `MsalUiRequiredException` and `ErrorCode: user_null` at step 3. That's expected: Microsoft.Identity.Web logs the error before throwing the exception that the cookie check catches, so the check can't stop it. The recovery shows up in the log about a second later as a `POST https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` returning `200`. That's the app exchanging the new sign-in for tokens. The log entry only goes away with [Fix 2](#fix-2-store-tokens-somewhere-that-survives-a-restart-not-yet-implemented).

## Fix 2: store tokens somewhere that survives a restart (not yet implemented)

Fix 1 recovers from a lost cache; this fix stops the cache being lost. Replace the in-memory cache with a distributed cache that lives outside the app process:

```csharp
builder.Services.AddAuthentication(OpenIdConnectDefaults.AuthenticationScheme)
    .AddMicrosoftIdentityWebApp(builder.Configuration.GetSection("AzureAd"))
    .EnableTokenAcquisitionToCallDownstreamApi()
    .AddDistributedTokenCaches();
```

`AddDistributedTokenCaches()` stores the cache in whatever `IDistributedCache` the app has registered. It needs a persistent backing store: `AddDistributedMemoryCache()` is still in memory and would be lost on restart just the same. With Aspire, the natural choice is Redis:

- **AppHost:** add a Redis resource with a data volume so its contents survive restarts, and reference it from the web app:

  ```csharp
  var cache = builder.AddRedis("cache").WithDataVolume();
  // on the web resource:
  .WithReference(cache)
  .WaitFor(cache)
  ```

- **Blazor app:** add the Aspire Redis distributed cache client (`Aspire.StackExchange.Redis.DistributedCaching`) and register it with `builder.AddRedisDistributedCache("cache");`.

This needs Docker running locally, which the deployment already requires. It also fixes the deployed case: every replica shares one cache, and container restarts don't empty it.

Keep Fix 1 even with a persistent cache. Tokens can still become unusable (a refresh token expires or is revoked, or the cache is cleared), and Fix 1 handles those cases too.

## References

- [Microsoft.Identity.Web: token cache serialization](https://learn.microsoft.com/entra/msal/dotnet/how-to/token-cache-serialization)
- [Microsoft.Identity.Web wiki: Managing incremental consent and conditional access](https://github.com/AzureAD/microsoft-identity-web/wiki/Managing-incremental-consent-and-conditional-access)
