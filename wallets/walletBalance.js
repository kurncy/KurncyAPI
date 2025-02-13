// @ts-ignore
globalThis.WebSocket = require('websocket').w3cwebsocket;

const path = require('path');
const fs = require('fs');
const kaspa = require('../rusty-kaspa/wasm/nodejs/kaspa');
const {
    setDefaultStorageFolder,
    Resolver, NetworkId,
    NetworkType, RpcClient,
    UtxoProcessor, UtxoContext
} = kaspa;

// 1 Kaspa = 100000000 Sompi
const SOMPI_PER_KASPA = 100000000n;

function sompiToKaspa(sompi) {
    const sompiAsBigInt = BigInt(sompi);
    const kaspaValue = Number(sompiAsBigInt) / Number(SOMPI_PER_KASPA);
    return kaspaValue.toFixed(8);
}

class WalletBalance {
    constructor(networkType = 'testnet-10') {
        this.networkId = new NetworkId(networkType);
        this.networkType = networkType.includes('testnet') ? NetworkType.Testnet : NetworkType.Mainnet;
        this.setupStorage();
        this.rpc = null;
        this.processor = null;
        this.context = null;
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

    async getBalance(address) {
        try {
            console.log('Getting balance for address:', address);
            await this.initialize();

            // Track the address
            await this.context.trackAddresses([address]);
            console.log('Tracking address for UTXOs');

            // Wait a bit for UTXOs to be processed
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Get balance from context
            const mature = this.context.balance.mature || 0n;
            const pending = this.context.balance.pending || 0n;
            const total = mature + pending;

            const balance = {
                mature: sompiToKaspa(mature),
                pending: sompiToKaspa(pending),
                total: sompiToKaspa(total)
            };

            console.log('Balance:', balance);
            return balance;
        } catch (error) {
            console.error('Error in getBalance:', error);
            console.error('Stack:', error.stack);
            throw error;
        }
    }

    async cleanup() {
        if (this.processor) {
            await this.processor.stop();
        }
        if (this.rpc) {
            await this.rpc.disconnect();
        }
    }
}

module.exports = WalletBalance; 