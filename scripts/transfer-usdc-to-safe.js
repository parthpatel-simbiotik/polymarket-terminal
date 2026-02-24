#!/usr/bin/env node
/**
 * Transfer USDC.e (Polygon) to your Safe.
 *
 * Modes:
 *  1. EOA → Safe (default): Transfer from the EOA (PRIVATE_KEY) to the Safe.
 *     Use when your USDC is in a regular wallet (e.g. MetaMask).
 *
 *  2. Safe → Safe (--from-safe): Transfer from the Safe in .env (PROXY_WALLET_ADDRESS)
 *     to another Safe (TRANSFER_TO_SAFE_ADDRESS). Use when your "main" Polymarket
 *     balance is already in a Gnosis Safe and you want to move it to a new Safe.
 *
 * Usage:
 *   node scripts/transfer-usdc-to-safe.js <amount>
 *   node scripts/transfer-usdc-to-safe.js <amount> --from-safe
 *
 * Env:
 *   PRIVATE_KEY, POLYGON_RPC_URL
 *   PROXY_WALLET_ADDRESS  — destination Safe (EOA mode) or source Safe (--from-safe mode)
 *   TRANSFER_TO_SAFE_ADDRESS — required in --from-safe mode (destination address)
 *   TRANSFER_FROM_SAFE=true — use Safe as source (avoids npm swallowing --from-safe)
 *   TRANSFER_AMOUNT_USDC    — optional; overridden by <amount> argument
 *
 * Balance on Polymarket: After you transfer, the balance leaves the source wallet
 * and appears in the destination Safe. Polymarket.com shows the balance of the
 * wallet you're connected with — so the old wallet balance goes down, and the
 * Safe's balance (when you use that Safe) goes up.
 */

import dotenv from 'dotenv';
import { ethers } from 'ethers';
import logger from '../src/utils/logger.js';

dotenv.config();

const short = (addr) => `${addr.slice(0, 10)}\u2026${addr.slice(-4)}`;

const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ERC20_ABI = [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address account) view returns (uint256)',
];

async function transferFromEoa(amountUsdc, destinationSafe) {
    const privateKey = process.env.PRIVATE_KEY;
    const rpcUrl = process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com';

    if (!privateKey) {
        console.error('Missing PRIVATE_KEY in .env');
        process.exit(1);
    }
    if (!destinationSafe) {
        console.error('Missing destination. Set PROXY_WALLET_ADDRESS in .env or pass as second argument.');
        process.exit(1);
    }

    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);
    const usdc = new ethers.Contract(USDC_E, ERC20_ABI, wallet);

    const amountWei = ethers.utils.parseUnits(String(amountUsdc), 6);
    const balance = await usdc.balanceOf(wallet.address);
    if (balance.lt(amountWei)) {
        console.error(`Insufficient USDC.e. EOA has ${ethers.utils.formatUnits(balance, 6)}, requested ${amountUsdc}`);
        process.exit(1);
    }

    logger.info(`Transferring ${amountUsdc} USDC.e from EOA (${short(wallet.address)}) to Safe (${short(destinationSafe)})`);
    const tx = await usdc.transfer(destinationSafe, amountWei);
    await tx.wait();
    logger.success('Done. Tx:', tx.hash);
}

async function transferFromSafe(amountUsdc, destinationSafe) {
    const sourceSafe = process.env.PROXY_WALLET_ADDRESS;
    if (!sourceSafe) {
        console.error('Missing PROXY_WALLET_ADDRESS (source Safe) in .env');
        process.exit(1);
    }
    if (!destinationSafe) {
        console.error('Missing TRANSFER_TO_SAFE_ADDRESS in .env for --from-safe mode');
        process.exit(1);
    }

    // Dynamic import so we only load client/ctf when using Safe mode
    const { initClient } = await import('../src/services/client.js');
    const { transferUsdcFromSafe } = await import('../src/services/ctf.js');

    await initClient();
    logger.info(`Transferring ${amountUsdc} USDC.e from Safe (${short(sourceSafe)}) to Safe (${short(destinationSafe)})`);
    await transferUsdcFromSafe(destinationSafe, amountUsdc);
    logger.success('Transfer complete');
}

async function main() {
    const args = process.argv.slice(2);
    const fromSafe = args.includes('--from-safe') || process.env.TRANSFER_FROM_SAFE === 'true';
    const numArgs = args.filter((a) => a !== '--from-safe');
    const amount = numArgs[0] || process.env.TRANSFER_AMOUNT_USDC;
    const destinationFromArg = numArgs[1];

    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
        console.error('Usage: node scripts/transfer-usdc-to-safe.js <amount> [destination] [--from-safe]');
        console.error('   Or: TRANSFER_FROM_SAFE=true npm run transfer-to-safe <amount>  (Safe → wallet)');
        console.error('   Or set TRANSFER_AMOUNT_USDC and PROXY_WALLET_ADDRESS / TRANSFER_TO_SAFE_ADDRESS in .env');
        process.exit(1);
    }

    const amountUsdc = Number(amount);
    const destination = destinationFromArg || process.env.PROXY_WALLET_ADDRESS;

    if (fromSafe) {
        const toSafe = process.env.TRANSFER_TO_SAFE_ADDRESS || destinationFromArg;
        await transferFromSafe(amountUsdc, toSafe);
    } else {
        await transferFromEoa(amountUsdc, destination);
    }

    logger.info('Balance now sits in the destination Safe (source decreased, destination increased)');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
