// @ts-ignore
globalThis.WebSocket = require('websocket').w3cwebsocket;

const path = require('path');
const fs = require('fs');
const kaspa = require('../rusty-kaspa/wasm/nodejs/kaspa');
const {
    setDefaultStorageFolder,
    Resolver, NetworkId,
    NetworkType, RpcClient,
    Generator, PrivateKey,
    kaspaToSompi,
    sompiToKaspaString,
    ScriptBuilder,
    Opcodes,
    addressFromScriptPublicKey
} = kaspa;

const DEFAULT_GAS_FEE = "0.3";  // Fixed gas fee for KRC20 transactions

class KaspaKrc20FeeEstimator {
    constructor(networkType = 'testnet-10') {
        this.networkId = new NetworkId(networkType);  // Use the exact network type
        this.networkType = networkType === 'testnet-10' ? NetworkType.Testnet : NetworkType.Mainnet;
        this.setupStorage();
        this.rpc = null;
    }

    setupStorage() {
        const storageFolder = path.join(__dirname, '../../../data/wallets');
        if (!fs.existsSync(storageFolder)) {
            fs.mkdirSync(storageFolder, { recursive: true });
        }
        setDefaultStorageFolder(storageFolder);
    }

    formatKaspaAmount(sompiAmount) {
        // Convert sompi (BigInt) to KAS with exactly 8 decimal places
        const kaspaAmount = Number(sompiAmount) / 100000000;
        return kaspaAmount.toFixed(8);
    }

    async initialize() {
        try {
            if (!this.rpc) {
                console.log('Initializing RPC client...');
                this.rpc = new RpcClient({
                    resolver: new Resolver(),
                    networkId: this.networkId
                });
                await this.rpc.connect();
                console.log('RPC client connected');

                const { isSynced } = await this.rpc.getServerInfo();
                if (!isSynced) {
                    throw new Error("Please wait for the node to sync");
                }
            }
            return this.rpc;
        } catch (error) {
            console.error('Error in initialize:', error);
            console.error('Stack:', error.stack);
            throw error;
        }
    }

    async estimateKrc20TransactionFee(fromPrivateKey, toAddress, amount, ticker) {
        try {
            console.log('Starting KRC20 fee estimation...');
            const rpc = await this.initialize();

            // Create private key object and get source address
            const privateKey = new PrivateKey(fromPrivateKey);
            const publicKey = privateKey.toPublicKey();
            const sourceAddress = publicKey.toAddress(this.networkType);
            console.log('Source address:', sourceAddress.toString());

            // Get UTXOs for the source address
            console.log('Getting UTXOs for source address...');
            const { entries } = await rpc.getUtxosByAddresses([sourceAddress.toString()]);

            if (!entries || entries.length === 0) {
                throw new Error('No UTXOs found for source address');
            }

            // Sort UTXOs by amount (smallest first)
            entries.sort((a, b) => Number(a.amount) - Number(b.amount));

            // Create KRC20 transfer data
            const adjustedAmount = (BigInt(amount) * 100000000n).toString();
            const data = {
                p: "krc-20",
                op: "transfer",
                tick: ticker,
                amt: adjustedAmount,
                to: toAddress
            };

            // Create script with proper OPcodes
            const script = new ScriptBuilder()
                .addData(publicKey.toXOnlyPublicKey().toString())
                .addOp(Opcodes.OpCheckSig)
                .addOp(Opcodes.OpFalse)
                .addOp(Opcodes.OpIf)
                .addData(Buffer.from("kasplex"))
                .addI64(0n)
                .addData(Buffer.from(JSON.stringify(data)))
                .addOp(Opcodes.OpEndIf);

            const p2shAddress = addressFromScriptPublicKey(script.createPayToScriptHashScript(), this.networkType);
            console.log('P2SH Address:', p2shAddress.toString());

            // Estimate Commit Transaction
            console.log('Estimating commit transaction...');
            const commitGenerator = new Generator({
                entries,
                outputs: [{
                    address: p2shAddress.toString(),
                    amount: kaspaToSompi(DEFAULT_GAS_FEE) // Standard gas fee for KRC20
                }],
                priorityFee: kaspaToSompi("0.0001"),
                changeAddress: sourceAddress.toString(),
                networkId: this.networkId,
                networkType: this.networkType
            });

            const commitEstimation = await commitGenerator.estimate();
            console.log('Commit estimation:', commitEstimation);

            // Format the result with both commit and reveal transaction details
            const result = {
                commitFee: this.formatKaspaAmount(commitEstimation.fees || 0n),
                revealFee: this.formatKaspaAmount(commitEstimation.fees || 0n), // Same as commit fee
                totalFee: this.formatKaspaAmount((commitEstimation.fees || 0n) * 2n), // Double the fee for total
                commitMass: commitEstimation.mass ? commitEstimation.mass.toString() : "0",
                revealMass: commitEstimation.mass ? commitEstimation.mass.toString() : "0", // Same as commit mass
                gasFee: DEFAULT_GAS_FEE, // Standard gas fee for KRC20
                size: commitEstimation.utxos || 0,
                transactions: commitEstimation.transactions || 0,
                note: "Both commit and reveal transactions will have similar fees"
            };

            console.log('KRC20 fee estimation result:', result);
            return result;
        } catch (error) {
            console.error('Error in estimateKrc20TransactionFee:', error);
            console.error('Stack:', error.stack);
            throw error;
        } finally {
            await this.cleanup();
        }
    }

    async cleanup() {
        if (this.rpc) {
            await this.rpc.disconnect();
            this.rpc = null;
        }
    }
}

module.exports = KaspaKrc20FeeEstimator; 