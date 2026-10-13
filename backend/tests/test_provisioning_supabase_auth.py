"""Tests for the Supabase-to-VPS provisioning identity bridge.

These pin the contract that the rebuilt provisioning feature depends on:

  * a valid Supabase access token resolves to the AUTHORITATIVE local user row
    (mapped via ``users.supabase_user_id``) — never a synthetic user, because
    ``provisioning_sessions.user_id`` has a foreign key to ``users.id``
    (the old synthetic ``id=0`` user made every session insert a 500);
  * an unmapped Supabase subject is 403, not a silently privileged user;
  * a customer role cannot provision;
  * a token Supabase rejects is 401;
  * no Bearer token is 401;
  * a misconfigured or unreachable Supabase bridge is 503, never 401/200;
  * a non-staff role is 403.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException, Request

from app.api import deps
from app.models.user import UserRole


class FakeSupabaseResponse:
    def __init__(self, status_code: int, body):
        self.status_code = status_code
        self.body = body

    def json(self):
        if isinstance(self.body, Exception):
            raise self.body
        return self.body


class FakeSupabaseClient:
    def __init__(self, response: FakeSupabaseResponse):
        self.response = response
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return None

    async def get(self, url: str, headers: dict):
        self.calls.append((url, headers))
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


def user_row(role=UserRole.ISP_TECHNICIAN, org_id=42):
    return SimpleNamespace(
        id=7,
        email="operator@isp.example.com",
        supabase_user_id="auth-uuid",
        is_active=True,
        role=role,
        organization_id=org_id,
    )


def db_returning(user):
    result = SimpleNamespace(scalar_one_or_none=lambda: user)
    return SimpleNamespace(execute=AsyncMock(return_value=result))


@pytest.mark.asyncio
async def test_supabase_subject_maps_to_authoritative_operator(monkeypatch, reject_existing_auth):
    """A valid token resolves to the real local row, so the session's
    ``user_id`` foreign key and the tenant scope both hold."""
    user = user_row()
    db = db_returning(user)
    client = FakeSupabaseClient(FakeSupabaseResponse(200, {"id": "auth-uuid"}))
    monkeypatch.setattr(deps.httpx, "AsyncClient", lambda **kwargs: client)

    resolved = await deps.get_optional_current_user(make_request(), db)

    assert resolved is user
    assert resolved.id == 7
    assert resolved.organization_id == 42
    assert resolved.role == UserRole.ISP_TECHNICIAN
    db.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_never_synthesizes_a_user(monkeypatch, reject_existing_auth):
    """Regression: the old fallback built an in-memory User with id=0. That row
    does not exist in ``users.id``, so every provisioning session insert failed
    with an IntegrityError (HTTP 500). No synthetic user may ever be returned."""
    db = db_returning(user_row())
    client = FakeSupabaseClient(FakeSupabaseResponse(200, {"id": "auth-uuid"}))
    monkeypatch.setattr(deps.httpx, "AsyncClient", lambda **kwargs: client)

    resolved = await deps.get_optional_current_user(make_request(), db)

    assert resolved.id != 0, "a synthetic id=0 user defeats the user_id FK"
    assert resolved.email != "provisioning@supabase"


@pytest.mark.asyncio
async def test_unmapped_supabase_subject_is_forbidden(monkeypatch, reject_existing_auth):
    db = db_returning(None)
    client = FakeSupabaseClient(FakeSupabaseResponse(200, {"id": "unmapped-uuid"}))
    monkeypatch.setattr(deps.httpx, "AsyncClient", lambda **kwargs: client)

    with pytest.raises(HTTPException) as exc:
        await deps.get_optional_current_user(make_request(), db)

    assert exc.value.status_code == 403
    db.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_invalid_supabase_access_token_is_unauthorized(monkeypatch, reject_existing_auth):
    db = db_returning(user_row())
    client = FakeSupabaseClient(FakeSupabaseResponse(401, {"message": "invalid token"}))
    monkeypatch.setattr(deps.httpx, "AsyncClient", lambda **kwargs: client)

    with pytest.raises(HTTPException) as exc:
        await deps.get_optional_current_user(make_request(), db)

    assert exc.value.status_code == 401
    # No local user may be loaded from a token Supabase rejected.
    db.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_expired_supabase_access_token_is_unauthorized(monkeypatch, reject_existing_auth):
    """A 401 from Supabase means the token is expired/revoked: the client must
    see 401 so it prompts a sign-in, never a 403 or a 500."""
    db = db_returning(user_row())
    client = FakeSupabaseClient(FakeSupabaseResponse(401, {"code": 401, "message": "token expired"}))
    monkeypatch.setattr(deps.httpx, "AsyncClient", lambda **kwargs: client)

    with pytest.raises(HTTPException) as exc:
        await deps.get_optional_current_user(make_request(), db)

    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_mapped_customer_cannot_provision(monkeypatch, reject_existing_auth):
    """Tenant isolation: a customer identity must not enroll routers — it would
    be a route to configuring another tenant's device."""
    db = db_returning(user_row(role=UserRole.CUSTOMER))
    client = FakeSupabaseClient(FakeSupabaseResponse(200, {"id": "auth-uuid"}))
    monkeypatch.setattr(deps.httpx, "AsyncClient", lambda **kwargs: client)

    with pytest.raises(HTTPException) as exc:
        await deps.get_optional_current_user(make_request(), db)

    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_inactive_mapped_user_cannot_provision(monkeypatch, reject_existing_auth):
    user = user_row()
    user.is_active = False
    db = db_returning(user)
    client = FakeSupabaseClient(FakeSupabaseResponse(200, {"id": "auth-uuid"}))
    monkeypatch.setattr(deps.httpx, "AsyncClient", lambda **kwargs: client)

    with pytest.raises(HTTPException) as exc:
        await deps.get_optional_current_user(make_request(), db)

    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_no_bearer_token_is_unauthorized(monkeypatch, reject_existing_auth):
    """Without a token no Supabase call may be made and no user resolved."""
    request = Request({
        "type": "http", "method": "GET", "path": "/api/v1/provisioning/sessions",
        "headers": [], "query_string": b"", "server": ("test", 80),
        "client": ("test", 1234), "scheme": "https",
    })
    db = db_returning(user_row())
    client = FakeSupabaseClient(FakeSupabaseResponse(200, {"id": "auth-uuid"}))
    monkeypatch.setattr(deps.httpx, "AsyncClient", lambda **kwargs: client)

    with pytest.raises(HTTPException) as exc:
        await deps.get_optional_current_user(request, db)

    assert exc.value.status_code == 401
    assert client.calls == []


@pytest.mark.asyncio
async def test_unconfigured_supabase_bridge_is_503_not_401(monkeypatch, reject_existing_auth):
    """SSO/Supabase unconfigured must never be presented as bad credentials: it
    is a server configuration fault. Also proves an unconfigured bridge cannot
    silently admit a request."""
    monkeypatch.setattr(deps.settings, "supabase_auth_url", None)
    monkeypatch.setattr(deps.settings, "supabase_anon_key", "")
    db = db_returning(user_row())
    client = FakeSupabaseClient(FakeSupabaseResponse(200, {"id": "auth-uuid"}))
    monkeypatch.setattr(deps.httpx, "AsyncClient", lambda **kwargs: client)

    with pytest.raises(HTTPException) as exc:
        await deps.get_optional_current_user(make_request(), db)

    assert exc.value.status_code == 503
    assert client.calls == []


@pytest.mark.asyncio
async def test_unreachable_supabase_is_503_not_401(monkeypatch, reject_existing_auth):
    """A Supabase outage must surface as 503 (service unavailable), not 401 —
    telling an operator to sign in again cannot fix a backend outage."""
    import httpx as real_httpx

    class Unreachable:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return None

        async def get(self, url, headers):
            raise real_httpx.ConnectError("connection refused")

    monkeypatch.setattr(deps.httpx, "AsyncClient", lambda **kwargs: Unreachable())
    db = db_returning(user_row())

    with pytest.raises(HTTPException) as exc:
        await deps.get_optional_current_user(make_request(), db)

    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_verification_uses_only_the_public_anon_key(monkeypatch, reject_existing_auth):
    """The anon key identifies the project, not the user: it is sent as `apikey`
    and the user token as `Authorization`. A service-role key must never be
    used, or the token would not be the caller's identity."""
    db = db_returning(user_row())
    client = FakeSupabaseClient(FakeSupabaseResponse(200, {"id": "auth-uuid"}))
    monkeypatch.setattr(deps.httpx, "AsyncClient", lambda **kwargs: client)

    await deps.get_optional_current_user(make_request(), db)

    assert client.calls, "the Supabase user endpoint must actually be called"
    url, headers = client.calls[0]
    assert url == "https://project.supabase.co/auth/v1/user"
    assert headers["apikey"] == "public-anon-key"
    assert headers["Authorization"] == "Bearer supabase-access-token"


@pytest.mark.asyncio
async def test_platform_owner_may_provision(monkeypatch, reject_existing_auth):
    db = db_returning(user_row(role=UserRole.PLATFORM_OWNER, org_id=None))
    client = FakeSupabaseClient(FakeSupabaseResponse(200, {"id": "auth-uuid"}))
    monkeypatch.setattr(deps.httpx, "AsyncClient", lambda **kwargs: client)

    resolved = await deps.get_optional_current_user(make_request(), db)
    assert resolved.role == UserRole.PLATFORM_OWNER


@pytest.mark.asyncio
async def test_isp_admin_may_provision(monkeypatch, reject_existing_auth):
    db = db_returning(user_row(role=UserRole.ISP_ADMIN))
    client = FakeSupabaseClient(FakeSupabaseResponse(200, {"id": "auth-uuid"}))
    monkeypatch.setattr(deps.httpx, "AsyncClient", lambda **kwargs: client)

    resolved = await deps.get_optional_current_user(make_request(), db)
    assert resolved.role == UserRole.ISP_ADMIN


@pytest.mark.asyncio
async def test_local_jwt_user_skips_the_supabase_bridge(monkeypatch):
    """Back-compat: a local HS256 JWT resolves without any Supabase call."""
    async def resolve_local(**kwargs):
        return user_row()

    monkeypatch.setattr(deps, "get_current_user_unified", resolve_local)
    client = FakeSupabaseClient(FakeSupabaseResponse(200, {"id": "auth-uuid"}))
    monkeypatch.setattr(deps.httpx, "AsyncClient", lambda **kwargs: client)
    db = db_returning(user_row())

    resolved = await deps.get_optional_current_user(make_request(), db)
    assert resolved.id == 7
    assert client.calls == []
