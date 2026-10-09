"""Regression tests for scoped RouterOS bootstrap credentials."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app.api.v1.provisioning import bootstrap as bootstrap_module
from app.api.v1.provisioning.bootstrap import (
    _issue_bootstrap_credential,
    _verify_bootstrap_session,
)
from app.core.security import create_access_token, verify_bootstrap_credential
from app.models.provisioning import ProvisioningStatus


def make_bootstrap_token(operation: str = "bootstrap.script", **overrides) -> str:
    claims = {
        "sub": "12",
        "jti": "single-use-id",
        "iat": datetime.now(timezone.utc).timestamp(),
        "purpose": "router_bootstrap",
        "session_id": "session-1",
        "router_id": 7,
        "bootstrap_scopes": [operation],
    }
    claims.update(overrides)
    return create_access_token(
        claims,
        expires_delta=timedelta(minutes=5),
        token_type="router_bootstrap",
    )


def test_bootstrap_credential_rejects_expired_token():
    token = create_access_token(
        {
            "sub": "12",
            "jti": "expired-id",
            "iat": datetime.now(timezone.utc).timestamp(),
            "purpose": "router_bootstrap",
            "session_id": "session-1",
            "router_id": 7,
            "bootstrap_scopes": ["bootstrap.script"],
        },
        expires_delta=timedelta(seconds=-1),
        token_type="router_bootstrap",
    )

    assert verify_bootstrap_credential(
        token,
        operation="bootstrap.script",
        session_id="session-1",
        router_id=7,
    ) is None


@pytest.mark.parametrize(
    ("session_id", "router_id", "operation"),
    [
        ("another-session", 7, "bootstrap.script"),
        ("session-1", 8, "bootstrap.script"),
        ("session-1", 7, "bootstrap.admin"),
    ],
)
def test_bootstrap_credential_rejects_wrong_binding_or_scope(
    session_id: str,
    router_id: int,
    operation: str,
):
    token = make_bootstrap_token()

    assert verify_bootstrap_credential(
        token,
        operation=operation,
        session_id=session_id,
        router_id=router_id,
    ) is None


def test_bootstrap_credential_rejects_scope_escalation():
    token = make_bootstrap_token(
        bootstrap_scopes=["bootstrap.script", "bootstrap.admin"]
    )

    assert verify_bootstrap_credential(
        token,
        operation="bootstrap.script",
        session_id="session-1",
        router_id=7,
    ) is None


@pytest.mark.asyncio
async def test_bootstrap_credential_replay_is_rejected(monkeypatch):
    session = SimpleNamespace(
        session_id="session-1",
        router_id=7,
        user_id=12,
        status=ProvisioningStatus.PENDING,
        configuration={},
    )
    user = SimpleNamespace(id=12, is_active=True)
    router = SimpleNamespace(id=7, name="router-1")

    class Result:
        def __init__(self, value):
            self.value = value

        def scalar_one_or_none(self):
            return self.value

    db = SimpleNamespace(
        execute=AsyncMock(side_effect=[
            Result(session),
            Result(user),
            Result(router),
            Result(session),
            Result(user),
            Result(router),
        ]),
        commit=AsyncMock(),
    )
    monkeypatch.setattr(
        bootstrap_module,
        "authorize_provisioning_router",
        AsyncMock(),
    )
    token = _issue_bootstrap_credential(12, "session-1", 7, "bootstrap.script")

    await _verify_bootstrap_session(
        db, token, "bootstrap.script", "session-1", "router-1"
    )
    with pytest.raises(HTTPException) as exc:
        await _verify_bootstrap_session(
            db, token, "bootstrap.script", "session-1", "router-1"
        )

    assert exc.value.status_code == 401
    db.commit.assert_awaited_once()
