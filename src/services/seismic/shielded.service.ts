import { http, type Chain, type Address, type Hex, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem/accounts";
import {
  createShieldedPublicClient,
  createShieldedWalletClient,
  getShieldedContract,
  getEncryption,
  AesGcmCrypto,
  encodeSeismicMetadataAsAAD,
  seismicTestnet2,
  checkRegistration,
  shieldedWriteContract,
  DIRECTORY_ADDRESS,
  DirectoryAbi,
  type ShieldedPublicClient,
  type ShieldedWalletClient,
  type GetSeismicClientsParameters,
} from "seismic-viem";
import { Logger } from "../../utils/index.js";
import { SRC20Abi } from "../../seismic/abi.js";
import { RpcService } from "./rpc.service.js";

type SeismicClient = ShieldedWalletClient<Transport, Chain>;
type SeismicPublicClient = ShieldedPublicClient<Transport, Chain>;

export class SeismicShieldedService {
  private readonly logger: Logger;
  private teePublicKey: string | null = null;

  constructor(
    private readonly rpc: RpcService,
    logger?: Logger
  ) {
    this.logger = logger ?? new Logger("services:shielded");
  }

  private async getTeePubkey(): Promise<string> {
    if (this.teePublicKey) return this.teePublicKey;
    const result = await this.rpc.jsonRpc<string>("seismic_getTeePublicKey", []);
    this.teePublicKey = result;
    return result;
  }

  async decryptSrc20Amount(
    txHash: string,
    encryptionSk: Hex,
    decimals: number = 18
  ): Promise<number | null> {
    try {
      const tx = await this.rpc.getTransactionByHash(txHash);
      if (!tx) return null;

      const input = tx.input as string | undefined;
      const encryptionNonce = tx.encryptionNonce as Hex | undefined;

      if (!input || !encryptionNonce || input === "0x") return null;

      const networkTeePubkey = await this.getTeePubkey();
      const { aesKey } = getEncryption(networkTeePubkey, encryptionSk);

      const encPubkey = (tx.encryptionPubkey as string).startsWith("0x")
        ? (tx.encryptionPubkey as Hex)
        : (`0x${tx.encryptionPubkey}` as Hex);

      const aad = encodeSeismicMetadataAsAAD({
        sender: tx.from as `0x${string}`,
        legacyFields: {
          chainId: parseInt(tx.chainId as string, 16),
          nonce: parseInt(tx.nonce as string, 16),
          to: (tx.to ?? "0x") as `0x${string}`,
          value: BigInt((tx.value as string) ?? "0x0"),
        },
        seismicElements: {
          encryptionPubkey: encPubkey,
          encryptionNonce,
          messageVersion: parseInt((tx.messageVersion as string) ?? "0x0", 16),
          recentBlockHash: tx.recentBlockHash as Hex,
          expiresAtBlock: BigInt(tx.expiresAtBlock as string),
          signedRead: (tx.signedRead as boolean) ?? false,
        },
      });

      const aesCrypto = new AesGcmCrypto(aesKey);
      const plaintext = await aesCrypto.decrypt(input as Hex, encryptionNonce, aad);

      const plain = plaintext.replace(/^0x/, "");
      if (plain.length < 8 + 64 + 64) return null;

      const amountHex = plain.slice(8 + 64, 8 + 64 + 64);
      const rawAmount = BigInt("0x" + amountHex);
      const divisor = BigInt(10 ** decimals);
      const whole = rawAmount / divisor;
      const remainder = rawAmount % divisor;
      return Number(whole) + Number(remainder) / 10 ** decimals;
    } catch (err) {
      this.logger.debug(`SRC-20 decryption failed for ${txHash}: ${(err as Error).message}`);
      return null;
    }
  }

  async registerViewingKey(client: SeismicClient, viewingKey: Hex): Promise<Hex> {
    this.logger.info("Registering viewing key in Directory precompile");
    const hexGasPrice = await this.rpc.jsonRpc<string>("eth_gasPrice", []);
    const gasPrice = BigInt(hexGasPrice);
    return shieldedWriteContract(client, {
      address: DIRECTORY_ADDRESS,
      abi: DirectoryAbi,
      functionName: "setKey",
      args: [BigInt(viewingKey)],
      gas: 200_000n,
      gasPrice,
    });
  }

  async checkViewingKeyRegistered(address: Address): Promise<boolean> {
    const publicClient = this.createPublicClient();
    return checkRegistration(publicClient as unknown as SeismicClient, address);
  }

  async createShieldedClient(
    accountOrPrivateKey: Hex | LocalAccount,
    encryptionSk?: Hex
  ): Promise<SeismicClient> {
    const account =
      typeof accountOrPrivateKey === "string"
        ? privateKeyToAccount(accountOrPrivateKey)
        : accountOrPrivateKey;

    const chain: Chain = {
      ...seismicTestnet2,
      id: this.rpc.chainId,
      rpcUrls: { default: { http: [this.rpc.rpcUrl] } },
    };

    const clientConfig: GetSeismicClientsParameters<Transport, Chain, typeof account> = {
      chain,
      account,
      transport: http(this.rpc.rpcUrl),
      encryptionSk,
    };

    this.logger.info(
      `Creating shielded client | rpc:${this.rpc.rpcUrl} | chainId:${this.rpc.chainId}`
    );
    const client = await createShieldedWalletClient(clientConfig);
    this.logger.info("Shielded client created - TEE public key fetched");
    return client as SeismicClient;
  }

  createPublicClient(): SeismicPublicClient {
    const chain: Chain = {
      ...seismicTestnet2,
      id: this.rpc.chainId,
      rpcUrls: { default: { http: [this.rpc.rpcUrl] } },
    };

    return createShieldedPublicClient({
      chain,
      transport: http(this.rpc.rpcUrl),
    }) as SeismicPublicClient;
  }

  async readSrc20Balance(client: SeismicClient, contractAddress: Address): Promise<bigint> {
    this.logger.debug(`Reading own balance | contract:${contractAddress}`);
    const result = await client.readContract({
      address: contractAddress,
      abi: SRC20Abi,
      functionName: "balance",
    });
    return result as bigint;
  }

  async readSrc20BalanceSigned(
    client: SeismicPublicClient,
    contractAddress: Address,
    ownerAddress: Address,
    signature: Hex,
    expiry: bigint
  ): Promise<bigint> {
    this.logger.debug(
      `Reading signed balance | contract:${contractAddress} | owner:${ownerAddress}`
    );
    const result = await client.readContract({
      address: contractAddress,
      abi: SRC20Abi,
      functionName: "balanceOfSigned",
      args: [ownerAddress, expiry, signature],
    });
    return result as bigint;
  }

  async submitShieldedTransfer(
    client: SeismicClient,
    contractAddress: Address,
    to: Address,
    amount: bigint
  ): Promise<Hex> {
    this.logger.info(
      `Submitting shielded transfer | contract:${contractAddress} | to:${to} | amount:${amount}`
    );
    const contract = getShieldedContract({
      abi: SRC20Abi,
      address: contractAddress,
      client,
    });
    const hexGasPrice = await this.rpc.jsonRpc<string>("eth_gasPrice", []);
    const gasPrice = BigInt(hexGasPrice);
    const txHash = await contract.write.transfer([to, amount], { gas: 200_000n, gasPrice });
    this.logger.info(`Shielded transfer submitted | txHash:${txHash}`);
    return txHash;
  }

  async waitForReceipt(client: SeismicClient, txHash: Hex, timeoutMs = 60_000) {
    this.logger.debug(`Waiting for receipt | txHash:${txHash}`);
    return client.waitForTransactionReceipt({ hash: txHash, timeout: timeoutMs });
  }
}
