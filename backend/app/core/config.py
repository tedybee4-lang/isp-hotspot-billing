"""Application configuration settings."""

import warnings
from functools import lru_cache
from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, field_validator, model_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Application
    app_name: str = "ISP Billing System"
    app_version: str = "1.0.0"
    debug: bool = False
    environment: str = "development"

    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    workers: int = 1

    # Database
    database_url: str
    database_pool_size: int = 10
    database_max_overflow: int = 20
    database_echo: bool = False

    # Redis
    redis_url: str
    redis_password: Optional[str] = None

    # Celery
    celery_broker_url: str
    celery_result_backend: str

    # JWT
    secret_key: str
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 7

# ── SSO (decommissioned; Supabase JWT is the single identity path) ──
    # ADDITIVE: accepted alongside the existing local HS256 JWT. The local
    # login path is unchanged; these only configure RS256 SSO acceptance.
    sso_issuer: Optional[str] = None
    # When empty, the JWKS URL is derived as <issuer>/.well-known/jwks.json.
    sso_jwks_url: Optional[str] = None
    # Audience this service expects in SSO tokens (the isp-billing client id).
    sso_audience: str = "isp-billing-ui"
    # Supabase Auth token verification for browser-to-provisioning requests.
    # The anon key is public by design; service-role keys must never be used.
    supabase_auth_url: Optional[str] = None
    supabase_anon_key: Optional[str] = None
    # Shared secret for trusted service-to-service (S2S) callers via X-API-Key.
    internal_service_key: Optional[str] = None
    # Base URL of the central auth-api (the SSO host). auth-api is the SoT for
    # tenant IDENTITY + BRANDING (logo_url / brand_colors). isp-billing stores NO
    # local branding: the captive portal config fetches branding SERVER-SIDE from
    # auth-api's PUBLIC tenant-by-slug endpoint (GET /api/v1/tenants/by-slug/{slug})
    # and projects it through its own already-walled-gardened portal-config
    # response, so the pre-auth captive device never has to reach auth-api directly.
    # When empty, defaults to sso_issuer. Override via AUTH_API_URL.
    auth_api_url: Optional[str] = None
    # Request timeout (seconds) for the server-side auth-api branding fetch.
    auth_request_timeout: float = 6.0
    # In-process TTL (seconds) for the cached auth-api branding lookup (per slug).
    auth_branding_cache_ttl: int = 300

    @property
    def auth_api_base(self) -> str:
        """Resolved auth-api base URL for the public branding fetch.

        Prefers an explicit ``auth_api_url``; otherwise falls back to the SSO
        issuer host (auth-api serves SSO + the public tenant endpoints)."""
        return (self.auth_api_url or self.sso_issuer or "").rstrip("/")

    # ── Treasury payments (centralized — treasury-api is the ONLY path) ──
    # ALL payments (customer hotspot/PPPoE purchases, SMS-credit + WhatsApp
    # top-ups) are centralized on the central treasury-api (intent → shared pay
    # page; NATS consumer + get_status poll for confirmation). isp-billing has no
    # local payment-gateway path anymore; there is no flag to disable this.
    # Internal (S2S) base URL for treasury-api — used for create-intent / get-status
    # calls authenticated with internal_service_key (X-API-Key). e.g.
    # http://treasury-api.finance.svc.cluster.local:8080
    treasury_api_url: Optional[str] = None
    # Browser-reachable shared pay page base (treasury-ui). The customer is
    # redirected here to choose a gateway and pay. e.g.
    # (shared pay page base, configurable; off by default)
    treasury_pay_page_url: Optional[str] = None
    # Request timeout (seconds) for S2S treasury calls.
    treasury_request_timeout: float = 20.0
    # PUBLIC, browser-reachable host the captive (unauthenticated) device polls for
    # payment-status confirmation (the treasury/books public API). This host MUST be
    # whitelisted in the MikroTik captive walled-garden, otherwise a pre-auth device
    # cannot poll payment status and the purchase only "confirms" at the client-side
    # (payment-status host, configurable; off by default)
    treasury_status_host: Optional[str] = None
    # (payment-status host, configurable; off by default)
    # the platform-owned payment rail ("ISP Billing Platform") is enabled in
    # Treasury "platform operating tenant" identifier — the tenant under which
    # the platform-owned payment rail ("ISP Billing Platform") is enabled in
    # treasury. Captive customers pay this platform rail, so when an ISP tenant has
    # the platform tenant slug ``isp-billing`` (NOT an Organization.uuid). Override via PLATFORM_TREASURY_TENANT.
    platform_treasury_tenant: str = "isp-billing"

    # ── Central subscriptions-api (Phase 3, ADDITIVE) ──
    # Internal (S2S) base URL for subscriptions-api — used to read an ISP
    # provider tenant's subscription (plan / status / features / limits) and to
    # subscribe a tenant to an ISP plan, both authenticated with
    # internal_service_key (X-API-Key). e.g.
    # http://subscription-api.subscriptions.svc.cluster.local:4000
    # When empty, plan-limit gating degrades to ALLOW (migration-safe) and the
    # local Licence model remains the source of truth.
    # Canonical env var name (standardized fleet-wide 2026-08-07): SUBSCRIPTION_BASE_URL.
    subscription_base_url: Optional[str] = None
    # Request timeout (seconds) for S2S subscriptions calls.
    subscriptions_request_timeout: float = 10.0

    # ── Central notifications-api (centralized — the ONLY delivery path) ──
    # Internal (S2S) base URL for the central notifications-api, which owns ALL
    # notification DELIVERY (SMS / WhatsApp / email). isp-billing no longer has
    # local SMS/WhatsApp/email providers. Authenticated with internal_service_key
    # (X-API-Key). e.g. http://notifications-api.notifications.svc.cluster.local:4000
    #
    # IMPORTANT: this is DELIVERY only. All SMS-credit and WhatsApp-subscription
    # BILLING / top-up / usage logic stays local in isp-billing.
    notifications_api_url: Optional[str] = None
    # Request timeout (seconds) for S2S notifications calls.
    notifications_request_timeout: float = 10.0
    # Tenant id used on the notifications-api send endpoint path
    # (POST /{tenant_id}/notifications/messages). May be an Organization.uuid or
    # the platform tenant slug; when empty the caller-supplied tenant_id is used.
    notifications_tenant_id: Optional[str] = None

    # ── NATS / JetStream event integration (Phase 5, ADDITIVE) ──
    # Inter-service event bus. isp-billing PUBLISHES isp.* events via a
    # transactional outbox (outbox_events table + a Celery beat poller) and
    # CONSUMES treasury.payment.succeeded / auth.user.* / subscription.* via a
    # standalone durable consumer (app.events.consumer).
    #
    # When nats_url is EMPTY (default), the whole event subsystem is INERT:
    #   - the outbox poller no-ops (rows accumulate harmlessly / are pruned),
    #   - the consumer is simply not deployed,
    #   - the existing Phase-2 treasury payment/status POLLING remains the live
    #     confirmation path (it is never removed — it is the fallback).
    # This keeps the feature fully additive and migration-safe.
    nats_url: Optional[str] = None  # e.g. nats://nats.nats.svc.cluster.local:4222
    # JetStream stream that carries the isp.* subjects this service publishes.
    nats_stream_name: str = "isp"
    # Durable consumer name (shared across replicas → queue/durable, multi-pod
    # safe: each event delivered once to the group, not once per pod).
    nats_durable_name: str = "isp-billing-consumer"
    # Connection name reported to the NATS server (observability).
    nats_connection_name: str = "isp-billing"
    # Settle buffer (seconds) before the consumer's first bind attempt, to dodge
    # the JetStream "consumer already bound" race on rolling redeploys.
    nats_rebind_settle_seconds: int = 25

    # Encryption (NEW)
    encryption_key: Optional[str] = None
    master_password: Optional[str] = None
    encryption_salt: Optional[str] = None

    global_admin_email: str = "admin@ispbilling.example.com"
    # No insecure default: the platform super-admin password MUST come from the
    # environment. validate_production_secrets() rejects an unset or known-weak
    # value in production so the seeded admin can never use a shipped credential.
    global_admin_password: str = ""
    
    @model_validator(mode="after")
    def set_encryption_fallback(self) -> "Settings":
        """Set fallback encryption key for development if not provided."""
        if not self.encryption_key and not self.master_password:
            if self.environment == "development":
                # Use a fallback key derived from secret_key in development only
                import hashlib
                self.encryption_key = hashlib.sha256(self.secret_key.encode()).hexdigest()
                warnings.warn(
                    "No ENCRYPTION_KEY or MASTER_PASSWORD set. Using fallback derived from SECRET_KEY. "
                    "This is only acceptable in development. Set proper encryption keys in production!",
                    UserWarning
                )
        return self

    # URL Configuration
    backend_url: Optional[str] = None  # e.g., https://api.example.com
    frontend_url: Optional[str] = None  # e.g., https://app.example.com
    force_https: bool = False  # Force HTTPS for all integration URLs

    @model_validator(mode="after")
    def derive_backend_url_from_api_base(self) -> "Settings":
        """Backwards-compatible: if BACKEND_URL is not provided, derive it from
        API_BASE_URL (strip any trailing /api or /api/v1). This prevents a
        Helm/values mismatch where charts set API_BASE_URL but forget BACKEND_URL.
        """
        import os
        if not self.backend_url:
            api_base = os.getenv("API_BASE_URL") or os.getenv("NEXT_PUBLIC_API_URL")
            if api_base:
                # Strip known API path suffixes to get canonical service base
                for suffix in ("/api/v1", "/api"):
                    if api_base.endswith(suffix):
                        api_base = api_base[: -len(suffix)]
                        break
                # Ensure scheme present
                if api_base.startswith("http://") or api_base.startswith("https://"):
                    self.backend_url = api_base
                else:
                    self.backend_url = f"https://{api_base}"
        return self

    # CORS
    cors_origins: List[str] = [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://192.168.100.4:3000",
        "http://192.168.100.4:3001",
        "http://172.31.255.221:3000",
        "http://172.31.255.221:3001",
        # Deployed frontend (Vercel) — the provisioning wizard runs on the
        # public site and talks to the operator's engine, so its origins
        # must be allowed here. Override via CORS_ORIGINS when needed.
        "https://isp-hotspot-billing-phi.vercel.app",
        "https://isp-hotspot-billing-mhapfxdsa-malariachrome-7756s-projects.vercel.app",
    ]
    cors_allow_credentials: bool = True

    # Trusted hosts (comma-separated for production)
    allowed_hosts: Optional[str] = None  # e.g., "api.example.com,*.example.com"

    @field_validator("cors_origins", mode="before")
    @classmethod
    def assemble_cors_origins(cls, v: Union[str, List[str]]) -> Union[List[str], str]:
        """Parse CORS origins from string or list.

        Previously returned JSON-like strings unchanged which caused the value to
        remain a raw string in some environments. Accept both CSV *and* JSON
        array strings and normalize to a Python list of origins.
        """
        # Accept CSV string (e.g. "https://a.com,https://b.com")
        if isinstance(v, str) and not v.startswith("["):
            return [i.strip() for i in v.split(",")]

        # If value is a JSON array string (eg. '["https://a.com"]'), parse it
        if isinstance(v, str) and v.startswith("["):
            import json

            try:
                parsed = json.loads(v)
                if isinstance(parsed, list):
                    return parsed
            except Exception:
                # Fall through and return the original string so Pydantic can
                # attempt coercion (backwards compatible)
                return v

        # Already a list or other accepted shape — return as-is
        elif isinstance(v, (list, str)):
            return v
        raise ValueError(v)


    # NOTE (Phase C1): SMS / Email provider settings (AfricasTalking, Twilio,
    # SMTP, SendGrid, AWS SES) were removed — SMS / email / WhatsApp DELIVERY is
    # centralized on notifications-api now (see notifications_api_url above).

    # MikroTik
    mikrotik_default_username: str = "admin"
    mikrotik_default_password: str = "admin"
    mikrotik_default_port: int = 8728
    mikrotik_timeout: int = 10
    mikrotik_default_ip: str = "192.168.88.1"  # Default router IP for provisioning/ping
    mikrotik_default_subnet: str = "192.168.88.0/24"  # Default subnet for provisioning
    # API user credentials (created during bootstrap for secure API access)
    mikrotik_api_username: str = "isp_api"
    # No insecure default: the MikroTik API user password MUST come from the
    # environment (MIKROTIK_API_PASSWORD). An empty value disables use of the
    # shared default so a shipped credential can never be pushed to a router.
    mikrotik_api_password: str = ""

    # Router Agent (polling agent installed on MikroTik routers)
    agent_default_poll_interval: int = 10  # seconds between agent polls (low so hotspot create_user lands fast for post-redeem/payment auto-login)
    agent_offline_threshold_multiplier: int = 3  # offline if no poll in interval * multiplier
    agent_command_expiry_hours: int = 1  # default command expiry
    agent_max_commands_per_poll: int = 10  # max commands returned per poll
    agent_script_version: str = "1.0"  # current agent script version

    # VPN overlay (remote Winbox / management). Per-org overrides live in
    # OrganizationSettings.vpn_domain; this is the platform-wide default.
    vpn_domain: Optional[str] = None

    # ── WireGuard VPN overlay (router management tunnel) ──
    # The WG server runs in k8s ns `vpn`; routers dial it outbound (NAT-safe).
    # The server keypair lives ONLY in the k8s Secret `wg-server-keys`; the
    # PUBLIC key is injected here so the backend can hand it to routers during
    # bootstrap. The router generates + keeps its OWN private key — it is never
    # transmitted. Empty WG_SERVER_PUBLIC_KEY disables VPN enrollment (the
    # bootstrap script then skips the WireGuard block and routers stay on the
    # polling-agent fallback).
    wg_server_public_key: str = ""  # base64 server pubkey (from wg-server-keys Secret)
    wg_endpoint: Optional[str] = None
    wg_subnet: str = "10.8.0.0/16"  # tunnel subnet; server is .1, routers .2+
    # Shared bearer token authenticating the WG server's reconcile loop when it
    # pulls the authoritative peer list (GET /api/v1/vpn/peers). Stored in the
    # backend Secret and the WG server Secret. Empty => peer-list endpoint 503s.
    wg_peer_sync_token: str = ""

    @property
    def wg_enabled(self) -> bool:
        """True when VPN enrollment is configured (server pubkey present)."""
        return bool(self.wg_server_public_key.strip())

    # Rate Limiting
    rate_limit_enabled: bool = True
    rate_limit_requests: int = 100
    rate_limit_window: int = 60

    # Logging
    log_level: str = "INFO"
    log_format: str = "json"
    log_file: Optional[str] = None

    # File Upload
    max_file_size: int = 10485760  # 10MB
    upload_dir: str = "uploads"

    # Security
    bcrypt_rounds: int = 12
    password_min_length: int = 8
    session_timeout: int = 3600

    # Monitoring
    sentry_dsn: Optional[str] = None
    health_check_interval: int = 30

    # Backup
    backup_enabled: bool = True
    backup_schedule: str = "0 2 * * *"  # Daily at 2 AM
    backup_retention_days: int = 30
    backup_s3_bucket: Optional[str] = None

    @field_validator("environment")
    @classmethod
    def validate_environment(cls, v: str) -> str:
        """Validate environment setting."""
        if v not in ["development", "staging", "production"]:
            raise ValueError("Environment must be development, staging, or production")
        return v

    @model_validator(mode="after")
    def validate_production_secrets(self) -> "Settings":
        """Validate that production has proper secrets configured."""
        if self.environment == "production":
            issues = []

            # Check secret_key
            if len(self.secret_key) < 32:
                issues.append("SECRET_KEY must be at least 32 characters in production")
            dangerous_secrets = ["changeme", "secret", "your-secret-key", "changethis"]
            if any(d in self.secret_key.lower() for d in dangerous_secrets):
                issues.append("SECRET_KEY contains default/example values")

            # Check encryption key or master password
            if not self.encryption_key and not self.master_password:
                issues.append(
                    "ENCRYPTION_KEY or MASTER_PASSWORD required in production"
                )

            # Check admin credentials. Reject the unset default AND the known
            # weak/shipped values (the code default used to be "Vertex2020!",
            # which the previous single-string check missed entirely).
            weak_admin_passwords = {
                "",
                "superuser123",
                "vertex2020!",
                "changeme",
                "change-me",
                "admin",
                "password",
            }
            if self.global_admin_password.lower() in weak_admin_passwords:
                issues.append(
                    "GLOBAL_ADMIN_PASSWORD must be set to a strong, non-default "
                    "value in production"
                )

            # NOTE: MIKROTIK_API_PASSWORD is intentionally NOT enforced here.
            # It is only consumed when provisioning a router (it is pushed onto
            # the MikroTik device / embedded in the bootstrap script), never at
            # basic startup. Enforcing it globally re-introduced the "backend
            # won't boot without an unrelated credential" problem the deployment
            # kept hitting. Instead, Settings.require_mikrotik_api_password()
            # raises a clear error at the point of use so provisioning fails
            # loudly rather than shipping a weak/empty credential to a router.
            # The insecure "Vertex2020!" default remains removed (empty above).

            # Check database URL
            if "localhost" in self.database_url or "127.0.0.1" in self.database_url:
                warnings.warn(
                    "Database URL points to localhost in production environment",
                    UserWarning,
                )

            if issues:
                raise ValueError(
                    f"Production configuration validation failed: {'; '.join(issues)}"
                )

        return self

    def require_mikrotik_api_password(self) -> str:
        """Return the MikroTik API user password, raising if unset or weak.

        This password is pushed onto customer routers during bootstrap and
        provisioning (and embedded in the generated RouterOS bootstrap script),
        so it must never fall back to a shipped/empty default. It is validated
        at the point of use — not at application startup — so the backend can
        boot before any router exists while router provisioning still fails
        loudly with a sanitized message instead of writing a weak credential.

        Raises:
            ValueError: if MIKROTIK_API_PASSWORD is empty or a known weak/default
                value.
        """
        weak = {
            "",
            "vertex2020!",
            "superuser123",
            "changeme",
            "change-me",
            "change_me",
            "admin",
            "password",
            "router",
            "mikrotik",
        }
        value = (self.mikrotik_api_password or "").strip()
        if value.lower() in weak or len(value) < 8:
            raise ValueError(
                "MIKROTIK_API_PASSWORD must be set to a strong (>=8 chars), "
                "non-default value before provisioning routers. Configure it on "
                "the server environment; the insecure 'Vertex2020!' default is "
                "not restored."
            )
        return self.mikrotik_api_password

    @property
    def database_url_sync(self) -> str:
        """Get synchronous database URL for Alembic."""
        return self.database_url.replace("postgresql+asyncpg://", "postgresql://")

    @property
    def is_production(self) -> bool:
        """Check if running in production."""
        return self.environment == "production"

    @property
    def is_development(self) -> bool:
        """Check if running in development."""
        return self.environment == "development"

    @property
    def is_staging(self) -> bool:
        """Check if running in staging."""
        return self.environment == "staging"

    model_config = {
        "env_file": ".env",
        "case_sensitive": False,
        "extra": "ignore",
    }


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()


def clear_settings_cache() -> None:
    """Clear the settings cache. Useful for testing."""
    get_settings.cache_clear()


# Global settings instance
settings = get_settings()
