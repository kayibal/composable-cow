import { Command, Option, InvalidOptionArgumentError } from "commander";
import { BigNumberish, ethers, utils } from "ethers";
import {
  MetaTransactionData,
  SafeTransaction,
} from "@safe-global/safe-core-sdk-types";
import EthersAdapter from "@safe-global/safe-ethers-lib";
import SafeServiceClient from "@safe-global/safe-service-client";
import Safe from "@safe-global/safe-core-sdk";

import {
  ERC20__factory,
  ComposableCoW__factory,
  GPv2Settlement__factory,
  ExtensibleFallbackHandler__factory,
} from "./types";

import type { IConditionalOrder } from "./types/ComposableCoW";

import * as dotenv from "dotenv";
import { keccak256 } from "ethers/lib/utils";
dotenv.config();

// These are constant across all networks supported by CoW Protocol
const RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110";
const SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";

const TWAP_ORDER_STRUCT =
  "tuple(address sellToken,address buyToken,address receiver,uint256 partSellAmount,uint256 minPartLimit,uint256 t0,uint256 n,uint256 t,uint256 span,bytes32 appData)";

const DUTCH_ORDER_STRUCT =
  "tuple(address sellToken, address buyToken, uint256 sellAmount, bytes32 appData, address receiver, bool isPartiallyFillable, uint32 startTs, uint32 duration, uint32 timeStep, address sellTokenPriceOracle, address buyTokenPriceOracle, uint256 startPrice, uint256 endPrice)"


const CONDITIONAL_ORDER_PARAMS_STRUCT =
  "tuple(address handler, bytes32 salt, bytes staticInput)";

// The TWAP order data that is signed by Safe
interface TWAPData {
  sellToken: string;
  buyToken: string;
  receiver: string;
  partSellAmount: BigNumberish;
  minPartLimit: BigNumberish;
  t0: number;
  n: number;
  t: number;
  span: number;
  appData: string;
}

/**
 * Root CLI options
 * @property safeAddress Address of the Safe
 * @property composableCow Address of the Composable CoW contract
 * @property rpcUrl An Ethereum JSON-RPC URL
 * @property privateKey A Safe owner's private key for proposing transactions
 */
interface RootCliOptions {
  safeAddress: string;
  composableCow: string;
  rpcUrl: string;
  privateKey: string;
}

/**
 * Options for the `twap` command
 * @property sellToken Address of the token to sell
 * @property buyToken Address of the token to buy
 * @property receiver Address of the receiver of the bought tokens
 * @property totalSellAmount Total amount of tokens to sell
 * @property totalMinBuyAmount Total minimum amount of tokens to buy
 * @property startTime Start time of the TWAP order
 * @property numParts Number of parts to split the TWAP order into
 * @property timeInterval Time interval between each part of the TWAP order
 * @property span Time span of the TWAP order (0 for indefinite)
 */
interface TWAPCliOptions extends RootCliOptions {
  handler: string;
  sellToken: string;
  buyToken: string;
  receiver: string;
  totalSellAmount: string;
  totalMinBuyAmount: string;
  startTime: number;
  numParts: number;
  timeInterval: number;
  span: number;
}

interface DutchAuctionData {
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  appData: string;
  receiver: string;
  isPartiallyFillable: boolean;
  startTs: number;
  duration: number;
  timeStep: number;
  sellTokenPriceOracle: string;
  buyTokenPriceOracle: string;
  startPrice: string;
  endPrice: string;
}

/**
 * Options for the `setFallbackHandler` command
 * @property handler Address of the fallback handler
 */
interface SetFallbackHandlerCliOptions extends RootCliOptions {
  handler: string;
}

/**
 * Returns the URL of the transaction service for the given chainId
 * @param chainId The chainId of the network
 * @returns The URL of the transaction service
 */
const getTxServiceUrl = (chainId: number) => {
  switch (chainId) {
    case 1:
      return "https://safe-transaction-mainnet.safe.global/";
    case 5:
      return "https://safe-transaction-goerli.safe.global/";
    case 100:
      return "https://safe-transaction-gnosis-chain.safe.global";
    default:
      throw new Error(`Unsupported chainId: ${chainId}`);
  }
};

/**
 * Returns a SafeServiceClient and Safe instance
 * @param safeAddress Address of the Safe
 * @returns SafeServiceClient and Safe instances
 */
const getSafeAndService = async (
  options: RootCliOptions
): Promise<{
  safeService: SafeServiceClient;
  safe: Safe;
  signer: ethers.Signer;
}> => {
  const { rpcUrl, privateKey, safeAddress } = options;

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const signerOrProvider = new ethers.Wallet(privateKey, provider);
  const ethAdapter = new EthersAdapter({ ethers, signerOrProvider });

  const safeService = new SafeServiceClient({
    txServiceUrl: getTxServiceUrl(await ethAdapter.getChainId()),
    ethAdapter,
  });
  const safe = await Safe.create({ ethAdapter, safeAddress });

  return { safeService, safe, signer: signerOrProvider };
};

/**
 * Set the fallback handler of a Safe
 * @param options CLI and fallback handler options
 */
async function setFallbackHandler(options: SetFallbackHandlerCliOptions) {
  const { safeService, safe, signer } = await getSafeAndService(options);

  const safeTransaction = await safe.createEnableFallbackHandlerTx(
    options.handler
  );

  console.log(
    `Proposing setFallbackHandler Transaction: ${JSON.stringify(
      safeTransaction.data
    )}`
  );
  await proposeTransaction(safe, safeService, safeTransaction, signer);
}

/**
 * Set the CoW Protocol domain verifier of a Safe (`ExtensibleFallbackHandler`)
 * @param options CLI and domain verifier options
 */
async function setDomainVerifier(options: RootCliOptions) {
  const { safeService, safe, signer } = await getSafeAndService(options);

  // For the given chain, we need to lookup the EIP-712 domain separator
  // to set the domain verifier.
  const settlement = GPv2Settlement__factory.connect(SETTLEMENT, signer);

  const domain = await settlement.domainSeparator();

  const safeTransaction = await safe.createTransaction({
    safeTransactionData: {
      to: options.safeAddress,
      value: "0",
      data: ExtensibleFallbackHandler__factory.createInterface().encodeFunctionData(
        "setDomainVerifier",
        [domain, options.composableCow]
      ),
    },
  });

  console.log(
    `Proposing setDomainVerifier Transaction: ${JSON.stringify(
      safeTransaction.data
    )}`
  );
  await proposeTransaction(safe, safeService, safeTransaction, signer);
}

/**
 * Propose a transaction to a Safe
 * @param safe on which the transaction is proposed
 * @param safeService API client
 * @param tx transaction to propose
 * @param signer used to propose the transaction
 */
async function proposeTransaction(
  safe: Safe,
  safeService: SafeServiceClient,
  tx: SafeTransaction,
  signer: ethers.Signer
) {
  const safeTxHash = await safe.getTransactionHash(tx);
  const senderSignature = await safe.signTransactionHash(safeTxHash);
  await safeService.proposeTransaction({
    safeAddress: safe.getAddress(),
    safeTransactionData: tx.data,
    safeTxHash,
    senderAddress: await signer.getAddress(),
    senderSignature: senderSignature.data,
  });

  console.log(`Submitted Transaction hash: ${safeTxHash}`);
}

async function createDutchAuction(options: RootCliOptions) {
  const { safeService, safe, signer } = await getSafeAndService(options);
  const sellTokenOracle = "0xa767f745331D267c7751297D982b050c93985627";
  const provider = new ethers.providers.JsonRpcProvider(options.rpcUrl);
  const handler = "0xc089745e395850f2075f005e3f3492411d9d5f9c";
  let oracleABI = [
    {
      "constant": true,
      "inputs": [],
      "name": "latestAnswer",  // the function we want to call
      "outputs": [{ "name": "", "type": "int256" }],
      "payable": false,
      "stateMutability": "view",
      "type": "function"
    }
  ];
  let oracleContract = new ethers.Contract(sellTokenOracle, oracleABI, provider);
  let latestAnswerBN = await oracleContract.latestAnswer();
  let startPrice = latestAnswerBN.mul(ethers.BigNumber.from('110')).div(ethers.BigNumber.from('100'));
  let endPrice = latestAnswerBN.mul(ethers.BigNumber.from('90')).div(ethers.BigNumber.from('100'));
  let now = Math.floor(Date.now() / 1000);


  const dutchAuction: DutchAuctionData = {
    sellToken: "0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1",
    buyToken: "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83",
    receiver: "0x0fBE13d155E734EaE790b3C24B955Ca16A52C3fC",
    appData: keccak256(ethers.utils.toUtf8Bytes("dutch.cli")),
    sellAmount: "10000000000000000",
    isPartiallyFillable: false,
    startTs: now,
    duration: 1800,
    timeStep: 300,
    // https://docs.chain.link/data-feeds/price-feeds/addresses/?network=gnosis-chain
    sellTokenPriceOracle: sellTokenOracle,
    buyTokenPriceOracle: "0x26C31ac71010aF62E6B486D1132E266D6298857D",
    startPrice: startPrice.toString(),
    endPrice: endPrice.toString(),
  }

  const params: IConditionalOrder.ConditionalOrderParamsStruct = {
    handler: handler,
    salt: utils.keccak256(utils.toUtf8Bytes(Date.now().toString())),
    staticInput: utils.defaultAbiCoder.encode([DUTCH_ORDER_STRUCT], [dutchAuction]),
  };

  const orderHash = utils.defaultAbiCoder.encode(
    [CONDITIONAL_ORDER_PARAMS_STRUCT],
    [params]
  );

  const safeTransactionData: MetaTransactionData[] = [
    {
      to: options.composableCow,
      data: ComposableCoW__factory.createInterface().encodeFunctionData(
        "create",
        [params, true]
      ),
      value: "0",
    },
  ];

  const safeTransaction = await safe.createTransaction({
    safeTransactionData,
    options: { nonce: await safeService.getNextNonce(options.safeAddress) },
  });

  console.log(
    `Proposing TWAP Order Transaction: ${JSON.stringify(safeTransaction.data)}`
  );
  await proposeTransaction(safe, safeService, safeTransaction, signer);
  console.log(`IConditionalOrder hash for cancelling: ${orderHash}`);
}

/**
 * Create an `IConditionalOrder` of type TWAP by submitting a `singleOrder`.
 *
 * This function provides some utility math to calculate the part sell amount
 * and the min part limit, with units of sell token and buy token specified
 * in decimalised units (ie. to sell 1.5 WETH, specify 1.5).
 *
 * This function batches together:
 * 1. Approving `GPv2VaultRelayer` to transfer the sell token
 * 2. Set the signle order on `ComposableCoW` to be picked up by the watchtower
 * @param options CLI and TWAP order options
 */
async function createTwapOrder(options: TWAPCliOptions) {
  const { safeService, safe, signer } = await getSafeAndService(options);

  const sellToken = ERC20__factory.connect(options.sellToken, signer);
  const buyToken = ERC20__factory.connect(options.buyToken, signer);

  // calculate the part sell amount
  const totalSellAmount = utils.parseUnits(
    options.totalSellAmount,
    await sellToken.decimals()
  );
  const partSellAmount = totalSellAmount.div(options.numParts);

  // calculate the min part limit
  const minBuyAmount = utils.parseUnits(
    options.totalMinBuyAmount,
    await buyToken.decimals()
  );
  const minPartLimit = minBuyAmount.div(options.numParts);

  // enforce that it is a valid TWAP order

  // sell token and buy token must be different
  if (sellToken === buyToken) {
    throw new Error("Sell token and buy token must be different");
  }

  // neither sell token nor buy token can be address(0)
  if (sellToken.address === ethers.constants.AddressZero || buyToken.address === ethers.constants.AddressZero) {
    throw new Error("Sell token and buy token must be non-zero addresses");
  }

  // part sell amount must be greater than 0
  if (partSellAmount.isZero()) {
    throw new Error("Part sell amount must be greater than 0");
  }

  // min part limit must be greater than 0
  if (minPartLimit.isZero()) {
    throw new Error("Min part limit must be greater than 0");
  }

  // startTime must be in the future and less than uint32 max
  if (options.startTime < Date.now() || options.startTime > 2 ** 32) {
    throw new Error("Start time must be in the future and less than uin32 max");
  }

  // numParts must be greater than 1 and less than uint32 max
  if (options.numParts < 1 || options.numParts > 2 ** 32) {
    throw new Error("Num parts must be greater than 1 and less than uin32 max");
  }

  // timeInterval must be greater than 0 and less than or equal to 365 days
  if (options.timeInterval == 0 || options.timeInterval > 365 * 24 * 60 * 60) {
    throw new Error("Invalid time interval");
  }

  // span must be less than or equal to time interval
  if (options.span > options.timeInterval) {
    throw new Error("Span must be less than or equal to time interval");
  }

  const twap: TWAPData = {
    sellToken: options.sellToken,
    buyToken: options.buyToken,
    receiver: options.receiver,
    partSellAmount,
    minPartLimit,
    t0: options.startTime,
    n: options.numParts,
    t: options.timeInterval,
    span: options.span,
    appData: keccak256("twap.cli"),
  };

  const params: IConditionalOrder.ConditionalOrderParamsStruct = {
    handler: options.handler,
    salt: utils.keccak256(utils.toUtf8Bytes(Date.now().toString())),
    staticInput: utils.defaultAbiCoder.encode([TWAP_ORDER_STRUCT], [twap]),
  };

  const orderHash = utils.defaultAbiCoder.encode(
    [CONDITIONAL_ORDER_PARAMS_STRUCT],
    [params]
  );

  const safeTransactionData: MetaTransactionData[] = [
    {
      to: twap.sellToken,
      data: ERC20__factory.createInterface().encodeFunctionData("approve", [
        RELAYER,
        totalSellAmount,
      ]),
      value: "0",
    },
    {
      to: options.composableCow,
      data: ComposableCoW__factory.createInterface().encodeFunctionData(
        "create",
        [params, true]
      ),
      value: "0",
    },
  ];
  const safeTransaction = await safe.createTransaction({
    safeTransactionData,
    options: { nonce: await safeService.getNextNonce(options.safeAddress) },
  });

  console.log(
    `Proposing TWAP Order Transaction: ${JSON.stringify(safeTransaction.data)}`
  );
  await proposeTransaction(safe, safeService, safeTransaction, signer);
  console.log(`IConditionalOrder hash for cancelling: ${orderHash}`);
}

/**
 * Options that are inherited by all commands
 */
class RootCommand extends Command {
  createCommand(name?: string | undefined): Command {
    const cmd = new Command(name);
    cmd
      .addOption(
        new Option("-s, --safe-address <safeAddress>", "Address of the Safe")
          .env("SAFE_ADDRESS")
          .makeOptionMandatory(true)
      )
      .addOption(
        new Option(
          "-c, --composable-cow <composableCow>",
          "Address of Composable Cow"
        )
          .env("COMPOSABLE_COW")
          .makeOptionMandatory(true)
      )
      .addOption(
        new Option("-r --rpc-url <rpcUrl>", "URL of the Ethereum node")
          .env("ETH_RPC_URL")
          .makeOptionMandatory(true)
      )
      .addOption(
        new Option(
          "-p --private-key <privateKey>",
          "Private key of the account that will sign transaction batches"
        )
          .env("PRIVATE_KEY")
          .makeOptionMandatory(true)
      );
    return cmd;
  }
}

// --- CLI parsers

/**
 * Parses a number from the CLI
 * @param value raw user input for verification
 * @returns a sanitized string representing a number
 */
function cliParseInt(value: string, _: unknown): number {
  const parsedValue = parseInt(value, 10);
  if (isNaN(parsedValue)) {
    throw new InvalidOptionArgumentError("Not a number.");
  }
  return parsedValue;
}

/**
 * Parses an Ethereum address from the CLI
 * @param value raw user input for verification
 * @returns a sanitized string representing an Ethereum address
 */
function cliParseAddress(value: string, _: any): string {
  if (!ethers.utils.isAddress(value)) {
    throw new InvalidOptionArgumentError(`Invalid address: ${value}`);
  }

  return value;
}

/**
 * Parses a decimal number from the CLI
 * @param value raw user input for verification
 * @returns a sanitized string representing a decimal number
 */
function cliParseDecimalNumber(value: string, _: any): string {
  // Verify that the value is a string with only digits and a single decimal point that may be a represented by a comma
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new InvalidOptionArgumentError(`Invalid number: ${value}`);
  }

  // Replace the decimal point with a dot
  value = value.replace(",", ".");

  return value;
}

/**
 * CLI entry point
 */
async function main() {
  const program = new RootCommand()
    .name("composable-cow")
    .description(
      "Dispatch conditional orders on Safe using composable CoW Protocol"
    )
    .version("0.0.1");

  program
    .command("create-dutch")
    .description("Create a dutch auction order")
    .action(createDutchAuction)

  program
    .command("create-twap")
    .description("Create a TWAP order")
    .addOption(
      new Option("--sell-token <sellToken>", "Address of the token to sell")
        .argParser(cliParseAddress)
        .makeOptionMandatory(true)
    )
    .addOption(
      new Option("--buy-token <buyToken>", "Address of the token to buy")
        .argParser(cliParseAddress)
        .makeOptionMandatory(true)
    )
    .addOption(
      new Option(
        "-r, --receiver <receiver>",
        "Address of the receiver of the buy token"
      )
        .default(ethers.constants.AddressZero)
        .makeOptionMandatory(true)
    )
    .addOption(
      new Option(
        "--total-sell-amount <totalSellAmount>",
        "Total amount of the token to sell"
      )
        .argParser(cliParseDecimalNumber)
        .makeOptionMandatory(true)
    )
    .addOption(
      new Option(
        "--total-min-buy-amount <totalMinBuyAmount>",
        "Minimum amount of the token to buy"
      )
        .argParser(cliParseDecimalNumber)
        .makeOptionMandatory(true)
    )
    .addOption(
      new Option(
        "-t0 --start-time <startTime>",
        "Start time of the TWAP in UNIX epoch seconds"
      )
        .default(Math.floor(Date.now() / 1000).toString())
        .argParser(cliParseInt)
        .makeOptionMandatory(true)
    )
    .addOption(
      new Option("-n --num-parts <numParts>", "Number of time intervals")
        .argParser(parseInt)
        .makeOptionMandatory(true)
    )
    .addOption(
      new Option(
        "-t --time-interval <frequency>",
        "Duration of each time interval in seconds"
      )
        .argParser(parseInt)
        .makeOptionMandatory(true)
    )
    .addOption(
      new Option("-s --span <span>", "Duration of the TWAP in seconds")
        .argParser(parseInt)
        .default(0)
    )
    .addOption(
      new Option("-h --handler <handler>", "Address of the TWAP handler")
        .argParser(cliParseAddress)
        .makeOptionMandatory(true)
    )
    .action(createTwapOrder);

  program
    .command("set-fallback-handler")
    .description("Set the fallback handler of the Safe")
    .requiredOption("--handler <handler>", "Address of the fallback handler")
    .action(setFallbackHandler);

  program
    .command("set-domain-verifier")
    .description("Set the CoW Protocol domain verifier of the Safe")
    .requiredOption(
      "--handler <handler>",
      "Address of the ExtensibleFallbackHandler"
    )
    .action(setDomainVerifier);

  await program.parseAsync(process.argv);
}

main();
