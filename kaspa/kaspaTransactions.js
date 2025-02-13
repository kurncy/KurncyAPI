// @ts-ignore
globalThis.WebSocket = require('websocket').w3cwebsocket;

const path = require('path');
const fs = require('fs');
const kaspa = require('../rusty-kaspa/wasm/nodejs/kaspa');
const KaspaFeeEstimator = require('./kaspaFeeEstimator');
const {
    setDefaultStorageFolder,
    Resolver, NetworkId,
    NetworkType, RpcClient,
    UtxoProcessor, UtxoContext,
    Generator, PrivateKey,
    kaspaToSompi
} = kaspa;

// 1 Kaspa = 100000000 Sompi
const SOMPI_PER_KASPA = 100000000n;
const DEFAULT_PRIORITY_FEE = "0"; // Default priority fee is 0

function kaspaToSompiStr(amount) {
    return BigInt(Math.floor(Number(amount) * Number(SOMPI_PER_KASPA))).toString();
}

class KaspaTransactions {
    constructor(networkType = 'testnet-10') {
        this.networkId = new NetworkId(networkType);
        this.networkType = networkType.includes('testnet') ? NetworkType.Testnet : NetworkType.Mainnet;
        this.setupStorage();
        this.rpc = null;
        this.processor = null;
        this.context = null;
        this.feeEstimator = new KaspaFeeEstimator(networkType);
    }

    setupStorage() {
        const storageFolder = path.join(__dirname, '../../../data/wallets');
        if (!fs.existsSync(storageFolder)) {
            fs.mkdirSync(storageFolder, { recursive: true });
        }
        setDefaultStorageFolder(storageFolder);
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

            if (!this.processor) {
                console.log('Initializing UTXO processor...');
                this.processor = new UtxoProcessor({ rpc: this.rpc, networkId: this.networkId });
                await this.processor.start();
                console.log('UTXO processor started');

                this.processor.addEventListener("utxo-proc-start", (event) => {
                    console.log("UTXO processor event:", event);
                });
            }

            if (!this.context) {
                this.context = new UtxoContext({ processor: this.processor });
            }

            return { rpc: this.rpc, processor: this.processor, context: this.context };
        } catch (error) {
            console.error('Error in initialize:', error);
            console.error('Stack:', error.stack);
            throw error;
        }
    }

    async sendTransaction(fromPrivateKey, toAddress, amount, priorityFee = DEFAULT_PRIORITY_FEE) {
        try {
            console.log('Starting transaction...');
            await this.initialize();

            // Estimate transaction fee first
            console.log('Estimating transaction fee...');
            const feeEstimation = await this.feeEstimator.estimateTransactionFee(
                fromPrivateKey,
                toAddress,
                amount
            );
            console.log('Fee estimation:', feeEstimation);

            // Create private key object and get source address
            const privateKey = new PrivateKey(fromPrivateKey);
            const sourceAddress = privateKey.toKeypair().toAddress(this.networkType);
            console.log('Source address:', sourceAddress.toString());

            // Track source address for UTXOs
            await this.context.trackAddresses([sourceAddress.toString()]);
            console.log('Tracking source address for UTXOs');

            // Wait a bit for UTXOs to be processed
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Convert amounts to sompi
            const amountSompi = kaspaToSompiStr(amount);
            const estimatedFeeSompi = kaspaToSompiStr(feeEstimation.fee);
            const priorityFeeSompi = kaspaToSompiStr(priorityFee);

            // Total fee is estimated fee plus priority fee
            const totalFeeSompi = BigInt(estimatedFeeSompi) + BigInt(priorityFeeSompi);
            const totalFee = (Number(feeEstimation.fee) + Number(priorityFee)).toFixed(8);

            // Check if we have enough funds (amount + estimated fee + priority fee)
            const requiredAmount = BigInt(amountSompi) + totalFeeSompi;
            if (this.context.balance.mature < requiredAmount) {
                throw new Error(`Insufficient funds. Required: ${amount} KAS + ${totalFee} KAS total fee`);
            }

            // Create transaction generator
            console.log('Creating transaction...');
            const generator = new Generator({
                entries: this.context,
                outputs: [{
                    address: toAddress,
                    amount: BigInt(amountSompi)
                }],
                priorityFee: BigInt(priorityFeeSompi), // Only use priority fee here
                changeAddress: sourceAddress.toString()
            });

            // Process and sign transactions
            const transactions = [];
            let pending;
            while (pending = await generator.next()) {
                await pending.sign([privateKey]);
                const txid = await pending.submit(this.rpc);
                transactions.push(txid);
                console.log('Transaction submitted:', txid);
            }

            const summary = generator.summary();
            console.log('Transaction summary:', summary);

            return {
                success: true,
                transactions,
                summary: {
                    sent: amount,
                    estimatedFee: feeEstimation.fee,
                    priorityFee: priorityFee,
                    totalFee: totalFee,
                    total: (Number(amount) + Number(totalFee)).toFixed(8)
                }
            };
        } catch (error) {
            console.error('Error in sendTransaction:', error);
            console.error('Stack:', error.stack);
            throw error;
        } finally {
            await this.cleanup();
        }
    }

    async cleanup() {
        if (this.processor) {
            await this.processor.stop();
        }
        if (this.rpc) {
            await this.rpc.disconnect();
        }
        if (this.feeEstimator) {
            await this.feeEstimator.cleanup();
        }
    }
}

module.exports = KaspaTransactions; 