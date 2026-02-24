#!/usr/bin/env node
/**
 * Show USDC.e balance of the Safe at PROXY_WALLET_ADDRESS (Polygon).
 *
 * Usage:
 *   node scripts/show-safe-balance.js
 *
 * Env:
 *   PROXY_WALLET_ADDRESS — Safe (or any wallet) address to check
 *   POLYGON_RPC_URL      — optional; defaults to public RPC
 */

import dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ERC20_ABI = ['function balanceOf(address account) view returns (uint256)'];

async function main() {
    const safeAddress = process.env.PROXY_WALLET_ADDRESS;
    if (!safeAddress) {
        console.error('Missing PROXY_WALLET_ADDRESS in .env');
        process.exit(1);
    }

    const rpcUrl = process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com';
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const usdc = new ethers.Contract(USDC_E, ERC20_ABI, provider);

    const balanceWei = await usdc.balanceOf(safeAddress);
    const balanceUsdc = ethers.utils.formatUnits(balanceWei, 6);

    console.log('Safe (PROXY_WALLET_ADDRESS):', safeAddress);
    console.log('USDC.e balance:', balanceUsdc);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
