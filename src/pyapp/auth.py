import os

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

_security = HTTPBearer()

_jwks_client: jwt.PyJWKClient | None = None


def _get_jwks_client() -> jwt.PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        tenant_id = os.environ["ENTRA_TENANT_ID"]
        _jwks_client = jwt.PyJWKClient(
            f"https://login.microsoftonline.com/{tenant_id}/discovery/v2.0/keys"
        )
    return _jwks_client


def load_jwks() -> None:
    """Pre-fetch JWKS at startup so the first request is not slow."""
    _get_jwks_client().fetch_data()


def validate_token(
    credentials: HTTPAuthorizationCredentials = Depends(_security),
) -> dict:
    tenant_id = os.environ.get("ENTRA_TENANT_ID", "")
    client_id = os.environ.get("ENTRA_CLIENT_ID", "")

    if not tenant_id or not client_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is not configured",
        )

    try:
        signing_key = _get_jwks_client().get_signing_key_from_jwt(credentials.credentials)
        return jwt.decode(
            credentials.credentials,
            signing_key.key,
            algorithms=["RS256"],
            audience=client_id,
            issuer=f"https://login.microsoftonline.com/{tenant_id}/v2.0",
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except jwt.InvalidTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        )
