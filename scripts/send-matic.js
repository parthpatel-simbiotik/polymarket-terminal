#!/usr/bin/env node
/**
 * Send native MATIC (Polygon) from one wallet to another.
 * Use this to fund your signer EOA so it can pay gas for Safe transactions.
 *
 * Usage:
 *   node scripts/send-matic.js <amount> [recipient]
 *   npm run send-matic -- 0.05
 *
 * Env:
 *   MATIC_SENDER_PRIVATE_KEY  — wallet that has MATIC (sends from this)
 *   POLYGON_RPC_URL           — optional
 *   MATIC_RECIPIENT_ADDRESS   — optional; default is EOA from PRIVATE_KEY (your signer)
 *
 * If you omit recipient, the script sends to the address derived from PRIVATE_KEY
 * (your Polymarket signer EOA), so it gets funded for gas.
 *
 * Example: You have MATIC in a MetaMask wallet. Export its private key, set
 *   MATIC_SENDER_PRIVATE_KEY=0x... in .env, then run:
 *   node scripts/send-matic.js 0.05
 * That sends 0.05 MATIC to your PRIVATE_KEY address (the signer).
 */

import dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

async function main() {
    const args = process.argv.slice(2);
    const amountArg = args[0] || process.env.MATIC_AMOUNT;
    const recipientArg = args[1];

    const senderKey = process.env.MATIC_SENDER_PRIVATE_KEY || process.env.PRIVATE_KEY;
    const recipient =
        recipientArg ||
        process.env.MATIC_RECIPIENT_ADDRESS ||
        (process.env.PRIVATE_KEY ? new ethers.Wallet(process.env.PRIVATE_KEY).address : null);
    const rpcUrl = process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com';

    if (!amountArg || isNaN(Number(amountArg)) || Number(amountArg) <= 0) {
        console.error('Usage: node scripts/send-matic.js <amount_matic> [recipient_address]');
        console.error('   e.g. node scripts/send-matic.js 0.05');
        console.error('   Env: MATIC_SENDER_PRIVATE_KEY (source), MATIC_RECIPIENT_ADDRESS or PRIVATE_KEY (target)');
        process.exit(1);
    }

    if (!senderKey) {
        console.error('Missing MATIC_SENDER_PRIVATE_KEY or PRIVATE_KEY in .env');
        process.exit(1);
    }

    if (!recipient) {
        console.error('Missing recipient. Set MATIC_RECIPIENT_ADDRESS or PRIVATE_KEY in .env, or pass recipient as second argument.');
        process.exit(1);
    }

    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const sender = new ethers.Wallet(
        senderKey.startsWith('0x') ? senderKey : `0x${senderKey}`,
        provider,
    );

    const amountWei = ethers.utils.parseEther(String(amountArg));
    const balance = await provider.getBalance(sender.address);
    const gasPrice = await provider.getGasPrice();
    const gasLimit = 21000;
    const gasCost = gasPrice.mul(gasLimit);

    if (balance.lt(amountWei.add(gasCost))) {
        console.error(
            `Insufficient MATIC. Wallet has ${ethers.utils.formatEther(balance)} MATIC, ` +
                `requested ${amountArg} + ~${ethers.utils.formatEther(gasCost)} gas.`
        );
        process.exit(1);
    }

    console.log(`Sending ${amountArg} MATIC from ${sender.address} to ${recipient}...`);
    const tx = await sender.sendTransaction({
        to: recipient,
        value: amountWei,
        gasLimit: 21000,
    });
    await tx.wait();
    console.log('Done. Tx:', tx.hash);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
