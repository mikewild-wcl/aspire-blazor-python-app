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
