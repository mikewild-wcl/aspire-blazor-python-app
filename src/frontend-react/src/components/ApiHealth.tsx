import { useEffect, useMemo, useState } from 'react';

type HealthState = 'checking' | 'healthy' | 'unhealthy';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';
const HEALTH_ENDPOINT = `${API_BASE_URL}/health`;

function ApiHealth() {
    const [status, setStatus] = useState<HealthState>('checking');

    useEffect(() => {
        const controller = new AbortController();

        const checkHealth = async () => {
            try {
                const response = await fetch(HEALTH_ENDPOINT, {
                    method: 'GET',
                    signal: controller.signal,
                    headers: {
                        Accept: 'application/json, text/plain, */*',
                    },
                });

                const body = await response.text();
                console.log(`API health check response: ${response.status} - ${response.statusText} - ${body}`);

                setStatus(response.ok && body.toLowerCase() === "healthy" ? 'healthy' : 'unhealthy');
            } catch {
                if (!controller.signal.aborted) {
                    setStatus('unhealthy');
                }
            }
        };

        void checkHealth();

        return () => {
            controller.abort();
        };
    }, []);

    const statusText = useMemo(() => {
        if (status === 'healthy') {
            return 'Healthy';
        }
        if (status === 'unhealthy') {
            return 'Unhealthy';
        }
        return 'Checking';
    }, [status]);

    const helperText = useMemo(() => {
        if (status === 'healthy') {
            return 'Your service is reachable and responding as expected.';
        }
        if (status === 'unhealthy') {
            return `The API health check failed at ${HEALTH_ENDPOINT}.`;
        }
        return `Checking API status at ${HEALTH_ENDPOINT}...`;
    }, [status]);

    return (
        <article className="api-health-card" aria-live="polite">
            <h2>API Health</h2>
            <p>
                Backend status:{' '}
                <span className={`api-health-status is-${status}`}>{statusText}</span>
            </p>
            <p>{helperText}</p>
        </article>
    );
}

export default ApiHealth;