"""Clerk JWT verification (plan §3: "verified via Clerk's JWKS, cached").

PyJWKClient caches fetched signing keys in-process, so this doesn't hit
Clerk's JWKS endpoint on every request.
"""

from dataclasses import dataclass
from functools import lru_cache

import jwt
from fastapi import HTTPException, Request, status
from jwt import PyJWKClient

from ..config import get_settings


@dataclass
class ClerkUser:
    clerk_user_id: str


@lru_cache
def _get_jwk_client() -> PyJWKClient:
    return PyJWKClient(get_settings().clerk_jwks_url, cache_keys=True)


def verify_clerk_token(token: str) -> ClerkUser:
    settings = get_settings()
    try:
        signing_key = _get_jwk_client().get_signing_key_from_jwt(token)
        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=settings.clerk_issuer,
            options={"require": ["exp", "iss", "sub"]},
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token") from exc

    return ClerkUser(clerk_user_id=payload["sub"])


def get_current_clerk_user(request: Request) -> ClerkUser:
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    token = auth_header.removeprefix("Bearer ").strip()
    return verify_clerk_token(token)
