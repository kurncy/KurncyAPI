// @ts-ignore
globalThis.WebSocket = require('websocket').w3cwebsocket;

const path = require('path');
const fs = require('fs');
const kaspa = require('../rusty-kaspa/wasm/nodejs/kaspa');
const {
    setDefaultStorageFolder,
    Resolver, NetworkId,
    NetworkType, RpcClient,
    UtxoProcessor, UtxoContext,
    Generator, PrivateKey,
    kaspaToSompi,
    sompiToKaspaString
} = kaspa;

class KaspaFeeEstimator {
    constructor(networkType = 'testnet-10') {
        this.networkId = new NetworkId(networkType);
        this.networkType = networkType.includes('testnet') ? NetworkType.Testnet : NetworkType.Mainnet;
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

    async estimateTransactionFee(fromPrivateKey, toAddress, amount) {
        try {
            console.log('Starting fee estimation...');
            const rpc = await this.initialize();

            // Create private key object and get source address
            const privateKey = new PrivateKey(fromPrivateKey);
            const sourceAddress = privateKey.toKeypair().toAddress(this.networkType);
            console.log('Source address:', sourceAddress.toString());

            // Get UTXOs for the source address
            console.log('Getting UTXOs for source address...');
            const { entries } = await rpc.getUtxosByAddresses([sourceAddress.toString()]);

            if (!entries || entries.length === 0) {
                throw new Error('No UTXOs found for source address');
            }

            // Sort UTXOs by amount (smallest first)
            entries.sort((a, b) => Number(a.amount) - Number(b.amount));

            // Convert amount to sompi
            const amountSompi = BigInt(kaspaToSompi(amount.toString()));
            console.log('Amount in sompi:', amountSompi.toString());

            // Set priority fee (0.0001 KAS)
            const priorityFeeSompi = BigInt(kaspaToSompi("0"));
            console.log('Priority fee in sompi:', priorityFeeSompi.toString());

            // Create transaction generator for estimation
            console.log('Creating transaction generator for estimation...');
            const generator = new Generator({
                entries,
                outputs: [{
                    address: toAddress,
                    amount: amountSompi
                }],
                priorityFee: priorityFeeSompi,
                changeAddress: sourceAddress.toString(),
                networkId: this.networkId,
                networkType: this.networkType
            });

            // Get fee estimation
            console.log('Getting fee estimation...');
            const estimation = await generator.estimate();
            console.log('Raw estimation:', estimation);
            console.log('Fee estimation completed');

            // Calculate total amount including fee
            const totalAmount = estimation.finalAmount + estimation.fees;

            // Convert estimation to readable format with exactly 8 decimal places
            const result = {
                fee: this.formatKaspaAmount(estimation.fees || 0n),
                mass: estimation.mass ? estimation.mass.toString() : "0",
                size: estimation.utxos || 0,
                inputs: estimation.utxos || 0,
                outputs: estimation.transactions || 0,
                amount: this.formatKaspaAmount(estimation.finalAmount || 0n),
                totalAmount: this.formatKaspaAmount(totalAmount || 0n)
            };

            console.log('Estimation result:', result);
            return result;
        } catch (error) {
            console.error('Error in estimateTransactionFee:', error);
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

module.exports = KaspaFeeEstimator; 