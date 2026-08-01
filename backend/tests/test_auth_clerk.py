from unittest.mock import MagicMock, patch

import jwt
import pytest
from fastapi import HTTPException

from app.auth.clerk import ClerkUser, verify_clerk_token


def _make_token(claims: dict, key, kid: str = "test-kid") -> str:
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": kid})


@pytest.fixture
def rsa_keypair():
    from cryptography.hazmat.primitives.asymmetric import rsa

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private_key, private_key.public_key()


def test_verify_clerk_token_accepts_valid_token(rsa_keypair):
    private_key, public_key = rsa_keypair
    token = _make_token(
        {"sub": "user_abc123", "iss": "https://example.clerk.accounts.dev", "exp": 9999999999},
        private_key,
    )

    fake_signing_key = MagicMock()
    fake_signing_key.key = public_key
    with patch("app.auth.clerk._get_jwk_client") as mock_get_client:
        mock_get_client.return_value.get_signing_key_from_jwt.return_value = fake_signing_key

        user = verify_clerk_token(token)

    assert user == ClerkUser(clerk_user_id="user_abc123")


def test_verify_clerk_token_rejects_expired_token(rsa_keypair):
    private_key, public_key = rsa_keypair
    token = _make_token(
        {"sub": "user_abc123", "iss": "https://example.clerk.accounts.dev", "exp": 1},  # long expired
        private_key,
    )

    fake_signing_key = MagicMock()
    fake_signing_key.key = public_key
    with patch("app.auth.clerk._get_jwk_client") as mock_get_client:
        mock_get_client.return_value.get_signing_key_from_jwt.return_value = fake_signing_key

        with pytest.raises(HTTPException) as exc_info:
            verify_clerk_token(token)

    assert exc_info.value.status_code == 401


def test_verify_clerk_token_rejects_wrong_issuer(rsa_keypair):
    private_key, public_key = rsa_keypair
    token = _make_token(
        {"sub": "user_abc123", "iss": "https://attacker.example.com", "exp": 9999999999},
        private_key,
    )

    fake_signing_key = MagicMock()
    fake_signing_key.key = public_key
    with patch("app.auth.clerk._get_jwk_client") as mock_get_client:
        mock_get_client.return_value.get_signing_key_from_jwt.return_value = fake_signing_key

        with pytest.raises(HTTPException) as exc_info:
            verify_clerk_token(token)

    assert exc_info.value.status_code == 401
