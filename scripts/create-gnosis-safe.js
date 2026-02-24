#!/usr/bin/env node
/**
 * Deploy a Gnosis Safe on Polygon via Polymarket's relayer (gasless).
 *
 * Follows the official guide: https://docs.polymarket.com/market-makers/getting-started
 *
 * Prerequisites:
 *   - Builder Program membership: get API credentials at https://polymarket.com/settings?tab=builder
 *   - PRIVATE_KEY for the EOA that will own the Safe
 *
 * Usage:
 *   npm run create-gnosis-safe
 *
 * After deployment:
 *   1. Set PROXY_WALLET_ADDRESS in .env to the printed Safe address
 *   2. Deposit USDC.e to the Safe (see https://docs.polymarket.com/market-makers/getting-started)
 *   3. Approve tokens (USDC.e → CTF, CTF → exchanges) — can be done via relayer or app
 *   4. Generate CLOB API credentials (npm start or initClient will derive them)
 */

import dotenv from 'dotenv';
import logger from '../src/utils/logger.js';
dotenv.config();
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';

const RELAYER_URL = 'https://relayer-v2.polymarket.com/';
const CHAIN_ID = 137;

async function main() {
    const privateKey = process.env.PRIVATE_KEY;
    const rpcUrl = process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com';
    const builderKey = process.env.POLY_BUILDER_API_KEY;
    const builderSecret = process.env.POLY_BUILDER_SECRET;
    const builderPassphrase = process.env.POLY_BUILDER_PASSPHRASE;

    if (!privateKey) {
        console.error('Missing PRIVATE_KEY in .env');
        process.exit(1);
    }
    if (!builderKey || !builderSecret || !builderPassphrase) {
        console.error('Missing Builder API credentials. Get them at https://polymarket.com/settings?tab=builder');
        console.error('Set in .env: POLY_BUILDER_API_KEY, POLY_BUILDER_SECRET, POLY_BUILDER_PASSPHRASE');
        process.exit(1);
    }

    const account = privateKeyToAccount(
        privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`
    );
    const wallet = createWalletClient({
        account,
        chain: polygon,
        transport: http(rpcUrl),
    });

    const builderConfig = new BuilderConfig({
        localBuilderCreds: {
            key: builderKey,
            secret: builderSecret,
            passphrase: builderPassphrase,
        },
    });

    const client = new RelayClient(
        RELAYER_URL,
        CHAIN_ID,
        wallet,
        builderConfig,
        RelayerTxType.SAFE,
    );

    logger.info('EOA (owner):', account.address);
    logger.info('Deploying Safe via Polymarket relayer (gasless)...');

    const response = await client.deploy();
    const result = await response.wait();

    if (!result?.proxyAddress) {
        logger.error('Deploy failed or no proxy address in result:', result);
        process.exit(1);
    }

    logger.success('Safe deployed:', result.proxyAddress);
    if (result.transactionHash) {
        logger.info('Transaction:', result.transactionHash);
    }
    console.log('');
    console.log('Next steps (see docs.polymarket.com/market-makers/getting-started):');
    console.log('  1. .env  PROXY_WALLET_ADDRESS=' + result.proxyAddress);
    console.log('  2. Deposit USDC.e to the Safe');
    console.log('  3. Approve tokens (USDC.e \u2192 CTF, CTF \u2192 exchanges)');
    console.log('  4. Run the app to derive CLOB API credentials');
    console.log('');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
