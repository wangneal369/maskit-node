import { gatewayService } from '../service/gateway';
import type { AppConfig } from '../gateway/config';

/**
 * 网关控制器：渲染进程通过 ipc channel `controller/gateway/<method>` 调用
 */
class GatewayController {
  async status() {
    return gatewayService.status();
  }

  async getConfig() {
    return gatewayService.getConfig();
  }

  async setConfig(args: AppConfig) {
    await gatewayService.setConfig(args);
    return gatewayService.status();
  }

  async restart() {
    await gatewayService.start();
    return gatewayService.status();
  }

  async events() {
    return gatewayService.listEvents();
  }

  async clearMappings() {
    gatewayService.clearMappings();
    return gatewayService.status();
  }

  async playground(args: { text: string }) {
    return gatewayService.playground(args.text ?? '');
  }
}
export default GatewayController;
