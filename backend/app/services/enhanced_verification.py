"""
Service verification service for MikroTik router services.

This service handles the verification and testing of HotSpot, PPPoE, and WireGuard
services after they have been configured, including connectivity testing and service validation.
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


class EnhancedVerificationService:
    """Service for verifying MikroTik router services and configurations."""
    
    def __init__(self, db: AsyncSession):
        self.db = db
    
    async def verify_router_provisioning(
        self,
        router_id: int,
        service_type: str,
        configuration: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Comprehensive verification of router provisioning and services.
        
        Args:
            router_id: Router ID to verify
            service_type: 'hotspot', 'pppoe_server', or 'both'
            configuration: Configuration dictionary
            
        Returns:
            Complete verification report
        """
        router = await self._get_router(router_id)
        
        verification_report = {
            'router_id': router_id,
            'service_type': service_type,
            'verification_time': datetime.utcnow(),
            'overall_status': 'pending',
            'checks': {},
            'connectivity': {},
            'configurations': {},
            'functionality': {},
            'issues': [],
            'warnings': [],
            'recommendations': []
        }
        
        try:
            # Step 1: Verify router connectivity and basic access
            connectivity_result = await self._verify_router_connectivity(router)
            verification_report['connectivity'] = connectivity_result
            
            if not connectivity_result['success']:
                verification_report['overall_status'] = 'failed'
                verification_report['issues'].append(f"Router connectivity failed: {connectivity_result.get('error', 'Unknown error')}")
                return verification_report
            
            # Step 2: Verify router configuration status
            config_result = await self._verify_router_configuration(router)
            verification_report['configurations'] = config_result
            
            if not config_result['success']:
                verification_report['warnings'].extend(config_result.get('warnings', []))
            
            # Step 3: Verify service-specific configurations
            service_configs = await self._verify_service_configurations(router, service_type, configuration)
            verification_report['configurations']['services'] = service_configs
            
            # Step 4: Test service functionality
            functionality_result = await self._test_service_functionality(router, service_type)
            verification_report['functionality'] = functionality_result
            
            # Step 5: Compile overall verification status
            overall_success = self._compile_verification_status(verification_report)
            verification_report['overall_status'] = 'passed' if overall_success else 'failed'
            
            # Add recommendations if any issues found
            if verification_report['issues'] or verification_report['warnings']:
                verification_report['recommendations'] = self._generate_recommendations(verification_report)
            
            logger.info(
                f"Router {router_id} verification completed: {verification_report['overall_status']}"
            )
            
            return verification_report
            
        except Exception as e:
            verification_report['overall_status'] = 'error'
            verification_report['issues'].append(f"Verification process failed: {str(e)}")
            logger.error(f"Router verification failed for {router_id}: {str(e)}")
            return verification_report
    
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
                    'method': 'api',
                    'error': 'No credentials available',
                    'response_time_ms': None,
                    'last_check': datetime.utcnow().isoformat()
                }
            
            # Test API connectivity
            from app.integrations.mikrotik import MikroTikClient
            client = MikroTikClient()
            
            start_time = datetime.utcnow()
            await client.connect(
                ip_address=router.ip_address,
                username=credentials['username'],
                password=credentials['password'],
                port=router.port or 8728,
            )
            
            # Test basic command
            result = await client.execute_command('/system/identity/get')
            
            end_time = datetime.utcnow()
            response_time_ms = (end_time - start_time).total_seconds() * 1000
            
            await client.disconnect(router.ip_address, router.port or 8728)
            
            return {
                'success': True,
                'method': 'api',
                'error': None,
                'response_time_ms': round(response_time_ms, 2),
                'last_check': datetime.utcnow().isoformat(),
                'router_identity': result[0].get('name') if result else None,
                'routeros_version': result[0].get('version') if result else None
            }
            
        except Exception as e:
            logger.warning(f"Router connectivity verification failed for {router.id}: {str(e)}")
            return {
                'success': False,
                'method': 'api',
                'error': str(e),
                'response_time_ms': None,
                'last_check': datetime.utcnow().isoformat(),
                'retry_suggested': True
            }
    
    async def _verify_router_configuration(self, router: Router) -> Dict[str, Any]:
        """Verify basic router configuration.
        
        Args:
            router: Router instance
            
        Returns:
            Configuration verification result
        """
        try:
            # Get router credentials
            credentials = await self._get_router_credentials(router)
            
            from app.integrations.mikrotik import MikroTikClient
            client = MikroTokClient()
            
            await client.connect(
                ip_address=router.ip_address,
                username=credentials['username'],
                password=credentials['password'],
                port=router.port or 8728,
            )
            
            # Check system information
            system_info = await client.execute_command('/system/resource/get')
            
            # Check interface status
            interfaces = await client.execute_command('/interface/print')
            
            # Check service status
            services = await client.execute_command('/ip/service/print')
            
            await client.disconnect(router.ip_address, router.port or 8728)
            
            config_status = {
                'system_info_available': len(system_info) > 0,
                'interfaces_available': len(interfaces) > 0,
                'services_configured': len(services) > 0,
                'bootstrap_completed': router.bootstrap_completed,
                'provisioning_status': router.provisioning_status,
                'credentials_stored': bool(router.api_credentials_encrypted)
            }
            
            overall_success = all([
                config_status['system_info_available'],
                config_status['interfaces_available'],
                config_status['services_configured'],
                config_status['bootstrap_completed'],
                config_status['credentials_stored']
            ])
            
            return {
                'success': overall_success,
                'status': config_status,
                'warnings': self._get_config_warnings(config_status) if not overall_success else [],
                'last_check': datetime.utcnow().isoformat()
            }
            
        except Exception as e:
            logger.warning(f"Router configuration verification failed for {router.id}: {str(e)}")
            return {
                'success': False,
                'status': {},
                'warnings': [f'Configuration verification error: {str(e)}'],
                'last_check': datetime.utcnow().isoformat(),
                'error': str(e)
            }
    
    async def _verify_service_configurations(
        self, 
        router: Router, 
        service_type: str, 
        configuration: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Verify service-specific configurations.
        
        Args:
            router: Router instance
            service_type: Service type
            configuration: Configuration dictionary
            
        Returns:
            Service configuration verification result
        """
        service_configs = {}
        
        if service_type in ('hotspot', 'both'):
            hotspot_result = await self._verify_hotspot_configuration(router, configuration.get('hotspot_config', {}))
            service_configs['hotspot'] = hotspot_result
        
        if service_type in ('pppoe_server', 'both'):
            pppoe_result = await self._verify_pppoe_configuration(router, configuration.get('pppoe_config', {}))
            service_configs['pppoe'] = pppoe_result
        
        if service_type == 'hotspot' or (service_type == 'both' and configuration.get('enable_wireguard', False)):
            wireguard_result = await self._verify_wireguard_configuration(router, configuration.get('wireguard_config', {}))
            service_configs['wireguard'] = wireguard_result
        
        overall_success = all([
            result['success'] for result in service_configs.values() if isinstance(result, dict)
        ]) if service_configs else True
        
        return {
            'success': overall_success,
            'services': service_configs,
            'last_check': datetime.utcnow().isoformat()
        }
    
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
            HotSpot configuration verification result
        """
        try:
            credentials = await self._get_router_credentials(router)
            
            from app.integrations.mikrotik import MikroTikClient
            client = MikroTikClient()
            
            await client.connect(
                ip_address=router.ip_address,
                username=credentials['username'],
                password=credentials['password'],
                port=router.port or 8728,
            )
            
            # Check HotSpot configuration
            hotspot_config = await client.execute_command('/ip hotspot print')
            
            # Check DHCP configuration (HotSpot typically uses DHCP)
            dhcp_config = await client.execute_command('/ip dhcp-server print')
            
            # Check firewall rules
            firewall_rules = await client.execute_command('/ip firewall print')
            
            await client.disconnect(router.ip_address, router.port or 8728)
            
            hotspot_configured = len(hotspot_config) > 0
            dhcp_configured = len(dhcp_config) > 0
            firewall_configured = len(firewall_rules) > 0
            
            return {
                'success': hotspot_configured and dhcp_configured,
                'hotspot_configured': hotspot_configured,
                'dhcp_configured': dhcp_configured,
                'firewall_configured': firewall_configured,
                'interface': config.get('interface'),
                'errors': self._get_hotspot_config_errors(hotspot_configured, dhcp_configured, firewall_configured)
            }
            
        except Exception as e:
            logger.warning(f"HotSpot configuration verification failed for {router.id}: {str(e)}")
            return {
                'success': False,
                'hotspot_configured': False,
                'dhcp_configured': False,
                'firewall_configured': False,
                'interface': config.get('interface'),
                'errors': [f'Configuration verification error: {str(e)}']
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
            PPPoE configuration verification result
        """
        try:
            credentials = await self._get_router_credentials(router)
            
            from app.integrations.mikrotik import MikroTikClient
            client = MikroTikClient()
            
            await client.connect(
                ip_address=router.ip_address,
                username=credentials['username'],
                password=credentials['password'],
                port=router.port or 8728,
            )
            
            # Check PPPoE server configuration
            pppoe_config = await client.execute_command('/interface/pppoe-server print')
            
            # Check IP pool configuration
            ip_pool = await client.execute_command('/ip pool print')
            
            await client.disconnect(router.ip_address, router.port or 8728)
            
            pppoe_configured = len(pppoe_config) > 0
            ip_pool_configured = len(ip_pool) > 0
            
            return {
                'success': pppoe_configured and ip_pool_configured,
                'pppoe_configured': pppoe_configured,
                'ip_pool_configured': ip_pool_configured,
                'interface': config.get('interface'),
                'errors': self._get_pppoe_config_errors(pppoe_configured, ip_pool_configured)
            }
            
        except Exception as e:
            logger.warning(f"PPPoE configuration verification failed for {router.id}: {str(e)}")
            return {
                'success': False,
                'pppoe_configured': False,
                'ip_pool_configured': False,
                'interface': config.get('interface'),
                'errors': [f'Configuration verification error: {str(e)}']
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
            WireGuard configuration verification result
        """
        try:
            credentials = await self._get_router_credentials(router)
            
            from app.integrations.mikrotik import MikroTikClient
            client = MikroTikClient()
            
            await client.connect(
                ip_address=router.ip_address,
                username=credentials['username'],
                password=credentials['password'],
                port=router.port or 8728,
            )
            
            # Check WireGuard configuration
            wireguard_config = await client.execute_command('/interface/wireguard print')
            
            # Check peer configuration
            wireguard_peers = await client.execute_command('/interface/wireguard peer print')
            
            await client.disconnect(router.ip_address, router.port or 8728)
            
            wireguard_configured = len(wireguard_config) > 0
            peers_configured = len(wireguard_peers) > 0
            
            return {
                'success': wireguard_configured and peers_configured,
                'wireguard_configured': wireguard_configured,
                'peers_configured': peers_configured,
                'tunnel_ip': config.get('tunnel_ip'),
                'errors': self._get_wireguard_config_errors(wireguard_configured, peers_configured)
            }
            
        except Exception as e:
            logger.warning(f"WireGuard configuration verification failed for {router.id}: {str(e)}")
            return {
                'success': False,
                'wireguard_configured': False,
                'peers_configured': False,
                'tunnel_ip': config.get('tunnel_ip'),
                'errors': [f'Configuration verification error: {str(e)}']
            }
    
    async def _test_service_functionality(
        self, 
        router: Router, 
        service_type: str
    ) -> Dict[str, Any]:
        """Test actual service functionality.
        
        Args:
            router: Router instance
            service_type: Service type to test
            
        Returns:
            Service functionality test result
        """
        try:
            credentials = await self._get_router_credentials(router)
            
            from app.integrations.mikrotik import MikroTikClient
            client = MikroTikClient()
            
            await client.connect(
                ip_address=router.ip_address,
                username=credentials['username'],
                password=credentials['password'],
                port=router.port or 8728,
            )
            
            # Test service-specific functionality
            if service_type in ('hotspot', 'both'):
                hotspot_test = await self._test_hotspot_functionality(client)
            
            if service_type in ('pppoe_server', 'both'):
                pppoe_test = await self._test_pppoe_functionality(client)
            
            if service_type == 'hotspot' or (service_type == 'both' and router.wireguard_enabled):
                wireguard_test = await self._test_wireguard_functionality(client)
            
            await client.disconnect(router.ip_address, router.port or 8728)
            
            functionality_tests = []
            if service_type in ('hotspot', 'both'):
                functionality_tests.append(hotspot_test)
            if service_type in ('pppoe_server', 'both'):
                functionality_tests.append(pppoe_test)
            if service_type == 'hotspot' or (service_type == 'both' and router.wireguard_enabled):
                functionality_tests.append(wireguard_test)
            
            overall_success = all([test.get('success', False) for test in functionality_tests]) if functionality_tests else True
            
            return {
                'success': overall_success,
                'tests_performed': functionality_tests,
                'error': None if overall_success else 'Some service functionality tests failed',
                'last_check': datetime.utcnow().isoformat()
            }
            
        except Exception as e:
            logger.warning(f"Service functionality testing failed for {router.id}: {str(e)}")
            return {
                'success': False,
                'tests_performed': [],
                'error': str(e),
                'last_check': datetime.utcnow().isoformat()
            }
    
    async def _test_hotspot_functionality(self, client) -> Dict[str, Any]:
        """Test HotSpot functionality.
        
        Args:
            client: MikroTik client
            
        Returns:
            HotSpot functionality test result
        """
        try:
            # Test HotSpot user authentication simulation
            hotspot_users = await client.execute_command('/ip hotspot user print')
            
            # Test captive portal configuration
            captive_portal_config = await client.execute_command('/ip hotspot captive-portal print')
            
            # Test DHCP server configuration
            dhcp_servers = await client.execute_command('/ip dhcp-server print')
            
            return {
                'hotspot_users_configured': len(hotspot_users) > 0,
                'captive_portal_configured': len(captive_portal_config) > 0,
                'dhcp_configured': len(dhcp_servers) > 0,
                'success': len(hotspot_users) > 0 and len(dhcp_servers) > 0
            }
        except Exception as e:
            return {
                'hotspot_users_configured': False,
                'captive_portal_configured': False,
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
            
            # Test IP address assignments
            ip_addresses = await client.execute_command('/ip address print')
            
            return {
                'pppoe_server_running': len(pppoe_status) > 0,
                'ip_assignments': len(ip_addresses),
                'success': len(pppoe_status) > 0
            }
        except Exception as e:
            return {
                'pppoe_server_running': False,
                'ip_assignments': 0,
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
            # Test WireGuard tunnel status
            wireguard_status = await client.execute_command('/interface/wireguard print')
            
            # Test peer status
            wireguard_peers = await client.execute_command('/interface/wireguard peer print')
            
            # Test routing
            routes = await client.execute_command('/ip route print where distance=*')
            
            return {
                'wireguard_tunnel_running': len(wireguard_status) > 0,
                'peers_configured': len(wireguard_peers) > 0,
                'routes_configured': len(routes) > 0,
                'success': len(wireguard_status) > 0 and len(wireguard_peers) > 0
            }
        except Exception as e:
            return {
                'wireguard_tunnel_running': False,
                'peers_configured': False,
                'routes_configured': False,
                'success': False,
                'error': str(e)
            }
    
    def _get_router_credentials(self, router: Router) -> Optional[Dict[str, str]]:
        """Get router credentials for API access.
        
        Args:
            router: Router instance
            
        Returns:
            Dict with username and password or None if not available
        """
        import json
        
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
    
    def _compile_verification_status(self, report: Dict[str, Any]) -> bool:
        """Compile overall verification status from all checks.
        
        Args:
            report: Verification report
            
        Returns:
            Overall success status
        """
        # Check overall connectivity status
        if report['connectivity'].get('success', False) is False:
            return False
        
        # Check configuration status
        if report['configurations'].get('success', False) is False:
            return False
        
        # Check service configurations
        services = report['configurations'].get('services', {})
        for service_name, service_config in services.items():
            if isinstance(service_config, dict) and not service_config.get('success', False):
                return False
        
        # Check functionality
        if not report['functionality'].get('success', False):
            return False
        
        return True
    
    def _generate_recommendations(self, report: Dict[str, Any]) -> List[str]:
        """Generate recommendations based on verification results.
        
        Args:
            report: Verification report
            
        Returns:
            List of recommendations
        """
        recommendations = []
        
        if report['issues']:
            recommendations.extend([
                "Address the following issues:",
                *[f"  - {issue}" for issue in report['issues']]
            ])
        
        if report['warnings']:
            recommendations.extend([
                "Consider the following warnings:",
                *[f"  - {warning}" for warning in report['warnings']]
            ])
        
        if not report['connectivity'].get('success', False):
            recommendations.append("Check router connectivity and credentials")
        
        if not report['configurations'].get('success', False):
            recommendations.append("Verify router configuration and API credentials")
        
        return recommendations
    
    def _get_config_warnings(self, config_status: Dict[str, Any]) -> List[str]:
        """Get warnings based on configuration status.
        
        Args:
            config_status: Configuration status
            
        Returns:
            List of warnings
        """
        warnings = []
        
        if not config_status.get('system_info_available', True):
            warnings.append("System information not available")
        
        if not config_status.get('interfaces_available', True):
            warnings.append("Network interfaces not detected")
        
        if not config_status.get('services_configured', True):
            warnings.append("Services not properly configured")
        
        if not config_status.get('bootstrap_completed', True):
            warnings.append("Bootstrap not completed")
        
        return warnings
    
    def _get_hotspot_config_errors(
        self, 
        hotspot_configured: bool, 
        dhcp_configured: bool, 
        firewall_configured: bool
    ) -> List[str]:
        """Get errors based on HotSpot configuration.
        
        Args:
            hotspot_configured: Whether HotSpot is configured
            dhcp_configured: Whether DHCP is configured
            firewall_configured: Whether firewall is configured
            
        Returns:
            List of errors
        """
        errors = []
        
        if not hotspot_configured:
            errors.append("HotSpot service not configured")
        
        if not dhcp_configured:
            errors.append("DHCP server not configured")
        
        if not firewall_configured:
            errors.append("Firewall rules not configured")
        
        return errors
    
    def _get_pppoe_config_errors(
        self, 
        pppoe_configured: bool, 
        ip_pool_configured: bool
    ) -> List[str]:
        """Get errors based on PPPoE configuration.
        
        Args:
            pppoe_configured: Whether PPPoE is configured
            ip_pool_configured: Whether IP pool is configured
            
        Returns:
            List of errors
        """
        errors = []
        
        if not pppoe_configured:
            errors.append("PPPoE server not configured")
        
        if not ip_pool_configured:
            errors.append("IP pool not configured")
        
        return errors
    
    def _get_wireguard_config_errors(
        self, 
        wireguard_configured: bool, 
        peers_configured: bool
    ) -> List[str]:
        """Get errors based on WireGuard configuration.
        
        Args:
            wireguard_configured: Whether WireGuard is configured
            peers_configured: Whether peers are configured
            
        Returns:
            List of errors
        """
        errors = []
        
        if not wireguard_configured:
            errors.append("WireGuard tunnel not configured")
        
        if not peers_configured:
            errors.append("WireGuard peers not configured")
        
        return errors


# Global instance for use throughout the application
async def get_enhanced_verification_service(db: AsyncSession) -> EnhancedVerificationService:
    """Get enhanced verification service instance.
    
    Args:
        db: Database session
        
    Returns:
        EnhancedVerificationService instance
    """
    return EnhancedVerificationService(db)