"""Security utilities for authentication and authorization."""

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Union

import jwt
from jwt.exceptions import InvalidTokenError
import bcrypt
from pydantic import BaseModel

from app.core.config import settings


class TokenData(BaseModel):
    """Token data model."""

    user_id: Optional[int] = None
    username: Optional[str] = None
    role: Optional[str] = None
    organization_id: Optional[int] = None


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against its hash using bcrypt directly."""
    try:
        # Convert to bytes
        password_bytes = plain_password.encode('utf-8')
        hash_bytes = hashed_password.encode('utf-8') if isinstance(hashed_password, str) else hashed_password
        
        # Verify using bcrypt
        return bcrypt.checkpw(password_bytes, hash_bytes)
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"Password verification error: {str(e)}")
        return False


def get_password_hash(password: str) -> str:
    """Generate password hash using bcrypt directly."""
    try:
        # Convert to bytes
        password_bytes = password.encode('utf-8')
        
        # Generate salt and hash
        salt = bcrypt.gensalt(rounds=12)
        hashed = bcrypt.hashpw(password_bytes, salt)
        
        # Return as string
        return hashed.decode('utf-8')
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"Password hashing error: {str(e)}")
        raise


def create_access_token(
    data: Dict[str, Any],
    expires_delta: Optional[timedelta] = None,
    token_type: str = "access",
) -> str:
    """Create a signed token with an explicit token class."""
    to_encode = data.copy()
    
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(
            minutes=settings.access_token_expire_minutes
        )
    to_encode.update({"exp": expire, "type": token_type})
    encoded_jwt = jwt.encode(
        to_encode, settings.secret_key, algorithm=settings.algorithm
    )
    return encoded_jwt


def verify_bootstrap_credential(
    token: str,
    *,
    operation: str,
    session_id: str,
    router_id: int,
) -> Optional[Dict[str, Any]]:
    """Validate a short-lived credential limited to one bootstrap session.

    Bootstrap credentials are deliberately a distinct JWT type and cannot be
    used by the normal bearer-token dependency.
    """
    try:
        claims = jwt.decode(
            token,
            settings.secret_key,
            algorithms=[settings.algorithm],
            options={"require": ["exp", "iat", "sub", "jti"]},
        )
    except InvalidTokenError:
        return None

    scopes = claims.get("bootstrap_scopes")
    issued_at = claims.get("iat")
    expires_at = claims.get("exp")
    valid_lifetime = (
        isinstance(issued_at, (int, float))
        and not isinstance(issued_at, bool)
        and isinstance(expires_at, (int, float))
        and not isinstance(expires_at, bool)
        and 0 < expires_at - issued_at <= 600
        and issued_at <= datetime.now(timezone.utc).timestamp() + 30
    )
    if (
        claims.get("type") != "router_bootstrap"
        or claims.get("purpose") != "router_bootstrap"
        or scopes != [operation]
        or not isinstance(claims.get("sub"), str)
        or not claims["sub"].isdecimal()
        or str(claims.get("session_id")) != session_id
        or claims.get("router_id") != router_id
        or not isinstance(claims.get("jti"), str)
        or not claims["jti"]
        or not valid_lifetime
    ):
        return None
    return claims


def create_refresh_token(
    data: Dict[str, Any], expires_delta: Optional[timedelta] = None
) -> str:
    """Create JWT refresh token."""
    to_encode = data.copy()
    
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_expire_days)
    to_encode.update({"exp": expire, "type": "refresh"})
    encoded_jwt = jwt.encode(
        to_encode, settings.secret_key, algorithm=settings.algorithm
    )
    return encoded_jwt


def verify_token(token: str, token_type: str = "access") -> Optional[TokenData]:
    """Verify and decode JWT token."""
    try:
        payload = jwt.decode(
            token, settings.secret_key, algorithms=[settings.algorithm]
        )
        if payload.get("type") != token_type:
            return None
        user_id_str: str = payload.get("sub")
        username: str = payload.get("username")
        role: str = payload.get("role")
        organization_id = payload.get("organization_id")
        if user_id_str is None or username is None:
            return None
        # Convert string user_id back to int
        user_id = int(user_id_str)
        return TokenData(
            user_id=user_id,
            username=username,
            role=role,
            organization_id=organization_id
        )
    except InvalidTokenError:
        return None


def create_token_pair(
    user_id: int,
    username: str,
    role: str,
    organization_id: Optional[int] = None
) -> Dict[str, str]:
    """Create both access and refresh tokens."""
    token_data = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "organization_id": organization_id,
    }
    access_token = create_access_token(token_data)
    refresh_token = create_refresh_token(token_data)
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
    }


# create_2fa_challenge_token was removed with the local 2FA flow — 2FA is now
# handled centrally by the SSO IdP (auth-api).
