using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.Identity.Client;
using Microsoft.Identity.Web;

namespace AspirePy.Web;

/// <summary>
/// Rejects the sign-in cookie when the in-memory token cache no longer holds the user's account
/// (for example after the app restarts). The user is then sent through sign-in again as soon as
/// the page loads, instead of the first API call failing after they've already typed their input.
/// </summary>
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

    // Only reject for a missing account. Other challenges (such as missing consent) would not be
    // fixed by signing in again, so rejecting the cookie for them would cause a redirect loop.
    private static bool AccountDoesNotExistInTokenCache(MicrosoftIdentityWebChallengeUserException ex) =>
        ex.InnerException is MsalUiRequiredException { ErrorCode: "user_null" };
}
