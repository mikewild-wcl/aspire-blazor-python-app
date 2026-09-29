import { useState } from 'react';
import { InteractionRequiredAuthError } from '@azure/msal-browser';
import { useMsal } from '@azure/msal-react';
import { apiScope } from '../authConfig';

type GreetingStatus = 'idle' | 'loading' | 'error';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';
const HELLO_ENDPOINT = `${API_BASE_URL}/hello`;

function HelloPanel() {
    const { instance, accounts } = useMsal();
    const [name, setName] = useState('');
    const [greeting, setGreeting] = useState('');
    const [status, setStatus] = useState<GreetingStatus>('idle');

    async function getAccessToken() {
        const request = { scopes: [apiScope], account: accounts[0] };
        try {
            const result = await instance.acquireTokenSilent(request);
            return result.accessToken;
        } catch (error) {
            if (error instanceof InteractionRequiredAuthError) {
                const result = await instance.acquireTokenPopup(request);
                return result.accessToken;
            }
            throw error;
        }
    }

    async function handleGreetingSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();          // stop the browser reloading the page

        const trimmedName = name.trim();
        if (!trimmedName) {
            return;
        }

        // Keep the previous greeting visible while loading so the card doesn't collapse and jump.
        setStatus('loading');

        try {
            const accessToken = await getAccessToken();
            const response = await fetch(`${HELLO_ENDPOINT}/${encodeURIComponent(trimmedName)}`, {
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${accessToken}`,
                },
            });

            if (!response.ok) {
                console.log(`Hello request failed: ${response.status} - ${response.statusText}`);
                setGreeting('');
                setStatus('error');
                return;
            }

            const data: { message: string } = await response.json();
            setGreeting(data.message);
            setStatus('idle');
        } catch (error) {
            console.log('Hello request failed', error);
            setGreeting('');
            setStatus('error');
        }
    }

    return (
        <div className="hello-card">
            <h2>Say hello</h2>
            <p>Enter your name and get a greeting from the Python API.</p>

            <form className="hello-form" onSubmit={handleGreetingSubmit}>
                <input className="hello-input" type="text" placeholder="Enter your name" value={name} onChange={(e) => setName(e.target.value)} />
                <button className="hello-button" type="submit" disabled={status === 'loading'}>
                    {status === 'loading' ? 'Greeting…' : 'Greet'}
                </button>
            </form>

            {greeting && <p className="hello-result" aria-live="polite">{greeting}</p>}

            {status === 'error' && <p className="hello-result is-error" aria-live="polite">Couldn't get a greeting from the API.</p>}
        </div>
    );
}

export default HelloPanel;
