/**
 * 单个请求的响应检查：用量统计、被动审计、危险命令（记录 / 改写 / 阻断）。
 * 网关只负责把数据喂进来，结果在 finish() 时写回事件。
 */
import { scanErrorLeak, scanResponsePoison, type AuditFinding, type Severity } from '../core/audit';
import { CommandScanner, type CommandHit, type CommandMode } from '../core/command-block';
import type { SseHooks, ToolGateResult } from '../core/sse';
import { collectText, mapToolArgs } from '../core/tool-args';
import {
  costOf, findPrice, modelFromJson, usageFromJson, UsageCollector, type ModelPrice, type Usage,
} from '../core/usage';
import type { GatewayEvent } from './proxy';

export interface InspectPolicy {
  commands: CommandScanner;
  auditEnabled: boolean;
  prices: Record<string, ModelPrice>;
}

export interface CommandRecord {
  id: string;
  label: string;
  action: CommandMode;
  snippet: string;
}

const TEXT_LIMIT = 512 * 1024;
const SEVERITY_RANK: Record<Severity, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

export class ResponseInspector {
  private readonly collector = new UsageCollector();
  private usage?: Usage;
  private respModel?: string;
  private text = '';
  /** 仅记录模式下按通道累积的工具参数（流结束时整段扫描，避免命令被切在两个 chunk 里漏检） */
  private readonly toolText = new Map<string, string>();
  private readonly commands: CommandRecord[] = [];
  private readonly findings: AuditFinding[] = [];
  private blockedFlag = false;

  /**
   * @param requestText 客户端原始请求体（脱敏前）：审计判断「是不是用户自己要求的」需要它
   * @param reqModel    请求体里的 model
   */
  constructor(private readonly policy: InspectPolicy, private readonly requestText: string, private readonly reqModel?: string) {}

  get blocked(): boolean {
    return this.blockedFlag;
  }

  private get mode(): CommandMode {
    return this.policy.commands.mode;
  }

  /** 流式钩子：交给 SseRestorer */
  sseHooks(): SseHooks {
    return {
      onData: (data) => {
        this.collector.feed(data);
        this.respModel ??= modelFromJson(data);
      },
      onText: (channel, text, tool) => {
        this.appendText(text);
        if (tool && this.mode === 'observe') {
          this.toolText.set(channel, ((this.toolText.get(channel) ?? '') + text).slice(0, TEXT_LIMIT));
        }
      },
      toolGate: this.mode === 'observe' ? undefined : (_ch, args) => this.gate(args),
    };
  }

  /**
   * 非流式 JSON 响应（已还原）：提取用量、审计正文、处理工具参数。
   * 返回可能被改写的响应体；阻断时 blocked 置位，由调用方改回错误响应。
   */
  inspectJson(restored: unknown, rawUpstream: unknown): unknown {
    this.usage = usageFromJson(rawUpstream);
    this.respModel = modelFromJson(rawUpstream);
    this.appendText(collectText(restored, TEXT_LIMIT));
    if (this.mode === 'observe') {
      mapToolArgs(restored, (args) => {
        this.record(this.policy.commands.scanToolArgs(args), 'observe');
        return args;
      });
      return restored;
    }
    return mapToolArgs(restored, (args) => this.gate(args).text);
  }

  /** 上游错误响应（≥400）：检查是否泄漏密钥 / 路径 / 堆栈 */
  inspectError(status: number, bodyText: string): void {
    if (this.policy.auditEnabled) this.findings.push(...scanErrorLeak(status, bodyText));
  }

  /** 收尾：把检查结果写回事件 */
  finish(ev: GatewayEvent): void {
    // 仅记录模式：流里累积的工具参数在这里整段扫描
    for (const args of this.toolText.values()) this.record(this.policy.commands.scanToolArgs(args), 'observe');
    if (this.policy.auditEnabled && this.text) this.findings.push(...scanResponsePoison(this.text, this.requestText));

    const usage = this.usage ?? this.collector.result();
    const model = this.respModel ?? this.collector.model() ?? this.reqModel;
    if (model) ev.model = model;
    if (usage) {
      ev.usage = usage;
      const price = model ? findPrice(model, this.policy.prices) : undefined;
      const cost = price ? costOf(usage, price) : undefined;
      if (cost !== undefined) ev.cost = cost;
    }
    if (this.findings.length) ev.findings = dedupeFindings(this.findings);
    if (this.commands.length) ev.commands = this.commands;
  }

  private gate(args: string): ToolGateResult {
    if (this.mode === 'block') {
      const hits = this.policy.commands.scanToolArgs(args);
      this.record(hits, 'block');
      if (hits.length) this.blockedFlag = true;
      return { text: args, block: hits.length > 0 };
    }
    const r = this.policy.commands.rewriteToolArgs(args);
    this.record(r.hits, 'rewrite');
    return { text: r.text, block: false };
  }

  private record(hits: CommandHit[], action: CommandMode): void {
    for (const h of hits) this.commands.push({ id: h.id, label: h.label, action, snippet: h.snippet });
  }

  private appendText(t: string): void {
    if (this.text.length < TEXT_LIMIT) this.text = (this.text + '\n' + t).slice(0, TEXT_LIMIT);
  }
}

/** 同一 kind 只保留最高严重度的一条 */
function dedupeFindings(list: AuditFinding[]): AuditFinding[] {
  const byKind = new Map<string, AuditFinding>();
  for (const f of list) {
    const cur = byKind.get(f.kind);
    if (!cur || SEVERITY_RANK[f.severity] > SEVERITY_RANK[cur.severity]) byKind.set(f.kind, f);
  }
  return [...byKind.values()];
}
