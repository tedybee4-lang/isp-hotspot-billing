"""
Service provisioning logic for MikroTik router services.

This service handles the actual provisioning and verification of HotSpot, PPPoE, and WireGuard
services on MikroTik routers, including connectivity testing and service verification.
"""
import asyncio
import logging
from typing import Dict, List, Optional, Any
from datetime import datetime
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.models.router import Router
from app.core.config import settings

logger = logging.getLogger(__name__)


class ServiceProvisioningLogic:
    """Service for provisioning and verifying MikroTik router services."""
    
    def __init__(self, db: AsyncSession):
        self.db = db
    
    async def provision_services(
        self,
        router_id: int,
        service_type: str,
        configuration: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Provision router services with verification.
        
        Args:
            router_id: Router ID to provision
            service_type: 'hotspot', 'pppoe_server', or 'both'
            configuration: Configuration dictionary
            
        Returns:
            Provisioning result with service status and verification results
        """
        router = await self._get_router(router_id)
        
        provisioning_result = {
            'router_id': router_id,
            'service_type': service_type,
            'status': 'pending',
            'start_time': datetime.utcnow(),
            'steps': [],
            'verification_results': {},
            'errors': [],
            'warnings': []
        }
        
        try:
            # Step 1: Verify router connectivity
            connectivity_result = await self._verify_router_connectivity(router)
            provisioning_result['steps'].append({
                'step': 'connectivity_check',
                'status': 'completed' if connectivity_result['success'] else 'failed',
                'details': connectivity_result
            })
            
            if not connectivity_result['success']:
                raise Exception(f"Router connectivity failed: {connectivity_result['error']}")
            
            # Step 2: Configure services based on service type
            if service_type in ('hotspot', 'both'):
                hotspot_result = await self._configure_hotspot_service(
                    router, configuration.get('hotspot_config', {})
                )
                provisioning_result['verification_results']['hotspot'] = hotspot_result
                provisioning_result['steps'].append({
                    'step': 'hotspot_provisioning',
                    'status': 'completed' if hotspot_result['success'] else 'failed',
                    'details': hotspot_result
                })
            
            if service_type in ('pppoe_server', 'both'):
                pppoe_result = await self._configure_pppoe_service(
                    router, configuration.get('pppoe_config', {})
                )
                provisioning_result['verification_results']['pppoe'] = pppoe_result
                provisioning_result['steps'].append({
                    'step': 'pppoe_provisioning',
                    'status': 'completed' if pppoe_result['success'] else 'failed',
                    'details': pppoe_result
                })
            
            # Step 3: Configure WireGuard if needed and available
            wireguard_result = None
            if service_type in ('hotspot', 'both') and configuration.get('enable_wireguard', False):
                wireguard_result = await self._configure_wireguard_service(
                    router, configuration.get('wireguard_config', {})
                )
                provisioning_result['verification_results']['wireguard'] = wireguard_result
                provisioning_result['steps'].append({
                    'step': 'wireguard_provisioning',
                    'status': 'completed' if wireguard_result['success'] else 'failed',
                    'details': wireguard_result
                })
            
            # Step 4: Verify service functionality
            verification_result = await self._verify_service_functionality(
                router, service_type, provisioning_result['verification_results']
            )
            provisioning_result['verification_results']['verification'] = verification_result
            provisioning_result['steps'].append({
                'step': 'service_verification',
                'status': 'completed' if verification_result['success'] else 'failed',
                'details': verification_result
            })
            
            # Mark provisioning as complete if all steps succeeded
            all_steps_success = all(
                step['status'] == 'completed' 
                for step in provisioning_result['steps']
            )
            
            provisioning_result['status'] = 'completed' if all_steps_success else 'partial'
            provisioning_result['end_time'] = datetime.utcnow()
            
            if not all_steps_success:
                provisioning_result['errors'].extend([
                    f"Provisioning completed with {len([s for s in provisioning_result['steps'] if s['status'] == 'failed'])} failed steps"
                ])
            
            logger.info(
                f"Service provisioning completed for router {router_id}: {provisioning_result['status']}"
            )
            
            return provisioning_result
            
        except Exception as e:
            provisioning_result['status'] = 'failed'
            provisioning_result['errors'].append(str(e))
            provisioning_result['end_time'] = datetime.utcnow()
            
            logger.error(f"Service provisioning failed for router {router_id}: {str(e)}")
            raise
    
    async def _get_router(self, router_id: int) -> Router:
        """Get router by ID."""
        result = await self.db.execute(select(Router).where(Router.id == router_id))
        router = result.scalar_one_or_none()
        
        if not router:
            raise ValueError(f"Router {router_id} not found")
            
        return router
    
    async def _verify_router_connectivity(self, router: Router) -> Dict[str, Any]:
        """Verify router connectivity and API access.
        
        Args:
            router: Router instance
            
        Returns:
            Connectivity verification result
        """
        try:
            # Get router credentials
            credentials = await self._get_router_credentials(router)
            
            if not credentials:
                return {
                    'success': False,
                    'error': 'No credentials available for router connectivity test',
                    'method': None
                }
            
            # Try to connect via API
            from app.integrations.mikrotik import MikroTikClient
            client = MikroTikClient()
            
            # Test connection
            connection = await client.connect(
                ip_address=router.ip_address,
                username=credentials['username'],
                password=credentials['password'],
                port=router.port or 8728,
            )
            
            # Test basic command (get system identity)
            result = await client.execute_command('/system/identity/get')
            
            # Disconnect
            await client.disconnect(router.ip_address, router.port or 8728)
            
            return {
                'success': True,
                'error': None,
                'method': 'api',
                'router_identity': result[0].get('name') if result else None,
                'connection_time': datetime.utcnow().isoformat()
            }
            
        except Exception as e:
            logger.warning(f"Router connectivity test failed for {router.id}: {str(e)}")
            return {
                'success': False,
                'error': str(e),
                'method': 'api',
                'retry_suggested': True
            }
    
    async def _configure_hotspot_service(
        self, 
        router: Router, 
        config: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Configure HotSpot service on the router.
        
        Args:
            router: Router instance
            config: HotSpot configuration
            
        Returns:
            HotSpot provisioning result
        """
        result = {
            'success': False,
            'service': 'hotspot',
            'interface': config.get('interface'),
            'start_time': datetime.utcnow(),
            'end_time': None,
            'commands_executed': [],
            'verification': {},
            'errors': [],
            'warnings': []
        }
        
        try:
            # Build HotSpot configuration commands
            commands = self._build_hotspot_commands(router, config)
            
            # Apply configuration
            await self._apply_commands(router, commands)
            
            # Verify HotSpot configuration
            verification = await self._verify_hotspot_configuration(router, config)
            
            result['commands_executed'] = commands
            result['verification'] = verification
            result['end_time'] = datetime.utcnow()
            
            if verification['success']:
                result['success'] = True
                logger.info(f"HotSpot service successfully configured on router {router.id}")
            else:
                result['errors'].extend(verification.get('errors', []))
                logger.warning(f"HotSpot service configuration incomplete on router {router.id}: {verification.get('error')}")
            
        except Exception as e:
            result['errors'].append(str(e))
            logger.error(f"HotSpot service configuration failed for router {router.id}: {str(e)}")
        
        return result
    
    async def _configure_pppoe_service(
        self, 
        router: Router, 
        config: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Configure PPPoE service on the router.
        
        Args:
            router: Router instance
            config: PPPoE configuration
            
        Returns:
            PPPoE provisioning result
        """
        result = {
            'success': False,
            'service': 'pppoe',
            'interface': config.get('interface'),
            'start_time': datetime.utcnow(),
            'end_time': None,
            'commands_executed': [],
            'verification': {},
            'errors': [],
            'warnings': []
        }
        
        try:
            # Build PPPoE configuration commands
            commands = self._build_pppoe_commands(router, config)
            
            # Apply configuration
            await self._apply_commands(router, commands)
            
            # Verify PPPoE configuration
            verification = await self._verify_pppoe_configuration(router, config)
            
            result['commands_executed'] = commands
            result['verification'] = verification
            result['end_time'] = datetime.utcnow()
            
            if verification['success']:
                result['success'] = True
                logger.info(f"PPPoE service successfully configured on router {router.id}")
            else:
                result['errors'].extend(verification.get('errors', []))
                logger.warning(f"PPPoE service configuration incomplete on router {router.id}: {verification.get('error')}")
            
        except Exception as e:
            result['errors'].append(str(e))
            logger.error(f"PPPoE service configuration failed for router {router.id}: {str(e)}")
        
        return result
    
    async def _configure_wireguard_service(
        self, 
        router: Router, 
        config: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Configure WireGuard service on the router.
        
        Args:
            router: Router instance
            config: WireGuard configuration
            
        Returns:
            WireGuard provisioning result
        """
        result = {
            'success': False,
            'service': 'wireguard',
            'tunnel_ip': config.get('tunnel_ip'),
            'start_time': datetime.utcnow(),
            'end_time': None,
            'commands_executed': [],
            'verification': {},
            'errors': [],
            'warnings': []
        }
        
        try:
            # Check if WireGuard infrastructure is available
            if not self._has_wireguard_infrastructure():
                result['warnings'].append('WireGuard infrastructure not available')
                result['end_time'] = datetime.utcnow()
                return result
            
            # Build WireGuard configuration commands
            commands = self._build_wireguard_commands(router, config)
            
            # Apply configuration
            await self._apply_commands(router, commands)
            
            # Verify WireGuard configuration
            verification = await self._verify_wireguard_configuration(router, config)
            
            result['commands_executed'] = commands
            result['verification'] = verification
            result['end_time'] = datetime.utcnow()
            
            if verification['success']:
                result['success'] = True
                logger.info(f"WireGuard service successfully configured on router {router.id}")
            else:
                result['errors'].extend(verification.get('errors', []))
                logger.warning(f"WireGuard service configuration incomplete on router {router.id}: {verification.get('error')}")
            
        except Exception as e:
            result['errors'].append(str(e))
            logger.error(f"WireGuard service configuration failed for router {router.id}: {str(e)}")
        
        return result
    
    def _build_hotspot_commands(self, router: Router, config: Dict[str, Any]) -> List[str]:
        """Build HotSpot configuration commands.
        
        Args:
            router: Router instance
            config: HotSpot configuration
            
        Returns:
            List of RouterOS commands
        """
        commands = [
            f"# HotSpot Setup",
            f"/ip hotspot setup",
            f"\tinterface={config.get('interface', 'ether2')}",
            f"\tserver-address={config.get('server_address', '192.168.100.1')}",
            f"\taddress-list={config.get('address_list', 'hotspot-clients')}",
            f"\tradius={config.get('radius_server', '')}",
            f"\tauth-type={config.get('auth_type', 'pap')}",
            f"\trate-limit={config.get('rate_limit', '')}",
            f"\tdns-server={config.get('dns_server', '8.8.8.8')}",
            f"\tnat={config.get('nat', 'yes')}",
            f"\tfirewall={config.get('firewall', 'yes')}",
        ]
        
        # Add captive portal configuration if specified
        if config.get('captive_portal_enabled'):
            commands.extend([
                f"/ip hotspot profile add name=hotspot-user",
                f"\tauthentication=other",
                f"\thttp-header-names=Host",
                f"\thttp-pass-same=true",
                f"\tno-chaining=no",
                f"\tsession-timeout=5m",
            ])
        
        return commands
    
    def _build_pppoe_commands(self, router: Router, config: Dict[str, Any]) -> List[str]:
        """Build PPPoE configuration commands.
        
        Args:
            router: Router instance
            config: PPPoE configuration
            
        Returns:
            List of RouterOS commands
        """
        commands = [
            f"# PPPoE Server Setup",
            f"/interface pppoe-server",
            f"\tadd name=PPPoE-Out interface={config.get('interface', 'ether3')}",
            f"\t\tacct-profile={config.get('acct_profile', '')}",
            f"\t\tauthentication={config.get('authentication', 'pap')}",
            f"\t\trate-limit={config.get('rate_limit', '')}",
            f"\t\tip-pool={config.get('ip_pool', 'pppoe-pool')}",
            f"\t\tradius={config.get('radius_server', '')}",
        ]
        
        # Add IP pool if specified
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
            f"# WireGuard Setup",
            f"/interface wireguard",
            f"\tadd name=ISP-Tunnel ip-address={config.get('tunnel_ip', '10.0.0.1/24')}",
            f"\t\tpeer=ISP-Server private-key={config.get('private_key', '')}",
            f"/interface wireguard peer add name=ISP-Server ip={config.get('peer_ip', '10.0.0.2')}",
            f"\t\tpublic-key={config.get('public_key', '')} endpoint-address={config.get('endpoint_ip', 'isp-server.example.com:51820')}",
        ]
        
        return commands
    
    async def _apply_commands(self, router: Router, commands: List[str]) -> None:
        """Apply configuration commands to the router.
        
        Args:
            router: Router instance
            commands: List of RouterOS commands to apply
        """
        try:
            # Get router credentials
            credentials = await self._get_router_credentials(router)
            
            if not credentials:
                raise Exception("No credentials available for router configuration")
            
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
            
        except Exception as e:
            logger.error(f"Failed to apply commands to router {router.id}: {str(e)}")
            raise
    
    async def _verify_hotspot_configuration(
        self, 
        router: Router, 
        config: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Verify HotSpot configuration.
        
        Args:
            router: Router instance
            config: HotSpot configuration
            
        Returns:
            Verification result
        """
        try:
            # Get router credentials
            credentials = await self._get_router_credentials(router)
            
            # Connect and verify HotSpot configuration
            from app.integrations.mikrotik import MikroTikClient
            client = MikroTikClient()
            
            await client.connect(
                ip_address=router.ip_address,
                username=credentials['username'],
                password=credentials['password'],
                port=router.port or 8728,
            )
            
            # Check if HotSpot interface exists
            interface_check = await client.execute_command(
                f"/interface/print where name={config.get('interface', 'ether2')}"
            )
            
            hotspot_config_check = await client.execute_command(
                f"/ip hotspot print where interface={config.get('interface', 'ether2')}"
            )
            
            await client.disconnect(router.ip_address, router.port or 8728)
            
            interface_exists = len(interface_check) > 0
            hotspot_configured = len(hotspot_config_check) > 0
            
            return {
                'success': interface_exists and hotspot_configured,
                'interface_exists': interface_exists,
                'hotspot_configured': hotspot_configured,
                'error': None if (interface_exists and hotspot_configured) else 'HotSpot not properly configured'
            }
            
        except Exception as e:
            logger.warning(f"HotSpot configuration verification failed for router {router.id}: {str(e)}")
            return {
                'success': False,
                'interface_exists': False,
                'hotspot_configured': False,
                'error': str(e)
            }
    
    async def _verify_pppoe_configuration(
        self, 
        router: Router, 
        config: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Verify PPPoE configuration.
        
        Args:
            router: Router instance
            config: PPPoE configuration
            
        Returns:
            Verification result
        """
        try:
            # Get router credentials
            credentials = await self._get_router_credentials(router)
            
            # Connect and verify PPPoE configuration
            from app.integrations.mikrotik import MikroTikClient
            client = MikroTikClient()
            
            await client.connect(
                ip_address=router.ip_address,
                username=credentials['username'],
                password=credentials['password'],
                port=router.port or 8728,
            )
            
            # Check if PPPoE server exists
            pppoe_check = await client.execute_command(
                f"/interface/pppoe-server/print where name=PPPoE-Out"
            )
            
            await client.disconnect(router.ip_address, router.port or 8728)
            
            pppoe_exists = len(pppoe_check) > 0
            
            return {
                'success': pppoe_exists,
                'pppoe_exists': pppoe_exists,
                'error': None if pppoe_exists else 'PPPoE server not configured'
            }
            
        except Exception as e:
            logger.warning(f"PPPoE configuration verification failed for router {router.id}: {str(e)}")
            return {
                'success': False,
                'pppoe_exists': False,
                'error': str(e)
            }
    
    async def _verify_wireguard_configuration(
        self, 
        router: Router, 
        config: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Verify WireGuard configuration.
        
        Args:
            router: Router instance
            config: WireGuard configuration
            
        Returns:
            Verification result
        """
        try:
            # Get router credentials
            credentials = await self._get_router_credentials(router)
            
            # Connect and verify WireGuard configuration
            from app.integrations.mikrotik import MikroTikClient
            client = MikroTikClient()
            
            await client.connect(
                ip_address=router.ip_address,
                username=credentials['username'],
                password=credentials['password'],
                port=router.port or 8728,
            )
            
            # Check if WireGuard interface exists
            wireguard_check = await client.execute_command(
                f"/interface/wireguard/print where name=ISP-Tunnel"
            )
            
            await client.disconnect(router.ip_address, router.port or 8728)
            
            wireguard_exists = len(wireguard_check) > 0
            
            return {
                'success': wireguard_exists,
                'wireguard_exists': wireguard_exists,
                'error': None if wireguard_exists else 'WireGuard tunnel not configured'
            }
            
        except Exception as e:
            logger.warning(f"WireGuard configuration verification failed for router {router.id}: {str(e)}")
            return {
                'success': False,
                'wireguard_exists': False,
                'error': str(e)
            }
    
    async def _verify_service_functionality(
        self, 
        router: Router, 
        service_type: str, 
        verification_results: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Verify actual service functionality (connectivity testing).
        
        Args:
            router: Router instance
            service_type: Service type to verify
            verification_results: Previous verification results
            
        Returns:
            Service functionality verification result
        """
        try:
            # Get router credentials
            credentials = await self._get_router_credentials(router)
            
            if not credentials:
                return {
                    'success': False,
                    'error': 'No credentials available for service verification',
                    'tests_performed': []
                }
            
            from app.integrations.mikrotik import MikroTikClient
            client = MikroTikClient()
            
            await client.connect(
                ip_address=router.ip_address,
                username=credentials['username'],
                password=credentials['password'],
                port=router.port or 8728,
            )
            
            tests_performed = []
            
            if service_type in ('hotspot', 'both'):
                # Test HotSpot service functionality
                hotspot_test = await self._test_hotspot_functionality(client)
                tests_performed.append('hotspot')
            
            if service_type in ('pppoe_server', 'both'):
                # Test PPPoE service functionality
                pppoe_test = await self._test_pppoe_functionality(client)
                tests_performed.append('pppoe')
            
            if service_type == 'hotspot' or (service_type == 'both' and verification_results.get('wireguard', {}).get('success')):
                # Test WireGuard service functionality
                wireguard_test = await self._test_wireguard_functionality(client)
                tests_performed.append('wireguard')
            
            await client.disconnect(router.ip_address, router.port or 8728)
            
            return {
                'success': len(tests_performed) > 0,
                'tests_performed': tests_performed,
                'error': None if len(tests_performed) > 0 else 'No services could be tested'
            }
            
        except Exception as e:
            logger.warning(f"Service functionality verification failed for router {router.id}: {str(e)}")
            return {
                'success': False,
                'tests_performed': [],
                'error': str(e)
            }
    
    async def _test_hotspot_functionality(self, client) -> Dict[str, Any]:
        """Test HotSpot functionality.
        
        Args:
            client: MikroTik client
            
        Returns:
            HotSpot functionality test result
        """
        try:
            # Test HotSpot interface status
            hotspot_status = await client.execute_command('/ip hotspot print')
            
            # Test DHCP server status (HotSpot typically uses DHCP)
            dhcp_status = await client.execute_command('/ip dhcp-server print')
            
            return {
                'hotspot_enabled': len(hotspot_status) > 0,
                'dhcp_configured': len(dhcp_status) > 0,
                'success': len(hotspot_status) > 0 and len(dhcp_status) > 0
            }
        except Exception as e:
            return {
                'hotspot_enabled': False,
                'dhcp_configured': False,
                'success': False,
                'error': str(e)
            }
    
    async def _test_pppoe_functionality(self, client) -> Dict[str, Any]:
        """Test PPPoE functionality.
        
        Args:
            client: MikroTik client
            
        Returns:
            PPPoE functionality test result
        """
        try:
            # Test PPPoE server status
            pppoe_status = await client.execute_command('/interface/pppoe-server print')
            
            # Test IP pool status
            ip_pool_status = await client.execute_command('/ip pool print')
            
            return {
                'pppoe_configured': len(pppoe_status) > 0,
                'ip_pool_configured': len(ip_pool_status) > 0,
                'success': len(pppoe_status) > 0 and len(ip_pool_status) > 0
            }
        except Exception as e:
            return {
                'pppoe_configured': False,
                'ip_pool_configured': False,
                'success': False,
                'error': str(e)
            }
    
    async def _test_wireguard_functionality(self, client) -> Dict[str, Any]:
        """Test WireGuard functionality.
        
        Args:
            client: MikroTik client
            
        Returns:
            WireGuard functionality test result
        """
        try:
            # Test WireGuard interface status
            wireguard_status = await client.execute_command('/interface/wireguard print')
            
            return {
                'wireguard_configured': len(wireguard_status) > 0,
                'success': len(wireguard_status) > 0
            }
        except Exception as e:
            return {
                'wireguard_configured': False,
                'success': False,
                'error': str(e)
            }
    
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
        try:
            from app.services.wireguard import WireGuardService
            wg_service = WireGuardService(None)
            return wg_service.enabled
        except Exception:
            logger.warning("Could not check WireGuard infrastructure availability")
            return False


# Global instance for use throughout the application
async def get_service_provisioning_logic(db: AsyncSession) -> ServiceProvisioningLogic:
    """Get service provisioning logic instance.
    
    Args:
        db: Database session
        
    Returns:
        ServiceProvisioningLogic instance
    """
    return ServiceProvisioningLogic(db)