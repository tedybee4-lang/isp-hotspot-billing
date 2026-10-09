"""Tests for the Supabase-to-VPS provisioning identity bridge."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException, Request

from app.api import deps
from app.models.user import UserRole


class FakeSupabaseResponse:
    def __init__(self, status_code: int, body: dict):
        self.status_code = status_code
        self.body = body

    def json(self):
        return self.body


class FakeSupabaseClient:
    def __init__(self, response: FakeSupabaseResponse):
        self.response = response

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return None

    async def get(self, url: str, headers: dict):
        assert url == "https://project.supabase.co/auth/v1/user"
        assert headers["apikey"] == "public-anon-key"
        assert headers["Authorization"] == "Bearer supabase-access-token"
        return self.response


def make_request() -> Request:
    return Request({
        "type": "http",
        "method": "GET",
        "path": "/api/v1/provisioning/sessions",
        "headers": [(b"authorization", b"Bearer supabase-access-token")],
        "query_string": b"",
        "server": ("test", 80),
        "client": ("test", 1234),
        "scheme": "https",
    })


@pytest.fixture
def reject_existing_auth(monkeypatch):
    async def reject(**kwargs):
        raise HTTPException(status_code=401, detail="Not authenticated")

    monkeypatch.setattr(deps, "get_current_user_unified", reject)
    monkeypatch.setattr(deps.settings, "supabase_auth_url", "https://project.supabase.co")
    monkeypatch.setattr(deps.settings, "supabase_anon_key", "public-anon-key")


@pytest.mark.asyncio
async def test_supabase_subject_maps_to_authoritative_operator(monkeypatch, reject_existing_auth):
    user = SimpleNamespace(
        supabase_user_id="auth-uuid",
        is_active=True,
        role=UserRole.ISP_TECHNICIAN,
        organization_id=42,
    )
    result = SimpleNamespace(scalar_one_or_none=lambda: user)
    db = SimpleNamespace(execute=AsyncMock(return_value=result))
    client = FakeSupabaseClient(FakeSupabaseResponse(200, {"id": "auth-uuid"}))
    monkeypatch.setattr(deps.httpx, "AsyncClient", lambda **kwargs: client)

    resolved = await deps.get_optional_current_user(make_request(), db)

    assert resolved is user
    db.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_unmapped_supabase_subject_is_forbidden(monkeypatch, reject_existing_auth):
    result = SimpleNamespace(scalar_one_or_none=lambda: None)
    db = SimpleNamespace(execute=AsyncMock(return_value=result))
    client = FakeSupabaseClient(FakeSupabaseResponse(200, {"id": "unmapped-uuid"}))
    monkeypatch.setattr(deps.httpx, "AsyncClient", lambda **kwargs: client)

    with pytest.raises(HTTPException) as exc:
        await deps.get_optional_current_user(make_request(), db)

    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_invalid_supabase_access_token_is_unauthorized(monkeypatch, reject_existing_auth):
    db = SimpleNamespace(execute=AsyncMock())
    client = FakeSupabaseClient(FakeSupabaseResponse(401, {"message": "invalid token"}))
    monkeypatch.setattr(deps.httpx, "AsyncClient", lambda **kwargs: client)

    with pytest.raises(HTTPException) as exc:
        await deps.get_optional_current_user(make_request(), db)

    assert exc.value.status_code == 401
    db.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_mapped_customer_cannot_provision(monkeypatch, reject_existing_auth):
    user = SimpleNamespace(
        supabase_user_id="customer-uuid",
        is_active=True,
        role=UserRole.CUSTOMER,
        organization_id=42,
    )
    result = SimpleNamespace(scalar_one_or_none=lambda: user)
    db = SimpleNamespace(execute=AsyncMock(return_value=result))
    client = FakeSupabaseClient(FakeSupabaseResponse(200, {"id": "customer-uuid"}))
    monkeypatch.setattr(deps.httpx, "AsyncClient", lambda **kwargs: client)

    with pytest.raises(HTTPException) as exc:
        await deps.get_optional_current_user(make_request(), db)

    assert exc.value.status_code == 403
