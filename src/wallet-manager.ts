import { EventEmitter } from "stream";

import { z } from "zod";
import winston from "winston";
import { createLogger, mapConcurrent } from "./utils";
import { PrometheusExporter } from "./prometheus-exporter";
import {
  ChainWalletManager,
  WalletExecuteOptions,
  WithWalletExecutor,
  WalletBalancesByAddress,
  WalletInterface,
} from "./chain-wallet-manager";
import {
  ChainName,
  isChain,
  KNOWN_CHAINS,
  WalletBalance,
  WalletConfigSchema,
} from "./wallets";
import { TransferReceipt } from "./wallets/base-wallet";
import { RebalanceInstruction } from "./rebalance-strategies";
import { CoinGeckoIdsSchema } from "./price-assistant/supported-tokens.config";
import { ScheduledPriceFeed } from "./price-assistant/scheduled-price-feed";
import { OnDemandPriceFeed } from "./price-assistant/ondemand-price-feed";
import { preparePriceFeedConfig } from "./price-assistant/helper";

export const WalletRebalancingConfigSchema = z.object({
  enabled: z.boolean(),
  strategy: z.string().optional(),
  interval: z.number().optional(),
  minBalanceThreshold: z.number().optional(),
  maxGasPrice: z.number().optional(),
  gasLimit: z.number().optional(),
});

const TokenInfoSchema = z.object({
  tokenContract: z.string(),
  chainId: z.number(),
  chainName: z.string(),
  coingeckoId: CoinGeckoIdsSchema,
  symbol: z.string().optional(),
});

export type TokenInfo = z.infer<typeof TokenInfoSchema>;

export const WalletPriceFeedConfigSchema = z.object({
  supportedTokens: z.array(TokenInfoSchema),
});

export const WalletPriceFeedOptionsSchema = z.object({
  enabled: z.boolean(),
  scheduled: z
    .object({
      enabled: z.boolean().default(false),
      interval: z.number().optional(),
    })
    .optional(),
});

export const WalletBalanceConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    scheduled: z
      .object({
        enabled: z.boolean().default(false),
        interval: z.number().optional(),
      })
      .optional(),
  })
  .optional();

export type WalletBalanceConfig = z.infer<typeof WalletBalanceConfigSchema>;

export type WalletPriceFeedConfig = z.infer<typeof WalletPriceFeedConfigSchema>;

export type WalletPriceFeedOptions = z.infer<
  typeof WalletPriceFeedOptionsSchema
>;

export type WalletRebalancingConfig = z.infer<
  typeof WalletRebalancingConfigSchema
>;

export const WalletManagerChainConfigSchema = z.object({
  network: z.string().optional(),
  // FIXME: This should be a zod schema
  chainConfig: z.any().optional(),
  rebalance: WalletRebalancingConfigSchema.optional(),
  // This config can be used to control refresh balances behaviour
  walletBalanceConfig: WalletBalanceConfigSchema.optional(),
  wallets: z.array(WalletConfigSchema),
  priceFeedConfig: WalletPriceFeedConfigSchema.optional(),
});

export const WalletManagerConfigSchema = z.record(
  z.string(),
  WalletManagerChainConfigSchema,
);
export type WalletManagerConfig = z.infer<typeof WalletManagerConfigSchema>;

export const WalletManagerOptionsSchema = z.object({
  logger: z.any().optional(),
  logLevel: z
    .union([
      z.literal("error"),
      z.literal("warn"),
      z.literal("info"),
      z.literal("debug"),
      z.literal("verbose"),
      z.literal("silent"),
    ])
    .optional(),
  balancePollInterval: z.number().optional(),
  metrics: z
    .object({
      enabled: z.boolean(),
      port: z.number().optional(),
      path: z.string().optional(),
      registry: z.any().optional(),
      serve: z.boolean().optional(),
    })
    .optional(),
  failOnInvalidChain: z.boolean().default(true),
  failOnInvalidTokens: z.boolean().default(true).optional(),
  priceFeedOptions: WalletPriceFeedOptionsSchema.optional(),
});

export type WalletManagerOptions = z.infer<typeof WalletManagerOptionsSchema>;

export const WalletManagerGRPCConfigSchema = z.object({
  listenAddress: z.string().default("0.0.0.0"),
  listenPort: z.number().default(50051),
  connectAddress: z.string(),
  connectPort: z.number().default(50051),
});

export const WalletManagerFullConfigSchema = z.object({
  config: WalletManagerConfigSchema,
  options: WalletManagerOptionsSchema.optional(),
  grpc: WalletManagerGRPCConfigSchema.optional(),
});
export type WalletManagerFullConfig = z.infer<
  typeof WalletManagerFullConfigSchema
>;

export function getDefaultNetwork(chainName: ChainName) {
  return KNOWN_CHAINS[chainName]!.defaultNetwork;
}

export type PriceFeed = ScheduledPriceFeed | OnDemandPriceFeed;

export type MapChainsResult<T> = Record<ChainName, T>;

export class WalletManager {
  private emitter: EventEmitter = new EventEmitter();
  private managers: Record<ChainName, ChainWalletManager>;
  private exporter?: PrometheusExporter;
  protected logger: winston.Logger;

  constructor(config: WalletManagerConfig, options?: WalletManagerOptions) {
    this.logger = createLogger(options?.logger, options?.logLevel, {
      label: "WalletManager",
    });
    this.managers = {} as Record<ChainName, ChainWalletManager>;

    if (options?.metrics?.enabled) {
      const { port, path, registry } = options.metrics;
      this.exporter = new PrometheusExporter(port, path, registry);
      if (options.metrics?.serve) {
        this.logger.info("Starting metrics server.");
        this.exporter.startMetricsServer();
      }
    }

    const isPriceFeedEnabled = options?.priceFeedOptions?.enabled;
    
    // TODO: might be better to remove price feed from wallet manager to avoid cluttering
    // PriceFeed can be used as a singleton until we have it as a separate "PriceOracle" service
    let priceFeedInstance;
    if (isPriceFeedEnabled) {
      const allSupportedTokens = preparePriceFeedConfig(config);
      if (options?.priceFeedOptions?.scheduled?.enabled) {
        priceFeedInstance = new ScheduledPriceFeed(
          { supportedTokens: allSupportedTokens, ...options.priceFeedOptions },
          this.logger,
        );
      } else {
        priceFeedInstance = new OnDemandPriceFeed(
          { supportedTokens: allSupportedTokens },
          this.logger,
        );
      }
    }

    for (const [chainName, chainConfig] of Object.entries(config)) {
      if (!isChain(chainName)) {
        if (options?.failOnInvalidChain) {
          throw new Error(`Invalid chain name: ${chainName}`);
        } else {
          this.logger.warn(`Invalid chain name: ${chainName}`);
          continue;
        }
      }

      const network = chainConfig.network || getDefaultNetwork(chainName);

      const chainManagerConfig = {
        network,
        chainName,
        logger: this.logger,
        rebalance: chainConfig.rebalance,
        walletOptions: chainConfig.chainConfig,
        walletBalanceConfig: chainConfig.walletBalanceConfig,
        balancePollInterval: options?.balancePollInterval,
        failOnInvalidTokens: options?.failOnInvalidTokens ?? true,
      };

      const chainManager = new ChainWalletManager(
        chainManagerConfig,
        chainConfig.wallets,
        priceFeedInstance,
      );

      chainManager.on("error", error => {
        this.logger.error("Error in chain manager: ${error}");
        this.emitter.emit("error", error, chainName);
      });

      chainManager.on(
        "balances",
        (balances: WalletBalance[], previousBalances: WalletBalance[]) => {
          this.logger.verbose(`Balances updated for ${chainName} (${network})`);
          this.exporter?.updateBalances(chainName, network, balances);

          this.emitter.emit(
            "balances",
            chainName,
            network,
            balances,
            previousBalances,
          );
        },
      );

      chainManager.on(
        "rebalance-started",
        (strategy: string, instructions: RebalanceInstruction[]) => {
          this.logger.info(
            `Rebalance Started. Instructions to execute: ${instructions.length}`,
          );
        },
      );

      chainManager.on(
        "rebalance-finished",
        (strategy: string, receipts: TransferReceipt[]) => {
          this.logger.info(
            `Rebalance Finished. Executed transactions: ${receipts.length}}`,
          );
          this.exporter?.updateRebalanceSuccess(chainName, strategy, receipts);
        },
      );

      chainManager.on("rebalance-error", (error, _, strategy) => {
        this.logger.error(`Rebalance Error: ${error}`);
        this.exporter?.updateRebalanceFailure(chainName, strategy);
      });

      // TODO: Events shouldreflect things happening, not metrics
      chainManager.on("active-wallets-count", (chainName, network, count) => {
        this.exporter?.updateActiveWallets(chainName, network, count);
      });

      // TODO: Events should reflect things happening, not metrics
      chainManager.on(
        "wallets-lock-period",
        (chainName, network, walletAddress, lockTime) => {
          this.exporter?.updateWalletsLockPeriod(
            chainName,
            network,
            walletAddress,
            lockTime,
          );
        },
      );

      this.managers[chainName] = chainManager;

      chainManager.start();
    }
  }

  public stop() {
    Object.values(this.managers).forEach(manager => manager.stop());
  }

  public on(event: string, listener: (...args: any[]) => void) {
    this.emitter.on(event, listener);
  }

  public metrics() {
    return this.exporter?.metrics();
  }

  public getRegistry() {
    return this.exporter?.getRegistry();
  }

  public async acquireLock(
    chainName: ChainName,
    opts?: WalletExecuteOptions,
  ): Promise<WalletInterface> {
    const chainManager = this.managers[chainName];
    if (!chainManager)
      throw new Error(`No wallets configured for chain: ${chainName}`);

    let wallet: WalletInterface;
    try {
      wallet = await chainManager.acquireLock(opts);
      this.exporter?.increaseAcquiredLocks(chainName);
    } catch (error) {
      this.exporter?.increaseAcquireLockFailure(chainName);
      throw error;
    }
    return wallet;
  }

  public releaseLock(chainName: ChainName, address: string) {
    const chainManager = this.managers[chainName];
    if (!chainManager)
      throw new Error(`No wallets configured for chain: ${chainName}`);

    return chainManager.releaseLock(address);
  }

  /**
   * Guarantees wallet will only be used by caller in a single process setup.
   * There is no enforcement of lease timeout, so you should have one defined by the fn param.
   * If no lock is obtained befored specified waitToAcquireTimeout expires, an error will be thrown.
   *
   * @param chainName
   * @param fn
   * @param opts - leaseTimeout will be ignored
   */
  public async withWallet(
    chainName: ChainName,
    fn: WithWalletExecutor,
    opts?: WalletExecuteOptions,
  ): Promise<void> {
    const wallet = await this.acquireLock(chainName, opts);

    try {
      await fn(wallet);
    } finally {
      await this.releaseLock(chainName, wallet.address);
    }
  }

  private async mapToChains<T>(method: (chain: ChainName, manager: ChainWalletManager) =>  Promise<T>): Promise<MapChainsResult<T>> {
    const result  = {} as MapChainsResult<T>;

    await mapConcurrent(
      Object.entries(this.managers),
      async ([chain, manager]) => {
        const chainName = chain as ChainName;
        result[chainName] = await method(chainName as ChainName, manager) as T;
      },
    );

    return result;
  }

  // gets balances from memory
  public async getAllBalances(): Promise<
    MapChainsResult<WalletBalancesByAddress>
  > {
    return await this.mapToChains(async(_chainName: ChainName, manager: ChainWalletManager) => {
      return manager.getBalances();
    });
  }
  
  // pulls de balances from the node
  public async pullBalances(): Promise<
    MapChainsResult<WalletBalancesByAddress>
  > {
    return this.mapToChains(async (chainName: ChainName, manager: ChainWalletManager) => {
      return manager.pullBalances();
    });
  }

  public getBlockHeight(chainName: ChainName): Promise<number> {
    const manager = this.managers[chainName];
    if (!manager)
      throw new Error(`No wallets configured for chain: ${chainName}`);

    return manager.getBlockHeight();
  }


  private validateBlockHeightByChain(
    blockHeightByChain: Record<ChainName, number>,
  ) {
    for (const chain in blockHeightByChain) {
      const manager = this.managers[chain as ChainName];
      if (!manager)
        throw new Error(`No wallets configured for chain: ${chain}`);
    }
  }

  public async getBlockHeightForAllSupportedChains(): Promise<
    Record<ChainName, number>
  > {
    // Required concurrency is the number of chains as we want to fetch the block height for all chains in parallel
    // to be precise about the block height at the time of fetching balances
    let blockHeightPerChain = {} as Record<ChainName, number>;
    const requiredConcurrency = Object.keys(this.managers).length;
    await mapConcurrent(
      Object.entries(this.managers),
      async ([chainName, manager]) => {
        try {
          const blockHeight = await manager.getBlockHeight();          
          blockHeightPerChain = {
            ...blockHeightPerChain,
            [chainName]: blockHeight,
          } as Record<ChainName, number>;
        } catch (err) {
          throw new Error(`No block height found for chain: ${chainName}, error: ${err}`);
        }
      },
      requiredConcurrency,
    );
    return blockHeightPerChain;
  }

  // pullBalancesAtBlockHeight doesn't need balances to be refreshed in the background
  public async pullBalancesAtBlockHeight(
    blockHeightByChain?: Record<ChainName, number>,
  ): Promise<Record<string, WalletBalancesByAddress>> {
    const balances: Record<string, WalletBalancesByAddress> = {};
    if (blockHeightByChain) {
      this.validateBlockHeightByChain(blockHeightByChain);
    }

    const blockHeightPerChain = blockHeightByChain ?? await this.getBlockHeightForAllSupportedChains();

    await mapConcurrent(
      Object.entries(this.managers),
      async ([chainName, manager]) => {
        const blockHeight = blockHeightPerChain[chainName as ChainName];
        const balancesByChain = await manager.pullBalancesAtBlockHeight(
          blockHeight,
        );
        balances[chainName] = balancesByChain;
      },
    );

    return balances;
  }

  public getChainBalances(chainName: ChainName): WalletBalancesByAddress {
    const manager = this.managers[chainName];
    if (!manager)
      throw new Error(`No wallets configured for chain: ${chainName}`);

    return manager.getBalances();
  }
}
