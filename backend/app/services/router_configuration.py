"""
Router configuration service for MikroTik provisioning.

This service handles the actual configuration of HotSpot, PPPoE, and WireGuard services
on MikroTik routers after bootstrap enrollment.
"""
import logging
import asyncio
from typing import Dict, List, Optional, Any
from datetime import datetime
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.models.router import Router
from app.core.encryption import get_credential_encryption
from app.core.config import settings

logger = logging.getLogger(__name__)


class RouterConfigurationService:
    """Service for configuring MikroTik routers with HotSpot, PPPoE, and WireGuard services."""
    
    def __init__(self, db: AsyncSession):
        self.db = db
    
    async def configure_router_services(
        self,
        router_id: int,
        service_type: str,
        configuration: Dict[str, Any]
    ) -> Router:
        """Configure router services based on service type and configuration.
        
        Args:
            router_id: Router ID to configure
            service_type: 'hotspot', 'pppoe_server', or 'both'
            configuration: Configuration dictionary with interface and settings
            
        Returns:
            Updated router instance
        """
        router = await self._get_router(router_id)
        
        try:
            # Apply service configurations based on type
            if service_type in ('hotspot', 'both'):
                await self._configure_hotspot(router, configuration)
                
            if service_type in ('pppoe_server', 'both'):
                await self._configure_pppoe(router, configuration)
                
            if service_type == 'hotspot' or (service_type == 'both' and configuration.get('enable_wireguard', False)):
                await self._configure_wireguard(router, configuration)
            
            # Mark provisioning as complete
            await self._mark_provisioning_complete(router, service_type)
            
            logger.info(
                f"Successfully configured router {router_id} "
                f"with service_type={service_type}, interfaces={configuration.get('interfaces', [])}"
            )
            
            return router
            
        except Exception as e:
            logger.error(f"Failed to configure router {router_id}: {str(e)}")
            raise
    
    async def _get_router(self, router_id: int) -> Router:
        """Get router by ID."""
        result = await self.db.execute(select(Router).where(Router.id == router_id))
        router = result.scalar_one_or_none()
        
        if not router:
            raise ValueError(f"Router {router_id} not found")
            
        return router
    
    async def _configure_hotspot(self, router: Router, config: Dict[str, Any]) -> None:
        """Configure HotSpot service on the router.
        
        Args:
            router: Router instance
            config: Configuration dictionary
        """
        hotspot_config = config.get('hotspot_config', {})
        
        # Prepare Hotspot configuration commands
        hotspot_commands = self._build_hotspot_commands(router, hotspot_config)
        
        # Apply configuration via MikroTik API
        await self._apply_router_configuration(router, hotspot_commands)
        
        # Update router with Hotspot interface info
        if hotspot_config.get('interface'):
            router.hotspot_interface = hotspot_config['interface']
    
    async def _configure_pppoe(self, router: Router, config: Dict[str, Any]) -> None:
        """Configure PPPoE server on the router.
        
        Args:
            router: Router instance
            config: Configuration dictionary
        """
        pppoe_config = config.get('pppoe_config', {})
        
        # Prepare PPPoE configuration commands
        pppoe_commands = self._build_pppoe_commands(router, pppoe_config)
        
        # Apply configuration via MikroTik API
        await self._apply_router_configuration(router, pppoe_commands)
        
        # Update router with PPPoE interface info
        if pppoe_config.get('interface'):
            router.pppoe_interface = pppoe_config['interface']
    
    async def _configure_wireguard(self, router: Router, config: Dict[str, Any]) -> None:
        """Configure WireGuard tunnel on the router.
        
        Args:
            router: Router instance
            config: Configuration dictionary
        """
        wireguard_config = config.get('wireguard_config', {})
        
        # Only configure if WireGuard is enabled and required infrastructure exists
        if not wireguard_config.get('enabled', False):
            logger.info(f"WireGuard not enabled for router {router.id}")
            return
        
        # Check if required WireGuard infrastructure is available
        if not self._has_wireguard_infrastructure():
            logger.warning(f"WireGuard infrastructure not available for router {router.id}")
            return
        
        # Prepare WireGuard configuration commands
        wireguard_commands = self._build_wireguard_commands(router, wireguard_config)
        
        # Apply configuration via MikroTik API
        await self._apply_router_configuration(router, wireguard_commands)
        
        # Update router with WireGuard info
        router.wireguard_enabled = True
        router.wireguard_tunnel_ip = wireguard_config.get('tunnel_ip')
    
    def _build_hotspot_commands(self, router: Router, config: Dict[str, Any]) -> List[str]:
        """Build HotSpot configuration commands.
        
        Args:
            router: Router instance
            config: HotSpot configuration
            
        Returns:
            List of RouterOS commands
        """
        commands = [
            f"# HotSpot Configuration - {datetime.utcnow().isoformat()}",
            f"/ip hotspot setup",
            f"\tinterface={config.get('interface', 'ether2')}",
            f"\tserver-address={config.get('server_address', '192.168.100.1')}",
            f"\taddress-list={config.get('address_list', 'hotspot-clients')}",
            f"\tauth-type={config.get('auth_type', 'pap')}",
            f"\tradius={config.get('radius_server', '')}",
            f"\tmac-authentication={config.get('mac_auth', 'no')}",
            f"\tdns-server={config.get('dns_server', '8.8.8.8')}",
            f"\tnat={config.get('nat', 'yes')}",
            f"\tfirewall={config.get('firewall', 'yes')}",
            f"\tcorner-cases={config.get('corner_cases', 'yes')}",
        ]
        
        # Add captive portal configuration if specified
        if config.get('captive_portal_enabled'):
            commands.extend([
                f"/ip hotspot profile add name=isp-hotspot",
                f"    authentication=other",
                f"    http-header-names=Host",
                f"    http-pass-same=true",
                f"    http-proxy-support=no",
                f"    mac-cookie-timeout=5m",
                f"    mac-notification=no",
                f"    act-as-browser=no",
                f"    no-chaining=no",
                f"    sso=no",
                f"\t\"{config.get('login_page_url', 'http://192.168.100.100/hotspot/login.html')}\"",
            ])
        
        return commands
    
    def _build_pppoe_commands(self, router: Router, config: Dict[str, Any]) -> List[str]:
        """Build PPPoE server configuration commands.
        
        Args:
            router: Router instance
            config: PPPoE configuration
            
        Returns:
            List of RouterOS commands
        """
        commands = [
            f"# PPPoE Server Configuration - {datetime.utcnow().isoformat()}",
            f"/interface pppoe-server",
            f"\tadd name=PPPoE-Out",
            f"\t\tinterface={config.get('interface', 'ether3')}",
            f"\t\tacct-profile={config.get('acct_profile', '')}",
            f"\t\tauthentication={config.get('authentication', 'pap')}",
            f"\t\trate-limit={config.get('rate_limit', '')}",
            f"\t\tip-pool={config.get('ip_pool', 'pppoe-pool')}",
            f"\t\tradius={config.get('radius_server', '')}",
            f"\t\tradius-accounting={config.get('radius_accounting', 'no')}",
            f"\t\tradius-nas-ip={config.get('radius_nas_ip', '192.168.100.7')}",
        ]
        
        # Add IP pool configuration if specified
        if config.get('ip_pool_start') and config.get('ip_pool_end'):
            commands.extend([
                f"/ip pool add name=PPPoE-Pool",
                f"\tranges={config.get('ip_pool_start')} - {config.get('ip_pool_end')}",
            ])
        
        return commands
    
    def _build_wireguard_commands(self, router: Router, config: Dict[str, Any]) -> List[str]:
        """Build WireGuard configuration commands.
        
        Args:
            router: Router instance
            config: WireGuard configuration
            
        Returns:
            List of RouterOS commands
        """
        commands = [
            f"# WireGuard Configuration - {datetime.utcnow().isoformat()}",
            f"/interface wireguard",
            f"\tadd name=ISP-Tunnel",
            f"\t\tip-address={config.get('tunnel_ip', '10.0.0.1/24')}",
            f"\t\tpeer=ISP-Server",
            f"\t\tprivate-key={config.get('private_key', '')}",
            f"\t\tlisten-port={config.get('listen_port', 51820)}",
            f"\t\tfirewall=default-action=drop",
            f"\t\tcomment=ISP Billing WireGuard Tunnel",
            f"",
            f"/interface wireguard peer add",
            f"\tname=ISP-Server",
            f"\t\tip={config.get('peer_ip', '10.0.0.2')}",
            f"\t\tpublic-key={config.get('public_key', '')}",
            f"\t\tendpoint-address={config.get('endpoint_ip', 'isp-server.example.com:51820')}",
            f"\t\tpersistent-keepalive={config.get('keepalive_interval', '25s')}",
        ]
        
        return commands
    
    async def _apply_router_configuration(self, router: Router, commands: List[str]) -> None:
        """Apply configuration commands to the router via API.
        
        Args:
            router: Router instance
            commands: List of RouterOS commands to apply
        """
        try:
            # Get router credentials
            credentials = await self._get_router_credentials(router)
            
            if not credentials:
                logger.warning(f"No credentials available for router {router.id}")
                return
            
            # Apply commands via MikroTik API
            from app.integrations.mikrotik import MikroTikClient
            client = MikroTikClient()
            
            # Connect to router
            await client.connect(
                ip_address=router.ip_address,
                username=credentials['username'],
                password=credentials['password'],
                port=router.port or 8728,
            )
            
            # Apply each command
            for command in commands:
                if command.strip() and not command.startswith('#'):
                    await client.execute_command(command)
            
            # Disconnect
            await client.disconnect(router.ip_address, router.port or 8728)
            
            logger.info(f"Applied {len(commands)} configuration commands to router {router.id}")
            
        except Exception as e:
            logger.error(f"Failed to apply configuration to router {router.id}: {str(e)}")
            raise
    
    async def _get_router_credentials(self, router: Router) -> Optional[Dict[str, str]]:
        """Get router credentials for API access.
        
        Args:
            router: Router instance
            
        Returns:
            Dict with username and password or None if not available
        """
        from app.core.encryption import get_credential_encryption
        
        # Try to get from encrypted storage first
        if router.api_credentials_encrypted:
            encryption = get_credential_encryption()
            try:
                credentials = encryption.decrypt_credentials(router.api_credentials_encrypted)
                return credentials
            except Exception as e:
                logger.error(f"Failed to decrypt credentials for router {router.id}: {e}")
        
        # Fallback to default credentials
        logger.info(f"Using default credentials for router {router.id}")
        return {
            'username': settings.mikrotik_api_username,
            'password': settings.mikrotik_api_password
        }
    
    def _has_wireguard_infrastructure(self) -> bool:
        """Check if WireGuard infrastructure is available.
        
        Returns:
            True if WireGuard infrastructure is available
        """
        # Check if backend has WireGuard service configured
        try:
            from app.services.wireguard import WireGuardService
            wg_service = WireGuardService(None)  # Pass None for db since this is just checking availability
            return wg_service.enabled
        except Exception:
            logger.warning("Could not check WireGuard infrastructure availability")
            return False
    
    async def _mark_provisioning_complete(self, router: Router, service_type: str) -> None:
        """Mark router provisioning as complete and update status.
        
        Args:
            router: Router instance
            service_type: Service type that was configured
        """
        from app.services.router_provisioning import mark_provisioning_complete
        
        # Update router status in database
        router.provisioning_status = 'provisioned'
        router.bootstrap_completed = True
        router.last_provisioned_at = datetime.utcnow()
        
        # Store service type information
        existing_config = {}
        if router.config:
            try:
                import json
                existing_config = json.loads(router.config) if isinstance(router.config, str) else router.config
            except (json.JSONDecodeError, TypeError):
                existing_config = {}
        
        existing_config["provisioned_service_type"] = service_type
        existing_config["provisioned_at"] = datetime.utcnow().isoformat()
        
        import json
        router.config = json.dumps(existing_config)
        
        await self.db.commit()
        await self.db.refresh(router)
        
        logger.info(f"Marked router {router.id} provisioning as complete (service_type={service_type})")


# Global instance for use throughout the application
async def get_router_configuration_service(db: AsyncSession) -> RouterConfigurationService:
    """Get router configuration service instance.
    
    Args:
        db: Database session
        
    Returns:
        RouterConfigurationService instance
    """
    return RouterConfigurationService(db)